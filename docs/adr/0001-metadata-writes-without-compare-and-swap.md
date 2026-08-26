# ADR-0001 — `_meta.json` writes without compare-and-swap

Status: accepted · Date: 2026-08-26 · Package: `@docstack/pouchdb-adapter-googledrive`

Follows [docstack-gdrive-adapter-0.1.5.md](docstack-gdrive-adapter-0.1.5.md), finding #1.

## Decision

`_meta.json` is the only shared mutable state in a database folder, and Google Drive
offers nothing to lock it with. Four mechanisms stand in for the compare-and-swap the
adapter believed it had:

1. **Every commit builds on metadata read from Drive moments earlier**, never on the
   copy this handler cached at load time.
2. **Modifiers merge into that copy rather than replacing it**, so whatever a
   concurrent writer added survives.
3. **Commits that matter read back afterwards** and retry if what they wrote is not
   there.
4. **A writer remembers the change logs it published** (`ownLogIds`) and restores any
   that go missing, unless a compaction has tombstoned them in the new
   `MetaData.retiredLogIds`.

They live in `DriveHandler.commitMeta()`, which every metadata mutation now goes
through — append, compaction, and the `_local_docs.json` pointer.

Two consequences of the same reasoning:

- **Compaction deletes nothing until it has read back the metadata that
  de-references it.**
- **Sequence numbers are allocated from Drive at write time**, not from the cached
  counter.

## The symptom

A shared folder held pairs of change logs claiming one sequence number, one of each
pair referenced by nothing:

```
changes-101-wlvct.ndjson   (14:32:30)     changes-101-gxt64r.ndjson  (14:37:22)
changes-111-axyrdw.ndjson  (14:37:35)     changes-111-b7hh8.ndjson   (14:38:42)
```

Readers reconstruct state from `snapshot-index-*` plus the `changeLogIds` in
`_meta.json`. A log outside that set is unreachable — present in Drive, invisible to
every client.

## Why the locking that existed never ran

The adapter did not lack optimistic concurrency control. `tryAppendChanges` called
`saveMeta(nextMeta, this.metaEtag)`, and `saveMeta` passed that through to
`GoogleDriveClient.updateFile`, which sets `If-Match`. The header was simply never
sent, and would have been ignored if it had been:

| step | what happens on Drive v3 |
| :--- | :--- |
| `listFiles` requests `files(id,name,mimeType,parents,modifiedTime,md5Checksum)` | no `etag` — the File resource has no such field |
| `findFile` sees `!file.etag`, falls back to `getFileMetadata` | `extractEtag` reads the `ETag` response header; absent |
| `findFile` returns `etag: ''`; `load()` did `this.metaEtag = metaFile.etag \|\| null` | `null` |
| `saveMeta(meta, null)` → `updateFile(id, content, undefined)` | header omitted — **unconditional PATCH** |

Drive API v3 dropped ETags, so even a correctly plumbed `If-Match` is accepted and
ignored. There is no compare-and-swap to reach for; the fix suggested in the findings
doc ("the plumbing already exists — what is missing is using it") could not have
worked.

**The emulated test server does enforce `If-Match`** (`tests-src/server.ts`,
`updateFile` → 412). Every concurrency test therefore exercised a compare-and-swap
that production never had, which is why this held green in CI while production lost logs.

That also explains the five-minute gap between the paired writes above. Nothing was
racing on a network window: each client wrote `changeLogIds` derived from
`this.meta`, refreshed only on load, so the window in which a peer could be clobbered
was the client's entire lifetime.

## What replaces it

| mechanism | closes |
| :--- | :--- |
| read fresh before every commit | the lifetime-long window — down to one round trip |
| merge, don't replace | a concurrent writer's logs, whatever else it added |
| read back and retry | the writer who read just before we wrote |
| `ownLogIds` restore on load/commit | anything dropped despite the above, once the writer runs again |

`retiredLogIds` is what keeps mechanism 4 from fighting compaction: a log folded into
a snapshot is tombstoned, so the writer that produced it stops defending it. The list
is capped at 500 entries. A writer that slept through more compactions than that may
resurrect a dead file id, which replays as a skipped 404 and is pruned by the next
compaction.

Two supporting changes fell out of the same work:

- **A writer catches up before it writes.** If the folder holds logs this handler has
  not replayed, it loads them first. Previously this only happened on a 412, which
  Drive never returns — so `checkConflicts` had effectively never run in production.
  It is applied only to the low-level `appendChange()` callers; `_bulkDocs` resolves
  revisions through pouchdb-merge and expresses a collision as a conflict branch, so
  failing its whole batch would be the wrong answer.
- **A published log is marked processed.** The log lines on Drive have
  `nextIndexEntry` stripped, so a later `load()` replaying our own log would overwrite
  a real merged rev tree with a synthesized single-node one.

## The second defect

Compaction called `cleanupOldFiles` on the strength of a metadata write nothing had
confirmed. With no compare-and-swap, a lost update there means the snapshot never
lands *and* the change logs — still the only copy of everything in them — are deleted.
A lost update becomes lost documents.

