/**
 * Production Replication Round-Trip
 * ===================================
 * Development tool (packaged as a Jest test, same as tests/production.explore.test.ts),
 * not a narrow pass/fail unit test. It verifies that PouchDB's standard replication
 * protocol works correctly THROUGH a real Google Drive-backed database, in both
 * directions:
 *
 *   classical (memory) instance A --replicate--> Google Drive instance B
 *   Google Drive instance B       --replicate--> classical (memory) instance C
 *
 * i.e. Google Drive acting as the replication hub between two ordinary PouchDB
 * instances, which is the adapter's actual intended use case (sync a local PouchDB
 * to Drive, then pull it down on another device/instance).
 *
 * It writes documents and a couple of updates (second revisions) on A, replicates
 * A -> B, deep-compares every document (including revision IDs, not just content) on
 * B against A, then replicates B -> C and deep-compares C against A/B the same way.
 * A structural mismatch at either hop - missing docs, extra docs, wrong revision,
 * wrong content - is treated as a failure.
 *
 * Skipped entirely unless TEST_ENV=production - only runs when explicitly invoked.
 *
 * Usage:
 *   npm run test:prod:replication
 *   (on Windows, run through Git Bash: TEST_ENV=production npx jest tests/production.replication.test.ts)
 *
 * Env vars:
 *   KEEP_TEST_DATA=1        Skip deleting the Drive folder at the end.
 *   PROD_TEST_DOC_COUNT=10  Override how many documents to write on instance A.
 *
 * See docs/TESTING.md for details, including a write-up of the `activeTasks` gap
 * this tool needed to work around below (bare `pouchdb-core` + `pouchdb-adapter-memory`
 * don't provide `db.activeTasks`, which pouchdb-replication's checkpointing requires
 * on whichever side is acting as the replication *source* - without it, replication
 * dies silently instead of emitting 'error').
 */

import * as fs from 'fs';
import * as path from 'path';
import PouchDB from 'pouchdb-core';
import Replication from 'pouchdb-replication';
import MemoryAdapter from 'pouchdb-adapter-memory';
import GoogleDriveAdapter from '../src/index';
import { GoogleDriveClient } from '../src/client';
import { isProd, accessToken, getTestOptions } from '../tests-src/test-config';

PouchDB.plugin(GoogleDriveAdapter({ accessToken: 'placeholder' } as any));
PouchDB.plugin(Replication);
PouchDB.plugin(MemoryAdapter);

const RUN_TS = Date.now();
const REPORT_DIR = path.resolve(__dirname, '..', 'prod-test-reports', `replication-run-${RUN_TS}`);
const KEEP_TEST_DATA = process.env.KEEP_TEST_DATA === '1';
const DOC_COUNT = parseInt(process.env.PROD_TEST_DOC_COUNT || '10', 10);

/**
 * pouchdb-replication's internal `createTask()`/`completeReplication()` call
 * `src.activeTasks.add/remove/update` unconditionally on whichever database is acting
 * as the replication SOURCE. Our Google Drive adapter provides this itself (see
 * `src/adapter.ts`), but a plain `pouchdb-core` + `pouchdb-adapter-memory` instance
 * does not - so the very first `memory -> gdrive` replication in this file crashes
 * deep inside pouchdb-replication with `Cannot read properties of undefined (reading
 * 'add')`, and because that throw happens inside an internal, unawaited promise chain,
 * it never reaches this test's 'error' listener - the replication just hangs forever
 * from the caller's point of view. Same minimal polyfill as the adapter's own.
 */
