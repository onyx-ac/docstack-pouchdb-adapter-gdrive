# Findings: `@docstack/pouchdb-adapter-googledrive` 0.1.5

Written 2026-08-26 from `paper`, against a real Drive account, with
`@docstack/client@0.1.6`.

**Read [docstack-client-0.1.6.md](docstack-client-0.1.6.md) first.** The data loss we set
out to investigate turned out to be a client-side id-allocation bug, not an adapter bug.
What follows is a separate defect found while looking, which is real but has not yet been
shown to lose data on its own.

## What works

- **Connecting and converging.** A single client reaches `state: "idle"` with
  `lastError: null`, reliably, in ~20–30s against a folder of ~130 documents.
- **Push.** Documents created locally reach the remote — verified by reading the folder
  directly through the Drive API rather than trusting the counters.
- **Pull.** A client that connects to a populated folder receives its contents.
- **Handoff.** Client A writes and disconnects, client B connects and reads what A wrote.
  Green: [`drive-handoff.spec.ts`](../../packages/web/tests/drive-handoff.spec.ts).

The transport is in better shape than the first symptoms suggested.

## 1. Two clients allocate the same change-log sequence number

**Severity: unclear, potentially data loss. Needs a reproduction that isolates it from the
client's id bug.**

The folder shows pairs of change-log files claiming one sequence number:

```
changes-101-wlvct.ndjson   (14:32:30)     changes-101-gxt64r.ndjson  (14:37:22)
changes-111-axyrdw.ndjson  (14:37:35)     changes-111-b7hh8.ndjson   (14:38:42)
```

Each client reads `_meta.json`, takes `seq`, appends `changes-<seq>-<random>.ndjson`, and
writes `_meta.json` back carrying its own `changeLogIds`. That last write is
unconditional, so a second client's metadata replaces the first's — and the first's change
log stops being referenced by anything.

Readers reconstruct state from `snapshot-index-*` plus the `changeLogIds` in `_meta.json`.
A log outside that set is unreachable, though the file still sits in the folder. We saw
`Paper-2` written to `changes-43-mirh5.ndjson`, absent from the snapshot index written
three minutes later, and `changes-43` absent from `changeLogIds` — present in Drive,
invisible to every client.

We cannot yet say whether that document was lost *here* or by the client-side collision,
because both were in play. The orphaning is visible in the folder regardless, and
compaction has the same exposure: two clients compacting independently each fold their own
view of the log set into a snapshot.

### Suggested fix

Make the `_meta.json` write a compare-and-swap. Drive supports it and the plumbing already
exists — `GoogleDriveClient.updateFile` takes `expectedEtag` and passes it through — so
what is missing is using it for the metadata write and retrying the read-modify-write on
mismatch.

Failing that, stop deriving log filenames from a shared counter: name them by client id
plus a local monotonic counter, and merge `changeLogIds` on write rather than replacing.

### How to reproduce it cleanly

The client's id bug has to be out of the way first. Either wait for that fix, or drive two
clients that only write documents with explicit, distinct `_id`s, then read the folder
through the Drive API and check whether every change-log file is still referenced by
`_meta.json`.

## 2. Worth documenting either way

Nothing in the adapter's API suggests a limit on concurrent writers, and until #1 is
settled there is one. A line in the README would have saved this investigation a day.
