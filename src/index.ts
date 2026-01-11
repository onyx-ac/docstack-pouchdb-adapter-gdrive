import { GoogleDriveAdapter } from './adapter';
import { GoogleDriveAdapterOptions } from './types';

export default function (PouchDB: any) {
    PouchDB.adapter('googledrive', GoogleDriveAdapter(PouchDB), true);
}

// Re-export types
export * from './types';

// Define the configuration interface
export interface GoogleDriveDatabaseConfiguration extends GoogleDriveAdapterOptions {
    adapter: 'googledrive';
}

// Module Augmentation for PouchDB
// This allows the user to see 'drive' and other options on the PouchDB constructor options
// Module Augmentation for PouchDB
declare global {
    namespace PouchDB {
        namespace Core {
            interface DatabaseConfiguration {
                drive?: any;
                folderId?: string;
                folderName?: string;
                parents?: string[];
                pollingIntervalMs?: number;
                compactionThreshold?: number;
                compactionSizeThreshold?: number;
                cacheSize?: number;
            }
        }
    }
}
