
import { GoogleDriveAdapter as CoreAdapter } from './adapter';
import { GoogleDriveAdapterOptions } from './types';

// Export types
export * from './types';

/**
 * Google Drive Adapter Plugin Factory
 * 
 * Usage:
 * const plugin = GoogleDriveAdapter({ drive: myDriveClient, ... });
 * PouchDB.plugin(plugin);
 */
export default function GoogleDriveAdapter(config: GoogleDriveAdapterOptions) {
    return function (PouchDB: any) {
        // Get the base adapter constructor (scoped to this PouchDB instance)
        const BaseAdapter = CoreAdapter(PouchDB);

        // Create a wrapper constructor that injects the config
        function ConfiguredAdapter(this: any, opts: any, callback: any) {
            // Merge factory config with constructor options
            // Constructor options take precedence (overrides)
            const mergedOpts = Object.assign({}, config, opts);

            // Call the base adapter
            BaseAdapter.call(this, mergedOpts, callback);
        }

        // Copy static properties required by PouchDB
        // @ts-ignore
        ConfiguredAdapter.valid = BaseAdapter.valid;
        // @ts-ignore
        ConfiguredAdapter.use_prefix = BaseAdapter.use_prefix;

        // Register the adapter manually
        // Check if already registered to avoid overwriting or conflicts
        if (PouchDB.adapters) {
            if (!PouchDB.adapters['googledrive'] || PouchDB.adapters['googledrive'] !== ConfiguredAdapter) {
                PouchDB.adapters['googledrive'] = ConfiguredAdapter;
            }
        } else {
            console.warn('PouchDB.adapters not found, unable to register googledrive adapter');
        }
    };
}
