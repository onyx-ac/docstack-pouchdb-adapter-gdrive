# PouchDB Adapter for Google Drive

A PouchDB adapter that uses Google Drive as a backend storage.

## Features

- **Append-Only Log**: Uses an efficient append-only log pattern for fast writes.
- **Auto-Compaction**: Automatically merges logs into a snapshot when thresholds are met.
- **Offline/Sync**: Supports PouchDB's replication and sync capabilities.
- **TypeScript**: Written in TypeScript with full type definitions.

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
  folderId: '...',           // Optional: Folder ID to store database files
  folderName: 'my-db',       // Optional: Folder name (created if not exists)
  pollingIntervalMs: 2000,   // Optional: Check for remote changes
  compactionThreshold: 50    // Optional: Number of changes before auto-compaction
});
```

## How it works

The adapter implements an **append-only log** pattern for efficiency and reliability:

1. **Folder Structure**: Each database is a folder in Google Drive.
2. **`_meta.json`**: Tracks the current sequence number and active log files.
3. **`snapshot.json`**: Contains the full database state at a specific sequence point.
4. **`changes-{timestamp}.ndjson`**: New changes are appended to these newline-delimited JSON files.

### Compaction

To prevent the change logs from growing indefinitely, the adapter performs auto-compaction:
- When the number of pending changes exceeds `compactionThreshold` (default: 100).
- Or when the log file size exceeds `compactionSizeThreshold` (default: 1MB).

Compaction merges the snapshot and all change logs into a new `snapshot.json` and deletes old log files.

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
