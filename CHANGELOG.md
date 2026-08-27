# Changelog

## 0.1.7 — unreleased

### Fixed

- **A re-replayed old change log no longer regresses the reader's index.** A log
  download clipped by the rate limiter was retried on a later load — after higher
  logs had applied — and the replay path replaced index entries blindly, rewriting
  rev/seq/location to older state. The regressed entry then failed the changes
  feed's gate, the newer revision was never emitted, and the puller's checkpoint
  sealed the loss: both devices idle and up to date while holding different data.
  Replay now merges into the existing entry and never moves a document backwards;
  winners are decided by revision generation (a stale revision echoed at a fresh
  sequence number loses too), and losing revisions stay reachable as conflicts.
  Field report and reasoning: ADR-0004 / finding 0006, in the repository.

- **Cold-boot change-log downloads are bounded to 8 in flight**, not one burst of
  everything pending — the burst was what invited the rate limiting that created
  out-of-order retries in the first place.

- **The live changes listener emits each batch in sequence order** and advances its
  checkpoint as it emits, instead of gating each document against a bar that other
  documents in the same batch had already raised — the initial pass's own fix,
  applied to the listener.

### Added

- `tests/production.concurrency.test.ts` (`npm run test:prod:concurrency`) —
  re-checks the multi-writer invariants (no orphaned logs, no duplicate sequence
  numbers, lost metadata updates cost nothing, acknowledged writes readable) against
  the real Drive API rather than the test fake.


## 0.1.6 — 2026-08-27

