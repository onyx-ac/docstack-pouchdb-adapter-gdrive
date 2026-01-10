import { GoogleDriveAdapterOptions, DriveData } from './types';
import { DriveHandler } from './drive';

/**
 * GoogleDriveAdapter - PouchDB adapter for Google Drive storage.
 * 
 * Based on the PouchDB Memory/LevelDB adapter pattern.
 * Uses a single JSON file on Google Drive as the backing store.
 */
export function GoogleDriveAdapter(PouchDB: any) {

    function GoogleDrivePouch(this: any, opts: any, callback: any) {
        const api = this;
        const name = opts.name;

        // Clone options to avoid mutation
        opts = Object.assign({}, opts);

        // Internal state
        let instanceId: string;
        let db: DriveHandler;

        // Initialize DriveHandler
        db = new DriveHandler(opts, name);

        // After database is initialized
        function afterDBCreated() {
            // Generate a unique instance ID
            instanceId = 'gdrive-' + name + '-' + Date.now().toString(36);

            // Finalize initialization
            process.nextTick(function () {
                callback(null, api);
            });
        }

        // Load data from Drive and initialize
        db.load().then(() => {
            afterDBCreated();
        }).catch((err: any) => {
            callback(err);
        });

        // ============ PouchDB Adapter API Methods ============

        api._remote = false;

        api.type = function () {
            return 'googledrive';
        };

        api._id = function (callback: any) {
            callback(null, instanceId);
        };

        api._info = function (callback: any) {
            const docCount = Object.keys(db.currentData.docs).length;
            const res = {
                doc_count: docCount,
                update_seq: db.currentData.seq,
                backend_adapter: 'googledrive'
            };
            process.nextTick(function () {
                callback(null, res);
            });
        };

        // Get a single document by ID
        api._get = function (id: string, opts: any, callback: any) {
            if (typeof opts === 'function') {
                callback = opts;
                opts = {};
            }

            const doc = db.currentData.docs[id];
            if (!doc) {
                const err = {
                    status: 404,
                    error: true,
                    name: 'not_found',
                    message: 'missing',
                    reason: 'missing'
                };
                return callback(err);
            }

            // Return document and metadata
            const metadata = {
                id: doc._id,
                rev: doc._rev,
                winningRev: doc._rev,
                deleted: !!doc._deleted
            };

            callback(null, {
                doc: doc,
                metadata: metadata
            });
        };

        // Get all documents
        api._allDocs = function (opts: any, callback: any) {
            if (typeof opts === 'function') {
                callback = opts;
                opts = {};
            }

            const keys = Object.keys(db.currentData.docs);
            const total = keys.length;

            // Apply skip and limit
            let startIndex = opts.skip || 0;
            let limit = typeof opts.limit === 'number' ? opts.limit : keys.length;

            // Filter and sort keys
            let filteredKeys = keys;
            if (opts.startkey) {
                filteredKeys = filteredKeys.filter(k => k >= opts.startkey);
            }
            if (opts.endkey) {
                filteredKeys = filteredKeys.filter(k => k <= opts.endkey);
            }
            if (opts.key) {
                filteredKeys = filteredKeys.filter(k => k === opts.key);
            }
            if (opts.keys) {
                filteredKeys = opts.keys;
            }

            filteredKeys.sort();
            if (opts.descending) {
                filteredKeys.reverse();
            }

            const sliced = filteredKeys.slice(startIndex, startIndex + limit);

            const rows = sliced.map(id => {
                const doc = db.currentData.docs[id];
                if (!doc) {
                    return {
                        key: id,
                        error: 'not_found'
                    };
                }
                const row: any = {
                    id: id,
                    key: id,
                    value: {
                        rev: doc._rev
                    }
                };
                if (opts.include_docs) {
                    row.doc = doc;
                }
                return row;
            });

            const result = {
                total_rows: total,
                offset: startIndex,
                rows: rows
            };

            if (opts.update_seq) {
                (result as any).update_seq = db.currentData.seq;
            }

            process.nextTick(function () {
                callback(null, result);
            });
        };

        // Bulk document operations
        api._bulkDocs = function (req: any, opts: any, callback: any) {
            const docs = req.docs;
            const results: any[] = [];
            const newEdits = opts.new_edits !== false;

            // Increment update sequence
            db.currentData.seq++;

            for (const doc of docs) {
                const id = doc._id;

                if (doc._deleted) {
                    // Handle deletion
                    if (!db.currentData.docs[id]) {
                        results.push({
                            ok: false,
                            id: id,
                            error: 'not_found',
                            reason: 'missing'
                        });
                        continue;
                    }

                    const oldRev = db.currentData.docs[id]._rev || '0-0';
                    const revNum = parseInt(oldRev.split('-')[0], 10) + 1;
                    const newRev = revNum + '-' + generateRevId();

                    delete db.currentData.docs[id];
                    results.push({
                        ok: true,
                        id: id,
                        rev: newRev
                    });
                } else {
                    // Handle insert/update
                    let newRev: string;

                    if (newEdits) {
                        // Generate new revision
                        const oldRev = db.currentData.docs[id]?._rev || '0-0';
                        const revNum = parseInt(oldRev.split('-')[0], 10) + 1;
                        newRev = revNum + '-' + generateRevId();
                    } else {
                        // Use provided revision (replication scenario)
                        newRev = doc._rev;
                    }

                    const savedDoc = Object.assign({}, doc, { _rev: newRev });
                    db.currentData.docs[id] = savedDoc;

                    results.push({
                        ok: true,
                        id: id,
                        rev: newRev
                    });
                }
            }

            // Persist to Google Drive
            db.save().then(() => {
                process.nextTick(function () {
                    callback(null, results);
                });
            }).catch((err: any) => {
                callback(err);
            });
        };

        // Changes feed
        api._changes = function (opts: any) {
            opts = Object.assign({}, opts);

            const descending = opts.descending;
            const since = opts.since || 0;
            const limit = typeof opts.limit === 'number' ? opts.limit : Infinity;
            const returnDocs = opts.return_docs !== false;
            const results: any[] = [];
            let lastSeq = since;
            let complete = false;

            function processChanges() {
                // For a simple adapter, we emit all docs as changes
                const docs = Object.values(db.currentData.docs) as any[];
                let processed = 0;

                for (const doc of docs) {
                    if (complete) break;
                    if (processed >= limit) break;

                    const change = {
                        id: doc._id,
                        seq: db.currentData.seq,
                        changes: [{ rev: doc._rev }],
                        doc: opts.include_docs ? doc : undefined
                    };

                    if (opts.onChange) {
                        opts.onChange(change);
                    }

                    if (returnDocs) {
                        results.push(change);
                    }

                    processed++;
                    lastSeq = db.currentData.seq;
                }

                if (opts.complete && !complete) {
                    opts.complete(null, {
                        results: results,
                        last_seq: lastSeq
                    });
                }
            }

            // For live changes, listen to drive updates
            if (opts.live) {
                db.onChange((newData) => {
                    if (complete) return;
                    processChanges();
                });
            }

            // Initial processing
            process.nextTick(processChanges);

            return {
                cancel: function () {
                    complete = true;
                    if (opts.complete) {
                        opts.complete(null, {
                            results: results,
                            last_seq: lastSeq,
                            status: 'cancelled'
                        });
                    }
                }
            };
        };

        // Get revision tree (simplified - our adapter doesn't track full rev tree)
        api._getRevisionTree = function (docId: string, callback: any) {
            const doc = db.currentData.docs[docId];
            if (!doc) {
                return callback({
                    status: 404,
                    error: true,
                    name: 'not_found',
                    message: 'missing'
                });
            }

            // Return a minimal rev tree structure
            const revTree = [{
                pos: 1,
                ids: [doc._rev.split('-')[1], { status: 'available' }, []]
            }];

            callback(null, revTree);
        };

        // Close the database
        api._close = function (callback: any) {
            db.stopPolling();
            process.nextTick(function () {
                callback();
            });
        };

        // Destroy the database
        api._destroy = function (opts: any, callback: any) {
            if (typeof opts === 'function') {
                callback = opts;
                opts = {};
            }

            db.stopPolling();

            // Optionally delete file from Google Drive
            if (opts.deleteFile) {
                db.deleteFile().then(() => {
                    callback(null, { ok: true });
                }).catch((err: any) => {
                    callback(err);
                });
            } else {
                process.nextTick(function () {
                    callback(null, { ok: true });
                });
            }
        };

        // Put a local document (for internal PouchDB use)
        api._putLocal = function (doc: any, opts: any, callback: any) {
            if (typeof opts === 'function') {
                callback = opts;
                opts = {};
            }

            const id = doc._id;
            const rev = '0-1';
            const savedDoc = Object.assign({}, doc, { _rev: rev });
            db.currentData.docs[id] = savedDoc;

            db.save().then(() => {
                callback(null, { ok: true, id: id, rev: rev });
            }).catch((err: any) => {
                callback(err);
            });
        };

        // Get a local document
        api._getLocal = function (id: string, callback: any) {
            const doc = db.currentData.docs[id];
            if (!doc) {
                return callback({
                    status: 404,
                    error: true,
                    name: 'not_found',
                    message: 'missing'
                });
            }
            callback(null, doc);
        };

        // Remove a local document
        api._removeLocal = function (doc: any, opts: any, callback: any) {
            if (typeof opts === 'function') {
                callback = opts;
                opts = {};
            }

            const id = doc._id;
            if (!db.currentData.docs[id]) {
                return callback({
                    status: 404,
                    error: true,
                    name: 'not_found',
                    message: 'missing'
                });
            }

            delete db.currentData.docs[id];

            db.save().then(() => {
                callback(null, { ok: true, id: id, rev: '0-0' });
            }).catch((err: any) => {
                callback(err);
            });
        };
    }

    // Static properties
    GoogleDrivePouch.valid = function () {
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
