# Root Cause Analysis: Replication FROM Google Drive Not Working

## The Culprit: `_changes` API Implementation in adapter.ts

### Issue #1: Incomplete `opts.complete` Call (PRIMARY CAUSE)

**Location**: `src/adapter.ts` lines 524-531

```typescript
if (opts.complete && !complete && !opts.live) {
    opts.complete(null, { results, last_seq: lastSeq });
}
```

**Problem**:
- The `opts.complete` callback is ONLY called when `opts.live` is FALSE
- But PouchDB replication ALWAYS uses `opts.live: true` for bidirectional replication
- When `opts.live === true`, the callback is never invoked
- This means PouchDB never receives the initial changes batch and doesn't know when to start live monitoring

### Issue #2: Broken Live Listener Logic

**Location**: `src/adapter.ts` lines 533-556

The live listener has problems:
1. It's registered AFTER `processChangesAsync()` starts
2. Changes emitted during `processChangesAsync()` might not have `opts.onChange` defined yet
3. For `include_docs: true`, the change is emitted immediately without waiting for `db.get()` to complete

### Issue #3: No Error Propagation

The `processChangesAsync()` error is caught but only logged, not passed to replication engine.

---

## Why `replicate.to()` Works But `replicate.from()` Doesn't

### What works (localDB → googleDriveDB):
- Local PouchDB has a complete `_changes` implementation
- It properly emits changes with the replication engine listening

### What fails (googleDriveDB → localDB):
- PouchDB calls `googleDriveDB._changes()` expecting:
  1. Initial batch of changes → call `opts.onChange(change)` for each
  2. Then call `opts.complete(null, { results, last_seq })` to signal batch done
  3. Then set up live listener for future changes
- Your implementation:
  1. ✅ Emits changes via `opts.onChange()`
  2. ❌ Never calls `opts.complete()` when `live: true`
  3. ❌ Live listener setup is buggy

---

## Solution: Fix the _changes Implementation

See the updated code in the codebase. The fix:

1. **Call `opts.complete()` for BOTH live and non-live modes**
2. **Setup live listener BEFORE calling `opts.onChange()` to avoid race conditions**
3. **Properly handle `include_docs` with async fetching**
