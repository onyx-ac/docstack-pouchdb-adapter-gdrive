import {
    GoogleDriveAdapterOptions,
    ChangeEntry,
    SnapshotIndex,
    SnapshotDataChunk,
    MetaData,
    IndexEntry,
    FilePointer,
    LegacySnapshotData
} from './types';
import { LRUCache } from './cache';
import { GoogleDriveClient } from './client';

const DEFAULT_COMPACTION_THRESHOLD = 100; // entries
const DEFAULT_SIZE_THRESHOLD = 1024 * 1024; // 1MB
const DEFAULT_CACHE_SIZE = 1000; // Number of docs
const META_COMMIT_RETRIES = 6; // read-modify-write attempts per _meta.json commit
const RETIRED_LOG_HISTORY = 500; // tombstones kept for change logs compaction deleted

/**
 * Sequence numbers are `tick * SEQ_SLOTS + writerSlot`.
 *
 * Writers mint them blind to one another - there is no lock and no compare-and-swap -
 * so two clients reading the same counter will always be able to derive the same next
 * tick. Reserving the low digits for a per-writer slot means they can share a tick and
 * still never share a *sequence number*, which is the part that matters: `_changes`
 * filters on `seq > since`, so a second document sharing a checkpointed sequence
 * number is never emitted to a replication target again.
 *
 * A million slots keeps the chance that two concurrent writers hash to the same one
 * near 1 in 20,000 for a ten-client fleet, and leaves room for 9e9 ticks inside
 * Number.MAX_SAFE_INTEGER.
 */
export const SEQ_SLOTS = 1000000;

