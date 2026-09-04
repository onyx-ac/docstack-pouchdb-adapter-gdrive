# Finding — one missing change log stops every future write, for ever

**For dispatch to the `docstack-pouchdb-adapter-gdrive` repository.** Found in a consumer
whose workspace folder replicated normally for weeks, then stopped writing on
2026-08-30 14:44 and never wrote again — while the same client's other folder, over the
same connection and the same token, continued normally.

**A single unreadable change log referenced by the metadata converts one lost change into
a permanent, silent write outage.** The symptom is not an error: replication reports
`active`, converges on schedule, and sends nothing.

---

## The evidence

A Drive request failing constantly, always the same file:

```
404  https://www.googleapis.com/drive/v3/files/1uI0uvtHUQkruc_zG7yZqpNZPEkqOgiPN?alt=media
```

That id is **position 68 of 69 in `_meta.json`'s `changeLogIds`** — the newest *active*
log. It is not in `retiredLogIds`, so this is not a compaction race, where a reader can
briefly ask for a file a compaction has just removed. It is referenced as live, and it does
not exist. It can only 404, on every load, for ever.

The consumer's replication status, three minutes apart:

```
tokido:             idle   · sent 1, received 0 · up to date 16:24:39 → 16:27:17
tokido-ws-personal: active · sent 0, received 0 · up to date 16:24:33 → 16:26:55
```

Converging, and sending nothing.

## How it happens, and how it stays

**The dangling reference** is `0.1.8`'s own fixed defect, from the other side: *"a
connectivity blip on the read that verifies a metadata commit… made the writer treat it as
unpublished and clean up a log the metadata referenced — a dangling reference, and the
document behind it gone despite a successful write."* The commit landed; the log was
deleted; `changeLogIds` still names it.

**What makes it permanent** is a separate, still-current behaviour. `load()` tolerates a
failed download, correctly:

```ts
} catch (e) {
    this.log(`Failed to download change log ${id}`, e);
    return { id, changes: null };          // skipped, and the bar still reaches total
}
```

But a skipped log never enters `processedLogIds`, so:

```ts
private hasUnprocessedLogs(meta: MetaData): boolean {
    if (meta.snapshotIndexId !== this.currentSnapshotIndexId) return true;
    return meta.changeLogIds.some(id => !this.processedLogIds.has(id));   // for ever true
}
```

And every write consults it:

```ts
if (current && this.hasUnprocessedLogs(current.meta)) {
    if (++catchUps > META_COMMIT_RETRIES) {
        throw new Error('Could not catch up with concurrent writers');
    }
    await this.load();                     // 404s again
    continue;
}
```

So each `_bulkDocs` spends its whole catch-up budget re-reading a file that cannot be read,
then throws. **The read path tolerates the missing log and the write path cannot**, and the
disagreement is the outage.

It is invisible because every layer above reports something true about the wrong thing:
PouchDB retries a rejected write rather than surfacing it, so the state stays `active`; the
pull direction is unaffected, so `lastConvergedAt` keeps advancing; and the error the
writer throws names concurrent writers, which is not what is happening.

## Suggested fix

**A log that is definitively gone is processed.** A 404 is not a transient failure and
should not be retried like one:

```ts
} catch (e: any) {
    this.log(`Failed to download change log ${id}`, e);
    // A 404 is an answer, not an outage: the file is gone and no retry will bring it
    // back. Recording it as processed costs the changes it held — which are already
    // lost — and keeps that loss from also stopping every future write.
    if (e?.status === 404) this.processedLogIds.add(id);
    return { id, changes: null };
}
```

Two things worth having with it:

1. **Prune the id from `changeLogIds`** on the next metadata commit, so a folder repairs
   itself rather than carrying a permanent 404 and a permanent log line. The writer already
   rewrites that array; dropping an id it has proven absent is one more line.
2. **Distinguish the two failures in the thrown error.** "Could not catch up with
   concurrent writers" sent this investigation looking for a second writer for some time.
   Where the catch-up budget is exhausted with no *readable* new logs, the honest message
   names the unreadable ones.

A transient failure keeps today's behaviour, and should: retrying is right when the file is
there and the network was not.

## Severity

A folder in this state accepts no writes from any device, indefinitely, and says nothing.
The consumer lost two days of work from one device before noticing, and noticed only
because a document created on one device never appeared on another. The repair is a
one-line edit to `_meta.json` — remove the dangling id — which is not something a user can
be asked to do.
