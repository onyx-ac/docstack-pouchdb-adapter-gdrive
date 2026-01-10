# Architecture & Design Documentation

## 1. Core Principles
The `pouchdb-adapter-googledrive` implementation is built on three core pillars to ensure data integrity and performance on a file-based remote storage system.

### A. Append-Only Log (Storage)
Instead of modifying a single database file (which is prone to conflicts), we use an **Append-Only** strategy.
- **Changes**: Every write operation (or batch of writes) creates a **new, immutable file** (e.g., `changes-{seq}-{uuid}.ndjson`).
- **Snapshots**: Periodically, the log is compacted into a `snapshot` file.
- **Benefit**: Historical data is preserved until compaction, and file-write conflicts are minimized.

### B. Optimistic Concurrency Control (OCC)
To prevent race conditions (two clients writing simultaneously), we use **ETag-based locking** on a single entry point: `_meta.json`.
- **The Lock**: `_meta.json` holds the current Sequence Number and the list of active log files.
- **The Protocol**:
    1. Reader fetches `_meta.json` and its `ETag`.
    2. Writer prepares a new change file and uploads it (orphaned initially).
    3. Writer attempts to update `_meta.json` with the new file reference, sending `If-Match: <Old-ETag>`.
    4. **Success**: The change is now officially part of the DB.
    5. **Failure (412/409)**: Another client updated the DB. The writer deletes its orphaned file, pulls the new state, and retries the logical operation.

### C. Remote-First "Lazy" Loading (Memory Optimization)
To support large databases without exhausting client memory, we separate **Metadata** from **Content**.

#### Storage Structure
- `_meta.json`: Root pointer. Small.
- `snapshot-index.json`: A map of `{ docId: { rev, filePointer } }`. Medium size (~100 bytes/doc). Loaded at startup.
- `snapshot-data.json`: The actual document bodies. Large. **Never fully loaded.**
- `changes-*.ndjson`: Recent updates.

#### Client Startup Sequence
1.  **Fetch Meta**: Download `_meta.json` and get the `snapshotIndexId`.
2.  **Fetch Index**: Download `snapshot-index.json`. This builds the "Revision Tree" in memory.
3.  **Replay Logs**: Download and parse only the small `changes-*.ndjson` files created since the snapshot to update the in-memory Index.
4.  **Ready**: The client is now ready to query keys. No document content has been downloaded yet.

#### On-Demand Usage
- **`db.get(id)`**: 
    1. Look up `id` in the **Memory Index** to find the `filePointer`.
    2. Check **LRU Cache**.
    3. If missing, fetch the specific file/range from Google Drive.
- **`db.allDocs({ keys: [...] })`**: Efficiently looks up pointers and fetches only requested docs.

## 2. Technical Patterns

### Atomic Compaction
Compaction is a critical maintenance task that merges the `snapshot-data` with recent `changes` to create a new baseline.
- **Safe**: Limits memory usage by streaming/batching.
- **Atomic**: Uploads the new snapshot as a new file. Swaps the pointer in `_meta.json` using OCC.
- **Zero-Downtime**: Clients can continue reading/writing to the old logs while compaction runs. Writes that happen *during* compaction are detected via the ETag check, causing the compaction to abort/retry safeley.

### Conflict Handling
- **PouchDB Level**: Standard CouchDB revision conflicts (409) are preserved. A "winner" is chosen deterministically, but conflicting revisions are kept in the tree (requires `snapshot-index` to store the full revision tree, not just the winner).
- **Adapter Level**: Drive API 409s handling (retry logic) ensures the transport layer is reliable.
