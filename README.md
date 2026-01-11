# PouchDB Adapter for Google Drive

A persistent, serverless PouchDB adapter that uses Google Drive as a backend storage. Designed for high concurrency, large datasets (via lazy loading), and offline resilience.

## Features

- **🚀 Append-Only Log**: Uses an efficient append-only log pattern for fast, conflict-free writes.
- **⚡ Lazy Loading**: Optimizes memory and bandwidth by loading only the **Index** into memory. Document bodies are fetched on-demand.
- **🛡️ Optimistic Concurrency Control**: Uses ETag-based locking on metadata to prevent race conditions.
- **📦 Auto-Compaction**: Automatically merges logs for performance.
- **🌍 Universal**: Works natively in Node.js 18+, Browsers, and Edge environments (no `googleapis` dependency).

## Requirements

- **Node.js 18+** (for global `fetch` support) or a modern browser.

## Installation

```bash
npm install @docstack/pouchdb-adapter-googledrive
```

## Usage

The adapter is initialized as a plugin with your Google Drive access token.

```typescript
import PouchDB from 'pouchdb-core';
import GoogleDriveAdapter from '@docstack/pouchdb-adapter-googledrive';

// 1. Initialize the Adapter Plugin Factory
const adapterPlugin = GoogleDriveAdapter({
  accessToken: 'YOUR_GOOGLE_ACCESS_TOKEN',
  folderName: 'my-app-db-folder', // Root folder in Drive
  pollingIntervalMs: 2000         // Optional: check for remote changes
});

// 2. Register Plugin
PouchDB.plugin(adapterPlugin);

// 3. Create Database
const db = new PouchDB('user_db', {
  adapter: 'googledrive'
});

await db.post({ title: 'Hello World' });
```

### Dynamic Tokens

If your token expires, you can provide an async function that returns a valid token:

```typescript
const adapterPlugin = GoogleDriveAdapter({
  accessToken: async () => {
    const session = await getMySession();
    return session.accessToken;
  },
  folderName: 'my-app-db'
});
```

## Architecture

The adapter implements a **"Remote-First"** architecture:
- **Lazy Loading**: `db.get(id)` fetches data on-demand from Drive.
- **Caching**: Changes are indexed locally but bodies are cached in an LRU cache.
- **Resilience**: Writes use optimistic locking to handle multi-client concurrency safer.

## License

CC-BY-SA-4.0