It now returns without deleting anything if `commitMeta` could not verify the write.
The new snapshot files are left behind unreferenced rather than deleted, because a
reader may already have picked them up.

## Reproduction

[`tests/meta_concurrency.test.ts`](../../tests/meta_concurrency.test.ts) runs against
a fake Drive that behaves like the real one: it never returns an ETag and never
honours one. It needs no Drive account, and — unlike the reproduction the findings doc
asked for — no fix to the client's id allocation first, because it drives
`DriveHandler` directly with explicit ids.

All seven cases fail against the pre-fix adapter. The headline one, two clients that
never saw each other's writes:

```
● does not orphan a change log written by a client it never saw
  - Array []
  + Array [ "changes-1-esygai.ndjson" ]
```

Both logs were named `changes-1-*`: the duplicated sequence number and the orphaning,
in one assertion.

## Consequences

**Appends cost more round trips.** Per append, 4 Drive calls became 9:

| | before | after |
| :--- | ---: | ---: |
| read metadata for the sequence range | 0 | 3 |
| create the change log | 1 | 1 |
| commit metadata (read, write) | 3 | 4 |
| read back to verify | 0 | 1 |

Two of those nine are `findFile`'s etag backfill — one `getFileMetadata` per
`findFile`, and `findFile` runs twice per append, to fetch an ETag that Drive v3 can
never return.
`listFiles` already returns the `md5Checksum` and `modifiedTime` that callers
actually use. Removing the backfill would take an append from 9 calls to 7 and is the
cheapest remaining win here; it is left for a separate change because it touches every
`findFile` caller, not just the metadata path.

**What is still not guaranteed:**

- A client that writes and then disconnects *forever* inside the one-round-trip window
  can still leave a log unreferenced. Mechanisms 3 and 4 both need the writer to live
  long enough to run them.
- Concurrent writes to the *same document* resolve last-writer-wins in the index
  rather than through pouchdb-merge: `_bulkDocs` computes its merged tree before the
  catch-up replay, so it is applied against a view that has since moved. Both
  revisions are on Drive; the losing one does not surface as a conflict branch.
- Two clients that each create a folder by `folderName` get two databases. Duplicate
  `_meta.json` files inside one folder are now detected and resolved (lowest file id
  wins, the loser deletes its own and adopts the winner); duplicate folders are not.

## Adjacent: `pollingIntervalMs` was dead since April

`DriveHandler.startPolling` is never called. The call site was removed by
`2105386` (*"Parallel loading, md5checksum, seperate feed for _local docs"*,
2026-04-06) when `load()` was rewritten — the block

```ts
// 3. Start Polling (if enabled)
if (this.options.pollingIntervalMs) {
    this.log('Starting polling with interval', this.options.pollingIntervalMs);
    this.startPolling(Number(this.options.pollingIntervalMs));
} else {
    this.log('Polling disabled (no interval provided)');
}
```

was replaced by the local-docs loading block, leaving the `// 3. Start Polling ...`
comment stub that is still in `load()` today. The method, its re-entrancy guard, the
public `stopPolling()`, the option, and its README entry all survived; only the call
did not. Collateral damage from a refactor, not a decision — nothing in the three
earlier polling fixes (`4d98038`, `e21903e`, `441cba8`) suggests it was meant to go.

What it was for: it compares `_meta.json`'s ETag, then `md5Checksum`, then
`modifiedTime` against the cached values, and on a change calls `load()` — which
replays the new logs and emits them through `notifyListeners`. That is the only thing
that would ever have made `db.changes({ live: true })` fire for a *remote* write.
Without it, `db.onChange` only ever delivers what this client wrote itself, or what it
happened to discover during some other load. Connect-and-read works, which is why
pull and handoff both looked healthy; continuous sync between two connected clients
does not.

### Reconnected

The call site is back in `load()`, and is now idempotent — `load()` runs again on
every catch-up and retry, and the old code cleared and reset the interval each time,
which pushed the next tick further out for as long as the client stayed busy.

Three things had to change with it, all of them the same ETag problem in another
costume:

- **The ETag comparison is gone**, not demoted. It led the chain, so it decided the
  outcome, and on Drive v3 it could only ever compare `''` against `''` — shadowing
  the two comparisons that work. Detection is now `md5Checksum`, falling back to
  `modifiedTime`.
- **`createFile` and `updateFile` now request `md5Checksum` in `fields`.** They asked
  for `id,modifiedTime`, so `this.metaMd5` was null after every write and the md5
  branch silently fell through to `modifiedTime` — which, for a client that had just
  written, is a timestamp it set itself.
- **The trailing bare `notifyListeners()` is removed.** With no argument it returned
  immediately rather than firehosing the index (that is what `e21903e` fixed); the
  `load()` above it is what actually emits, and emits precisely what it replayed.

Teardown was already wired: `api._close` and `api._destroy` both call
`db.stopPolling()`.

[`tests/polling.test.ts`](../../tests/polling.test.ts) covers it — the feature's
first tests. Five cases: a remote write reaches a listener, a client does not
re-announce its own writes, `stopPolling` stops it, `load()` does not restart the
interval, and no interval means no polling. Only the first depends on the call site;
it fails without it, and the other four are the guards around it.
