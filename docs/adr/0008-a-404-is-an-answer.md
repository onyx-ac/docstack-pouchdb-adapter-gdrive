# ADR-0008 — A 404 is an answer, not an outage

Status: accepted · Date: 2026-09-01 · Package: `@docstack/pouchdb-adapter-googledrive`

Answers [0007-a-missing-change-log-stops-every-future-write.md](0007-a-missing-change-log-stops-every-future-write.md).

## Decision

1. **A change log that answers 404 is written off, not retried.** It is marked
   processed (its changes are already lost; the loss must not compound) and removed
   from `ownLogIds` (reconcile would otherwise defend the reference for ever).
2. **The dead reference is pruned from `changeLogIds` and tombstoned in
   `retiredLogIds`** — on every metadata commit, and on the first `load()` that
   proves it dead, by any client, reader or writer. The tombstone is what stops the
   log's own writer, which still remembers writing it, from restoring the reference
   its reconcile pass would otherwise put back: prune-and-restore would ping-pong
   between the pruning reader and the remembering writer.
3. **Any other failure keeps today's retry.** A 503 or a clipped download is an
   outage; retrying is right when the file is there and the network was not.
4. **The catch-up error names what blocked it.** "Could not catch up with concurrent
   writers" sent a real investigation hunting a second writer; when the budget is
   exhausted by logs that could not be read, the message now lists them.

## The finding, in one line

The read path tolerated a missing log but never marked it processed, so
`hasUnprocessedLogs` stayed true for ever and every write burned its catch-up budget
re-reading a file that can only 404 — one dangling reference (damage the 0.1.8
verify-blip bug left in real folders) became a permanent, silent write outage, found
as a workspace that accepted no writes from any device for two days while reporting
`active` and converging on schedule.

## The subtlety the first cut missed

The self-heal commit originally ran where the other load-time repair runs — before
replay. But 404s are discovered *during* replay, so a pure reader never healed the
folder it had just diagnosed; only a later write did. The heal runs after replay
now, and `tests/dead_log.test.ts`'s "folder heals" case is the one that caught it.

## Verification

`tests/dead_log.test.ts`, five cases: writes continue past a dangling reference (the
outage itself); the folder heals on first load — pruned and tombstoned; the log's own
writer does not resurrect a pruned reference; a transient failure keeps its retry and
applies next load; the error names the unreadable log. Four fail against the pre-fix
adapter; the transient case passes there too, as it should — it pins the behaviour
this change must not break.
