# Testing

Four layers, in increasing order of realism:

1. **Local emulator** (`npm test`) — fast, no credentials, runs on every change.
2. **Production integration tests** (`npm run test:prod`) — pass/fail tests against your real Drive account.
3. **Production Drive Explorer** (`npm run test:prod:explore`) — an exploratory dev tool, not a
   pass/fail test, that writes real data, queries it, compacts it, and audits the raw file structure
   left behind on Drive.
4. **Production Replication Round-Trip** (`npm run test:prod:replication`) — replicates real PouchDB
   data through a real Drive-backed instance and back, verifying every document and revision survives
   the round trip.

## 1. Testing with the Local Express Emulator

The adapter includes a built-in test mode that emulates the Google Drive API using a local Express
server. This allows for full integration testing without needing real Google Cloud credentials or
network calls.

### Configuration
To enable the test emulator:

```typescript
const db = new PouchDB('testdb', {
  adapter: 'googledrive',
  testMode: true,
  // testServerUrl: 'http://localhost:3000' // Optional, defaults to localhost:3000
});
```

### Test Server
The `TestServer` class (exported in `tests-src/server.ts`) provides:
- In-memory metadata storage
- Local file system storage for content (defaults to `.test-drive-root` directory)
- Emulation of `files.list`, `files.get`, `files.create` (multipart), `files.update`, and `files.delete`.

### Example Usage
```typescript
import { TestServer } from './tests-src/server';

const server = new TestServer(3000);
await server.start();

// Run PouchDB operations...
```

Run it with:
```bash
npm test
```

## 2. Production Testing (Real Google Drive API)

To verify the adapter against the actual Google Drive service, you can run the production test suite.
This requires a valid Google OAuth2 Access Token.

### A. Environment Setup
Create a `.env` file in the project root (see `.env.example`):
```env
GOOGLE_ACCESS_TOKEN=your_temporary_access_token_here
```