A data-loss fix. Every client sharing a folder should be upgraded together; see
[Compatibility](#compatibility).

Background and reasoning, in order:
[ADR-0001](docs/adr/0001-metadata-writes-without-compare-and-swap.md) (metadata writes
without compare-and-swap), [ADR-0002](docs/adr/0002-the-folder-is-the-index.md) (the
folder is the index), [ADR-0003](docs/adr/0003-sequence-numbers-carry-a-writer-slot.md)
(sequence numbers carry a writer slot). The reports that drove it:
[docstack-gdrive-adapter-0.1.5.md](docs/adr/docstack-gdrive-adapter-0.1.5.md) and
[0005-orphaned-change-logs.md](docs/adr/0005-orphaned-change-logs.md). The ADRs live in
the repository, not in this package.

### Fixed

- **A lost metadata update no longer costs a document.** Change logs are found by
  listing the folder, not only by reading `changeLogIds` out of `_meta.json`. The
  file's existence is the durable record that a change log exists; the metadata is a
  cache of that. Reported from Tokido on 2026-08-27 and reproduced locally as
  acknowledged writes going missing in roughly one stress run in five —
  [ADR-0002](docs/adr/0002-the-folder-is-the-index.md).

  This supersedes the reachability half of the fix below, which could only repair a
  dropped reference if the writer that lost the race ran again. At the end of a
  session it never does.

- **Change logs replay in sequence order.** Insertion order was not deterministic
  across clients once metadata merges were in play, so two readers of one folder
  could disagree about which revision of a document won.

- **Concurrent writers no longer orphan each other's change logs.** Two clients could
  each read `_meta.json`, append a change log, and write back a `changeLogIds` list
  that did not mention the other's. The losing log stayed in the folder referenced by
  nothing — present in Drive, invisible to every reader, and its documents with it.

  The adapter believed it was guarding this with an ETag compare-and-swap. Drive API
  v3 has no ETags, so `If-Match` was never sent and would have been ignored if it
  had been; the emulated test server *does* enforce it, which is why the existing
  concurrency tests stayed green. Metadata writes now read fresh, merge instead of
  replace, read back to confirm, and restore any of this writer's logs that go
  missing.

- **Compaction no longer deletes change logs it has not confirmed de-referencing.**
  It deleted them straight after a metadata write that nothing had verified. With no
  compare-and-swap, a lost update there means the snapshot never lands *and* the logs
  — still the only copy of everything in them — are gone. A lost update became lost
  documents.

- **Two writers can no longer mint the same sequence number.** A sequence number is
  now `tick * 1_000_000 + writerSlot`, the slot being a hash of the writer's id. Two
  clients reading the same counter still derive the same tick — nothing stops that
  without a lock — but they no longer collide on the number itself.

  This matters because `_changes` filters on `seq > since`: two documents sharing a
  number means the second is never emitted to a replication target again, having
  already been checkpointed past. Allocating from Drive at write time narrowed the
  window and did not close it, because "read the counter, then check it has not
  moved" is not atomic without a compare-and-swap —
  [ADR-0003](docs/adr/0003-sequence-numbers-carry-a-writer-slot.md).

  Sequence numbers are consequently large and sparse. The first write to a fresh
  folder gets about `1000000`, not `1`.

  A writer that sees a rival id hashing to its own slot in the folder listing re-rolls
  to a free slot before minting anything, closing the hash-collision residual down to
  the window before the rival's first log is visible.

- **Two clients opening the same empty folder converge on one `_meta.json`.** Drive
  allows duplicate names, and clients were choosing between the rivals at random.
  Lowest file id wins; the loser deletes its own and adopts the winner.

- **A client no longer replays its own change logs on reload.** The log lines on
  Drive have `nextIndexEntry` stripped, so replaying one overwrote a real merged
  revision tree with a synthesized single-node one, losing ancestry.

- **`pollingIntervalMs` works again.** The call site was lost in a refactor in April
  (`2105386`) and the option has done nothing since. Without it a client only hears
  about its own writes, so `db.changes({ live: true })` never fires for a remote one —
  connect-and-read worked, continuous sync between two connected clients did not.

  Change detection is now by `md5Checksum`, falling back to `modifiedTime`. The ETag
  comparison is gone: it led the chain, so it decided the outcome, and on Drive v3 it
  could only compare `''` against `''`.

- **`createFile` and `updateFile` request `md5Checksum`.** They asked for
  `id,modifiedTime`, so the cached checksum was null after every write and polling
  silently degraded to comparing a timestamp the client had set itself.

### Changed

- **`MetaData` gains `retiredLogIds`** — change logs a compaction has folded into the
  snapshot and deleted. They stop the writer that produced a log from restoring it
  after it is legitimately gone. Capped at 500 entries.

- **Change-log filenames carry a writer id**: `changes-<seq>-<writerId>-<random>.ndjson`,
  previously `changes-<seq>-<random>.ndjson`. Nothing parses these names — this is so
  two writers cannot produce the same one, and so an orphan can be traced to whoever
  wrote it.

- **A writer catches up before it writes.** If the folder holds logs this client has
  not replayed, it loads them first. For the low-level `appendChange()` API this also
  restores conflict detection, which in production had never run — it was reached
  only from a 412 that Drive never returns. `_bulkDocs` is exempt: it resolves
  revisions through pouchdb-merge and expresses a collision as a conflict branch, so
  failing its whole batch would be the wrong answer.

- **Appends cost more Drive calls — 4 became 9.** Reading metadata fresh before
  allocating a sequence range, and reading it back after committing, are what the
  missing compare-and-swap is bought with. Two of the nine are `findFile`'s ETag
  backfill, which can never succeed on Drive v3; removing it takes an append to 7 and
  is the cheapest remaining win.

- **`GoogleDriveClient.createFile` and `.updateFile` return `md5Checksum`.** Additive
  — the returned object gained an optional field.

- **Loads cost one more `files.list`**, to discover change logs. A load happens on
  connect, on a polling tick that sees a change, and on a write that has to catch up
  with another writer.

- **An interrupted write can now become visible.** A change log uploaded by a client
  that died before committing its metadata used to be invisible; it is now found by
  the listing and adopted. Correct for an append-only log, but it is a change in
  which writes survive.

### Compatibility

- **Sequence numbers jump once, harmlessly.** A folder sitting at `seq: 23` yields a
  next sequence number of about a million — above everything already in the index and
  above any checkpoint a replication target holds. Nothing re-replicates, nothing is
  skipped.
- **No migration.** `retiredLogIds` is optional and absent metadata reads as an empty
  list. Existing folders work untouched.
- **A 0.1.5 client can still orphan a 0.1.6 client's logs**, because the bug is in the
  writer, not the format. A 0.1.6 client restores its own logs on its next load or
  commit, so the damage is repaired rather than prevented. Upgrade every writer.
- **A 0.1.5 client preserves `retiredLogIds`** as it passes through — it copies the
  metadata it downloaded rather than rebuilding it — so a mixed fleet will not strip
  the tombstones.

### Known limitations

- **Slot collisions are detected and dodged, not impossible.** A writer that sees a
  rival id hashing to its own slot in the folder listing re-rolls to a free slot
  before minting anything. What remains is the window before the rival's first log
  appears in a listing, combined with the 1-in-a-million hash collision itself.
- **A change that lands below a target's checkpoint is still skipped.** Uniqueness
  stops two documents sharing a number; it does not stop a writer committing a tick it
  allocated before the target checkpointed past it. That needs a serialization point,
  which Drive does not offer.
- Concurrent writes to the *same document* resolve last-writer-wins in the index
  rather than through pouchdb-merge. Both revisions are on Drive; the losing one does
  not surface as a conflict branch.
- Two clients that each create a folder by `folderName` get two databases. Duplicate
  folders are not reconciled, only duplicate `_meta.json` files within one.

### Tests

- `tests/meta_concurrency.test.ts` — eight cases against a fake Drive that behaves
  like the real one: never returns an ETag, never honours one. This is the clean
  reproduction the 0.1.5 report asked for, and it needs neither a Drive account nor
  the client-side id fix first.
- `tests/writer_stress.test.ts` — three writers, eight rounds, jittered latency, and
  a writer that vanishes mid-write. The invariant is the load-bearing one: *an append
  whose promise resolved must be readable by whoever comes next.* This is what caught
  the defect ADR-0002 fixes.
- `tests/simultaneous_writers.test.ts` — overlapping appends, as opposed to the
  stale-writer shape the other suites cover.
- `tests/polling.test.ts` — five cases, `pollingIntervalMs`'s first tests.
- `tests/fake-drive.ts` — the shared fake: real md5 hashing, latency jitter, a
  `sever()` for simulating a context that goes away, and a `diagnose()` that tells an
  orphaned log apart from a dangling reference.

---

## 0.1.5 and earlier

Not recorded. See `git log`.
