# Finding — concurrent writers orphan each other's change logs

**Status: fixed upstream in `@docstack/pouchdb-adapter-googledrive@0.1.6`**, on the same
day it was reported. Kept as the record, with the correction below — **the fix suggested
here could not have worked**, and the reason is worth more than the finding was.

**Originally for dispatch to the `docstack-pouchdb-adapter-gdrive` repository.** Found in
Tokido on 2026-08-27 against `@docstack/pouchdb-adapter-googledrive@0.1.5` and
`@docstack/client@0.1.6`, running two browser contexts against one Drive folder.

**This is the defect the `paper` project's adapter findings
(`docs/findings/docstack-gdrive-adapter-0.1.5.md` in that repository) recorded as "severity
unclear, needs a reproduction that isolates it".** It is now isolated. Paper could
not separate it from the client's `lastDocId` collision because both were in play; that bug
is fixed, and this one is still here on its own.

**Severity: silent data loss, by construction.** Documents reach Drive, are stored
correctly, and become unreachable to every client including the one that wrote them.

---

## Symptom

A folder written by an automated two-instance run, read back through the Drive API:

```
seq counter in _meta.json:  18
changeLogIds referenced:    14
change files present:       17
```

Three files hold document revisions that nothing references:

```
changes-19-7485opwl-dy7pyd.ndjson   ->  Workspace-0 x4
changes-19-q3xm4ss9-sdn2vu.ndjson   ->  Workspace-0 x4
changes-3-r1ho1oby-zt8fo.ndjson     ->  Workspace-0 x1
```

Note `changes-19-*` **twice, from two different writers**, while `_meta.json` still reports
`seq: 18`. Two clients read the same counter, both derived the same next sequence, and both
appended. The same folder also holds `changes-11-*` three times and `changes-3-*` twice.

Nine document revisions are present in Drive and invisible to every client.

## Mechanism

Each client:

1. reads `_meta.json` and takes `seq`,
2. appends `changes-<seq>-<writerId>-<random>.ndjson`,
3. writes `_meta.json` back **carrying its own `changeLogIds`**.

Step 3 is unconditional. A second client's metadata replaces the first's, and the first's
change log stops being referenced by anything. Readers reconstruct state from
`snapshot-index-*` plus the `changeLogIds` in `_meta.json`, so a log outside that set is
unreachable even though the file is still sitting in the folder.

The random suffix in the filename prevents two clients from *overwriting* one another's log
— which is why this loses references rather than bytes — but it does not stop them
allocating the same sequence number, and the sequence is what the metadata is keyed on.

Compaction has the same exposure: two clients compacting independently each fold their own
view of the log set into a snapshot.

## Why the sample looks harmless and is not

Every orphaned revision here is `Workspace-0`, a seeded descriptor that each client
rebuilds for itself, so this particular run lost nothing a user would notice. **The
mechanism does not discriminate.** Nothing about it is specific to seeded documents; a
`Task` written in the same window is orphaned on the same terms, and the loss is silent in
both directions — the writing client believes it succeeded, and the reading client cannot
know a log it never hears about exists.

## Reproduction

Two browser contexts against one Drive folder, both replicating, is enough. In Tokido:

```
npm run test:e2e
```

then read the run's `tokido-e2e-*-tokido-ws-personal` folder through the Drive API and
compare `_meta.json`'s `changeLogIds` against the `changes-*.ndjson` files present. Any
file not in the set is orphaned. Duplicate sequence numbers in the filenames are the
visible tell and need no API call.

The window is small — both clients have to read `_meta.json` before either writes it — so a
single run may produce none. Three of seventeen logs in one run here.

## Suggested fix — and why it was wrong

This section originally read: *"Make the `_meta.json` write a compare-and-swap. Drive
supports it and the plumbing already exists: `GoogleDriveClient.updateFile` takes
`expectedEtag` and passes it through."*

**Drive API v3 has no ETags.** They were dropped from the API, so `If-Match` was never
sent and would have been ignored if it had been. The plumbing existed and did nothing —
and the adapter's own concurrency tests stayed green because the *emulated* test server
enforces ETags that the real API does not. A suggestion inferred from a parameter name,
against a service whose documentation says otherwise.

The upstream fix is better than compare-and-swap and does not need it: **the folder is the
index.** Change logs are found by listing the folder rather than only by reading
`changeLogIds`, so a file's existence is the durable record that it exists and the metadata
is a cache of that. A lost metadata update then costs nothing, because there is nothing
that only the metadata knew.

Two of the smaller suggestions did land, as supporting changes rather than the fix:
metadata writes now merge instead of replacing and read back to confirm, and change-log
filenames carry a writer id (`changes-<seq>-<writerId>-<random>.ndjson`) so two writers
cannot produce the same name and an orphan can be traced to whoever wrote it.

Upstream reproduced it as acknowledged writes going missing in roughly one stress run in
five, and the release fixes several adjacent defects the same reproduction exposed —
including `pollingIntervalMs` having done nothing since April, which meant continuous sync
between two connected clients never worked at all.

## Still open after 0.1.6 — sequence numbers still collide

Verified against `0.1.6` on 2026-08-27, same suite, fresh folder. **The data-loss half is
fixed**: unreferenced change logs still occur (2 of 14) and no longer matter, because logs
are found by listing the folder. Nothing is unreachable.

The sequence collision is not fixed. Three sequences were minted twice, each by a *different*
writer, and the entries inside overlap:

```
seq  3:  owllxyrw                     icnhty8c
seq  9:  owllxyrw -> seqs[9,10,11]    5emlcj01 -> seqs[9,10]
seq 14:  5emlcj01 -> seqs[14,15,16]   3xwcumbi -> seqs[14,15]
```

0.1.6 says sequence numbers are "allocated from Drive at write time, not from a counter
refreshed only on load", and names the consequence itself: *"`_changes` filters on
`seq > since`, so a second document sharing a checkpointed sequence number is never emitted
again."* A reader checkpointed past 9 never sees the second writer's seq-9 document.

Every colliding document is `Workspace-0` — the descriptor each client writes when its
database mounts, which is exactly why it is the one that collides, and also why nothing was
lost here: every client rebuilds it. The mechanism does not discriminate.

Whether allocation at write time can close this without a lock, or whether the residual is
considered acceptable now that a lost reference costs nothing, is upstream's call. This is
the evidence, not a verdict.

## What this does not cover

Whether a reader recovers if an orphaned log is later re-referenced, and whether compaction
can be made safe under concurrent writers, are separate questions. This finding is only
about the reference being lost.
