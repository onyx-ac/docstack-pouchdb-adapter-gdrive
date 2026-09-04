# @docstack/pouchdb-adapter-googledrive — a re-replayed old log regresses the reader's index, and updates are silently lost

**For:** `docstack-pouchdb-adapter-gdrive`
**Found in:** `0.1.6`, in ordinary two-device use — not a test rig.
**Severity:** silent data loss. Both devices reported `idle · up to date` while holding
different data, and the losing device's checkpoint guarantees it never recovers on its own.

Related, and distinct: [the orphaned-log and sequence-collision findings](./docstack-gdrive-adapter-orphaned-change-logs.md).
This is neither of those. The dropped rows here hold unique sequence numbers, and the log
that carried them is referenced, present, and fully readable.

---

## Symptom

Two devices replicating one folder. Device B created two buckets and moved two tasks into
one of them; B's push landed on Drive as a single ten-row change log. Device A applied
**seven of the ten rows and silently skipped three**. A's pull checkpoint then advanced to
the folder's tip, so the three rows are permanently unreachable: every future pull asks for
`seq >` a number past them.

Both devices' status read `idle · up to date`.

## Evidence

The batch — `changes-69057610-jvgim7v3-v92c6l.ndjson`, uploaded 19:50:29 UTC:

| seq | doc | rev | also in an older log? | on device A |
| --- | --- | --- | --- | --- |
| 69057610 | `Workspace-0` | 1-c62e | yes (≤ 68464267) | received |
| 70057610 | `Workspace-0` | 1-973c | yes | received |
| 71057610 | `Task-2bd41d…` *(deletion)* | 2-f969 | **yes, at rev 1** (seq 46401557) | **dropped** |
| 72057610 | `Bucket-649d…` "Minor bugs" | 1-e3b3 | no | received |
| 73057610 | `Task-356f2a…` *(bucket set)* | 3-55b7 | **yes, at rev 2** (seq 37401557) | **dropped** |
| 74057610 | `Task-3e84df…` *(bucket set)* | 2-af59 | **yes, at rev 1** (seq 61401557) | **dropped** |
| 75057610 | `Bucket-5461…` "Bugs" | 1-82e4 | no | received |
| 76057610 | `Task-e0016c…` | 1-48b5 | no | received |
| 77057610 | `Task-283486…` | 1-62c0 | no | received |
| 78057610 | `Task-d4d47b…` | 2-6e6c | yes — **at the same rev** (seq 60401557) | received (no-op) |

The discriminator is exact: **a row was dropped if and only if the same document exists in
an older change log at a different revision.** New documents cannot be dropped this way;
neither can a row whose old-log revision is identical, because the regression it suffers is
invisible. Seq 78 is the exception that proves the mechanism — it regressed too, to itself.

No sequence threshold fits this pattern (received seqs bracket the dropped ones on both
sides), which rules out every checkpoint- and gate-level explanation. Only per-document
state discriminates like this.

The permanence: `_local_docs.json` shows the pull checkpoint at `93057610` — the folder's
tip — with a single-entry history. The losing reader has checkpointed past changes it never
applied.

## Mechanism

Three facts from the source combine:

1. **Change-log rows carry no ancestry.** `nextIndexEntry` — the merged revision tree the
   writer computed — is stripped before upload (`drive.ts`, the push path). Every reader
   therefore replays every row through `updateIndex`'s legacy branch, which **blindly
   replaces** the index entry:

   ```ts
   this.index[change.id] = {
       tree: synthesizeTree(change.rev, change.deleted),
       rev: change.rev,
       seq: change.seq, ...
   };
   ```

   No comparison with the existing entry. A row replayed out of order rewrites the entry —
   rev, seq, and `location` — to an older state.

