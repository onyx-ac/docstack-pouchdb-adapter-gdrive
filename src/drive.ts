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
    private metaModifiedTime: string | null = null;

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

    private log(...args: any[]) {
        if (this.debug) console.log(`[googledrive-drive] [${this.meta.dbName}]`, ...args);
    }



    constructor(options: GoogleDriveAdapterOptions, dbName: string) {
        this.client = new GoogleDriveClient(options);
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
                if (!this.folderId) {
                    this.folderId = await this.findOrCreateFolder();
                }

                const metaFile = await this.findFile('_meta.json');
                if (metaFile) {
                    this.meta = await this.downloadJson(metaFile.id);
                    this.metaEtag = metaFile.etag || null;
                    this.metaModifiedTime = metaFile.modifiedTime || null;
                } else {
                    await this.saveMeta(this.meta);
                }

                if (this.meta.snapshotIndexId !== this.currentSnapshotIndexId) {
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
                        try {
                            const legacySnapshot = await this.downloadJson((this.meta as any).snapshotId);
                            this.filesFromLegacySnapshot(legacySnapshot);
                        } catch (e) {
                            console.warn('Failed to load legacy snapshot', e);
                        }
                    }
                }

                // 2. Replay NEW Change Logs (Metadata only updates)
                for (const logId of this.meta.changeLogIds) {
                    if (this.processedLogIds.has(logId)) continue;

                    const changes = await this.downloadNdjson(logId);
                    this.currentLogSizeEstimate += 100 * changes.length;

                    for (const change of changes) {
                        this.updateIndex(change, logId);
                        if (this.docCache.get(change.id)) {
                            this.docCache.remove(change.id);
                        }
                    }
                    this.processedLogIds.add(logId);
                }

                // 3. Start Polling (if enabled)
                if (this.options.pollingIntervalMs) {
                    this.startPolling(this.options.pollingIntervalMs);
                }
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
    private async fetchFile(fileId: string): Promise<any> {
        const cached = this.fileCache.get(fileId);
        if (cached) {
            this.log('fetchFile cache hit', fileId);
            return cached;
        }

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
                        // Optional: if we know it was supposed to be NDJSON? 
                        // Our change files are always NDJSON. 
                        // But _meta.json and snapshot-*.json are regular JSON.
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

        this.fileCache.put(fileId, parsed);
        return parsed;
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
    getIndexKeys(): string[] {
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
        let attempt = 0;

        while (attempt < MAX_RETRIES) {
            try {
                return await this.tryAppendChanges(changes);
            } catch (err: any) {
                if (err.status === 412 || err.status === 409) {
                    // Reload and RETRY
                    await this.load();
                    // Check conflicts against Index (Metadata sufficient)
                    this.checkConflicts(changes);

                    // Reseq
                    let currentSeq = this.meta.seq;
                    for (const change of changes) {
                        currentSeq++;
                        change.seq = currentSeq;
                    }
                    attempt++;
                    await new Promise(r => setTimeout(r, Math.random() * 500 + 100));
                    continue;
                }
                throw err;
            }
        }
        throw new Error('Failed to append changes');
    }

    private async tryAppendChanges(changes: ChangeEntry[]): Promise<void> {
        // 1. Write Log File (Upload Data)
        const fileId = await this.writeChangeFile(changes);

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

        // 5. Compaction Check
        // Count changes since last compaction *pointer*, not just list length
        const totalChanges = await this.countTotalChanges();
        if (totalChanges >= this.compactionThreshold ||
            this.currentLogSizeEstimate >= this.compactionSizeThreshold) {
            this.compact().catch(e => console.error('Compaction failed', e));
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
        const snapshotSeq = this.meta.seq;
        const oldLogIds = [...this.meta.changeLogIds];
        const oldIndexId = this.meta.snapshotIndexId;

        // 1. Fetch ALL active documents
        // We need them to build the new large snapshot-data file
        // This is the one time we download everything if not cached. 
        // Optimization: We could reuse existing `snapshot-data` chunks and only append new data 
        // to a new chunk, but for simplicity: Merge All.

        const allIds = Object.keys(this.index).filter(id => !this.index[id].deleted);
        const allDocs = await this.getMulti(allIds);

        const snapshotData: SnapshotDataChunk = { docs: {} };
        allIds.forEach((id, i) => {
            if (allDocs[i]) snapshotData.docs[id] = allDocs[i];
        });

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
        await this.atomicUpdateMeta((latest) => {
            const remainingLogs = latest.changeLogIds.filter(id => !oldLogIds.includes(id));
            return {
                ...latest,
                snapshotIndexId: newIndexId,
                changeLogIds: remainingLogs,
                lastCompaction: Date.now()
            };
        });

        // 5. Cleanup
        this.cleanupOldFiles(oldIndexId, oldLogIds); // And potentially old data files if we tracked them
        this.currentLogSizeEstimate = 0;
    }

    // ... Helpers (atomicUpdateMeta, saveMeta, writeChangeFile same as before) ...

    private async atomicUpdateMeta(modifier: (meta: MetaData) => MetaData): Promise<void> {
        const MAX_RETRIES = 5;
        let attempt = 0;
        while (attempt < MAX_RETRIES) {
            try {
                const metaFile = await this.findFile('_meta.json');
                if (!metaFile) throw new Error('Meta missing');
                const validMeta = await this.downloadJson(metaFile.id);
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

    private async findFile(name: string): Promise<{ id: string, etag: string, modifiedTime: string } | null> {
        if (!this.folderId) return null;
        const safeName = this.escapeQuery(name);
        const q = `name = '${safeName}' and '${this.folderId}' in parents and trashed = false`;
        const files = await this.client.listFiles(q);
        if (files.length > 0) return {
            id: files[0].id,
            etag: files[0].etag || '',
            modifiedTime: files[0].modifiedTime || ''
        };
        return null;
    }

    private async downloadJson(fileId: string): Promise<any> {
        return await this.fetchFile(fileId);
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
            const res = await this.client.updateFile(metaFile.id, content, expectedEtag || undefined);
            this.metaEtag = res.etag;
            this.metaModifiedTime = res.modifiedTime;
        } else {
            const res = await this.client.createFile('_meta.json', [this.folderId!], 'application/json', content);
            this.metaEtag = res.etag;
            this.metaModifiedTime = res.modifiedTime;
        }
    }

    private async countTotalChanges(): Promise<number> {
        // Calculate diff between meta.seq and snapshot seq
        // But we don't store snapshot seq in meta directly?
        // We can approximate by pending changes count + known gaps?
        // Actually we used to check snapshot.seq. 
        // We can assume snapshot is somewhat recent.
        return this.pendingChanges.length + 10; // dummy for now, rely on log size
    }

    private async cleanupOldFiles(oldIndexId: string | null, oldLogIds: string[]) {
        if (oldIndexId) try { await this.client.deleteFile(oldIndexId); } catch { }
        for (const id of oldLogIds) try { await this.client.deleteFile(id); } catch { }
    }

    private startPolling(intervalMs: number): void {
        if (this.pollingInterval) clearInterval(this.pollingInterval);
        this.pollingInterval = setInterval(async () => {
            if (this.isPollingActive) return;
            this.isPollingActive = true;
            try {
                const metaFile = await this.findFile('_meta.json');
                if (!metaFile) return;
                // Use modifiedTime for polling as it's readable in projections
                if (metaFile.modifiedTime !== this.metaModifiedTime) {
                    this.log('Polling detected change', metaFile.modifiedTime);
                    await this.load();
                    this.notifyListeners();
                }
            } catch (err) {
                console.error('Polling error', err);
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
            changes[id] = { _id: id, _rev: entry.rev, _deleted: entry.deleted };
        }
        for (const l of this.listeners) l(changes);
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