function ensureActiveTasks(db: any): void {
    if (db.activeTasks) return;
    const tasks: Record<string, any> = {};
    db.activeTasks = {
        add(task: any) {
            const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
            tasks[id] = { ...task, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
            return id;
        },
        remove(id: string) { delete tasks[id]; },
        update(id: string, update: any) {
            if (tasks[id]) Object.assign(tasks[id], update, { updated_at: new Date().toISOString() });
        },
        get(id: string) { return tasks[id]; },
        list() { return Object.values(tasks); }
    };
}

/** Deterministic (key-order-independent) stringify, so content comparisons aren't
 *  thrown off by adapters returning object keys in a different order. */
function stableStringify(value: any): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function docsById(rows: any[]): Record<string, any> {
    const map: Record<string, any> = {};
    for (const row of rows) {
        if (row.doc) {
            // _revisions is optional ancestry metadata that adapters differ on including by
            // default in allDocs() (the memory adapter omits it, this adapter includes it) -
            // that's a cosmetic difference, not a replication defect, so it's excluded from
            // the comparison. _rev itself (the field that actually matters) is always compared.
            const { _revisions, ...doc } = row.doc;
            map[row.id] = doc;
        }
    }
    return map;
}

interface CompareResult {
    label: string;
    sourceCount: number;
    targetCount: number;
    missingOnTarget: string[];
    unexpectedOnTarget: string[];
    contentMismatch: string[];
    ok: boolean;
}

/** Deep-compares two id->doc maps, including _rev - replication is only "correct" if
 *  the exact revision (not just the content) made it across. */
function compareDocSets(
    label: string,
    sourceDocs: Record<string, any>,
    targetDocs: Record<string, any>,
    record: (...args: any[]) => void
): CompareResult {
    const sourceIds = Object.keys(sourceDocs).sort();
    const targetIds = Object.keys(targetDocs).sort();

    const missingOnTarget = sourceIds.filter(id => !targetIds.includes(id));
    const unexpectedOnTarget = targetIds.filter(id => !sourceIds.includes(id));
    const contentMismatch = sourceIds.filter(id =>
        targetDocs[id] && stableStringify(sourceDocs[id]) !== stableStringify(targetDocs[id])
    );

    const ok = missingOnTarget.length === 0 && unexpectedOnTarget.length === 0 && contentMismatch.length === 0;

    record(
        `[${label}] source=${sourceIds.length} target=${targetIds.length} ` +
        `missing=${missingOnTarget.length} unexpected=${unexpectedOnTarget.length} mismatched=${contentMismatch.length}`
    );
    if (missingOnTarget.length) record(`[${label}] MISSING on target:`, missingOnTarget);
    if (unexpectedOnTarget.length) record(`[${label}] UNEXPECTED on target:`, unexpectedOnTarget);
    if (contentMismatch.length) {
        record(`[${label}] CONTENT/REV MISMATCH:`, contentMismatch);
        for (const id of contentMismatch) {
            record(`    - ${id} source:`, sourceDocs[id]);
            record(`    - ${id} target:`, targetDocs[id]);
        }
    }

    return { label, sourceCount: sourceIds.length, targetCount: targetIds.length, missingOnTarget, unexpectedOnTarget, contentMismatch, ok };
}

/** One-shot (non-live) replication, resolved/rejected via events - mirrors the
 *  pattern already used in tests/emulation.test.ts. */
function replicateOnce(source: any, target: any, record: (...args: any[]) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        source.replicate.to(target)
            .on('active', () => record('  replication active'))
            .on('denied', (err: any) => record('  replication denied:', err))
            .on('complete', (info: any) => { record('  replication complete:', info); resolve(); })
            .on('error', (err: any) => reject(err));
    });
}

const maybeDescribe = isProd ? describe : describe.skip;

