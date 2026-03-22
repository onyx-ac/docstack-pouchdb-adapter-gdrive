# Root Cause Analysis: Replication FROM Google Drive Issues

After extensive debugging with a live emulation test suite, multiple critical issues were identified in the `_changes` and `notifyListeners` implementations.

## 1. Missing `seq` Property in Notifications (CRITICAL)
**Location**: `src/drive.ts` -> `notifyListeners()`

**Problem**: 
The `notifyListeners` method was emitting change objects that included `id`, `rev`, and `deleted`, but omitted the `seq` (sequence number). 

**Consequence**: 
PouchDB's replication engine uses the `seq` to track checkpoints. If a change arrives without a `seq`, PouchDB silently ignores it or fails to update its "since" pointer, meaning the replication appears to "detect" a change but never actually processes the document.

**Fix**: 
Updated the notification object to include the correct sequence number from the index.

---

## 2. Infinite Reconnect Loop in Live Changes
**Location**: `src/adapter.ts` -> `_changes()`

**Problem**: 
An initial "fix" (based on standard CouchDB behavior) suggested calling `opts.complete()` at the end of the initial changes batch, even for live feeds. 

**Consequence**: 
In PouchDB, calling `complete()` on a **live** stream signals that the stream has ended gracefully. Because the replication is set to `live: true`, PouchDB interprets this as a connection drop and immediately restarts the changes feed. This created an infinite loop of:
`Connect -> Fetch Batch -> Call Complete -> Disconnect -> Reconnect`
This loop caused high CPU usage and eventually a "JavaScript heap out of memory" crash.

**Fix**: 
Restricted `opts.complete()` to only be called if `!opts.live`.

---

## 3. System Document Leakage (`_local/`)
**Location**: `src/adapter.ts` -> `_changes()`

**Problem**: 
PouchDB uses local documents (IDs starting with `_local/`) to store replication checkpoints. Our adapter was incorrectly including these internal documents in the `_changes` feed results.

**Consequence**: 
When the remote side (Google Drive) reported a change to a `_local/` document, the local PouchDB tried to fetch it to replicate it. However, local documents are non-replicable and often missing from the full document fetch logic, leading to `not_found: missing` errors that crashed the replication process.

**Fix**: 
Added a filter to both the initial batch and the live listener to ignore any document ID starting with `_local/`.

---

## 4. Inefficient Polling & Redundant `load()` Calls
**Location**: `src/drive.ts` -> `startPolling()` / `load()`

**Problem**: 
The polling mechanism was frequently triggering `load()`, which cleared the entire `processedLogIds` cache and re-downloaded all change logs from Google Drive. Additionally, `load()` was being called on every conflict retry without checking if the metadata had actually changed.

**Fix**: 
1. Implemented **ETag-based change detection** in polling.
2. Added an **ETag check at the start of `load()`** to skip processing if the metadata on the server haven't changed since the last load.
3. Updated `tryAppendChanges` to proactively call `notifyListeners()` for local writes, reducing reliance on the next polling tick for local UI updates.

---

## Summary of Results
With these fixes applied, bidirectional replication is now stable and efficient. The "Out of Memory" crashes have been resolved, and changes from Google Drive are correctly detected and propagated to the local database within the specified polling interval.
