# ADR-0003 — Sequence numbers carry a writer slot

Status: accepted · Date: 2026-08-27 · Package: `@docstack/pouchdb-adapter-googledrive`

Answers the "still open after 0.1.6" section of
[0005-orphaned-change-logs.md](0005-orphaned-change-logs.md). Completes
[ADR-0001](0001-metadata-writes-without-compare-and-swap.md) and
[ADR-0002](0002-the-folder-is-the-index.md).

## Decision

A sequence number is `tick * SEQ_SLOTS + writerSlot`, with `SEQ_SLOTS = 1_000_000`
and `writerSlot` an FNV-1a hash of the handler's writer id.

Two writers reading the same counter still derive the same tick — nothing can stop
that without a lock. They no longer derive the same *sequence number*, which is the
part that matters.

The abort-and-retry that used to guard allocation is gone with it. It existed only to
avoid collisions, it never reliably did, and it cost an upload every time it fired.

## Why the old guard could not work

`tryAppendChanges` read `_meta.json`, remembered `seq`, and refused to commit if the
counter had moved by the time it wrote:

```ts
if (latest.seq !== observedSeq) return null;   // someone took our range
```

That is a read, then a write, with a gap. Two writers whose commit-time *reads* both
land before either's *write* both see the untouched counter and both commit. It is
the same shape as every other defect in this sequence of ADRs, and it has the same
cause: Drive API v3 offers no compare-and-swap, so "check then act" is never atomic.

Narrowing a race is not closing it. The way out is to stop needing the check.

## Why the collision mattered

`_changes` filters on `seq > since`, and a replication target checkpoints on the
highest sequence number it has seen. Two documents sharing a number means the second
one is never emitted again — the target has already checkpointed past it. The data is
in Drive and reachable; it simply never replicates.

ADR-0001 named this consequence and then failed to prevent it.

## Evidence

From the field, `0.1.6` against a fresh folder, two browser contexts:

```
seq  3:  owllxyrw                     icnhty8c
seq  9:  owllxyrw -> seqs[9,10,11]    5emlcj01 -> seqs[9,10]
seq 14:  5emlcj01 -> seqs[14,15,16]   3xwcumbi -> seqs[14,15]
```

Three sequences minted twice, each by a different writer, with overlapping ranges
inside.

Locally, `tests/writer_stress.test.ts` with the slot space collapsed to 1 — which
reproduces the old dense allocation exactly, leaving everything else in place:

| allocation | runs failing on a duplicate sequence number |
| :--- | ---: |
| dense (`SEQ_SLOTS = 1`) | **10 / 10** |
| slotted (`SEQ_SLOTS = 1_000_000`) | **0 / 20** |

A failing run reported 22 colliding sequence numbers, `seq: 1` among them, claimed by
three writers at once.

## Consequences

- **Sequence numbers are large and sparse.** The first write to a fresh folder gets
  something like `1000042`, not `1`. They remain monotonic and comparable, which is
  all `_changes` requires of them.

- **Existing folders migrate silently.** A folder sitting at `seq: 23` yields
  `floor(23 / 1_000_000) = 0`, so the next tick is 1 and the next sequence number is
  about a million — above every number already in the index, and above any checkpoint
  a replication target holds. Nothing re-replicates and nothing is skipped. The
  numbers simply jump once.

- **`countTotalChanges` had to stop reading `meta.seq` as a count.** It returned the
  counter when no snapshot existed yet, on the reasoning that the two were the same
  number. They are now a million apart, and compaction would have fired on the first
  write. It counts change-log files in both branches now, which is what its other
  branch always did.

- **Fewer wasted uploads.** The removed guard used to discard an uploaded change log
  and rewrite it whenever another writer advanced the counter first. Under real
  concurrency that fired often, and every occurrence left a file to be deleted —
  visible in the field report as duplicate `changes-<seq>-*` files.

- **Two assertions in the existing suite were about density, not correctness**
  (`expect(driveHandler1.seq).toBe(2)`, and a replication test that hardcoded
  `const seq1 = 1; // approximate knowing impl`). Both now assert the property they
  were reaching for: that two writers never share a number, and that a target
  checkpointing on a real `last_seq` sees exactly what came after it.

## What is still not guaranteed

- ~~Slot collisions are possible, not impossible.~~ **Implemented since:** writer ids
  appear in change-log filenames and `load()` lists the folder anyway, so a client
  that sees a rival id hashing to its own slot re-rolls to a free one before minting
  anything (`rerollIfSlotContested`). The residual shrinks from "roughly 1 in 20,000
  per ten-client fleet, for the whole session" to the window in which a rival's first
  log is not yet visible in a listing — the same one-round-trip class of exposure as
  everything else here, and one that additionally requires the hash collision itself.
  Logs already written keep their names and numbers; `ownLogIds` tracks file ids, so
  nothing else moves.

- **A late arrival below a checkpoint is still skipped.** Uniqueness stops two
  documents from sharing a number. It does not stop a writer from committing a tick
  it allocated *before* a target checkpointed past it. Closing that needs a
  serialization point, which is the thing Drive does not offer — CouchDB has the same
  exposure when a source rewinds.

- Concurrent writes to the *same document* still resolve last-writer-wins in the
  index rather than through pouchdb-merge.
