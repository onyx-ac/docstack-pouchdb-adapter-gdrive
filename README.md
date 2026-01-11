# PouchDB Adapter for Google Drive

A persistent, serverless PouchDB adapter that uses Google Drive as a backend storage. Designed for high concurrency, large datasets (via lazy loading), and offline resilience.

## Features

- **🚀 Append-Only Log**: Uses an efficient append-only log pattern for fast, conflict-free writes.
- **⚡ Lazy Loading**: Optimizes memory and bandwidth by loading only the **Index** into memory. Document bodies are fetched on-demand.
- **🛡️ Optimistic Concurrency Control**: Uses ETag-based locking on metadata to prevent race conditions.
- **📦 Auto-Compaction**: Automatically merges logs for performance.

## Installation

```bash
npm install @docstack/pouchdb-adapter-googledrive
```

## Usage

The adapter is initialized as a plugin with your Google Drive configuration.

```typescript
import PouchDB from 'pouchdb-core';
import GoogleDriveAdapter from '@docstack/pouchdb-adapter-googledrive';
import { google } from 'googleapis';

// 1. Setup Google Drive Client
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, SECRET, REDIRECT);
oauth2Client.setCredentials({ access_token: '...' });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// 2. Initialize the Adapter Plugin with Config
const adapterPlugin = GoogleDriveAdapter({
  drive: drive,
  folderName: 'my-app-db-folder', // Root folder
  pollingIntervalMs: 2000
});

// 3. Register Plugin
PouchDB.plugin(adapterPlugin);
// Also needs replication plugin if using replicate()
// PouchDB.plugin(require('pouchdb-replication'));

// 4. Create Database
// No need to pass 'drive' here anymore!
const db = new PouchDB('user_db', {
  adapter: 'googledrive'
});

await db.post({ title: 'Hello World' });
```

## Architecture

The adapter implements a **"Remote-First"** architecture:
- **Lazy Loading**: `db.get(id)` fetches data on-demand from Drive.
- **Caching**: Changes are indexed locally but bodies are cached in an LRU cache.
- **Resilience**: Writes use optimistic locking to handle multi-client concurrency safer.

## License

CC-BY-SA-4.0
