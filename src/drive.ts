import { GoogleDriveAdapterOptions, DriveData } from './types';

export class DriveHandler {
    private drive: any;
    private fileId: string | null = null;
    private fileName: string;
    private parents: string[];
    public currentData: DriveData = { docs: {}, seq: 0 };
    private lastEtag: string | null = null;
    private listeners: ((data: DriveData) => void)[] = [];
    private pollingInterval: NodeJS.Timeout | null = null;

    constructor(options: GoogleDriveAdapterOptions, dbName: string) {
        this.drive = options.drive;
        this.fileId = options.fileId || null;
        this.fileName = options.fileName || dbName + '.json';
        this.parents = options.parents || [];

        if (options.pollingIntervalMs) {
            this.startPolling(options.pollingIntervalMs);
        }
    }

    async load(): Promise<void> {
        if (!this.fileId) {
            // Try to find file by name
            const q = `name = '${this.fileName}' and trashed = false`;
            const res = await this.drive.files.list({ q, spaces: 'drive', fields: 'files(id, name, modifiedTime)' });
            if (res.data.files && res.data.files.length > 0) {
                this.fileId = res.data.files[0].id;
            }
        }

        if (!this.fileId) {
            // Create new empty file
            this.currentData = { docs: {}, seq: 0 };
            await this.save(true);
            return;
        }

        // Download content
        try {
            const res = await this.drive.files.get({ fileId: this.fileId, alt: 'media' });
            this.currentData = res.data;

            // Get metadata for etag/version tracking
            const meta = await this.drive.files.get({ fileId: this.fileId, fields: 'version, modifiedTime' });
            this.lastEtag = meta.data.version; // Using version as a proxy for etag/change tracking

        } catch (err) {
            console.error('Error loading file from Drive', err);
            // Fallback to empty if not found or corrupted
            this.currentData = { docs: {}, seq: 0 };
        }
    }

    async save(isNew: boolean = false): Promise<void> {
        const fileMetadata: any = {
            name: this.fileName,
            mimeType: 'application/json'
        };
        if (this.parents.length > 0) {
            fileMetadata.parents = this.parents;
        }

        const media = {
            mimeType: 'application/json',
            body: JSON.stringify(this.currentData)
        };

        if (isNew || !this.fileId) {
            const res = await this.drive.files.create({
                requestBody: fileMetadata,
                media: media,
                fields: 'id, version'
            });
            this.fileId = res.data.id;
            this.lastEtag = res.data.version;
        } else {
            const res = await this.drive.files.update({
                fileId: this.fileId,
                media: media,
                fields: 'version'
            });
            this.lastEtag = res.data.version;
        }
    }

    startPolling(intervalMs: number) {
        if (this.pollingInterval) clearInterval(this.pollingInterval);
        this.pollingInterval = setInterval(async () => {
            if (!this.fileId) return;
            try {
                const res = await this.drive.files.get({ fileId: this.fileId, fields: 'version' });
                const remoteVersion = res.data.version;

                if (remoteVersion !== this.lastEtag) {
                    // Changed remotely, reload
                    console.log('Remote change detected, reloading...');
                    await this.load();
                    this.notifyListeners();
                }
            } catch (err) {
                console.error('Polling error', err);
            }
        }, intervalMs);
    }

    stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    onChange(callback: (data: DriveData) => void) {
        this.listeners.push(callback);
    }

    private notifyListeners() {
        for (const listener of this.listeners) {
            listener(this.currentData);
        }
    }

    async deleteFile(): Promise<void> {
        if (this.fileId) {
            await this.drive.files.delete({ fileId: this.fileId });
            this.fileId = null;
            this.currentData = { docs: {}, seq: 0 };
        }
    }
}
