import { DriveClientOptions } from './client';

/** Global fetch type for environments that might need it (Node < 18 polyfills) */
declare const fetch: any;

/** Options for configuring the Google Drive adapter */
export interface GoogleDriveAdapterOptions extends DriveClientOptions {
    /** Specific folder ID to use as the DB root */
    folderId?: string;
    /** Folder name to search/create if no ID provided */
    folderName?: string;
    /** Parent folder IDs for folder creation */
    parents?: string[];
    /** Interval in ms to check for remote changes */
    pollingIntervalMs?: number;
    /** Compaction threshold - number of change entries before auto-compact */
    compactionThreshold?: number;
    /** Compaction threshold - size in bytes before auto-compact */
    compactionSizeThreshold?: number;
    /** Cache size (number of documents) */
    cacheSize?: number;
    /** Enable debug logging */
    debug?: boolean;
    /**
     * Called as load() replays change logs, the phase where a cold connect to a
     * busy folder can otherwise look frozen (a real-world boot has been seen with
     * 72 logs pending). `done` counts logs applied so far out of `total` for THIS
     * load; a later load that finds new logs starts a fresh cycle at 0. Errors
     * thrown by the callback are swallowed - progress reporting must never be able
     * to fail a load.
     */
    onSyncProgress?: (progress: { phase: 'replay'; done: number; total: number }) => void;
    /** Enable test mode (emulates Google Drive API) */
    testMode?: boolean;
    /** Test server URL (defaults to http://localhost:3000) */
    testServerUrl?: string;
}

/** A single change entry in the append-only log */
export interface ChangeEntry {
    /** Sequence number of this change */
    seq: number;
    /** Document ID */
    id: string;
    /** New revision */
    rev: string;
    /** Whether document was deleted */
    deleted?: boolean;
    /** The document data (omitted for deletes) */
    doc?: Record<string, any>;
    /** Timestamp of the change */
    timestamp: number;
    /**
     * When set (computed by adapter.ts's `_bulkDocs` via pouchdb-merge before
     * appending), fully describes the resulting IndexEntry for this doc - any
     * `location`/`conflictLocations[rev]` that should point at *this* change's own
     * (not-yet-uploaded) file is left as `{fileId: '__SELF__'}`;
     * `DriveHandler.updateIndex()` substitutes the real fileId once known.
     * Absent for the low-level `DriveHandler.appendChange()` API's raw callers
     * (e.g. concurrency tests), which fall back to a synthesized single-node tree.
     */
    nextIndexEntry?: Omit<IndexEntry, 'seq'>;
}

/** Location pointer for lazy loading */
export interface FilePointer {
    fileId: string;
    etag?: string;
    md5Checksum?: string;
    modifiedTime?: string;
    /** Optional offset/length for future optimization (packed files) */
    offset?: number;
    length?: number;
}

/** In-Memory Index Entry */
export interface IndexEntry {
    /** Opaque pouchdb-merge rev tree, JSON-stringified. JS (this file's callers)
     *  owns tree shape entirely - nothing here parses it beyond handing it to
     *  pouchdb-merge's own functions. */
    tree: string;
    /** Winning revision, computed via pouchdb-merge's winningRev() - the real
     *  deterministic CouchDB algorithm (generation, then lexicographic rev-hash
     *  tie-break), not "whichever write landed last". */
    rev: string;
    /** Sequence number where this rev was minted */
    seq: number;
    /** Whether the winning revision is a deletion marker */
    deleted?: boolean;
    /** Pointer to the file containing the winning revision's body (changes-*.ndjson
     *  or snapshot-data-*.json) */
    location: FilePointer;
    /** Every OTHER known leaf's body location, keyed by rev string. Absent/empty
     *  when there's no conflict. */
    conflictLocations?: Record<string, FilePointer>;
}

/** Old Legacy Snapshot (Compact + Data) - Kept for migration */
export interface LegacySnapshotData {
    docs: Record<string, any>;
    seq: number;
    createdAt: number;
}

/** New Snapshot Index (Compact Metadata only) */
export interface SnapshotIndex {
    /** Map of DocID -> IndexEntry */
    entries: Record<string, IndexEntry>;
    /** Sequence number at snapshot time */
    seq: number;
    /** Timestamp */
    createdAt: number;
}

/** New Snapshot Data (Bulk Content) */
export interface SnapshotDataChunk {
    /** Map of DocID -> Document Body (winning revision only) */
    docs: Record<string, any>;
    /** Non-winning leaf bodies carried forward through compaction, DocID -> rev ->
     *  Document Body. Absent when nothing in this chunk has a conflict. */
    conflicts?: Record<string, Record<string, any>>;
}

/** Metadata file content */
export interface MetaData {
    /** Current sequence number */
    seq: number;
    /** List of active change log file IDs */
    changeLogIds: string[];
    /** Change logs a compaction has folded into the snapshot and deleted.
     *  Tombstones: without them a writer that still remembers writing one of these
     *  would keep putting it back (see DriveHandler.reconcileOwnLogs). Capped at
     *  RETIRED_LOG_HISTORY entries - a writer that slept through more compactions
     *  than that may resurrect a dead file id, which replays as a skipped 404 and is
     *  pruned by the next compaction. */
    retiredLogIds?: string[];
    /** Snapshot Index file ID */
    snapshotIndexId: string | null;
    /** Last compaction timestamp */
    lastCompaction: number | null;
    /** Database name */
    dbName: string;
    /** File ID for _local documents store (optimizes by avoiding app-log writes) */
    localDocsId?: string | null;
    /** Schema Version (for migration) */
    version?: number;
}
