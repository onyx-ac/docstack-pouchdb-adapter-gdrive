# ADR-0004 — Replay merges into the index, and never moves a document backwards

Status: accepted · Date: 2026-08-27 · Package: `@docstack/pouchdb-adapter-googledrive`

Answers [0006-index-regression-drops-updates.md](0006-index-regression-drops-updates.md).
Continues [ADR-0002](0002-the-folder-is-the-index.md) — which made every log reachable,
and thereby made *replay* the mechanism that decides what a replica believes.

## Decision

Three changes, one per mechanism in the finding:

1. **`updateIndex`'s replay path merges instead of replacing.** A row for a document
   already in the index merges its synthesized node into the existing tree
   (`pouchdb-merge`), keeps `seq = max(existing, incoming)`, and picks the winner by
   revision generation with CouchDB's lexicographic hash tie-break. The losing
   revision is kept reachable in `conflictLocations`. A re-replay of an
   already-known revision only advances the seq.

2. **`load()` downloads change logs 8 at a time**, not all at once. The unbounded
   burst was what invited the rate limiter that created out-of-order stragglers.

3. **The live listener gates the whole batch against where the feed stood before
   it**, sorts by seq, fetches bodies for the batch in one pass, and advances
   `lastSeq` only as it emits in order — the initial pass's own fix, applied to the
   spot its comment already described.

## The finding, in one line

A change-log download clipped mid-boot is retried on a later load — after higher
logs applied — and the blind `this.index[id] = {...}` rewrote entries to older
state; the regressed entry then failed the feed's `seq > since` gate, the newer
revision was never emitted, and the puller's checkpoint sealed the loss. Ten rows,
three dropped, both devices `idle · up to date`.

## Why the winner is decided by generation, not `winningRev`

The finding's minimal guard (`if existing.seq >= change.seq return`) misses its own
second case: a writer echoing rev 3 at a *fresh* seq after rev 4 landed — seqs
honestly ordered, revisions not. The winner has to come from the revision, not the
replay order.

But handing the decision to `pouchdb-merge.winningRev` is wrong here too, for a
reason specific to this adapter: replayed rows carry no ancestry (`nextIndexEntry`
is stripped before upload), so every merged node is parentless and every revision is
a *leaf*. `winningRev` prefers live leaves over deleted ones — correct for real
conflict branches, but here it would let a document's old live rev 1 beat its own
genuine deletion at rev 2. Generation ordering is exactly CouchDB's descendant rule
for the single-lineage case these rows actually are; the hash tie-break keeps equal
generations deterministic across replicas.

The trees still merge — `_getRevisionTree` stays honest about which revisions
exist — but the *winner* never regresses.

## What is deliberately not changed

- **`nextIndexEntry` stays stripped from uploaded rows.** Shipping every writer's
  merged tree in every row is a storage format change growing with tree depth; the
  regression is fixed without it. The cost that remains: replicated updates arrive
  at the local database as parentless branches, so `revs: true` fetches serve
  synthesized history. Real, but a different problem than losing data.

- **A device already bitten stays bitten** until touched. The folder holds
  everything; the losing reader's checkpoint is past the dropped rows. Touch the
  affected documents from any healthy device, or rebuild the replica — as the
  finding's remediation section says.

## Verification

`tests/index_regression.test.ts`, against the ETag-less fake with fail-once download
injection — five cases: the straggler retry (the incident), the stale echo at a
fresh seq (the second casualty), an in-order deletion still winning (the case the
naive `winningRev` approach would break), the same-rev re-replay advancing only the
seq (the finding's seq-78 row), and the download burst staying ≤ 8. Four of five
fail against the pre-fix adapter; the deletion case passes there too, as expected —
blind replace was only wrong out of order.

`tests/production.concurrency.test.ts` re-checks the ADR-0001/0002/0003 invariants
against the real Drive API — two live writers, a raw-client metadata clobber, orphan
and duplicate-seq sweeps — because every finding in this series shipped after a fake
had said the previous fix was fine.
