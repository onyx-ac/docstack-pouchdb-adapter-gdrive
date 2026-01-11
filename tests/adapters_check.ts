
import PouchDB from 'pouchdb-core';
import GoogleDriveAdapter from '../src/index';

// Mock Drive
const drive = {} as any;

// 1. Initialize Plugin (Factory)
const plugin = GoogleDriveAdapter({
    accessToken: 'mock-token',
    folderName: 'my-db',
    pollingIntervalMs: 5000
});

// 2. Register Plugin
PouchDB.plugin(plugin);

// 3. Verify Adapter Registration
// @ts-ignore
if (PouchDB.adapters['googledrive']) {
    console.log('Adapter registered successfully!');
} else {
    console.error('Adapter NOT registered.');
    process.exit(1);
}

// 4. Create DB
const db = new PouchDB('test', {
    adapter: 'googledrive'
});

console.log('Database created with adapter:', db.adapter);
