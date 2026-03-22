# Promise Support Documentation

The adapter now fully supports all three PouchDB call patterns:

## 1. Callback Pattern
```javascript
db.get('mydoc', function(err, doc) {
  if (err) { return console.log(err); }
  // handle doc
});
```

## 2. Promise Pattern
```javascript
db.get('mydoc').then(function (doc) {
  // handle doc
}).catch(function (err) {
  console.log(err);
});
```

## 3. Async/Await Pattern
```javascript
try {
  const doc = await db.get('mydoc');
  // handle doc
} catch (err) {
  console.log(err);
}
```

## Methods Updated

The following adapter methods now support all three patterns:

### Query Methods
- `_get()` / `get()` - Get a single document
- `_allDocs()` / `allDocs()` - Get all documents
- `_getLocal()` - Get a local document
- `_getRevisionTree()` - Get revision tree (internal)

### Mutation Methods
- `_bulkDocs()` / `bulkDocs()` - Bulk document operations
- `_bulkGet()` / `bulkGet()` - Bulk get operation
- `_putLocal()` - Put a local document
- `_removeLocal()` - Remove a local document

### Maintenance Methods
- `_compact()` - Compact the database

## Implementation Details

Each method now:
1. **Always returns a Promise** (even when a callback is provided)
2. **Calls the callback if provided** for backward compatibility
3. **Properly propagates errors** through both callbacks and rejections
4. **Handles callback overloading** (when `opts` is actually the callback)

This allows PouchDB and its replication engine to use the adapter with promises and async/await, fixing the error:
```
TypeError: can't access property "then", db.get(...) is undefined
```

## Migration Path

Your existing callback-based code continues to work:
```javascript
// Old callback pattern - still works!
db.get('doc1', (err, doc) => {
  if (err) console.error(err);
  else console.log(doc);
});
```

You can gradually migrate to promises/async-await as needed.
