import { GoogleDriveAdapterOptions, ChangeEntry, FilePointer, IndexEntry } from './types';
import { DriveHandler } from './drive';
import { parseDoc } from 'pouchdb-adapter-utils';
import { merge, winningRev, isDeleted as isRevDeleted, revExists, collectConflicts, collectLeaves } from 'pouchdb-merge';

/**
 * Schedule a function to run asynchronously.
 */
function nextTick(fn: () => void): void {
    if (typeof fn === 'function') {
        queueMicrotask(fn);
    }
}

/** Substituted by DriveHandler.updateIndex() once the batch's change-log file
 *  actually has an id - lets adapter.ts build a complete IndexEntry (including
 *  pointers at revisions being written in *this* batch) before that file exists. */
const SELF_FILE = '__SELF__';

/** True when a newEdits write's parent rev isn't actually present in the tree
 *  (the caller claimed a rev that doesn't exist) - same check, same name,
 *  `pouchdb-adapter-native` uses (traced from pouchdb-adapter-utils's processDocs.js). */
function rootIsMissing(docInfo: any): boolean {
    return docInfo.metadata.rev_tree[0].ids[1].status === 'missing';
}

/**
 * Builds a change's `changes` array.
 *
 * `style: 'all_docs'` - which is what `pouchdb-replication` asks for, and its default -
 * means "list every leaf of the revision tree, not just the winner". Reporting only the
 * winner hides conflict leaves from the changes feed, so they are never fetched, never
 * pushed, and the two replicas quietly disagree about which revisions exist. The winner
 * goes first, as CouchDB orders it.
 *
 * @param entry - The index entry for the document, carrying the serialized rev tree.
 * @param style - The `style` the caller asked for; anything but `'all_docs'` yields the
 * winning revision alone.
 * @returns The `changes` array for the changes feed.
 */
function buildChangesList(entry: IndexEntry, style?: string): { rev: string }[] {
    const winner = [{ rev: entry.rev }];
    if (style !== 'all_docs') return winner;

    try {
        const leaves = collectLeaves(JSON.parse(entry.tree));
        if (!leaves || !leaves.length) return winner;
        const others = leaves
            .map(leaf => leaf.rev)
            .filter(rev => rev !== entry.rev)
            .map(rev => ({ rev }));
        return [...winner, ...others];
    } catch (e) {
        // A tree that will not parse is a bigger problem than a missing conflict leaf;
        // fall back to the winner rather than breaking the feed.
        return winner;
    }
}

/** Combined options type for PouchDB adapter */
interface AdapterOptions extends GoogleDriveAdapterOptions {
    name: string;
}

/** Callback type for adapter initialization */
type AdapterCallback = (err: Error | null, api?: any) => void;


/**
 * TODO: Implement dynamic method signature, since PouchDB CRUD methods can be called as promise, callback or (?)
 */

/**
 * GoogleDriveAdapter - PouchDB adapter for Google Drive storage.
 * Updated for Lazy Loading (Async Access).
 */