### B. Obtaining a Token via OAuth2 Playground
The easiest way to get a temporary token for manual testing:
1.  Go to the [Google OAuth2 Playground](https://developers.google.com/oauthplayground/).
2.  **Step 1 (Select & authorize APIs)**:
    *   Find "Drive API v3" in the list.
    *   Select the scope: `https://www.googleapis.com/auth/drive.file` (this is the recommended scope as it only allows the app to see files it creates).
    *   Click **Authorize APIs** and sign in with your Google account.
3.  **Step 2 (Exchange authorization code for tokens)**:
    *   Click **Exchange authorization code for tokens**.
4.  **Step 3 (Configure request to API)**:
    *   Copy the **Access Token** string.
    *   Paste it into your `.env` file as `GOOGLE_ACCESS_TOKEN`.

The token is short-lived (about an hour) — grab a fresh one before each session of production testing.

### C. Running the Tests
```bash
npm run test:prod
```
This sets `TEST_ENV=production`, which tells the test runner to skip the local Express emulator and
use the real Google Drive endpoints with your provided token.

> **Windows note:** npm scripts run through `cmd.exe` on Windows, which doesn't understand the
> `VAR=value command` shorthand. If `npm run test:prod` fails with `'TEST_ENV' is not recognized...`,
> run it directly through a POSIX shell (e.g. Git Bash) instead:
> ```bash
> TEST_ENV=production npx jest
> ```

## 3. Production Drive Explorer (Structural & Content Audit Tool)

`tests/production.explore.test.ts` is a development tool, not a pass/fail unit test. It runs the
adapter against your real Google Drive account and produces a report describing exactly what got
written, so you can answer questions like:
- Does querying through PouchDB (`allDocs`, `get`, `info`) return correct results against real Drive —
  including correctly excluding deleted documents?
- What does compaction actually leave behind in the folder — is anything redundant, orphaned, or
  otherwise clutter, and how many bytes does that clutter cost?
- Is any document body stored more than once across different files?
- Does the content PouchDB hands back match the raw bytes sitting in the Drive file?

It reuses the same `.env` / `TEST_ENV=production` setup as `npm run test:prod` — see section 2 above
to obtain a token first.

### Running it
```bash
npm run test:prod:explore
```
(or, on Windows, `TEST_ENV=production npx jest tests/production.explore.test.ts` — see the Windows
note above.)

Optional env vars:
| Var | Default | Purpose |
|---|---|---|
| `KEEP_TEST_DATA` | unset (folder is deleted) | Set to `1` to skip deleting the Drive test folder at the end, so you can open it in Drive or rerun the audit logic against it manually. |
| `PROD_TEST_DOC_COUNT` | `12` | How many documents to write in the first round. |
| `INSPECT_CONTENT` | on | Set to `0` to skip downloading file *content* (doc counts, byte sizes, duplicate-ID detection) and only audit file names/structure. Useful to cut API calls on a very large test run. |

### What it does
1. **Write**: creates N documents, updates two of them (second revision), deletes one — all through
   the PouchDB adapter API (`db.put` / `db.remove`).
2. **Query**: reads them back through PouchDB (`allDocs`, `get`, `info`) and asserts the counts match
   what was written (deleted docs excluded, per standard CouchDB/PouchDB semantics).
3. **Audit (raw Drive)**: using `GoogleDriveClient` directly (bypassing the adapter), lists every file
   physically present in the DB's Drive folder, downloads `_meta.json` and the current
   `snapshot-index-*.json`, and computes the set of files actually **referenced** (`_meta.json` itself,
   `changeLogIds`, `snapshotIndexId`, `localDocsId`, and every `location.fileId` inside the snapshot
   index entries). Anything present in the folder but not in that referenced set is reported as an
   **orphan**.
4. **Inspect content**: for every `snapshot-data`, `local-docs`, and `changes-log` file, downloads the
   actual content to compute a doc/entry count and an approximate byte size, and cross-references doc
   IDs across all data files to flag any ID that shows up in more than one file (redundant storage).
5. **Compact, twice**: calls `db.compact()`, re-runs the audit, writes 5 more docs, calls
   `db.compact()` again, and audits once more — so you can see whether clutter is a one-off or grows
   with every compaction cycle.
6. **Content diff**: fetches one updated document via PouchDB and separately downloads the raw
   `snapshot-data-*.json` chunk it lives in, and compares the two — a direct check that what PouchDB
   serves actually matches what's stored on Drive, not just an internal cache.

### Output
Each run writes to `prod-test-reports/run-<timestamp>/` (git-ignored):
- `run.log` — full chronological log of everything the tool did.
- `report.json` — structured dump per audit phase: file list (id/name/category/content summary),
  counts by category (`meta`, `snapshot-index`, `snapshot-data`, `changes-log`, `local-docs`,
  `unknown`), the downloaded `_meta.json`, the orphan list, total/orphan byte counts, and any
  duplicate doc IDs found across data files.

By default the Drive test folder is deleted at the end of the run; use `KEEP_TEST_DATA=1` to leave it
in place if you want to inspect it in Drive directly. If a run fails partway through an assertion, the
teardown still attempts to resolve and delete the folder — but if that resolution itself hasn't
happened yet, the folder is left behind; check the `run.log` for a `resolved Drive folderId:` line and
delete it manually via the Drive UI if cleanup didn't run.

### Bugs this tool has already found and fixed

**Compaction leaked old `snapshot-data-*.json` files.** Each compaction uploaded a new
`snapshot-data-{timestamp}.json` and a new `snapshot-index-{timestamp}.json` pointing at it, but
`cleanupOldFiles` ([`src/drive.ts`](../src/drive.ts)) only deleted the **old index** — never the **old
data** file it pointed to. That data file (often the largest file in the DB) became permanent orphaned
clutter, with a new one piling up every compaction cycle. Fixed: `compact()` now downloads the old
index before it's replaced, resolves the `location.fileId`(s) its entries point to, and deletes that
data file alongside the old index once the new snapshot is committed.

**`allDocs()` returned deleted documents.** `db.allDocs({ include_docs: true })` was returning rows for
deleted documents instead of excluding them, and `total_rows` counted deleted entries too (disagreeing
with `db.info().doc_count`). Root cause, [`src/adapter.ts`](../src/adapter.ts) `_allDocs`: a filter
meant to drop `not_found`/deleted rows unless specific `keys` were requested had its condition
inverted (`!r.error || !opts.keys` instead of `!r.error || !!opts.keys`), and the non-`include_docs`
branch didn't filter at all. Modeled the fix on
[`craftzdog/pouchdb-adapter-react-native-sqlite`](https://github.com/craftzdog/pouchdb-adapter-react-native-sqlite)'s
approach: a plain `allDocs()` excludes deleted docs from the candidate set entirely (they never even
become a row); an `allDocs({ keys: [...] })` that explicitly names a deleted doc gets it back with
`value.deleted: true, doc: null` rather than as an `error: 'not_found'` row — only keys absent from the
index entirely are `not_found`. `total_rows` now counts live documents only, matching `info.doc_count`.
The Production Replication tool ([`docs/REPLICATION.ipynb`](REPLICATION.ipynb)) later found a sibling
gap in the same function: `_local/*` documents (replication checkpoints, in particular) were never
excluded from the candidate key set either, so they leaked into `allDocs()` results too — real
CouchDB/PouchDB never surfaces `_local/*` docs there, they live in a separate namespace. Fixed
alongside it.

**`db.compact()` never resolved.** Calling the public `db.compact()` API hung forever, even though the
compaction itself completed correctly on Drive (verifiable by watching the folder in the Drive UI
while the call was still "pending"). Root cause: PouchDB core's compaction queue
(`pouchdb-core/lib/index.js`, `doNextCompaction`) invokes the adapter hook as `self._compact(opts,
callback)` — two arguments — but `api._compact` in [`src/adapter.ts`](../src/adapter.ts) was declared
as `function (callback)`, a single argument. `opts` (an empty object) landed in the `callback`
parameter, and the real callback PouchDB core passed as the second argument was silently discarded.
When compaction finished and the adapter tried `callback(null, result)`, it was actually invoking the
`opts` object as a function, which throws — and since PouchDB core never awaits `_compact`'s return
value (only its callback), that error vanished as an unhandled rejection instead of surfacing anywhere,
and the caller's `await db.compact()` was left waiting forever. Existing tests never caught this
because they only exercise *automatic* threshold-triggered compaction (which calls the internal
`DriveHandler.compact()` directly, bypassing `_compact` entirely) — this tool caught it because it
calls the public `db.compact()` API, same as any real consumer of the adapter would. Fixed by matching
the `(opts, callback)` signature, with the same `typeof opts === 'function'` normalization used
elsewhere in the file.

## 4. Production Replication Round-Trip

`tests/production.replication.test.ts` verifies PouchDB's standard replication protocol works
correctly *through* a real Google Drive-backed database — both a no-op idempotency leg and a genuine
bidirectional-writes leg (new docs plus updates to docs that originated on the other side), pushed
through the Drive hub in both directions.

```bash
npm run test:prod:replication
# Windows: TEST_ENV=production npx jest tests/production.replication.test.ts
```
Same `KEEP_TEST_DATA` / `PROD_TEST_DOC_COUNT` env vars as the explorer tool (section 3).

Full write-up — the test topology, the `activeTasks` test-harness gotcha, the bugs it found (most
notably `db.bulkDocs(..., { new_edits: false })` silently discarding replicated revisions), and the
merged historical record of earlier replication fixes — lives in
[`docs/REPLICATION.ipynb`](REPLICATION.ipynb).
