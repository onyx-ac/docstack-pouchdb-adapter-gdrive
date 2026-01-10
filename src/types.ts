/** Google Drive API client type */
export type DriveClient = any; // googleapis drive_v3.Drive

/** Options for configuring the Google Drive adapter */
export interface GoogleDriveAdapterOptions {
    /** Configured Google Drive client (googleapis) */
    drive: DriveClient;
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
}

/** Location pointer for lazy loading */
export interface FilePointer {
    fileId: string;
    /** Optional offset/length for future optimization (packed files) */
    offset?: number;
    length?: number;
}

/** In-Memory Index Entry */
export interface IndexEntry {
    /** Current revision */
    rev: string;
    /** Sequence number where this rev was minted */
    seq: number;
    /** Whether it is a deletion marker */
    deleted?: boolean;
    /** Pointer to the file containing the body (changes-*.ndjson or snapshot-data-*.json) */
    location: FilePointer;
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
    /** Map of DocID -> Document Body */
    docs: Record<string, any>;
}

/** Metadata file content */
export interface MetaData {
    /** Current sequence number */
    seq: number;
    /** List of active change log file IDs */
    changeLogIds: string[];
    /** Snapshot Index file ID */
    snapshotIndexId: string | null;
    /** Last compaction timestamp */
    lastCompaction: number | null;
    /** Database name */
    dbName: string;
    /** Schema Version (for migration) */
    version?: number;
}
