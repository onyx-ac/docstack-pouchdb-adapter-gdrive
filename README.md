# PouchDB Adapter for Google Drive

A persistent, serverless PouchDB adapter that uses Google Drive as a backend storage. Designed for high concurrency, large datasets (via lazy loading), and offline resilience.

## Features

- **🚀 Append-Only Log**: Uses an efficient append-only log pattern for fast, conflict-free writes.
- **⚡ Lazy Loading**: Optimizes memory and bandwidth by loading only the **Index** into memory. Document bodies are fetched on-demand.
- **🛡️ Optimistic Concurrency Control**: Uses ETag-based locking on metadata to prevent race conditions and data loss during simultaneous updates.
- **🔄 Replication Ready**: Fully automated support for PouchDB's `sync` and `replicate` protocols (bilateral sync).
- **📦 Auto-Compaction**: Automatically merges logs into snapshots to keep performance high.
- **💾 Offline/Resilient**: Retry logic with exponential backoff handles network instability and "thundering herd" scenarios.

## Installation

```bash
npm install @docstack/pouchdb-adapter-googledrive
```

## Usage

```typescript
import PouchDB from 'pouchdb-core';
import GoogleDriveAdapter from '@docstack/pouchdb-adapter-googledrive';
import { google } from 'googleapis';

// Register the adapter
PouchDB.plugin(GoogleDriveAdapter);

// Setup Google Drive Client (Authenticated)
const oauth2Client = new google.auth.OAuth2(
  YOUR_CLIENT_ID,
  YOUR_CLIENT_SECRET,
  YOUR_REDIRECT_URL
);
oauth2Client.setCredentials({ access_token: '...' });

const drive = google.drive({ version: 'v3', auth: oauth2Client });

// Create Database
const db = new PouchDB('my-drive-db', {
  adapter: 'googledrive',
  drive: drive,              // valid googleapis Drive instance
  folderId: '...',           // Optional: Storage Folder ID (recommended)
  folderName: 'my-db',       // Optional: Folder name (created if not exists)
  pollingIntervalMs: 2000,   // Optional: Check for remote changes
  compactionThreshold: 50,   // Optional: Entries before auto-compaction
  cacheSize: 1000            // Optional: Number of document bodies to keep in LRU cache
});

// Use standard PouchDB API
await db.put({ _id: 'doc1', title: 'Hello Drive!' });
const doc = await db.get('doc1');
```

## Architecture

The adapter implements a **"Remote-First"** architecture designed for scale:

### 1. Storage Structure
Inside your Google Drive folder, you will see:
- `_meta.json`: The "Lock File". Tracks the sequence number and active log pointers.
- `snapshot-index.json`: A lightweight map of `DocID -> { Revision, FilePointer }`. Loaded at startup.
- `snapshot-data.json`: Large payload files containing document bodies. **Not loaded** until requested.
- `changes-{seq}-{uuid}.ndjson`: Immutable append-only logs for recent updates.

### 2. Lazy Loading & Caching
- **Startup**: The client downloads only `_meta.json` and `snapshot-index.json` (~MBs even for large DBs).
- **Access**: `db.get(id)` checks a local **LRU Cache**. If missing, it fetches the specific file containing that document from Drive.
- **Sync**: `db.changes()` iterates the local index, ensuring fast replication without downloading full content.

### 3. Concurrency
- **Writes**: Every write creates a new unique `changes-*.ndjson` file.
- **Commit**: The adapter attempts to update `_meta.json` with an ETag check (`If-Match`).
- **Conflict**: If `_meta.json` was changed by another client, the write retries automatically after re-syncing the index.

## Testing

To run the tests, you need to provide Google Drive API credentials.

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Fill in your Google Cloud credentials in `.env`.
3. Run the tests:
   ```bash
   npm test
   ```

## License

CC-BY-SA-4.0
