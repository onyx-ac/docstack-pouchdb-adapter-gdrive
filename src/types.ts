export interface GoogleDriveAdapterOptions {
    drive: any; // configured google drive client (googleapis)
    fileId?: string; // specific file ID to use as the DB
    fileName?: string; // if no ID, search/create by name
    parents?: string[]; // parent folder IDs for creation
    debounceMs?: number; // debounce time for writes/updates
    pollingIntervalMs?: number; // interval to check for remote changes
}

export interface DriveData {
    docs: Record<string, any>;
    seq: number;
}
