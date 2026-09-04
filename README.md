# PouchDB Adapter for Google Drive

A persistent, serverless PouchDB adapter that uses Google Drive as a backend storage. Designed for high concurrency, large datasets (via lazy loading), and offline resilience.

## Features

- **🚀 Append-Only Log**: Uses an efficient append-only log pattern for fast, conflict-free writes.
- **⚡ Lazy Loading**: Optimizes memory and bandwidth by loading only the **Index** into memory. Document bodies are fetched on-demand.
- **🛡️ Multi-writer safe**: Metadata writes merge rather than replace, and are read back before anything is deleted. See [Concurrent writers](#concurrent-writers).
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

### Live changes from other clients

Set `pollingIntervalMs` to have the adapter watch `_meta.json` and replay what other
clients write. Without it, a client only hears about its own writes — connect-and-read
works, continuous sync between two connected clients does not.

```typescript
const adapterPlugin = GoogleDriveAdapter({
  accessToken: 'YOUR_GOOGLE_ACCESS_TOKEN',
  folderId: 'my-folder-id',
  pollingIntervalMs: 2000  // check for remote writes every 2s
});

db.changes({ live: true, since: 'now' }).on('change', change => { /* ... */ });
```

A tick costs one `files.list`, whatever has changed; only a tick that sees a new
`md5Checksum` (or, failing that, a new `modifiedTime`) goes on to fetch anything.
`db.close()` and `db.destroy()` stop it.

### Sync progress

Two signals, one per phase where a UI would otherwise show nothing:

**Replication progress** rides PouchDB's standard pipeline. The adapter's changes
feed reports `pending` (the CouchDB field), so replication `change` events and
`activeTasks` carry it without any adapter-specific wiring:

```typescript
const rep = PouchDB.replicate(remote, local);
rep.on('change', info => {
  const done = info.docs_written;
  const pct = Math.round(done / (done + info.pending) * 100);
  // Freeze the denominator at cycle start, or clamp the bar monotone —
  // other devices keep writing, so `pending` can grow mid-cycle.
});
```

Do not derive progress from `update_seq` arithmetic: sequence numbers are sparse
(they carry a writer slot in the low digits), so ratios of them mean nothing.

**Connect progress** covers the cold load, where a busy folder replays dozens of
change logs before the database is usable:

```typescript
GoogleDriveAdapter({
  accessToken: '...',
  folderId: 'my-folder-id',
  onSyncProgress: ({ phase, done, total }) => {
    // phase 'replay': applying change logs, done of total for this load.
  }
});
```

The callback is fire-and-forget: it always reaches `total` even when a log download
fails (that log is retried on a later load), and an exception it throws cannot fail
the load.

## Concurrent writers

Several clients may share one folder. What that costs, and what it does not:

- **Writes from different clients do not overwrite each other.** `_meta.json` is the
  only shared mutable state. Every write to it is built on a copy read from Drive
  moments earlier, merges into that copy instead of replacing it, and is read back
  afterwards to confirm it survived. A writer also remembers the change logs it
  wrote and restores any that go missing on its next load.
- **Compaction deletes nothing until its metadata write is confirmed.** Until then,
  the change logs are still the only copy of the changes in them.
- **Sequence numbers come from Drive, not from a local counter**, so two clients
  writing minutes apart cannot mint the same one.
- **A writer catches up before it writes**, so it sees what its peers have appended.
  A client that only *reads* needs `pollingIntervalMs` to notice anything.

Caveats worth knowing before you fan out:

- **There is no compare-and-swap.** Drive API v3 dropped ETags, so `If-Match` is
  accepted and ignored - the adapter still sends it (the emulated test server does
  enforce it), but nothing may assume it was honoured. Two clients writing metadata
  within the same round trip can still produce a lost update; the read-back and the
  restore-on-load above are what repair it, so a client that writes and immediately
  disconnects forever is the one case that can leave a change log unreferenced.
- **Pass `folderId`, not just `folderName`, when several clients may start at once.**
  Duplicate `_meta.json` files are detected and resolved; duplicate *folders* are
  not, and two clients that each create "my-app-db-folder" get two databases.
- **A document written concurrently by two clients resolves last-writer-wins in the
  index**, not through pouchdb-merge. Both revisions stay on Drive, but the losing
  one will not show up as a conflict branch.

## Architecture

The adapter implements a **"Remote-First"** architecture:
- **Lazy Loading**: `db.get(id)` fetches data on-demand from Drive.
- **Caching**: Changes are indexed locally but bodies are cached in an LRU cache.
- **Resilience**: Writes use optimistic locking to handle multi-client concurrency safer.

## License

CC-BY-SA-4.0