2. **`load()` downloads pending logs with one unbounded `Promise.all`,** and a failed
   download is skipped without being marked processed — correctly, so it can be retried.
   But the retry, on a later `load()`, replays the straggler **after** logs with higher
   sequences have already been applied. The in-batch sort ("Replay in sequence order, not
   in the order the ids happened to be listed") orders each batch internally; it cannot
   order a batch against the ones already applied. At boot this folder had 72 pending
   logs — 72 parallel Drive GETs is exactly the burst Drive's rate limiter clips, which is
   also why the symptom is intermittent.

3. **The changes feed emits one row per document, from the index entry** — its current
   `seq` gated by `> since` (initial pass) or `> lastSeq` (live listener), its current
   `rev`, its current `location` for the body fetch. A regressed entry fails the gate (old
   seq), offers a rev the puller already holds, and fetches an old body. Whichever point in
   the pipeline the regression lands relative to, the update is not delivered — and later
   rows advance the checkpoint past it.

Put together: reader boots → most logs replay in order, a few old logs fail to download →
index briefly correct (new revs in place) → the next poll retries the old logs → **entries
for every document those logs touch regress to the old rev/seq** → the feed never emits the
newer revision → checkpoint passes it → permanent.

The write path is not implicated: the puller's local write survives even a parentless
revision. Verified directly against `pouchdb-merge` 7.3.1 — merging a bare `3-c` node into
a `1-a → 2-b` tree yields winner `3-c` (as `internal_node` conflict), same as with full
ancestry. Had the rows been emitted at their new revisions, device A would show the moves.
The loss is entirely inside the adapter's feed.

## A second casualty of the same blind replace, visible in this folder

Device A pushed `Task-4a8ec5…` at **rev 4** (seq 84356997). Device B's next batch echoed
the same document at **rev 3** (seq 88057610). Any reader replaying seq 88 after seq 84
regresses that document's index entry from rev 4 to rev 3 — a winner regression with no
out-of-order download required, because replay order across writers is by seq and these
seqs are honestly ordered while the *revisions* are not. The same guard fixes both.

## Suggested fix

In `updateIndex`'s legacy path, never regress:

```ts
const existing = this.index[change.id];
if (existing && existing.seq >= change.seq) return;   // an older replay must not win
```

plus, for the echo case above, prefer the higher revision when seqs disagree with revs —
or properly: merge the synthesized node into the existing tree with `pouchdb-merge` and
keep `seq = max(existing.seq, change.seq)`, which handles both directions and keeps
`_getRevisionTree` honest.

Independently worth doing, each smaller than the guard:

- **Bound the download parallelism** in `load()` (72 unthrottled GETs invites the rate
  limiter that creates the stragglers).
- **Stop stripping `nextIndexEntry`**, or store ancestry some other way. Today every
  reader holds single-node synthesized trees, so replicated updates arrive at the local
  database as parentless branches — winners by pos, but the revision history is fiction,
  and `revs: true` fetches serve it.
- The live listener's gate (`entry.seq > lastSeq`, `lastSeq` advanced by `Math.max` over
  an unordered iteration) is the same class of bug the initial pass already fixed —
  its own comment reads *"an unordered batch can checkpoint past a change it never
  emitted."* The regression above is what bit here, but this gate is sitting on the same
  trap.

## Reproduction sketch

Two clients, one folder. Populate enough change logs that a boot has a large pending set
(dozens). On client A, fail a subset of the log downloads on first `load()` (fault
injection, or run the burst against the real rate limiter), chosen so the failed logs hold
old revisions of documents whose newer revisions are in logs that succeed. Let the retry
poll replay them. Write updates from client B to those same documents; observe A's index
entries regress and A's pull skip the updates while its checkpoint advances.

## Remediation for an affected device (until fixed)

The replica on Drive is complete — the loss is in the reader's bookkeeping. Either:

- touch the affected documents on any healthy device (a new revision gets a fresh seq
  above the loser's checkpoint and is delivered normally), or
- rebuild the affected device from the replica (destroy local databases and re-pull; a
  fresh replay applies all logs in seq order and lands on the right state).

## What this does not cover

Whether the sequence-collision residual (counter 87 was minted by both writers in this same
folder — `87057610` vs `87356997`) can produce an additional loss on top of this one; the
dropped rows here had unique sequences, so it was not the cause of this incident.