/** Stable slot for a writer id. FNV-1a, folded into the slot space. */
export function writerSlotFor(writerId: string): number {
    let h = 2166136261;
    for (let i = 0; i < writerId.length; i++) {
        h ^= writerId.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return Math.abs(h) % SEQ_SLOTS;
}

function newWriterId(): string {
    return Math.random().toString(36).substring(2, 10);
}

/** The writer id embedded in a change-log filename, if the name carries one.
 *  New format: changes-<seq>-<writerId>-<random>.ndjson (4 dash-parts).
 *  Old format: changes-<seq>-<random>.ndjson (3 parts) - no id to extract. */
export function writerIdFromLogName(name: string): string | null {
    if (!name.startsWith('changes-') || !name.endsWith('.ndjson')) return null;
    const parts = name.slice(0, -'.ndjson'.length).split('-');
    return parts.length === 4 ? parts[2] : null;
}

/** A trivial single-node pouchdb-merge tree for a bare rev string - used where a
 *  doc enters the index without going through _bulkDocs's real merge (local docs,
 *  legacy-snapshot migration, and the low-level DriveHandler.appendChange() API's
 *  raw callers). Correct as far as it goes (one leaf, no ancestry); these paths
 *  never participate in replication conflict resolution anyway. */
function synthesizeTree(rev: string, deleted?: boolean): string {
    const dash = rev.indexOf('-');
    const pos = dash >= 0 ? parseInt(rev.slice(0, dash), 10) : 0;
    const hash = dash >= 0 ? rev.slice(dash + 1) : rev;
    return JSON.stringify([{ pos, ids: [hash, { status: 'available', deleted: !!deleted }, []] }]);
}

/**
 * DriveHandler - Lazy Loading Implementation
 * 
 * Storage structure:
 * /db-folder/
 *   ├── _meta.json         
 *   ├── snapshot-index.json  # Map<DocId, IndexEntry>
 *   ├── snapshot-data.json   # Map<DocId, DocBody>
 *   └── changes-*.ndjson     # Append logs
 */
export class DriveHandler {
    private client: GoogleDriveClient;
    private options: GoogleDriveAdapterOptions;
    private folderId: string | null = null;
    private folderName: string;
    private parents: string[];

    private compactionThreshold: number;
    private compactionSizeThreshold: number;

    private meta: MetaData = {
        seq: 0,
        changeLogIds: [],
        snapshotIndexId: null,
        lastCompaction: null,
        dbName: ''
    };

    private metaEtag: string | null = null;
    private metaMd5: string | null = null;
    private metaModifiedTime: string | null = null;
    private localDocsEtag: string | null = null;
    private metaFileId: string | null = null;

    /** Identifies this handler among the writers sharing a folder. Change-log
     *  filenames carry it, so two writers can never produce the same name and an
     *  orphaned log can be traced back to whoever wrote it. Not readonly: if the
     *  folder shows another writer whose id hashes to our sequence slot, we re-roll
     *  to a free one before minting anything (see rerollIfSlotContested). */
    private writerId: string = newWriterId();

    /** Change-log file ids this handler wrote, minus any a compaction has retired.
     *  Drive API v3 has no compare-and-swap (ETags were dropped), so another
     *  writer's read-modify-write of _meta.json can drop a log id that landed in
     *  between. Anything still in here but missing from the remote changeLogIds was
     *  dropped that way and gets put back - see reconcileOwnLogs(). */
    private ownLogIds: Set<string> = new Set();

    /** This writer's reservation in the low digits of every sequence number it mints.
     *  Derived from writerId; changes only when writerId is re-rolled off a
     *  contested slot. */
    private writerSlot: number = writerSlotFor(this.writerId);

    /** Serializes this handler's own _meta.json read-modify-write cycles. Says
     *  nothing about other clients - that is what commitMeta's verify pass is for -
     *  but stops one handler racing itself when several writes are in flight. */
    private metaLock: Promise<unknown> = Promise.resolve();

    // In-Memory Index: ID -> Metadata/Pointer
    private index: Record<string, IndexEntry> = {};

    // Document Body Cache
    private docCache: LRUCache<string, any>;

    private pendingChanges: ChangeEntry[] = [];
    private currentLogSizeEstimate: number = 0;

    private listeners: ((docs: Record<string, any>) => void)[] = [];
    private pollingInterval: NodeJS.Timeout | null = null;
    private loadingPromise: Promise<void> | null = null;
    private isPollingActive: boolean = false;
    private fileCache: LRUCache<string, any>;
    private processedLogIds: Set<string> = new Set();
    private currentSnapshotIndexId: string | null = null;
    private debug: boolean = false;
    private isCompacting: boolean = false;
    private pendingDownloads: Map<string, Promise<any>> = new Map();
    private pendingFinds: Map<string, Promise<any>> = new Map();

    private log(...args: any[]) {
        console.log(`[googledrive-drive] [${this.meta.dbName}]`, ...args);
    }



    constructor(options: GoogleDriveAdapterOptions, dbName: string) {
        const clientOptions = { ...options };
        if (options.testMode) {
            const serverUrl = options.testServerUrl || 'http://localhost:3000';
            // @ts-ignore - baseUrl/uploadUrl might not be in the strict type if we didn't update types.ts definition for DriveClientOptions in client.ts yet? 
            // We did update DriveClientOptions in client.ts.
            // But GoogleDriveAdapterOptions extends DriveClientOptions?
            // types.ts: export interface GoogleDriveAdapterOptions extends DriveClientOptions
            // client.ts: export interface DriveClientOptions { accessToken: ...; baseUrl?: string; uploadUrl?: string; }
            // So typescript should be happy.

            // Using /drive/v3/files as base for the test server if simplified?
            // The TestServer mounts at /drive/v3/files.
            // But the client appends /drive/v3/files to BASE_URL? 
            // In client.ts default is `https://www.googleapis.com/drive/v3/files`.
            // Our TestServer mounts `/drive/v3/files`.
            // So testUrl should be `http://localhost:3000/drive/v3/files`.
            const testBase = `${serverUrl}/drive/v3/files`;
            const testUpload = `${serverUrl}/upload/drive/v3/files`;
            // @ts-ignore
            clientOptions.baseUrl = testBase;
            // @ts-ignore
            clientOptions.uploadUrl = testUpload;
        }
        this.client = new GoogleDriveClient(clientOptions);
        this.options = options;
        this.folderId = options.folderId || null;
        this.folderName = options.folderName || dbName;
        this.parents = options.parents || [];
        this.compactionThreshold = options.compactionThreshold || DEFAULT_COMPACTION_THRESHOLD;
        this.compactionSizeThreshold = options.compactionSizeThreshold || DEFAULT_SIZE_THRESHOLD;
        this.meta.dbName = dbName;
        this.debug = !!options.debug;

        this.docCache = new LRUCache(options.cacheSize || DEFAULT_CACHE_SIZE);

        this.fileCache = new LRUCache(100); // Cache for last 100 files


        // Polling will be started in load() after folderId is resolved
    }

    // Public getter for Sequence (used by adapter)
    public get seq(): number {
        return this.meta.seq;
    }

    /** Load the database (Index Only) */
    async load(): Promise<void> {
        if (this.loadingPromise) return this.loadingPromise;

        this.loadingPromise = (async () => {
            try {
                this.log('Loading database, options', { options: this.options });
                if (!this.folderId) {
                    this.folderId = await this.findOrCreateFolder();
                    this.log('Retrieved folder', { folderId: this.folderId });
                }

                const current = await this.readRemoteMeta();
                if (current) {
                    this.log('Retrieved meta file', { fileId: current.pointer.fileId });
                    this.adoptMeta(current.meta, current.pointer);
                } else {
                    this.log('Meta file not found, creating new');
                    await this.ensureMetaFile();
                }

                // A change log of ours that has fallen out of changeLogIds without a
                // compaction retiring it was dropped by another writer's
                // read-modify-write. Put it back before replaying, so this load sees
                // its own writes - and so the next reader does too.
                if (this.hasOrphanedOwnLogs(this.meta)) {
                    await this.commitMeta((latest, repaired) => repaired ? latest : null);
                }

                if (this.meta.snapshotIndexId !== this.currentSnapshotIndexId) {
                    this.log('Snapshot index changed, loading index', {
                        snapshotIndexId: this.meta.snapshotIndexId,
                        currentSnapshotIndexId: this.currentSnapshotIndexId
                    });
                    // Compaction occurred or initial load
                    this.index = {};
                    this.processedLogIds.clear();
                    this.currentSnapshotIndexId = this.meta.snapshotIndexId;

                    if (this.meta.snapshotIndexId) {
                        try {
                            const snapshotIdx: SnapshotIndex = await this.downloadJson(this.meta.snapshotIndexId);
                            if ((snapshotIdx as any).docs) {
                                this.filesFromLegacySnapshot(snapshotIdx as unknown as LegacySnapshotData);
                            } else {
                                this.index = snapshotIdx.entries || {};
                            }
                        } catch (e) {
                            console.warn('Failed to load snapshot index', e);
                        }
                    } else if ((this.meta as any).snapshotId) {
                        this.log('Legacy snapshot found, loading index', {
                            snapshotId: (this.meta as any).snapshotId
                        });
                        try {
                            const legacySnapshot = await this.downloadJson((this.meta as any).snapshotId);
                            this.filesFromLegacySnapshot(legacySnapshot);
                        } catch (e) {
                            console.warn('Failed to load legacy snapshot', e);
                        }
                    }
                }

                // 2. Replay NEW Change Logs (Metadata only updates)
                this.log('Replaying change logs');
                const retired = new Set(this.meta.retiredLogIds || []);

                // Take the union of what the metadata references and what is actually
                // in the folder. A log missing from changeLogIds but present in the
                // folder was orphaned by a lost metadata update; a log referenced but
                // absent was deleted after being referenced. Both are survivable if
                // the folder gets the last word.
                let discovered: string[] = [];
                try {
                    const listed = await this.listChangeLogs();

                    // The same listing shows every writer's id - the moment to notice
                    // someone else is on our sequence slot and move off it.
                    this.rerollIfSlotContested(listed.map(f => f.name));

                    const referenced = new Set(this.meta.changeLogIds);
                    discovered = listed.map(f => f.id).filter(id => !referenced.has(id) && !retired.has(id));
                    if (discovered.length > 0) {
                        this.log('Found change logs the metadata does not reference', discovered);
                    }
                } catch (e) {
                    // Listing is an optimisation over the metadata, never a
                    // prerequisite - a failure here must not fail the load.
                    this.log('Failed to list change logs, falling back to metadata only', e);
                }

                const pendingLogs = [...this.meta.changeLogIds, ...discovered]
                    .filter(id => !this.processedLogIds.has(id) && !retired.has(id));

                if (pendingLogs.length > 0) {
                    this.log(`Downloading ${pendingLogs.length} change logs in parallel`);
                    const logResults = await Promise.all(pendingLogs.map(async (id) => {
                        try {
                            const changes = await this.downloadNdjson(id);
                            return { id, changes };
                        } catch (e) {
                            this.log(`Failed to download change log ${id}`, e);
                            return { id, changes: null };
                        }
                    }));

                    // Replay in sequence order, not in the order the ids happened to
                    // be listed. Two clients can hold different changeLogIds orderings
                    // for the same folder once merges are in play, and updateIndex
                    // takes the last write for a document - so insertion order meant
                    // two readers of one folder could disagree about the winner.
                    logResults.sort((a, b) => {
                        const seqOf = (r: { changes: ChangeEntry[] | null }) =>
                            r.changes && r.changes.length ? (Array.isArray(r.changes) ? r.changes[0].seq : (r.changes as any).seq) : Number.MAX_SAFE_INTEGER;
                        const sa = seqOf(a), sb = seqOf(b);
                        if (sa !== sb) return sa - sb;
                        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
                    });

                    const foundNew: Record<string, any> = {};
                    for (const { id, changes } of logResults) {
                        if (!changes) {
                            this.log(`Skipping failed log ${id}`);
                            continue;
                        }

                        let changesArray = Array.isArray(changes) ? (changes as ChangeEntry[]) : [changes as ChangeEntry];
                        this.log('Processing log file', id, 'changes', changesArray.length);

                        for (const change of changesArray) {
                            this.updateIndex(change, id);
                            if (this.docCache.get(change.id)) {
                                this.docCache.remove(change.id);
                            }
                            foundNew[change.id] = {
                                _id: change.id,
                                _rev: change.rev,
                                _deleted: !!change.deleted,
                                seq: change.seq
                            };
                        }
                        this.processedLogIds.add(id);
                    }

                    if (Object.keys(foundNew).length > 0) {
                        this.log('Load complete, notifying of changes', Object.keys(foundNew).length);
                        this.notifyListeners(foundNew);
                    }
                }

                // 2. Replay NEW Change Logs (Metadata only updates)
                // ... (previous logic for change logs)
                // (Already updated in previous turn, keep it)

                    // Put what we found back into the metadata, so the next reader
                    // does not have to rediscover it and compaction can see it. Any
                    // client repairs this, not only the writer that lost the race.
                    if (discovered.length > 0) {
                        await this.commitMeta((latest) => {
                            const referenced = new Set(latest.changeLogIds);
                            const stillRetired = new Set(latest.retiredLogIds || []);
                            const missing = discovered.filter(id => !referenced.has(id) && !stillRetired.has(id));
                            if (missing.length === 0) return null;
                            return { ...latest, changeLogIds: [...latest.changeLogIds, ...missing] };
                        });
                    }

                // 2b. Load Local Documents Store (Pinned in meta)
                if (this.meta.localDocsId) {
                    this.log('Loading local docs store', this.meta.localDocsId);
                    try {
                        const localStore = await this.client.getFileMetadata(this.meta.localDocsId);
                        this.localDocsEtag = localStore.etag || null;
                        const localDocsChunk: SnapshotDataChunk = await this.downloadJson(this.meta.localDocsId, true);
                        if (localDocsChunk && localDocsChunk.docs) {
                            for (const [id, doc] of Object.entries(localDocsChunk.docs)) {
                                this.log('Merging local doc', id);
                                this.index[id] = {
                                    tree: synthesizeTree(doc._rev),
                                    rev: doc._rev,
                                    seq: 0, // Local docs don't participate in shared sequences
                                    location: { fileId: this.meta.localDocsId }
                                };
                                this.docCache.put(id, doc);
                            }
                        }
                    } catch (e) {
                        this.log('Failed to load local docs store', e);
                    }
                }

                // 3. Start Polling (if enabled). Idempotent on purpose: load()
                // runs again on every catch-up and retry, and restarting the
                // interval each time would push the next tick further out for
                // exactly as long as the client stays busy.
                if (this.options.pollingIntervalMs) {
                    this.startPolling(Number(this.options.pollingIntervalMs));
                }
            } catch (e) {
                console.error('Failed to load database', e);
                throw e;
            } finally {
                this.loadingPromise = null;
            }
        })();

        return this.loadingPromise;
    }

    // Migration helper
    private filesFromLegacySnapshot(snapshot: LegacySnapshotData) {
        // Convert Legacy Snapshot (Docs in memory) to Index
        // Since we don't have a separate file pointer for each doc in legacy snapshot,
        // we say they are in the snapshot file itself.
        // BUT, lazy loading requires being able to fetch them. 
        // We will cache them ALL now (since we downloaded them) and index them.
        for (const [id, doc] of Object.entries(snapshot.docs)) {
            this.index[id] = {
                tree: synthesizeTree(doc._rev),
                rev: doc._rev,
                seq: snapshot.seq, // Approximate
                location: { fileId: 'LEGACY_MEMORY' } // Special validity marker
            };
            this.docCache.put(id, doc);
        }
    }

    /** 
     * Get a document body.
     * Index -> Cache -> Fetch
     */
    async get(id: string): Promise<any | null> {
        const entry = this.index[id];
        if (!entry) return null;
        if (entry.deleted) return null;

        // 1. Check Doc Cache
        const cachedDoc = this.docCache.get(id);
        if (cachedDoc) return cachedDoc;

        // 2. Fetch from Drive (via File Cache)
        if (entry.location.fileId === 'LEGACY_MEMORY') {
            if ((this.meta as any).snapshotId) {
                const legacy = await this.downloadJson((this.meta as any).snapshotId);
                if (legacy.docs[id]) {
                    this.docCache.put(id, legacy.docs[id]);
                    return legacy.docs[id];
                }
            }
            return null;
        }

        const fileId = entry.location.fileId;
        const content = await this.fetchFile(fileId);

        let doc: any = null;
        if (Array.isArray(content)) {
            // It's a change log (NDJSON parsed as array)
            const match = [...content].reverse().find((c: ChangeEntry) => c.id === id);
            doc = match ? match.doc : null;
        } else if (content && content.docs) {
            // It's a snapshot-data chunk
            doc = content.docs[id];
        } else if (content && content.id === id && content.doc) {
            // It's a single ChangeEntry object (parsed from single-line NDJSON)
            doc = content.doc;
        } else if (content && (content._id === id || content.id === id)) {
            // Single doc file or raw doc body
            doc = content;
        }

        if (doc) {
            // HEAL: Ensure PouchDB core validation doesn't fail due to history corruption
            // This prevents the infinite replicator retry loop when start < ids.length
            if (doc._revisions && doc._revisions.start < doc._revisions.ids.length) {
                 const start = doc._revisions.start || 1;
                 doc._revisions.ids = doc._revisions.ids.slice(0, start);
            }
            this.docCache.put(id, doc);
            doc._rev = entry.rev;
        }

        return doc;
    }

    /**
     * Fetch a specific (possibly non-winning/conflicting) revision's body by its
     * own tracked location - used by _get(opts.rev)/_bulkGet when the requested
     * rev isn't the current winner. Deliberately doesn't touch docCache (keyed
     * per-id, not per-rev - a conflict fetch is rare enough not to warrant a
     * per-rev cache key) and doesn't force `_rev` to the index's winning rev the
     * way get() does.
     */
    async getRevisionBody(id: string, rev: string, location: FilePointer): Promise<any | null> {
        if (location.fileId === 'LEGACY_MEMORY' || location.fileId === '__SELF__') return null;
        const content = await this.fetchFile(location.fileId);

        let doc: any = null;
        if (Array.isArray(content)) {
            const match = content.find((c: ChangeEntry) => c.id === id && c.rev === rev);
            doc = match ? match.doc : null;
        } else if (content && content.conflicts && content.conflicts[id]) {
            doc = content.conflicts[id][rev] ?? null;
        } else if (content && content.docs && content.docs[id]) {
            // Winning body happened to be requested through this path (e.g. after
            // a merge where the "conflict" turned out to be the new winner).
            const candidate = content.docs[id];
            if (candidate && candidate._rev === rev) doc = candidate;
        } else if (content && content.id === id && content.rev === rev && content.doc) {
            doc = content.doc;
        }

        if (doc) doc._rev = rev;
        return doc;
    }

    /** Generic Download with Caching and Parsing */
    private async fetchFile(fileId: string, skipCache: boolean = false): Promise<any> {
        if (!skipCache) {
            const cached = this.fileCache.get(fileId);
            if (cached) {
                this.log('fetchFile cache hit', fileId);
                return cached;
            }
        }

        // Always check pending downloads. A download in progress is as fresh as it 
        // can be right now, so we can reuse it even if skipCache is true.
        const pending = this.pendingDownloads.get(fileId);
        if (pending) {
            this.log('fetchFile reuse pending download', fileId);
            return await pending;
        }

        const downloadPromise = (async () => {
            try {
                this.log('fetchFile downloading', fileId);
                const data = await this.client.getFile(fileId);
                let parsed: any;

                if (typeof data === 'string') {
                    const trimmed = data.trim();
                    if (trimmed.startsWith('{')) {
                        // Could be JSON or NDJSON
                        if (trimmed.includes('\n')) {
                            // Definitely NDJSON (multiple lines)
                            try {
                                const lines = trimmed.split('\n').filter(l => l);
                                parsed = lines.map(line => JSON.parse(line));
                            } catch (e) {
                                parsed = data;
                            }
                        } else {
                            // Single line. Try regular JSON first.
                            try {
                                parsed = JSON.parse(trimmed);
                            } catch (e) {
                                parsed = data;
                            }
                        }
                    } else {
                        parsed = data;
                    }
                } else {
                    parsed = data;
                }

                if (!skipCache) this.fileCache.put(fileId, parsed);
                return parsed;
            } finally {
                if (!skipCache) this.pendingDownloads.delete(fileId);
            }
        })();

        if (!skipCache) this.pendingDownloads.set(fileId, downloadPromise);
        return await downloadPromise;
    }

    /** Get multiple docs (Atomic-ish) used for _allDocs */
    async getMulti(ids: string[]): Promise<any[]> {
        // Naive parallel fetch
        // Optimization: Group by fileID to reduce requests

        const byFile: Record<string, string[]> = {};
        const results: Record<string, any> = {};

        for (const id of ids) {
            const entry = this.index[id];
            if (!entry || entry.deleted) {
                results[id] = null;
                continue;
            }

            // Check cache
            const cached = this.docCache.get(id);
            if (cached) {
                results[id] = cached;
                continue;
            }

            // Group by file
            if (entry.location.fileId === 'LEGACY_MEMORY') {
                // Handle legacy separately
                const doc = await this.get(id); // fallback
                results[id] = doc;
            } else {
                if (!byFile[entry.location.fileId]) byFile[entry.location.fileId] = [];
                byFile[entry.location.fileId].push(id);
            }
        }

        // Fetch files
        for (const [fileId, docIds] of Object.entries(byFile)) {
            try {
                const content = await this.fetchFile(fileId);

                for (const docId of docIds) {
                    let doc = null;
                    if (Array.isArray(content)) {
                        const match = [...content].reverse().find((c: ChangeEntry) => c.id === docId);
                        doc = match ? match.doc : null;
                    } else if (content && content.docs) {
                        doc = content.docs[docId];
                    } else if (content && content.id === docId && content.doc) {
                        // Single ChangeEntry object
                        doc = content.doc;
                    }

                    if (doc) {
                        // Add entry.rev to doc just in case
                        if (this.index[docId]) doc._rev = this.index[docId].rev;
                        this.docCache.put(docId, doc);
                        results[docId] = doc;
                    } else {
                        results[docId] = null;
                    }
                }
            } catch (e) {
                console.error(`Failed to fetch file ${fileId} for docs ${docIds}`, e);
                // Return nulls
                docIds.forEach(id => results[id] = null);
            }
        }

        return ids.map(id => results[id]);
    }

    /** Return all keys in Index */
    async getIndexKeys(): Promise<string[]> {
        if (this.loadingPromise) await this.loadingPromise;
        return Object.keys(this.index);
    }

    /** Get metadata for a specific ID from Index */
    getIndexEntry(id: string): IndexEntry | undefined {
        return this.index[id];
    }

    /** Single change wrapper */
    async appendChange(change: ChangeEntry): Promise<void> {
        return this.appendChanges([change]);
    }

    /** Append changes with OCC */
    async appendChanges(changes: ChangeEntry[]): Promise<void> {
        const MAX_RETRIES = 5;
        let attemptNum = 0;

        const local = changes.filter(c => c.id.startsWith('_local/'));
        const remote = changes.filter(c => !c.id.startsWith('_local/'));

        // Handle Local Docs (Pinned Store)
        if (local.length > 0) {
            await this.appendLocalDocs(local);
        }

        // Handle Remote Docs (App Log)
        if (remote.length === 0) return;

        while (attemptNum < MAX_RETRIES) {
            try {
                return await this.tryAppendChanges(remote);
            } catch (err: any) {
                if (err.status === 412 || err.status === 409) {
                    // Reload and RETRY. No resequencing here - tryAppendChanges
                    // stamps sequence numbers from a fresh read of _meta.json on
                    // every attempt of its own.
                    await this.load();
                    // Check conflicts against Index (Metadata sufficient)
                    this.checkConflicts(remote);

                    attemptNum++;
                    await this.backoff(attemptNum);
                    continue;
                }
                throw err;
            }
        }
        throw new Error('Failed to append changes');
    }

    private async appendLocalDocs(changes: ChangeEntry[]): Promise<void> {
        const MAX_RETRIES = 5;
        let attempt = 0;
        while (attempt < MAX_RETRIES) {
            try {
                // 1. Download current local docs (no cache)
                let store: SnapshotDataChunk = { docs: {} };
                let currentEtag: string | null = null;

                if (this.meta.localDocsId) {
                    try {
                        const fileMeta = await this.client.getFileMetadata(this.meta.localDocsId);
                        currentEtag = fileMeta.etag || null;
                        store = await this.downloadJson(this.meta.localDocsId, true);
                    } catch (e: any) {
                        if (e.status !== 404) throw e;
                    }
                }

                // 2. Merge changes
                for (const change of changes) {
                    if (change.deleted) {
                        delete store.docs[change.id];
                    } else if (change.doc) {
                        store.docs[change.id] = change.doc;
                    }
                }

                // 3. Save back
                const content = JSON.stringify(store);
                let res: { id: string, etag: string };
                if (this.meta.localDocsId) {
                    res = await this.client.updateFile(this.meta.localDocsId, content, currentEtag || undefined);
                } else {
                    res = await this.client.createFile('_local_docs.json', [this.folderId!], 'application/json', content);
                    // Update Meta with new File ID
                    const localRes = res;
                    await this.commitMeta((latest) => ({ ...latest, localDocsId: localRes.id }));
                }

                this.localDocsEtag = res.etag;
                // Update Index
                const changedDocs: Record<string, any> = {};
                for (const change of changes) {
                    this.updateIndex(change, res.id);
                    if (change.doc) this.docCache.put(change.id, change.doc);
                    else this.docCache.remove(change.id);
                    changedDocs[change.id] = {
                        _id: change.id,
                        _rev: change.rev,
                        _deleted: !!change.deleted,
                        seq: change.seq
                    };
                }
                this.notifyListeners(changedDocs);
                return;
            } catch (err: any) {
                if (err.status === 412 || err.status === 409) {
                    attempt++;
                    await new Promise(r => setTimeout(r, Math.random() * 500 + 100));
                    continue;
                }
                throw err;
            }
        }
    }

    private async tryAppendChanges(changes: ChangeEntry[]): Promise<void> {
        // Catching up on another writer's logs and failing to publish are separate
        // failures, so they get separate budgets - a busy folder should not be able
        // to spend the publish retries on catch-ups alone.
        let catchUps = 0;

        for (let attempt = 0; attempt < META_COMMIT_RETRIES;) {
            // 1. Take the sequence range from what Drive holds right now, not from
            // this handler's cached copy - that copy is only refreshed on load, so
            // two clients allocating from their own stale copies is exactly how two
            // change logs end up claiming the same sequence number.
            const current = await this.readRemoteMeta();

            // Catch up before writing. Another writer having appended since our last
            // load means our index - and so the revision this write is built on - is
            // out of date; replaying their logs first is what lets checkConflicts see
            // the collision instead of us silently writing over them. (Previously
            // this only happened when the metadata ETag came back 412, which Drive
            // itself never does.)
            if (current && this.hasUnprocessedLogs(current.meta)) {
                if (++catchUps > META_COMMIT_RETRIES) {
                    throw new Error('Could not catch up with concurrent writers');
                }
                await this.load();
                // Only the low-level appendChange() callers are checked here.
                // _bulkDocs has already resolved revisions through pouchdb-merge and
                // expresses a collision as a conflict branch, not as a thrown error;
                // failing its whole batch would be the wrong answer.
                this.checkConflicts(changes.filter(c => !c.nextIndexEntry));
                continue;
            }

            // Take the tick from whatever counter is furthest along and stamp our own
            // slot into it. Another writer working from the same counter lands on the
            // same tick and a different sequence number, which is the point - there is
            // no way to stop them sharing the tick, and no longer any need to.
            const observedSeq = current ? current.meta.seq : this.meta.seq;
            const baseTick = Math.floor(Math.max(observedSeq, this.meta.seq) / SEQ_SLOTS);
            changes.forEach((change, i) => {
                change.seq = (baseTick + i + 1) * SEQ_SLOTS + this.writerSlot;
            });
            const lastSeq = changes[changes.length - 1].seq;

            // 2. Write Log File (Upload Data). `nextIndexEntry` (the merged tree, only
            // needed transiently by updateIndex() below) is stripped first - it's
            // already durably captured by the index/snapshot system, so writing it into
            // every change-log line too would just redundantly bloat storage, growing
            // with tree depth on every single write.
            const fileId = await this.writeChangeFile(changes.map(({ nextIndexEntry, ...rest }) => rest));

            // 3. Publish it. The modifier merges into whatever _meta.json holds at
            // write time rather than replacing it, so a concurrent writer's logs
            // survive; it abandons the commit if someone has taken the sequence
            // range already stamped into our file, since those seqs would then
            // collide with theirs.
            let committed: MetaData | null;
            try {
                committed = await this.commitMeta(
                    (latest) => ({
                        ...latest,
                        // Idempotent: commitMeta may run this more than once.
                        changeLogIds: latest.changeLogIds.includes(fileId)
                            ? latest.changeLogIds
                            : [...latest.changeLogIds, fileId],
                        // Never let the shared counter go backwards: another writer may
                        // have reached a higher tick while we were uploading, and
                        // rewinding it would hand our tick out a second time.
                        seq: Math.max(latest.seq, lastSeq)
                    }),
                    { verify: (m) => m.changeLogIds.includes(fileId) }
                );
            } catch (err) {
                this.discardLog(fileId);
                throw err;
            }

            if (!committed) {
                // commitMeta ran out of attempts. Nothing references the log we just
                // uploaded, so drop it and start over against fresh metadata. This no
                // longer fires for a sequence collision - slots make those impossible -
                // only for a metadata write that would not stick.
                this.log('Change log not published, retrying', { fileId, attempt });
                this.discardLog(fileId);
                await this.backoff(attempt++);
                continue;
            }

            // Published: from here on this log is ours to defend if another writer
            // drops it from the metadata.
            this.ownLogIds.add(fileId);

            // 4. Update Local State. Marking our own log processed keeps a later
            // load() from replaying it: the entries we apply here carry the merged
            // rev tree computed by _bulkDocs, while the log lines on Drive have it
            // stripped, so a replay would overwrite real ancestry with a synthesized
            // single-node tree.
            this.processedLogIds.add(fileId);

            const changedDocs: Record<string, any> = {};
            for (const change of changes) {
                this.updateIndex(change, fileId);
                if (change.doc) {
                    this.docCache.put(change.id, change.doc);
                } else if (change.deleted) {
                    this.docCache.remove(change.id);
                }
                changedDocs[change.id] = {
                    _id: change.id,
                    _rev: change.rev,
                    _deleted: !!change.deleted,
                    seq: change.seq
                };
            }

            // Notify local changes feed listeners about only what we just wrote
            this.notifyListeners(changedDocs);

            // 5. Compaction Check
            const totalChanges = await this.countTotalChanges();
            if (totalChanges >= this.compactionThreshold ||
                this.currentLogSizeEstimate >= this.compactionSizeThreshold) {
                this.compact().catch(e => console.error('Compaction failed', e));
            }
            return;
        }

        throw new Error(`Failed to publish change log after ${META_COMMIT_RETRIES} attempts`);
    }

    /** Forget a change log we uploaded but never managed to reference from
     *  _meta.json. Nothing points at it, so it is safe to remove. */
    private discardLog(fileId: string): void {
        this.ownLogIds.delete(fileId);
        this.client.deleteFile(fileId).catch(e => this.log('Failed to clean up unreferenced log', fileId, e));
    }

    /** Update Index with a new change */
    private updateIndex(change: ChangeEntry, fileId: string) {
        if (change.nextIndexEntry) {
            // adapter.ts already computed the full merged tree/winner/conflicts via
            // pouchdb-merge - just substitute the '__SELF__' placeholder(s) with the
            // fileId this batch actually landed in (unknown until upload completed).
            const entry: IndexEntry = { ...change.nextIndexEntry, seq: change.seq };
            if (entry.location.fileId === '__SELF__') entry.location = { fileId };
            if (entry.conflictLocations) {
                const resolved: Record<string, FilePointer> = {};
                for (const rev of Object.keys(entry.conflictLocations)) {
                    const loc = entry.conflictLocations[rev];
                    resolved[rev] = loc.fileId === '__SELF__' ? { fileId } : loc;
                }
                entry.conflictLocations = resolved;
            }
            this.index[change.id] = entry;
            return;
        }

        // Legacy path: no computed tree (the low-level DriveHandler.appendChange()
        // API's raw callers - e.g. concurrency tests - never set nextIndexEntry).
        // Synthesize a trivial single-node tree so the index entry shape stays
        // consistent for anything reading `.tree` (e.g. _getRevisionTree).
        this.index[change.id] = {
            tree: synthesizeTree(change.rev, change.deleted),
            rev: change.rev,
            seq: change.seq,
            deleted: !!change.deleted,
            location: { fileId }
        };
    }

    private checkConflicts(changes: ChangeEntry[]): void {
        for (const change of changes) {
            const docId = change.id;
            const newRevNum = parseInt(change.rev.split('-')[0], 10);

            const existing = this.index[docId];
            if (existing) {
                const currentRevNum = parseInt(existing.rev.split('-')[0], 10);
                if (currentRevNum >= newRevNum) {
                    const err: any = new Error('Document update conflict');
                    err.status = 409;
                    err.name = 'conflict'; // PouchDB expectation
                    throw err;
                }
            }
        }
    }

    /** Compact: Create SnapshotIndex + SnapshotData */
    async compact(): Promise<void> {
        if (this.isCompacting) return;
        this.isCompacting = true;
        try {
            this.log('Starting compaction');
            const snapshotSeq = this.meta.seq;
            const oldLogIds = [...this.meta.changeLogIds];
            const oldIndexId = this.meta.snapshotIndexId;

            // Resolve which snapshot-data file(s) the OLD index points to, so we can
            // delete them too once the new snapshot is safely in place. Without this,
            // every compaction leaves its predecessor's data file behind as orphaned
            // clutter (the index gets cleaned up, but the (often much larger) data
            // file it pointed to never does).
            let oldDataFileIds: string[] = [];
            if (oldIndexId) {
                try {
                    const oldIndex: SnapshotIndex = await this.downloadJson(oldIndexId, true);
                    const ids = new Set<string>();
                    for (const entry of Object.values(oldIndex.entries || {})) {
                        const fid = (entry as IndexEntry).location?.fileId;
                        if (fid && fid !== 'LEGACY_MEMORY') ids.add(fid);
                    }
                    oldDataFileIds = [...ids];
                } catch (e) {
                    this.log('Failed to load old snapshot index for data-file cleanup', oldIndexId, e);
                }
            }

            // 1. Fetch ALL active documents
            // We need them to build the new large snapshot-data file
            // This is the one time we download everything if not cached. 
            // Optimization: We could reuse existing `snapshot-data` chunks and only append new data 
            // to a new chunk, but for simplicity: Merge All.

            const allIds = Object.keys(this.index).filter(id => !this.index[id].deleted && !id.startsWith('_local/'));
            const allDocs = await this.getMulti(allIds);

            const snapshotData: SnapshotDataChunk = { docs: {} };
            const missingDocs: string[] = [];
            allIds.forEach((id, i) => {
                if (allDocs[i]) {
                    snapshotData.docs[id] = allDocs[i];
                } else {
                    missingDocs.push(id);
                }
            });

            if (missingDocs.length > 0) {
                this.log('Compaction ABORTED: Failed to fetch documents', missingDocs);
                throw new Error(`Compaction failed: missing ${missingDocs.length} documents. Aborting to prevent data loss.`);
            }

            // 1b. Carry forward conflict-branch bodies too. Without this, the first
            // compaction after a real conflict exists would silently drop the losing
            // revision forever - snapshotData only ever had room for one body per id
            // before conflict tracking existed. A body that fails to fetch here is
            // logged and dropped rather than aborting the whole compaction (unlike
            // missingDocs above): losing one stale conflict branch is far less bad
            // than losing a doc's current data, and shouldn't block reclaiming space.
            const conflictFetches: Array<{ id: string; rev: string; location: FilePointer }> = [];
            for (const id of allIds) {
                const conflicts = this.index[id].conflictLocations;
                if (!conflicts) continue;
                for (const rev of Object.keys(conflicts)) {
                    conflictFetches.push({ id, rev, location: conflicts[rev] });
                }
            }
            const carriedConflicts: Record<string, Record<string, boolean>> = {};
            if (conflictFetches.length > 0) {
                snapshotData.conflicts = {};
                for (const { id, rev, location } of conflictFetches) {
                    const body = await this.getRevisionBody(id, rev, location);
                    if (!body) {
                        this.log('Compaction WARNING: could not fetch conflict body, dropping', id, rev);
                        continue;
                    }
                    if (!snapshotData.conflicts[id]) snapshotData.conflicts[id] = {};
                    snapshotData.conflicts[id][rev] = body;
                    if (!carriedConflicts[id]) carriedConflicts[id] = {};
                    carriedConflicts[id][rev] = true;
                }
            }

            // 2. Upload Data File
            const dataContent = JSON.stringify(snapshotData);
            const dataRes = await this.client.createFile(
                `snapshot-data-${Date.now()}.json`,
                [this.folderId!],
                'application/json',
                dataContent
            );
            const dataFileId = dataRes.id;

            // 3. Create Index pointing to this Data File
            const newIndexEntries: Record<string, IndexEntry> = {};
            for (const id of Object.keys(snapshotData.docs)) {
                const entry: IndexEntry = {
                    tree: this.index[id].tree,
                    rev: this.index[id].rev,
                    seq: this.index[id].seq,
                    location: { fileId: dataFileId }
                };
                if (carriedConflicts[id]) {
                    entry.conflictLocations = {};
                    for (const rev of Object.keys(carriedConflicts[id])) {
                        entry.conflictLocations[rev] = { fileId: dataFileId };
                    }
                }
                newIndexEntries[id] = entry;
            }

            const snapshotIndex: SnapshotIndex = {
                entries: newIndexEntries,
                seq: snapshotSeq,
                createdAt: Date.now()
            };

            const indexContent = JSON.stringify(snapshotIndex);
            const indexRes = await this.client.createFile(
                `snapshot-index-${Date.now()}.json`,
                [this.folderId!],
                'application/json',
                indexContent
            );
            const newIndexId = indexRes.id;

            // 4. Update Meta. Only the logs THIS handler had already replayed are
            // retired; anything another writer appended in the meantime stays in
            // changeLogIds and gets replayed on top of the new snapshot.
            let filesToDelete: string[] = [];
            const committed = await this.commitMeta(
                (latest) => {
                    const remainingLogs = latest.changeLogIds.filter(id => !oldLogIds.includes(id));
                    // Only delete files that were in oldLogIds but not in remainingLogs
                    filesToDelete = oldLogIds.filter(id => !remainingLogs.includes(id));
                    const retired = [...(latest.retiredLogIds || []), ...filesToDelete];
                    return {
                        ...latest,
                        snapshotIndexId: newIndexId,
                        changeLogIds: remainingLogs,
                        // Tombstones, so the writers of those logs don't put them back.
                        retiredLogIds: [...new Set(retired)].slice(-RETIRED_LOG_HISTORY),
                        lastCompaction: Date.now()
                    };
                },
                {
                    verify: (m) => m.snapshotIndexId === newIndexId &&
                        !filesToDelete.some(id => m.changeLogIds.includes(id))
                }
            );

            // 5. Cleanup - ONLY once we have read back the metadata that de-references
            // these files. Until that write is confirmed, the change logs are still
            // the only copy of everything in them, and deleting on the strength of an
            // unverified write is how a lost update turns into lost documents. If the
            // commit never stuck, the new snapshot files are left behind unreferenced
            // rather than deleted - a reader may already have picked them up.
            if (!committed) {
                this.log('Compaction: metadata never committed, keeping every change log', {
                    snapshotIndexId: newIndexId,
                    logs: oldLogIds.length
                });
                return;
            }
            for (const id of filesToDelete) this.ownLogIds.delete(id);
            const staleDataFileIds = oldDataFileIds.filter(id => id !== dataFileId);
            await this.cleanupOldFiles(oldIndexId, [...filesToDelete, ...staleDataFileIds]);
            this.currentLogSizeEstimate = 0;
        } finally {
            this.isCompacting = false;
        }
    }

    // --- _meta.json: the one piece of shared mutable state --------------------
    //
    // Drive API v3 has no compare-and-swap. ETags are gone from the API, so the
    // If-Match header saveMeta() still sends is honoured by the emulated server and
    // silently ignored by Drive itself - which is what let two clients read the same
    // metadata, append their own change log, and each write back a changeLogIds list
    // that did not mention the other's. The losing log stayed in the folder,
    // referenced by nothing, invisible to every reader.
    //
    // Four things stand in for the missing CAS:
    //
    //   1. every commit builds on metadata read from Drive moments earlier, never on
    //      this handler's cached copy, so the window in which a concurrent writer can
    //      be clobbered is one round trip instead of the client's whole lifetime;
    //   2. modifiers merge into that copy rather than replacing it, so whatever
    //      another writer added survives;
    //   3. commits that matter re-read afterwards and retry if what they wrote is not
    //      there, which catches the writer who read just before we wrote;
    //   4. and a writer remembers the logs it wrote (ownLogIds), so anything dropped
    //      despite all of the above is restored on its next load or commit.

    /** Run `fn` after every meta mutation this handler has already queued has
     *  settled. Never call this from inside a commitMeta modifier - it would wait on
     *  itself. */
    private withMetaLock<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.metaLock.then(fn, fn);
        this.metaLock = run.then(() => undefined, () => undefined);
        return run;
    }

    private async backoff(attempt: number): Promise<void> {
        const ceiling = Math.min(100 * Math.pow(2, attempt), 2000);
        await new Promise(r => setTimeout(r, ceiling * (0.5 + Math.random())));
    }

    /** Locate _meta.json and read its body straight from Drive, past every cache. */
    private async readRemoteMeta(): Promise<{ meta: MetaData; pointer: FilePointer } | null> {
        const pointer = await this.findFile('_meta.json');
        if (!pointer) {
            this.metaFileId = null;
            return null;
        }
        this.metaFileId = pointer.fileId;
        const meta = await this.readMetaBody(pointer.fileId);
        return meta ? { meta, pointer } : null;
    }

    /** Read a known _meta.json by id - no folder listing, no cache. Used by the
     *  post-write verification pass, which only needs the body. */
    private async readMetaBody(fileId: string): Promise<MetaData | null> {
        this.fileCache.remove(fileId);
        const raw = await this.client.getFile(fileId);
        if (typeof raw === 'string') return JSON.parse(raw) as MetaData;
        if (raw && typeof raw === 'object') return JSON.parse(JSON.stringify(raw)) as MetaData;
        return null;
    }

    private adoptMeta(meta: MetaData, pointer: FilePointer): void {
        this.meta = meta;
        this.metaFileId = pointer.fileId;
        this.metaEtag = pointer.etag || null;
        this.metaMd5 = pointer.md5Checksum || null;
        this.metaModifiedTime = pointer.modifiedTime || null;
    }

    /** True when the folder holds changes this handler has not replayed - another
     *  writer appended, or compacted, since our last load. */
    private hasUnprocessedLogs(meta: MetaData): boolean {
        if (meta.snapshotIndexId !== this.currentSnapshotIndexId) return true;
        return meta.changeLogIds.some(id => !this.processedLogIds.has(id));
    }

    /** True when a change log we wrote has fallen out of `changeLogIds` without a
     *  compaction retiring it - i.e. someone else's write dropped it. */
    private hasOrphanedOwnLogs(meta: MetaData): boolean {
        if (this.ownLogIds.size === 0) return false;
        const present = new Set(meta.changeLogIds);
        const retired = new Set(meta.retiredLogIds || []);
        for (const id of this.ownLogIds) {
            if (!present.has(id) && !retired.has(id)) return true;
        }
        return false;
    }

    /** Put back any such log. Returns `latest` by identity when there is nothing to
     *  repair, so callers can tell the two cases apart. */
    private reconcileOwnLogs(latest: MetaData): MetaData {
        if (this.ownLogIds.size === 0) return latest;
        const present = new Set(latest.changeLogIds);
        const retired = new Set(latest.retiredLogIds || []);
        const missing: string[] = [];
        for (const id of [...this.ownLogIds]) {
            if (retired.has(id)) {
                this.ownLogIds.delete(id); // folded into a snapshot - not ours to defend
                continue;
            }
            if (!present.has(id)) missing.push(id);
        }
        if (missing.length === 0) return latest;
        this.log('Restoring change logs dropped by another writer', missing);
        return { ...latest, changeLogIds: [...latest.changeLogIds, ...missing] };
    }

    /**
     * Read-modify-write `_meta.json`.
     *
     * `modify` receives the current remote metadata (with any of our dropped logs
     * already restored, which `repaired` reports) and returns the value to write, or
     * null to abandon the commit because its assumptions no longer hold. This method
     * also returns null when it runs out of attempts. Either way nothing durable has
     * changed and the caller must not act as though it had.
     */
    private commitMeta(
        modify: (latest: MetaData, repaired: boolean) => MetaData | null,
        opts: { verify?: (committed: MetaData) => boolean } = {}
    ): Promise<MetaData | null> {
        return this.withMetaLock(async () => {
            for (let attempt = 0; attempt < META_COMMIT_RETRIES; attempt++) {
                const current = await this.readRemoteMeta();
                if (!current) throw new Error('Meta missing');

                const reconciled = this.reconcileOwnLogs(current.meta);
                const next = modify(reconciled, reconciled !== current.meta);
                if (!next) return null;

                try {
                    await this.saveMeta(next, current.pointer);
                } catch (err: any) {
                    if (err.status === 412 || err.status === 409) {
                        await this.backoff(attempt);
                        continue;
                    }
                    throw err;
                }

                if (!opts.verify) {
                    this.meta = next;
                    return next;
                }

                const after = await this.readMetaBody(current.pointer.fileId);
                if (after && opts.verify(after)) {
                    // Adopt the remote view rather than our own - it carries whatever
                    // else landed alongside us.
                    this.meta = after;
                    return after;
                }
                this.log('Meta commit did not survive, retrying', { attempt });
                await this.backoff(attempt);
            }
            this.log('Meta commit abandoned after', META_COMMIT_RETRIES, 'attempts');
            return null;
        });
    }

    /** Create _meta.json for a folder that has none. Two clients opening the same
     *  empty folder both end up here and Drive will happily keep two files with the
     *  same name, after which every client picks between them at random. Settle it
     *  deterministically instead: lowest file id wins, the loser deletes its own and
     *  adopts the winner. */
    private async ensureMetaFile(): Promise<void> {
        await this.saveMeta(this.meta, null);
        const mine = this.metaFileId;
        const rivals = await this.findFiles('_meta.json');
        if (rivals.length < 2 || !mine) return;

        const winner = rivals.map(f => f.fileId).sort()[0];
        if (winner === mine) {
            this.log('Won the _meta.json creation race', { mine, rivals: rivals.length });
            return;
        }
        this.log('Lost the _meta.json creation race, adopting', winner);
        try {
            await this.client.deleteFile(mine);
        } catch (e) {
            this.log('Failed to remove duplicate _meta.json', mine, e);
        }
        const adopted = await this.readRemoteMeta();
        if (adopted) this.adoptMeta(adopted.meta, adopted.pointer);
    }

    // Reused helpers
    private async findOrCreateFolder(): Promise<string> {
        const safeName = this.escapeQuery(this.folderName);
        const q = `name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
        const files = await this.client.listFiles(q);
        if (files.length > 0) return files[0].id;

        const createRes = await this.client.createFile(
            this.folderName,
            this.parents.length ? this.parents : undefined,
            'application/vnd.google-apps.folder',
            ''
        );
        return createRes.id;
    }

    /** Every change log in the folder, whatever _meta.json has to say about them.
     *
     *  The folder is the authority on which change logs exist; _meta.json is only a
     *  cache of that, and a lossy one - it is a whole-file read-modify-write with no
     *  compare-and-swap behind it, so a writer whose metadata lands and is then
     *  overwritten by a slower writer loses its reference. The file is still right
     *  here. Listing for it is what stops a lost update from becoming a lost
     *  document. */
    private async listChangeLogs(): Promise<Array<{ id: string; name: string }>> {
        const q = `name contains 'changes-' and '${this.folderId}' in parents and trashed = false`;
        const files = await this.client.listFiles(q);
        return files.filter(f => f.name.startsWith('changes-')).map(f => ({ id: f.id, name: f.name }));
    }

    /**
     * Give up a sequence slot another writer is already using.
     *
     * Slots make sequence collisions structurally impossible only between writers on
     * *different* slots; two ids hashing to the same slot are back to the dense
     * allocation this scheme replaced. The filenames the folder listing hands us
     * carry every writer's id, so a contested slot is visible - and since this
     * handler re-rolls before minting anything against what it just saw, the
     * exposure shrinks from "the whole session" to "rival's first log not yet
     * visible in a listing".
     *
     * Logs already written keep their old name and numbers; ownLogIds tracks file
     * ids, not names, so nothing else cares.
     */
    private rerollIfSlotContested(logNames: string[]): void {
        const rivalSlots = new Set<number>();
        for (const name of logNames) {
            const id = writerIdFromLogName(name);
            if (id && id !== this.writerId) rivalSlots.add(writerSlotFor(id));
        }
        if (!rivalSlots.has(this.writerSlot)) return;

        for (let attempt = 0; attempt < 50; attempt++) {
            const candidateId = newWriterId();
            const candidateSlot = writerSlotFor(candidateId);
            if (!rivalSlots.has(candidateSlot)) {
                this.log('Sequence slot contested, re-rolling writer id', {
                    from: { writerId: this.writerId, slot: this.writerSlot },
                    to: { writerId: candidateId, slot: candidateSlot }
                });
                this.writerId = candidateId;
                this.writerSlot = candidateSlot;
                return;
            }
        }
        // ~50 rivals colliding with 50 fresh rolls in a million-slot space does not
        // happen by chance; leave the slot alone rather than loop forever.
        this.log('Could not find a free sequence slot, keeping', this.writerSlot);
    }

    /** Every file in the folder with this name. Drive allows duplicates, so this is
     *  how the callers that care (see ensureMetaFile) find out there are any. */
    private async findFiles(name: string): Promise<FilePointer[]> {
        const safeName = this.escapeQuery(name);
        const q = `name = '${safeName}' and '${this.folderId}' in parents and trashed = false`;
        const files = await this.client.listFiles(q);
        return files.map(file => ({
            fileId: file.id,
            etag: file.etag,
            md5Checksum: (file as any).md5Checksum,
            modifiedTime: file.modifiedTime
        } as FilePointer));
    }

    private async findFile(name: string): Promise<FilePointer | null> {
        const safeName = this.escapeQuery(name);
        const q = `name = '${safeName}' and '${this.folderId}' in parents and trashed = false`;
        const files = await this.client.listFiles(q);
        if (files.length > 0) {
            let file = files[0];
            if (!file.etag) {
                try {
                    file = await this.client.getFileMetadata(file.id);
                } catch (e) {
                    this.log('Failed to fetch file metadata for etag', file.id, e);
                }
            }
            return {
                fileId: file.id,
                etag: file.etag,
                md5Checksum: (file as any).md5Checksum,
                modifiedTime: file.modifiedTime
            } as FilePointer;
        }
        return null;
    }

    private async downloadJson(fileId: string, skipCache: boolean = false): Promise<any> {
        return await this.fetchFile(fileId, skipCache);
    }

    private async downloadFileAny(fileId: string): Promise<any> {
        return await this.fetchFile(fileId);
    }

    private async downloadNdjson(fileId: string): Promise<ChangeEntry[]> {
        return await this.fetchFile(fileId);
    }

    private async writeChangeFile(changes: ChangeEntry[]): Promise<string> {
        const lines = changes.map(c => JSON.stringify(c)).join('\n') + '\n';
        const startSeq = changes[0].seq;
        // The writer id makes the name unique even when two clients do manage to
        // stamp the same starting sequence number, and says who wrote it.
        const name = `changes-${startSeq}-${this.writerId}-${Math.random().toString(36).substring(7)}.ndjson`;

        const res = await this.client.createFile(
            name,
            [this.folderId!],
            'application/x-ndjson',
            lines
        );

        this.currentLogSizeEstimate += new Blob([lines]).size;
        return res.id;
    }

    /** Write `meta` to _meta.json. `target` is the file to write, as already
     *  located by the caller; pass null to force creation, or omit it to look the
     *  file up. */
    private async saveMeta(meta: MetaData, target?: FilePointer | null): Promise<void> {
        const content = JSON.stringify(meta);
        const metaFile = target !== undefined ? target : await this.findFile('_meta.json');

        if (metaFile) {
            // If-Match is a no-op against Drive v3, which dropped ETags - it still
            // guards the emulated server and costs nothing, but nothing here may
            // assume it was enforced. See the commitMeta block above.
            const res = await this.client.updateFile(metaFile.fileId, content, metaFile.etag || undefined);
            this.metaFileId = metaFile.fileId;
            this.metaEtag = res.etag;
            this.metaMd5 = (res as any).md5Checksum || null;
            this.metaModifiedTime = res.modifiedTime;
            this.fileCache.remove(metaFile.fileId); // Invalidate cache
        } else {
            const res = await this.client.createFile('_meta.json', [this.folderId!], 'application/json', content);
            this.metaFileId = res.id;
            this.metaEtag = res.etag;
            this.metaMd5 = (res as any).md5Checksum || null;
            this.metaModifiedTime = res.modifiedTime;
        }
    }

    private async countTotalChanges(): Promise<number> {
        // Count change-log files, not changes. This used to return meta.seq when there
        // was no snapshot yet, on the reasoning that the counter and the change count
        // were the same number. Sequence numbers now carry a writer slot in their low
        // digits (see SEQ_SLOTS), so meta.seq is about a million times the tick and
        // would trigger a compaction on the very first write.

        // Each log file ID in changeLogIds represents some number of changes.
        // For simplicity and to trigger compaction based on file count (which is what matters for Drive),
        // we can return the number of log files. 
        // But since compactionThreshold is usually in ENTRIES, let's keep a rough estimate
        // or just return the log file count if that's what the user expects.
        // The previous "* 5" was too aggressive. 
        // Let's assume on average 1 change per log file in tests (worst case).
        return this.meta.changeLogIds.length + this.pendingChanges.length;
    }

    private async cleanupOldFiles(oldIndexId: string | null, oldLogIds: string[]): Promise<void> {
        const deleteFile = async (fileId: string) => {
            try {
                await this.client.deleteFile(fileId);
                this.log('Deleted file', fileId);
            } catch (err: any) {
                // 404 is ok - file already deleted or doesn't exist
                if (err.status === 404 || err.code === 404) {
                    this.log('File already deleted or not found', fileId);
                    return;
                }
                // Log other errors but don't fail
                this.log('Failed to delete file', fileId, err);
            }
        };

        if (oldIndexId) {
            await deleteFile(oldIndexId);
        }
        for (const id of oldLogIds) {
            await deleteFile(id);
        }
    }

    /**
     * Watch _meta.json for writes by other clients.
     *
     * This is the only thing that makes `db.changes({ live: true })` fire for a
     * *remote* write: on a change it calls load(), which replays the newly
     * referenced logs and emits exactly those through notifyListeners. Without it a
     * client only ever hears about what it wrote itself, so connect-and-read works
     * and continuous sync between two connected clients does not.
     *
     * Change is detected by md5Checksum, falling back to modifiedTime. There is
     * deliberately no ETag comparison: Drive API v3 has none (see
     * docs/adr/0001-metadata-writes-without-compare-and-swap.md), so that branch
     * could only ever compare '' against '' - and sitting first in the chain, it
     * shadowed the two comparisons that do work.
     */
    private startPolling(intervalMs: number): void {
        if (isNaN(intervalMs) || intervalMs <= 0) return;
        if (this.pollingInterval) return; // already watching
        this.log('Starting polling with interval', { intervalMs });

        this.pollingInterval = setInterval(async () => {
            if (this.isPollingActive) {
                this.log('Polling already in progress, skipping tick');
                return;
            }
            this.isPollingActive = true;
            try {
                const metaFile = await this.findFile('_meta.json');
                if (!metaFile) {
                    this.log('Polling: _meta.json not found');
                    return;
                }

                const remoteMd5 = metaFile.md5Checksum;
                const remoteModified = metaFile.modifiedTime;
                const changed = remoteMd5 && this.metaMd5
                    ? remoteMd5 !== this.metaMd5
                    : remoteModified !== this.metaModifiedTime;

                if (changed) {
                    this.log('Polling detected change', { remoteMd5, remoteModified });
                    // load() emits precisely what it replayed. Announcing the whole
                    // index instead is what used to send PouchDB sync in circles.
                    await this.load();
                }
            } catch (err) {
                this.log('Polling error', err);
            } finally {
                this.isPollingActive = false;
            }
        }, intervalMs);
    }

    private notifyListeners(changedDocs?: Record<string, any>) {
        const changes: Record<string, any> = changedDocs || {};
        
        // If no specifically changed docs provided, we don't want to firehose the whole index anymore
        // as it causes reprocessing loops in PouchDB sync.
        if (Object.keys(changes).length === 0) return;

        for (const cb of this.listeners) {
            try {
                cb(changes);
            } catch (e) {
                this.log('Error in change listener callback', e);
            }
        }
    }

    // For tests/debug
    onChange(cb: (changes: Record<string, any>) => void) {
        this.listeners.push(cb);
        return () => {
            this.listeners = this.listeners.filter(l => l !== cb);
        };
    }

    stopPolling() { if (this.pollingInterval) clearInterval(this.pollingInterval); }

    private escapeQuery(value: string): string {
        return value.replace(/'/g, "\\'");
    }

    async deleteFolder() { if (this.folderId) await this.client.deleteFile(this.folderId); }
    getNextSeq() { return this.meta.seq + 1; }
}