export function GoogleDriveAdapter(PouchDB: any) {

    function GoogleDrivePouch(this: any, opts: AdapterOptions, callback: AdapterCallback) {
        const api = this;
        const name = opts.name;

        // Clone options to avoid mutation
        const adapterOpts = Object.assign({}, opts);

        // Internal state
        let instanceId: string;
        let db: DriveHandler;

        // Initialize DriveHandler
        console.log('Initializing DriveHandler with options:', adapterOpts);
        db = new DriveHandler(adapterOpts, name);

        // Initialize instanceId synchronously to avoid race conditions during replication setup
        instanceId = 'gdrive-' + name + '-' + Date.now().toString(36);

        // Polyfill activeTasks to ensure replication works even if PouchDB core doesn't attach it
        if (!api.activeTasks) {
            class ActiveTasks {
                _tasks: Record<string, any> = {};

                add(task: any) {
                    const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
                    this._tasks[id] = task;
                    this._tasks[id].created_at = new Date().toISOString();
                    this._tasks[id].updated_at = new Date().toISOString();
                    return id;
                }

                remove(id: string, err: any) {
                    delete this._tasks[id];
                }

                update(id: string, update: any) {
                    if (this._tasks[id]) {
                        Object.assign(this._tasks[id], update);
                        this._tasks[id].updated_at = new Date().toISOString();
                    }
                }

                get(id: string) {
                    return this._tasks[id];
                }

                list() {
                    return Object.values(this._tasks);
                }
            }

            // @ts-ignore
            api.activeTasks = new ActiveTasks();
        }



        // Wrap callback to ensure it's only called once
        let callbackCalled = false;
        const onceCallback: AdapterCallback = (err, api) => {
            if (callbackCalled) return;
            callbackCalled = true;
            callback(err, api);
        };

        const debug = adapterOpts.debug;
        const log = (...args: any[]) => { if (debug) console.log(`[googledrive-adapter] [${name}]`, ...args); };

        log('Initializing with options:', {
            folderId: adapterOpts.folderId,
            folderName: adapterOpts.folderName,
            pollingIntervalMs: adapterOpts.pollingIntervalMs,
            debug: adapterOpts.debug
        });

        // Load data from Drive and initialize
        db.load().then(() => {
            log('Database loaded');
            afterDBCreated();
        }).catch((err: Error) => {
            log('Load error', err);
            onceCallback(err);
        });

        // After database is initialized
        function afterDBCreated() {
            nextTick(function () {
                onceCallback(null, api);
            });
        }

        // ============ PouchDB Adapter API Methods ============

        api._remote = false;

        api.type = function (): string {
            return 'googledrive';
        };

        api._id = function (callback: (err: null, id: string) => void): void {
            callback(null, instanceId);
        };

        // Info now must be async-ish (calculated from Index)
        api._info = function (callback: any): Promise<any> | void {
            // Need to handle promise if it returns one
            const promise = Promise.resolve().then(async () => {
                const keys = await db.getIndexKeys();
                const docCount = keys.length; // Approximate (doesn't account for deleted unless filtered)

                // Filter deleted for accurate count
                let alive = 0;
                for (const k of keys) {
                    const entry = db.getIndexEntry(k);
                    if (entry && !entry.deleted) alive++;
                }

                return {
                    db_name: name,
                    doc_count: alive,
                    update_seq: db.seq,
                    backend_adapter: 'googledrive'
                };
            });

            if (callback) {
                promise.then(res => callback(null, res)).catch(err => callback(err));
            } else {
                return promise;
            }
        };

        api.info = api._info;

        // Get a single document by ID (Async fetch)
        api._get = function (id: string, opts: any, callback: any): Promise<any> | void {
            if (typeof opts === 'function') {
                callback = opts;
                opts = {};
            }

            // Ensure opts is always an object
            if (!opts || typeof opts !== 'object') {
                opts = {};
            }

            // PouchDB sometimes asks for metadata only (revs, revs_info)
            log('_get id:', id, 'opts:', JSON.stringify(opts));

            // A specific non-winning rev was requested (e.g. to inspect a conflict
            // via db.get(id, {rev, conflicts: true})'s follow-up fetch) - look it up
            // among known conflict locations instead of always returning the current
            // winner. The common case (no rev, or rev === the winner) is unaffected.
            // api.get = api._get below means this replaces the whole public `get()`
            // method (same "no _-prefixed hook, override the public method instead"
            // situation @docstack/pouchdb-adapter-native's own revsDiff/bulkGet ran
            // into) - AbstractPouchDB.prototype.get's own opts.conflicts handling
            // (pouchdbMerge.collectConflicts(metadata)) is bypassed entirely, so it
            // has to be done here instead.
            const entry = db.getIndexEntry(id);

            const fetchPromise: Promise<any> = (async () => {
                if (opts.rev && entry && entry.rev !== opts.rev) {
                    const loc = entry.conflictLocations && entry.conflictLocations[opts.rev];
                    return loc ? db.getRevisionBody(id, opts.rev, loc) : null;
                }
                return db.get(id);
            })();

            const promise = fetchPromise.then(doc => {
                if (!doc) {
                    log('_get missing', id);
                    const err = {
                        status: 404,
                        error: true,
                        name: 'not_found',
                        message: 'missing'
                    };
                    if (callback) callback(err);
                    throw err;
                }

                // Support open_revs for bulkGet shim compatibility
                if (opts.open_revs) {
                    log('_get handling open_revs for:', id);
                    // We currently only store the winning revision.
                    // If open_revs='all' or includes our rev, return it.
                    // TODO: Robust conflict support would check exact rev matching.
                    const result = [{ ok: doc }];
                    if (callback) callback(null, result);
                    return result;
                }

                if (opts.conflicts && entry) {
                    const conflicts = collectConflicts({ rev_tree: JSON.parse(entry.tree) });
                    if (conflicts.length) doc._conflicts = conflicts;
                }

                log('_get returning standard doc for:', id);
                // If only rev was requested? (Internal optimization)
                // PouchDB core handles this if we return the full doc.
                const response = doc;
                if (callback) callback(null, response);
                return response;
            }).catch(e => {
                log('_get error', e);
                if (callback) callback(e);
                throw e;
            });

            return promise;
        };

        api.get = api._get;

        // Get all documents (Lazy stream or fetch)
        api._allDocs = function (opts: any, callback: any): Promise<any> | void {
            if (typeof opts === 'function') {
                callback = opts;
                opts = {};
            }

            // Ensure opts is always an object
            if (!opts || typeof opts !== 'object') {
                opts = {};
            }

            const promise = (async () => {
                // _local/* docs live in a separate namespace and never appear in allDocs,
                // same as CouchDB - they aren't part of the B-tree of regular documents.
                const indexKeys = (await db.getIndexKeys()).filter(k => !k.startsWith('_local/'));

                // total_rows reflects live (non-deleted) documents, matching db.info().doc_count -
                // deleted entries stay in the index forever but were never meant to count here.
                let total = 0;
                for (const k of indexKeys) {
                    const entry = db.getIndexEntry(k);
                    if (entry && !entry.deleted) total++;
                }

                const startIndex = opts.skip || 0;

                let candidateKeys: string[];
                if (opts.keys) {
                    // Explicit keys: return exactly these, in the given order. Deleted docs are
                    // included here (flagged via value.deleted), not treated as errors - only
                    // keys absent from the index entirely are 'not_found'.
                    candidateKeys = opts.keys;
                } else {
                    // Default listing: deleted docs never appear, same as a real CouchDB/PouchDB
                    // allDocs() with no keys specified.
                    candidateKeys = indexKeys.filter(k => {
                        const entry = db.getIndexEntry(k);
                        return entry && !entry.deleted;
                    });
                    if (opts.startkey) candidateKeys = candidateKeys.filter(k => k >= opts.startkey);
                    if (opts.endkey) candidateKeys = candidateKeys.filter(k => k <= opts.endkey);
                    if (opts.key) candidateKeys = candidateKeys.filter(k => k === opts.key);
                    candidateKeys.sort();
                    if (opts.descending) candidateKeys.reverse();
                }

                const limit = typeof opts.limit === 'number' ? opts.limit : candidateKeys.length;
                const sliced = opts.keys ? candidateKeys : candidateKeys.slice(startIndex, startIndex + limit);

                const docs = opts.include_docs ? await db.getMulti(sliced) : null;

                const rows = sliced.map((id, i) => {
                    const entry = db.getIndexEntry(id);

                    if (!entry) return { key: id, error: 'not_found' };

                    if (entry.deleted) {
                        const row: any = { id, key: id, value: { rev: entry.rev, deleted: true } };
                        if (opts.include_docs) row.doc = null;
                        return row;
                    }

                    const row: any = { id, key: id, value: { rev: entry.rev } };
                    if (opts.include_docs) {
                        const doc = docs![i];
                        if (!doc) return { key: id, error: 'not_found' };
                        row.doc = doc;
                    }
                    return row;
                });

                const result: any = {
                    total_rows: total,
                    offset: startIndex,
                    rows
                };
                if (opts.update_seq) result.update_seq = db.seq;
                return result;
            })();

            if (callback) {
                promise.then(res => callback(null, res)).catch(err => callback(err));
            } else {
                return promise;
            }
        };

        api.allDocs = api._allDocs;

        // Bulk Get optimization for Replication
        api._bulkGet = function (opts: any, callback?: any): Promise<any> {
            const docs = opts.docs;
            const ids = docs.map((d: any) => d.id);

            return db.getMulti(ids).then(async results => {
                const rows = await Promise.all(ids.map(async (id: string, i: number) => {
                    let doc = results[i];
                    const requestedRev = docs[i].rev;
                    const entry = db.getIndexEntry(id);

                    // Winning body didn't match the specific rev requested - it may
                    // still be a known conflict leaf, not necessarily missing.
                    if (requestedRev && (!doc || doc._rev !== requestedRev) && entry) {
                        const loc = entry.conflictLocations && entry.conflictLocations[requestedRev];
                        if (loc) doc = await db.getRevisionBody(id, requestedRev, loc);
                    }

                    let docResult: any;
                    if (!doc || (requestedRev && doc._rev !== requestedRev)) {
                        docResult = {
                            error: {
                                status: 404,
                                error: true,
                                name: 'not_found',
                                message: 'missing'
                            }
                        };
                    } else {
                        docResult = { ok: doc };
                    }

                    return { id, docs: [docResult] };
                }));

                const response = { results: rows };
                if (callback) callback(null, response);
                return response;
            }).catch((err: any) => {
                if (callback) callback(err);
                throw err;
            });
        };

        api.bulkGet = api._bulkGet;


        // Bulk document operations. Merges every write into a real pouchdb-merge
        // rev tree (mirroring @docstack/pouchdb-adapter-native's own, already-proven
        // _bulkDocs, traced from pouchdb-adapter-utils's processDocs.js/updateDoc.js)
        // instead of blindly overwriting the index - the previous version had no
        // conflict detection at all on the new_edits:false (replication) path, so
        // two peers syncing a concurrent edit through this adapter would each just
        // keep whichever write landed last, silently disagreeing with each other.
        api._bulkDocs = function (req: any, opts: any, callback: any): Promise<any> | void {
            // `api.bulkDocs = api._bulkDocs` below means callers reach this directly and
            // AbstractPouchDB.prototype.bulkDocs never runs, so its two normalizations
            // have to happen here instead.
            //
            // First, the request shape: `db.bulkDocs([doc])` is the common call style and
            // core turns the array into an envelope before any adapter sees it.
            if (Array.isArray(req)) req = { docs: req };

            // Second, `new_edits`, which arrives on either side. `pouchdb-replication`
            // puts it on `req` (the CouchDB _bulk_docs body shape); `bulkDocs(docs,
            // { new_edits: false })` and `put(doc, { new_edits: false })` - which core
            // routes through `bulkDocs` - put it on `opts`. Core consults `opts` first and
            // falls back to `req`; reading only one side silently mints fresh revisions
            // for writes that were meant to land verbatim.
            const newEdits = (opts && typeof opts === 'object' && 'new_edits' in opts)
                ? opts.new_edits !== false
                : req.new_edits !== false;

            const docs = req.docs;
            const results: any[] = new Array(docs.length);
            const revsLimit = (adapterOpts as any).revs_limit || 1000;
            const changes: ChangeEntry[] = [];

            for (let i = 0; i < docs.length; i++) {
                const doc = docs[i];
                const id = doc._id;
                const entry = db.getIndexEntry(id);

                const docInfo: any = parseDoc(Object.assign({}, doc), newEdits);
                if (!docInfo || !docInfo.metadata) {
                    results[i] = Object.assign({ id }, docInfo);
                    continue;
                }

                let mergedTree: any;
                let stemmedRevs: string[];
                let winning: string;
                let winningDeleted: boolean;
                let selfIsWinner: boolean;
                let incomingRev: string;
                let savedDocInfo = docInfo;
                const conflictLocations: Record<string, FilePointer> = {};

                if (!entry) {
                    // Brand new doc.
                    if (newEdits && rootIsMissing(docInfo)) {
                        results[i] = { ok: false, id, error: 'conflict', reason: 'Document update conflict' };
                        continue;
                    }
                    const merged = merge([], docInfo.metadata.rev_tree[0], revsLimit);
                    mergedTree = merged.tree;
                    stemmedRevs = merged.stemmedRevs;
                    winning = winningRev({ rev_tree: mergedTree });
                    winningDeleted = isRevDeleted({ rev_tree: mergedTree }, winning);
                    incomingRev = docInfo.metadata.rev!;
                    selfIsWinner = true; // an empty starting tree can only ever produce one leaf
                } else {
                    const existingTree = JSON.parse(entry.tree);
                    if (revExists(existingTree, docInfo.metadata.rev!) && !newEdits) {
                        // Replication redelivering a rev we already have - a no-op.
                        results[i] = { ok: true, id, rev: docInfo.metadata.rev };
                        continue;
                    }

                    const previousWinningRev = entry.rev;
                    const previouslyDeleted = !!entry.deleted;
                    let deleted = docInfo.metadata.deleted !== undefined ? docInfo.metadata.deleted : false;
                    const isRoot = /^1-/.test(docInfo.metadata.rev!);

                    // Undeleting via a fresh newEdits put re-parents onto the tombstone
                    // rev instead of conflicting (CouchDB "resurrection").
                    if (previouslyDeleted && !deleted && newEdits && isRoot) {
                        const resurrected = Object.assign({}, docInfo.data, { _id: id, _rev: previousWinningRev });
                        const reparsed: any = parseDoc(resurrected, newEdits);
                        if (!reparsed || !reparsed.metadata) {
                            results[i] = Object.assign({ id }, reparsed);
                            continue;
                        }
                        savedDocInfo = reparsed;
                        deleted = savedDocInfo.metadata.deleted !== undefined ? savedDocInfo.metadata.deleted : false;
                    }

                    const merged = merge(existingTree, savedDocInfo.metadata.rev_tree[0], revsLimit);
                    const inConflict =
                        newEdits &&
                        ((previouslyDeleted && deleted && merged.conflicts !== 'new_leaf') ||
                            (!previouslyDeleted && merged.conflicts !== 'new_leaf') ||
                            (previouslyDeleted && !deleted && merged.conflicts === 'new_branch'));
                    if (inConflict) {
                        results[i] = { ok: false, id, error: 'conflict', reason: 'Document update conflict' };
                        continue;
                    }

                    mergedTree = merged.tree;
                    stemmedRevs = merged.stemmedRevs;
                    winning = winningRev({ rev_tree: mergedTree });
                    winningDeleted = isRevDeleted({ rev_tree: mergedTree }, winning);
                    incomingRev = savedDocInfo.metadata.rev!;
                    selfIsWinner = incomingRev === winning;

                    // Carry forward existing conflicts, minus anything just stemmed
                    // past revs_limit (pouchdb-adapter-native's own stemBodies
                    // handles the equivalent body cleanup for its own storage;
                    // compact() here does the same, see drive.ts).
                    if (entry.conflictLocations) {
                        for (const rev of Object.keys(entry.conflictLocations)) {
                            if (!stemmedRevs.includes(rev)) conflictLocations[rev] = entry.conflictLocations[rev];
                        }
                    }
                    if (selfIsWinner) {
                        // The old winner becomes a conflict leaf, unless it just got stemmed.
                        if (previousWinningRev !== winning && !stemmedRevs.includes(previousWinningRev)) {
                            conflictLocations[previousWinningRev] = entry.location;
                        }
                    } else if (!stemmedRevs.includes(incomingRev)) {
                        conflictLocations[incomingRev] = { fileId: SELF_FILE };
                    }
                }

                const seq = db.getNextSeq() + changes.length;
                const savedDoc = Object.assign({}, savedDocInfo.data, { _id: id, _rev: incomingRev });

                const nextIndexEntry: Omit<IndexEntry, 'seq'> = {
                    tree: JSON.stringify(mergedTree),
                    rev: winning,
                    deleted: winningDeleted,
                    location: selfIsWinner ? { fileId: SELF_FILE } : entry!.location,
                };
                if (Object.keys(conflictLocations).length > 0) {
                    nextIndexEntry.conflictLocations = conflictLocations;
                }

                changes.push({
                    seq,
                    id,
                    rev: incomingRev,
                    deleted: savedDocInfo.metadata.deleted,
                    doc: savedDoc,
                    timestamp: Date.now(),
                    nextIndexEntry,
                });

                results[i] = { ok: true, id, rev: incomingRev };
            }

            log('_bulkDocs flushing', changes.length, 'changes');
            // Append changes to log
            const promise = db.appendChanges(changes).then(() => {
                if (callback) nextTick(() => callback(null, results));
                return results;
            }).catch((err: Error) => {
                log('_bulkDocs error', err);
                if (callback) callback(err);
                throw err;
            });

            return promise;
        };

        api.bulkDocs = api._bulkDocs;

        // Changes feed
        api._changes = function (opts: any): { cancel: () => void } {
            opts = Object.assign({}, opts);

            const since = opts.since || 0;
            const limit = typeof opts.limit === 'number' ? opts.limit : Infinity;
            const returnDocs = opts.return_docs !== false;
            const results: any[] = [];
            let lastSeq = since;
            let complete = false;

            // Setup live listener FIRST (before emitting changes)
            let cancelLive: (() => void) | undefined;
            let liveListener: (changedDocs: Record<string, any>) => void;

            if (opts.live) {
                log('_changes setting up live listener');
                liveListener = (changedDocs: Record<string, any>) => {
                    if (complete) return;

                    // Gate the whole batch against where the feed stood BEFORE it,
                    // then emit in seq order and advance once at the end. The old
                    // shape - unordered iteration, lastSeq bumped per emission - is
                    // the initial pass's bug in another spot (its own comment: "an
                    // unordered batch can checkpoint past a change it never
                    // emitted"): a higher-seq doc processed first raised the bar,
                    // and a lower-seq sibling in the same batch failed `> lastSeq`
                    // and was never delivered, while the checkpoint moved past it.
                    const gate = lastSeq;
                    const batch = Object.keys(changedDocs)
                        .filter(id => !id.startsWith('_local/'))
                        .map(id => ({ id, entry: db.getIndexEntry(id) }))
                        .filter((row): row is { id: string; entry: NonNullable<ReturnType<typeof db.getIndexEntry>> } =>
                            Boolean(row.entry) && row.entry!.seq > gate)
                        .sort((a, b) => a.entry.seq - b.entry.seq);
                    if (batch.length === 0) return;

                    const emit = (bodies: Record<string, any> | null) => {
                        for (let i = 0; i < batch.length; i++) {
                            const { id, entry } = batch[i];
                            const change: any = {
                                id,
                                seq: entry.seq,
                                changes: buildChangesList(entry, opts.style)
                            };
                            // Same tombstone rule as the initial pass: a `null` body
                            // makes a filtered replication drop the deletion.
                            if (bodies) change.doc = bodies[id];
                            lastSeq = Math.max(lastSeq, entry.seq);
                            // Same progress contract as the initial pass; for a live
                            // batch the horizon is the batch itself.
                            if (opts.onChange) opts.onChange(change, batch.length - (i + 1), lastSeq);
                        }
                    };

                    if (opts.include_docs) {
                        // Bodies for the whole batch first, then emit in order -
                        // per-row fetches resolved in whatever order the network
                        // chose, which reordered emissions and raced the gate.
                        loadChangeBodies(batch).then(emit)
                            .catch(e => log('Live change body fetch error', e));
                    } else {
                        emit(null);
                    }
                };
                cancelLive = db.onChange(liveListener);
            }

            /**
             * Fetches the document bodies for a whole batch in one pass.
             *
             * `getMulti` groups ids by the file that holds them, so a batch drawn from a
             * single change-log file costs one download rather than one per document -
             * which is what a serial `get()` per change was costing. This path is only
             * ever taken because something asked for `include_docs`, and the one thing
             * that always asks is a filtered replication: `pouchdb-replication` forces
             * `include_docs: true` so it can run its filter over `change.doc`.
             *
             * Deleted documents have no body to fetch, and a `null` there is not
             * harmless: `pouchdb-replication`'s `filterChange` substitutes `{}` for a
             * missing `change.doc`, and a filter given `{}` has no id to judge, so it
             * drops the change. A filtered replication would then never propagate a
             * deletion. Emit the tombstone the rest of PouchDB expects instead.
             */
            async function loadChangeBodies(
                batch: { id: string; entry: IndexEntry }[]
            ): Promise<Record<string, any>> {
                const bodies: Record<string, any> = {};
                if (!batch.length) return bodies;

                const tombstone = (row: { id: string; entry: IndexEntry }) => ({
                    _id: row.id,
                    _rev: row.entry.rev,
                    _deleted: true
                });

                const live = batch.filter(row => !row.entry.deleted);
                for (const row of batch) {
                    if (row.entry.deleted) bodies[row.id] = tombstone(row);
                }

                if (!live.length) return bodies;

                try {
                    const docs = await db.getMulti(live.map(row => row.id));
                    live.forEach((row, index) => {
                        bodies[row.id] = docs[index] || tombstone(row);
                    });
                } catch (e) {
                    log('_changes include_docs error', e);
                    for (const row of live) bodies[row.id] = tombstone(row);
                }

                return bodies;
            }

            // Process initial changes
            async function processChangesAsync() {
                log('_changes processing since', since, 'limit', limit, 'live', !!opts.live);
                const keys = await db.getIndexKeys();

                // The index is a plain object keyed by document id, so iterating it
                // yields insertion order, not sequence order. Replication checkpoints on
                // the highest seq in each batch and `limit` makes every batch a partial
                // one, so an unordered batch can checkpoint past a change it never
                // emitted - and that change is then never replicated again. Order by seq
                // before the batch is cut.
                const pending = keys
                    .filter((id: string) => !id.startsWith('_local/'))
                    .map((id: string) => ({ id, entry: db.getIndexEntry(id) }))
                    .filter((row): row is { id: string; entry: IndexEntry } =>
                        Boolean(row.entry) && row.entry!.seq > since)
                    .sort((a, b) => a.entry.seq - b.entry.seq);

                // `descending` reverses the order the changes come back in. Its `since`
                // semantics are CouchDB's (walk down from the given seq) and are not
                // implemented here; replication never asks for it.
                if (opts.descending) pending.reverse();

                // Cut the batch before fetching anything: `include_docs` costs a download
                // per *file*, and there is no reason to pay it for changes beyond `limit`.
                const batch = pending.slice(0, limit);
                const bodies = opts.include_docs
                    ? await loadChangeBodies(batch)
                    : null;

                for (let i = 0; i < batch.length; i++) {
                    if (complete) break;
                    const { id, entry } = batch[i];

                    const change: any = {
                        id: id,
                        seq: entry.seq,
                        changes: buildChangesList(entry, opts.style)
                    };

                    if (bodies) change.doc = bodies[id];

                    lastSeq = Math.max(lastSeq, entry.seq);

                    // The second and third arguments are how progress actually
                    // reaches a consumer: pouchdb-replication reads `pending` from
                    // onChange's arguments (never from the complete response) and
                    // surfaces it on its own 'change' events. `pending` here is
                    // CouchDB's meaning - eligible changes remaining AFTER this row,
                    // both the rest of this batch and everything beyond the limit.
                    if (opts.onChange) opts.onChange(change, pending.length - (i + 1), lastSeq);
                    if (returnDocs) results.push(change);
                }

                // ✅ Call opts.complete() ONLY for non-live modes
                // PouchDB replication will infinite-loop reconnect if we call complete() on a live feed
                if (opts.complete && !complete && !opts.live) {
                    // `pending` is what CouchDB reports and what PouchDB's whole
                    // progress pipeline runs on: replication surfaces it on 'change'
                    // events and in activeTasks' total_items. The number was already
                    // computed to cut the batch; consumers turn it into a progress
                    // bar as docs_written / (docs_written + pending). It is also the
                    // only percentage source left standing - update_seq arithmetic
                    // stopped meaning anything when sequence numbers went sparse
                    // (ADR-0003).
                    const remaining = Math.max(0, pending.length - batch.length);
                    log('_changes calling complete callback with', { results_count: results.length, last_seq: lastSeq, pending: remaining });
                    opts.complete(null, { results, last_seq: lastSeq, pending: remaining });
                }
            }

            // Start processing (async) which will wait for load() via getIndexKeys()
            processChangesAsync().catch(err => {
                log('_changes error', err);
                complete = true;
                if (opts.complete) opts.complete(err);
            });

            return {
                cancel(): void {
                    log('_changes cancel');
                    complete = true;
                    if (cancelLive) cancelLive();
                }
            };
        };


        // Manual compaction trigger
        api._compact = function (opts: any, callback: any): Promise<any> | void {
            if (typeof opts === 'function') {
                callback = opts;
                opts = {};
            }
            const promise = db.compact().then(() => {
                const result = { ok: true };
                if (callback) callback(null, result);
                return result;
            }).catch((err: Error) => {
                if (callback) callback(err);
                throw err;
            });
            return promise;
        };

        api._getRevisionTree = function (docId: string, callback: any): void {
            const entry = db.getIndexEntry(docId);
            if (!entry) {
                return callback({ status: 404, error: true, name: 'not_found', message: 'missing' });
            }
            // The real tree, as maintained by _bulkDocs's merge() calls - not a
            // synthesized single-leaf stand-in. This is what makes PouchDB core's
            // default revsDiff (which walks this) actually see conflicting revisions
            // instead of only ever knowing about "whatever's currently winning".
            callback(null, JSON.parse(entry.tree));
        };

        api._close = function (callback: any): Promise<void> | void {
            db.stopPolling();
            if (typeof callback === 'function') {
                nextTick(callback);
            } else {
                return Promise.resolve();
            }
        };

        api.close = api._close;

        api._destroy = function (opts: any, callback: any): Promise<any> | void {
            if (typeof opts === 'function') {
                callback = opts;
                opts = {};
            }
            db.stopPolling();
            if (opts.deleteFolder) {
                return db.deleteFolder().then(() => {
                    if (typeof callback === 'function') {
                        callback(null, { ok: true });
                    }
                    return { ok: true };
                }).catch((err: Error) => {
                    if (typeof callback === 'function') {
                        callback(err);
                    }
                    throw err;
                });
            } else {
                if (typeof callback === 'function') {
                    nextTick(() => callback(null, { ok: true }));
                } else {
                    return Promise.resolve({ ok: true });
                }
            }
        };

        api.destroy = api._destroy;

        api._putLocal = function (doc: any, opts: any, callback: any): Promise<any> | void {
            if (typeof opts === 'function') {
                callback = opts;
                opts = {};
            }
            const id = doc._id;
            const revNum = 1;
            const revHash = generateRevId();
            const rev = revNum + '-' + revHash;

            const savedDoc = Object.assign({}, doc, { _rev: rev });
            if (doc._revisions) {
                savedDoc._revisions = {
                    start: revNum,
                    ids: [revHash, ...(doc._revisions.ids || [])]
                };
            }

            const change: ChangeEntry = {
                seq: db.getNextSeq(),
                id,
                rev,
                doc: savedDoc,
                timestamp: Date.now()
            };

            const promise = db.appendChanges([change]).then(() => { // Using appendChanges wrapper
                const result = { ok: true, id, rev };
                if (callback) callback(null, result);
                return result;
            }).catch((err: Error) => {
                if (callback) callback(err);
                throw err;
            });
            return promise;
        };

        api._getLocal = function (id: string, callback: any): Promise<any> | void {
            const promise = db.get(id).then(doc => {
                if (!doc) {
                    const err = { status: 404, error: true, name: 'not_found' };
                    if (callback) callback(err);
                    throw err;
                }
                if (callback) callback(null, doc);
                return doc;
            }).catch(err => {
                if (callback) callback(err);
                throw err;
            });
            return promise;
        };

        api._removeLocal = function (doc: any, opts: any, callback: any): Promise<any> | void {
            // ... Similar async update ...
            if (typeof opts === 'function') {
                callback = opts;
                opts = {};
            }
            const id = doc._id;
            // Check existence async if we want to be strict, but index check is ok
            if (!db.getIndexEntry(id)) {
                const err = { status: 404, error: true, name: 'not_found' };
                if (callback) callback(err);
                return Promise.reject(err);
            }
            // ...
            // Simplified removeLocal
            const change: ChangeEntry = {
                seq: db.getNextSeq(),
                id,
                rev: '0-0',
                deleted: true,
                timestamp: Date.now()
            };
            const promise = db.appendChanges([change]).then(() => {
                const result = { ok: true, id, rev: '0-0' };
                if (callback) callback(null, result);
                return result;
            }).catch((err: Error) => {
                if (callback) callback(err);
                throw err;
            });
            return promise;
        };
    }

    // Static properties
    GoogleDrivePouch.valid = function (): boolean {
        return true;
    };

    GoogleDrivePouch.use_prefix = false;

    return GoogleDrivePouch;
}

/**
 * Generate a random revision ID
 */
function generateRevId(): string {
    return Math.random().toString(36).substring(2, 11) +
        Math.random().toString(36).substring(2, 11);
}

export default GoogleDriveAdapter;
