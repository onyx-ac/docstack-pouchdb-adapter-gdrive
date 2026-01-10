# PouchDB Adapter for Google Drive

A PouchDB adapter that syncs with a single JSON file on Google Drive.

## Installation

```bash
npm install pouchdb-adapter-googledrive
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
  drive: drive,           // valid googleapis Drive instance
  parents: ['folder-id'], // Optional: Folder to store the file in
  debounceMs: 500,        // Optional: Debounce saves
  pollingIntervalMs: 2000 // Optional: Check for remote changes
});
```

## How it works

- The adapter treats the database as a single JSON file on Google Drive.
- On load, it fetches the file content.
- Writes are pushed to Drive (updating the file).
- If `pollingIntervalMs` is set, it checks the file version periodically and reloads if changed externally.

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

