/**
 * Production Replication Round-Trip
 * ===================================
 * Development tool (packaged as a Jest test, same as tests/production.explore.test.ts),
 * not a narrow pass/fail unit test. It verifies that PouchDB's standard replication
 * protocol works correctly THROUGH a real Google Drive-backed database, with BOTH
 * sides actually writing - the real-world shape of two devices syncing through a
 * shared Drive folder, not just a one-way mirror:
 *
 *   classical (memory) instance A --replicate--> Google Drive instance B
 *   Google Drive instance B       --replicate--> classical (memory) instance C
 *   ... C makes its own writes: updates to docs that originated on A, plus brand
 *       new docs that never existed on A ...
 *   classical (memory) instance C --replicate--> Google Drive instance B
 *   Google Drive instance B       --replicate--> classical (memory) instance A
 *
 * A plain C -> A leg (with C being a pure, untouched mirror of A) would be a no-op and
 * wouldn't prove bidirectional sync works - the point of this test is that C's *own*
 * edits and new documents survive being pushed back into the Drive hub and pulled back
 * down to the origin, with correct revisions and without corrupting the data A never
 * touched.
 *
 * It writes documents and a couple of updates (second revisions) on A, replicates
 * A -> B, deep-compares every document (including revision IDs, not just content) on
 * B against A, replicates B -> C and compares the same way, has C update two of the
 * A-originated docs and create two brand new ones, pushes that into B, then pulls the
 * merged state back down to A and confirms: (1) A now matches C's final state exactly,
 * and (2) every doc neither A nor C touched survived the whole loop byte-identical. A
 * structural mismatch at any hop, or any drift on the untouched docs, is a failure.
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

    it('replicates memory -> Drive -> memory -> memory in a full loop without drift', async () => {
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
        const cmpAC = compareDocSets('A -> C (transitively, via B)', aDocs, cDocs, record);
        comparisons.push(cmpAC);

        // --- Phase 4: replicate C (memory) -> A (memory), closing the loop -----------
        // C's data is just a mirror of A's, so this should be a no-op from PouchDB's point
        // of view (the checkpoint/revsDiff machinery should find nothing new to write) -
        // but actually running it, rather than assuming, is the point: it proves the whole
        // loop (A -> B -> C -> A) round-trips without corrupting or drifting A's data, which
        // is the real-world shape of two devices syncing through a shared Drive folder.
        record('--- Phase 4: replicating C -> A, closing the loop back to the origin (idempotency check) ---');
        const t2 = Date.now();
        await replicateOnce(targetC, sourceA, record);
        record(`C -> A replication complete in ${Date.now() - t2}ms`);

        const aDocsAfterIdempotentLoop = docsById((await sourceA.allDocs({ include_docs: true })).rows);
        const cmpCA = compareDocSets('C -> A (closing the loop, idempotent)', cDocs, aDocsAfterIdempotentLoop, record);
        comparisons.push(cmpCA);
        const cmpNoDriftIdempotent = compareDocSets('A before vs after idempotent loop (no-drift check)', aDocs, aDocsAfterIdempotentLoop, record);
        comparisons.push(cmpNoDriftIdempotent);

        // --- Phase 5: C makes its OWN writes - new docs, and updates to docs that ------
        // originated on A. The idempotent C -> A leg above doesn't prove bidirectional
        // sync actually works, since C was still just an untouched mirror at that point.
        // The real-world scenario is two devices syncing through a shared Drive folder,
        // where BOTH sides write; this phase makes C do that.
        record('--- Phase 5: making local writes on C (updates to A-originated docs + brand new docs) ---');
        const updatedOnC = ['doc-2', 'doc-3']; // untouched by A's own Phase 1 updates (doc-0/doc-1)
        for (const id of updatedOnC) {
            const existing: any = await targetC.get(id);
            existing.updatedByC = true;
            existing.payload = 'c-edit-' + existing.payload;
            await targetC.put(existing);
        }
        const newOnC = ['c-doc-0', 'c-doc-1'];
        for (const id of newOnC) {
            await targetC.put({ _id: id, origin: 'C', payload: 'created directly on C' });
        }
        record('C doc count after local writes:', (await targetC.info()).doc_count);

        // --- Phase 6: push C's changes back into the Drive hub (C -> B) ----------------
        record("--- Phase 6: replicating C's changes into the Drive hub (C -> B) ---");
        const t3 = Date.now();
        await replicateOnce(targetC, hubB, record);
        record(`C -> B replication complete in ${Date.now() - t3}ms`);

        const cDocsAfterWrites = docsById((await targetC.allDocs({ include_docs: true })).rows);
        const bDocsAfterPush = docsById((await hubB.allDocs({ include_docs: true })).rows);
        const cmpCB = compareDocSets("C -> B (C's writes landed in the Drive hub)", cDocsAfterWrites, bDocsAfterPush, record);
        comparisons.push(cmpCB);

        // --- Phase 7: pull the hub's now-merged state down to A (B -> A) ---------------
        // This is what actually proves bidirectional sync: A should end up with its own
        // untouched docs, PLUS C's updates to doc-2/doc-3, PLUS C's brand new docs - all
        // delivered through the same Drive-backed adapter that wrote them.
        record('--- Phase 7: replicating the merged hub state down to A (B -> A) ---');
        const t4 = Date.now();
        await replicateOnce(hubB, sourceA, record);
        record(`B -> A replication complete in ${Date.now() - t4}ms`);

        const aDocsAfterFullLoop = docsById((await sourceA.allDocs({ include_docs: true })).rows);
        const cmpFinal = compareDocSets('A after full loop vs C (should now fully match)', cDocsAfterWrites, aDocsAfterFullLoop, record);
        comparisons.push(cmpFinal);

        // Docs neither A nor C ever touched should have survived the whole session
        // byte-identical - proof the round trip doesn't silently corrupt unrelated data.
        const untouchedIds = Object.keys(aDocs).filter(id => !updatedOnC.includes(id));
        const aDocsUntouchedBefore: Record<string, any> = {};
        const aDocsUntouchedAfter: Record<string, any> = {};
        for (const id of untouchedIds) {
            aDocsUntouchedBefore[id] = aDocs[id];
            aDocsUntouchedAfter[id] = aDocsAfterFullLoop[id];
        }
        const cmpNoDrift = compareDocSets('Untouched docs before vs after full session (no-drift check)', aDocsUntouchedBefore, aDocsUntouchedAfter, record);
        comparisons.push(cmpNoDrift);

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
        expect(cmpCA.ok).toBe(true);
        expect(cmpNoDriftIdempotent.ok).toBe(true);
        expect(cmpCB.ok).toBe(true);
        expect(cmpFinal.ok).toBe(true);
        expect(cmpNoDrift.ok).toBe(true);
    }, 210000);
});
