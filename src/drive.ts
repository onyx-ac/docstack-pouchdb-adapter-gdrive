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

                const metaFile = await this.findFile('_meta.json');
                if (metaFile) {
                    this.log('Retrieved meta file', { fileId: metaFile.fileId });
                    this.meta = await this.downloadJson(metaFile.fileId, true); // No cache for meta
                    this.metaEtag = metaFile.etag || null;
                    this.metaMd5 = metaFile.md5Checksum || null;
                    this.metaModifiedTime = metaFile.modifiedTime || null;
                } else {
                    this.log('Meta file not found, creating new');
                    await this.saveMeta(this.meta);
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
                const pendingLogs = this.meta.changeLogIds.filter(id => !this.processedLogIds.has(id));
                
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

                    for (const { id, changes } of logResults) {
                        if (!changes) {
                            this.log(`Skipping failed log ${id}`);
                            continue;
                        }

                        let changesArray = Array.isArray(changes) ? changes : [changes];
                        this.currentLogSizeEstimate += 100 * changesArray.length;

                        for (const change of changesArray) {
                            this.log('Processing change, sequence', change.seq);
                            this.updateIndex(change, id);
                            if (this.docCache.get(change.id)) {
                                this.docCache.remove(change.id);
                            }
                        }
                        this.processedLogIds.add(id);
                        this.log('Processed log', id);
                    }
                }

                // 2. Replay NEW Change Logs (Metadata only updates)
                // ... (previous logic for change logs)
                // (Already updated in previous turn, keep it)

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

                // 3. Start Polling ...
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
            this.docCache.put(id, doc);
            doc._rev = entry.rev;
        }

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
                    // Reload and RETRY
                    await this.load();
                    // Check conflicts against Index (Metadata sufficient)
                    this.checkConflicts(remote);

                    // Reseq
                    let currentSeq = this.meta.seq;
                    for (const change of remote) {
                        currentSeq++;
                        change.seq = currentSeq;
                    }
                    attemptNum++;
                    await new Promise(r => setTimeout(r, Math.random() * 500 + 100));
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
                    await this.atomicUpdateMeta((latest) => ({ ...latest, localDocsId: res.id }));
                }
                
                this.localDocsEtag = res.etag;
                // Update Index
                for (const change of changes) {
                   this.updateIndex(change, res.id);
                   if (change.doc) this.docCache.put(change.id, change.doc);
                   else this.docCache.remove(change.id);
                }
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
        // 1. Write Log File (Upload Data)
        const fileId = await this.writeChangeFile(changes);

        try {
            // 2. Prepare speculative meta update
            const nextMeta = { ...this.meta };
            nextMeta.changeLogIds = [...nextMeta.changeLogIds, fileId];
            nextMeta.seq = changes[changes.length - 1].seq;

            // 3. Commit Lock
            await this.saveMeta(nextMeta, this.metaEtag);

            // 4. Update Local State
            this.meta = nextMeta;

            for (const change of changes) {
                this.updateIndex(change, fileId);
                if (change.doc) {
                    this.docCache.put(change.id, change.doc);
                } else if (change.deleted) {
                    this.docCache.remove(change.id);
                }
            }

            // Notify local changes feed listeners about our own write
            this.notifyListeners();

            // 5. Compaction Check
            const totalChanges = await this.countTotalChanges();
            if (totalChanges >= this.compactionThreshold ||
                this.currentLogSizeEstimate >= this.compactionSizeThreshold) {
                this.compact().catch(e => console.error('Compaction failed', e));
            }
        } catch (err) {
            // Cleanup orphaned log file on metadata update failure
            this.client.deleteFile(fileId).catch(e => this.log('Failed to cleanup orphaned log', fileId, e));
            throw err;
        }
    }

    /** Update Index with a new change */
    private updateIndex(change: ChangeEntry, fileId: string) {
        this.index[change.id] = {
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
            newIndexEntries[id] = {
                rev: this.index[id].rev,
                seq: this.index[id].seq,
                location: { fileId: dataFileId }
            };
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

        // 4. Update Meta
        let filesToDelete: string[] = [];
        await this.atomicUpdateMeta((latest) => {
            const remainingLogs = latest.changeLogIds.filter(id => !oldLogIds.includes(id));
            // Only delete files that were in oldLogIds but not in remainingLogs
            filesToDelete = oldLogIds.filter(id => !remainingLogs.includes(id));
            return {
                ...latest,
                snapshotIndexId: newIndexId,
                changeLogIds: remainingLogs,
                lastCompaction: Date.now()
            };
        });

        // 5. Cleanup - Only delete files that were confirmed removed from metadata
        await this.cleanupOldFiles(oldIndexId, filesToDelete);
        this.currentLogSizeEstimate = 0;
        } finally {
            this.isCompacting = false;
        }
    }

    // ... Helpers (atomicUpdateMeta, saveMeta, writeChangeFile same as before) ...

    private async atomicUpdateMeta(modifier: (meta: MetaData) => MetaData): Promise<void> {
        const MAX_RETRIES = 5;
        let attempt = 0;
        while (attempt < MAX_RETRIES) {
            try {
                const metaFile = await this.findFile('_meta.json');
                if (!metaFile) throw new Error('Meta missing');
                const validMeta = await this.downloadJson(metaFile.fileId, true); // No cache
                const newMeta = modifier(validMeta);
                await this.saveMeta(newMeta, metaFile.etag);
                this.meta = newMeta;
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

    private async findFile(name: string): Promise<FilePointer | null> {
        const pending = this.pendingFinds.get(name);
        if (pending) {
            this.log('findFile reuse pending search', name);
            return await pending;
        }

        const findPromise = (async () => {
            const safeName = this.escapeQuery(name);
            const q = `name = '${safeName}' and '${this.folderId}' in parents and trashed = false`;
            try {
                const files = await this.client.listFiles(q);
                if (files.length > 0) {
                    let file = files[0];
                    if (!file.etag) {
                        // Robustness: Fetch metadata for the file if etag is missing from list
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
            } finally {
                this.pendingFinds.delete(name);
            }
        })();

        this.pendingFinds.set(name, findPromise);
        return await findPromise;
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
        const name = `changes-${startSeq}-${Math.random().toString(36).substring(7)}.ndjson`;

        const res = await this.client.createFile(
            name,
            [this.folderId!],
            'application/x-ndjson',
            lines
        );

        this.currentLogSizeEstimate += new Blob([lines]).size;
        return res.id;
    }

    private async saveMeta(meta: MetaData, expectedEtag: string | null = null): Promise<void> {
        const content = JSON.stringify(meta);
        const metaFile = await this.findFile('_meta.json');

        if (metaFile) {
            const res = await this.client.updateFile(metaFile.fileId, content, expectedEtag || undefined);
            this.metaEtag = res.etag;
            this.metaMd5 = (res as any).md5Checksum || null;
            this.metaModifiedTime = res.modifiedTime;
            this.fileCache.remove(metaFile.fileId); // Invalidate cache
        } else {
            const res = await this.client.createFile('_meta.json', [this.folderId!], 'application/json', content);
            this.metaEtag = res.etag;
            this.metaMd5 = (res as any).md5Checksum || null;
            this.metaModifiedTime = res.modifiedTime;
        }
    }

    private async countTotalChanges(): Promise<number> {
        // If no snapshot exists yet, total changes = meta.seq (all changes)
        if (!this.meta.snapshotIndexId) {
            return this.meta.seq;
        }

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

    private startPolling(intervalMs: number): void {
        this.log('Starting polling with interval', { intervalMs });
        if (isNaN(intervalMs) || intervalMs <= 0) return;
        if (this.pollingInterval) clearInterval(this.pollingInterval);

        this.pollingInterval = setInterval(async () => {
            this.log('Polling tick...');
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

                // Compare etags, falling back to md5Checksum or modifiedTime
                const remoteEtag = metaFile.etag;
                const remoteMd5 = metaFile.md5Checksum;
                const remoteModified = metaFile.modifiedTime;

                this.log('Polling: comparing etag', remoteEtag, 'with', this.metaEtag, 'md5', remoteMd5, 'with', this.metaMd5);
                
                let changed = false;
                if (remoteEtag && this.metaEtag) {
                    if (remoteEtag !== this.metaEtag) changed = true;
                } else if (remoteMd5 && this.metaMd5) {
                    if (remoteMd5 !== this.metaMd5) changed = true;
                } else if (remoteModified !== this.metaModifiedTime) {
                    changed = true;
                }

                if (changed) {
                    this.log('Polling detected change!', remoteEtag || remoteMd5 || remoteModified);
                    await this.load();
                    this.notifyListeners();
                }
            } catch (err) {
                this.log('Polling error', err);
            } finally {
                this.isPollingActive = false;
            }
        }, intervalMs);
    }

    private notifyListeners() {
        // Observers expecting 'docs' object might be broken if they expect FULL body.
        // We can pass empty object or partials?
        // Real PouchDB changes feed calls `db.changes()`. 
        // Our `adapter.js` uses `db.onChange` effectively.
        // We should pass a map of { ID: { _rev, ... } } (Index entries)
        // Adapter needs to handle this.
        const changes: Record<string, any> = {};
        for (const [id, entry] of Object.entries(this.index)) {
            changes[id] = { 
                _id: id, 
                _rev: entry.rev, 
                _deleted: !!entry.deleted,
                seq: entry.seq // IMPORTANT: Missing previously, preventing filtered changes from working
            };
        }
        for (const cb of this.listeners) cb(changes);
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