maybeDescribe('Production Replication Round-Trip', () => {
    let client: GoogleDriveClient;
    let dbName: string;
    let sourceA: any;
    let hubB: any;
    let targetC: any;
    const logLines: string[] = [];
    const comparisons: CompareResult[] = [];

    const record = (...args: any[]) => {
        const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
        console.log(line);
        logLines.push(line);
    };

    const flushLog = () => {
        fs.mkdirSync(REPORT_DIR, { recursive: true });
        fs.writeFileSync(path.join(REPORT_DIR, 'run.log'), logLines.join('\n'));
    };

    beforeAll(() => {
        fs.mkdirSync(REPORT_DIR, { recursive: true });
        client = new GoogleDriveClient({ accessToken });
        dbName = 'prod-repl-' + RUN_TS;
    });

    afterAll(async () => {
        for (const [label, db] of [['sourceA', sourceA], ['hubB', hubB], ['targetC', targetC]] as const) {
            if (!db) continue;
            try {
                if (label === 'hubB') {
                    if (KEEP_TEST_DATA) {
                        record('KEEP_TEST_DATA=1 set — leaving Drive folder in place for manual inspection:', dbName);
                        await db.close();
                    } else {
                        record('Cleaning up: destroying Drive-backed hub instance and its folder');
                        await db.destroy({ deleteFolder: true } as any);
                        record('Drive folder deleted.');
                    }
                } else {
                    await db.destroy();
                }
            } catch (e: any) {
                record(`WARNING: cleanup of ${label} failed:`, e.message);
            }
        }
        flushLog();
        console.log(`\nProduction Replication report written to: ${REPORT_DIR}`);
    }, 60000);

    it('replicates memory -> Drive -> memory and preserves every document + revision', async () => {
        record('=== Production Replication Round-Trip ===');
        record('dbName (Drive hub):', dbName);
        record('docCount:', DOC_COUNT);

        sourceA = new PouchDB('prod-repl-source-' + RUN_TS, { adapter: 'memory' });
        hubB = new PouchDB(dbName, getTestOptions(dbName) as any);
        targetC = new PouchDB('prod-repl-target-' + RUN_TS, { adapter: 'memory' });
        ensureActiveTasks(sourceA);
        ensureActiveTasks(targetC);

        // --- Phase 1: write + update on the classical (memory) source ------------
        record('--- Phase 1: writing documents to classical instance A (memory adapter) ---');
        for (let i = 0; i < DOC_COUNT; i++) {
            const kind = i % 3 === 0 ? 'alpha' : i % 3 === 1 ? 'beta' : 'gamma';
            await sourceA.put({ _id: `doc-${i}`, seq: i, kind, payload: 'x'.repeat(200) });
        }
        for (const id of ['doc-0', 'doc-1']) {
            const existing: any = await sourceA.get(id);
            existing.updated = true;
            await sourceA.put(existing);
        }
        record('A doc count:', (await sourceA.info()).doc_count);

        // --- Phase 2: replicate A (memory) -> B (Google Drive) --------------------
        record('--- Phase 2: replicating A -> B (Google Drive) ---');
        const t0 = Date.now();
        await replicateOnce(sourceA, hubB, record);
        record(`A -> B replication complete in ${Date.now() - t0}ms`);

        const aDocs = docsById((await sourceA.allDocs({ include_docs: true })).rows);
        const bDocs = docsById((await hubB.allDocs({ include_docs: true })).rows);
        const cmpAB = compareDocSets('A -> B', aDocs, bDocs, record);
        comparisons.push(cmpAB);

        try {
            const files = await client.listFiles(`name = '${dbName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
            if (files.length) {
                const inFolder = await client.listFiles(`'${files[0].id}' in parents and trashed = false`);
                record('B Drive folder file count after replication:', inFolder.length, inFolder.map(f => f.name));
            }
        } catch (e: any) {
            record('WARNING: could not inspect B Drive folder:', e.message);
        }

        // --- Phase 3: replicate B (Google Drive) -> C (memory), the reverse hop ---
        record('--- Phase 3: replicating B (Google Drive) -> C (memory), the reverse direction ---');
        const t1 = Date.now();
        await replicateOnce(hubB, targetC, record);
        record(`B -> C replication complete in ${Date.now() - t1}ms`);

        const cDocs = docsById((await targetC.allDocs({ include_docs: true })).rows);
        const cmpBC = compareDocSets('B -> C', bDocs, cDocs, record);
        comparisons.push(cmpBC);
        const cmpAC = compareDocSets('A -> C (full round trip)', aDocs, cDocs, record);
        comparisons.push(cmpAC);

        // --- Report ----------------------------------------------------------------
        const report = {
            dbName,
            runTimestamp: RUN_TS,
            docCount: DOC_COUNT,
            comparisons
        };
        fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2));
        flushLog();

        expect(cmpAB.ok).toBe(true);
        expect(cmpBC.ok).toBe(true);
        expect(cmpAC.ok).toBe(true);
    }, 120000);
});
