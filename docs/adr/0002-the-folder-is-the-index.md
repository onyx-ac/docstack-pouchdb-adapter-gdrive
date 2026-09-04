# ADR-0002 — The folder is the index, `_meta.json` is a cache of it

Status: accepted · Date: 2026-08-27 · Package: `@docstack/pouchdb-adapter-googledrive`

Supersedes the reachability half of
[ADR-0001](0001-metadata-writes-without-compare-and-swap.md). Answers
[0005-orphaned-change-logs.md](0005-orphaned-change-logs.md).

## Decision

**A client finds change logs by listing the folder**, not only by reading
`changeLogIds` out of `_meta.json`. The replay set is the union of what the metadata
references and what is actually in the folder, minus what a compaction has retired.
Logs are replayed in sequence order rather than in listing order, and any client that
finds an unreferenced log writes the reference back for everyone.

`_meta.json` keeps its `changeLogIds`. It is now a cache — worth having, because it
saves a listing and carries the retirement tombstones, but no longer the only way to
learn that a log exists.

## Why ADR-0001 was not enough

ADR-0001 replaced the compare-and-swap Drive does not offer with four mechanisms:
read fresh, merge don't replace, read back and verify, and let a writer restore its
own logs. Mechanism 3 is the one that fails here, and it fails by construction:

> commits that matter re-read afterwards and retry if what they wrote is not there,
> **which catches the writer who read just before we wrote**

It catches that writer only if their write lands *before* our read-back. A writer who
read before our write and lands after our read-back is invisible to us, and by then
we have already returned success to the caller. Mechanism 4 repairs it — on this
writer's *next* load or commit. If there is no next one, the reference is gone for
good.

ADR-0001 recorded that gap and called it "a client that writes and then disconnects
*forever* inside the one-round-trip window". That was too generous. The window is not
one round trip; it is *until this client writes again*, which for the last write of a
session is forever. And a browser tab closing at the end of an e2e run is not an
exotic case — it is every run.

## Evidence

Reported from Tokido, two browser contexts against one folder: seventeen change logs
present, fourteen referenced, duplicate sequence numbers in the filenames. The report
was filed against `0.1.5`; the build it ran was byte-identical to the ADR-0001 fix,
which self-reported `0.1.5` because the version had not been bumped. The
`changes-<seq>-<writerId>-<random>.ndjson` filenames in it — a format ADR-0001
introduced — are what gave that away.

Reproduced locally in `tests/writer_stress.test.ts`: three writers, eight rounds,
jittered latency. Roughly one run in five lost a document **that had been
acknowledged** — the append's promise had resolved.

```
{
  "docId": "doc-1-7",
  "metaSeq": 23,
  "referencedCount": 23,
  "presentCount": 24,
  "danglingReferences": [],
  "orphanedLogs": ["changes-23-zpda5kz8-udykgx.ndjson"],
  "verdict": "ORPHANED - present, unreferenced"
}
```

Two writers both allocated sequence 23; the loser's reference was overwritten after
its verification pass had already succeeded. The file is right there in the folder,
holding the only copy of `doc-1-7`, and no client would ever look at it again.

After this change: 0 failures in 25 runs of the same test.

## Why listing is the right authority

Creating a file in Drive is atomic and no client can undo another's. The set of
`changes-*.ndjson` files in a folder is therefore the one piece of shared state that
concurrent writers cannot corrupt — no read-modify-write, nothing to lose a race
over. A whole-file `_meta.json` update is the opposite: last write wins, and every
writer's list is a guess about what the others have done.

So the durable record of "this change log exists" is the file's existence, and
`changeLogIds` becomes an optimisation over it. Losing a metadata update now costs a
listing, not a document.

Three things make it work:

- **Retirement tombstones still gate it.** Compaction writes `retiredLogIds` before
  it deletes anything, so a client that lists mid-compaction will not re-adopt a log
  that has been folded into the snapshot. Files that are already deleted cannot
  appear in a listing at all, so the tombstones only have to cover the window between
  the metadata write and the delete.
- **Replay is ordered by sequence number**, taken from each log's first entry rather
  than from its filename. Insertion order was never deterministic across clients once
  merges were in play — two readers of one folder could disagree about which
  revision won, because `updateIndex` takes the last write for a document. Sequence
  order is the same everywhere.
- **Discovery repairs the cache.** A client that finds an unreferenced log commits
  the reference back. Under ADR-0001 only the log's own writer could do that; now the
  first client to read the folder does it on everyone's behalf.

Listing failures are non-fatal: the load falls back to `changeLogIds` alone, which is
exactly the old behaviour.

## Consequences

- **One extra `files.list` per load.** Loads happen on connect, on a polling tick
  that sees a change, and on a write that has to catch up with another writer.
- **`name contains 'changes-'` is now part of the query surface.** The emulated test
  server and the test fake both had to learn it. Results are filtered again
  client-side with `startsWith`, so the query's prefix-matching quirks do not matter.
- **A log written but never referenced is now found and adopted** — including one
  from a writer that was interrupted before it could commit its metadata. That is a
  behaviour change: such a write used to be invisible, and is now durable. It is the
  right way round for an append-only log, but it does mean an interrupted write can
  now become visible rather than being silently dropped.

## What this still does not fix

- Concurrent writes to the *same document* resolve last-writer-wins in the index
  rather than through pouchdb-merge. Ordered replay makes the outcome consistent
  across clients, which it was not before, but it does not make the losing revision a
  conflict branch.
- Two clients that each create a folder by `folderName` still get two databases.
