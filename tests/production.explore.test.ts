/**
 * Production Drive Explorer
 * ==========================
 * This is NOT a pass/fail unit test. It is a development tool, packaged as a Jest
 * test so it can reuse the existing `TEST_ENV=production` / `.env` token plumbing
 * (see `tests-src/test-config.ts`).
 *
 * It exercises the adapter against a REAL Google Drive account:
 *   1. Writes a batch of documents (creates, updates, one delete) through PouchDB.
 *   2. Queries them back through PouchDB (`allDocs`, `get`, `info`).
 *   3. Triggers compaction twice (with a second write round in between) using the
 *      public `db.compact()` API.
 *   4. After each phase, bypasses the adapter entirely and talks to the Drive API
 *      directly (via `GoogleDriveClient`) to list the *real* file structure in the
 *      DB's Drive folder, classify every file, and cross-reference it against
 *      `_meta.json` + the snapshot index to find files that are no longer
 *      referenced by anything ("orphans"/clutter left behind by compaction).
 *   5. Spot-checks that a document's content read via PouchDB matches the bytes
 *      actually stored in the raw Drive snapshot file.
 *
 * Every phase is logged to console AND to a report file so you can inspect what
 * happened after the run (including a JSON dump of every file + the computed
 * orphan set) without re-running anything.
 *
 * Skipped entirely unless TEST_ENV=production. This only runs when explicitly invoked.
 *
 * Usage:
 *   npm run test:prod:explore
 *
 * Env vars:
 *   KEEP_TEST_DATA=1        Skip deleting the Drive folder at the end, so you can
 *                            open it in Drive / rerun the audit manually.
 *   PROD_TEST_DOC_COUNT=20  Override how many documents to write in the first round
 *                            (default 12).
 *
 * See docs/DOCUMENTATION.md section "Production Drive Explorer" for details on how
 * to read the generated report.
 */

import * as fs from 'fs';
import * as path from 'path';
import PouchDB from 'pouchdb-core';
import GoogleDriveAdapter from '../src/index';
import { GoogleDriveClient, DriveFile } from '../src/client';
import { isProd, accessToken, getTestOptions } from '../tests-src/test-config';

PouchDB.plugin(GoogleDriveAdapter({ accessToken: 'placeholder' } as any));

const RUN_TS = Date.now();
const REPORT_DIR = path.resolve(__dirname, '..', 'prod-test-reports', `run-${RUN_TS}`);
const KEEP_TEST_DATA = process.env.KEEP_TEST_DATA === '1';
const DOC_COUNT = parseInt(process.env.PROD_TEST_DOC_COUNT || '12', 10);
const INSPECT_CONTENT = process.env.INSPECT_CONTENT !== '0';
const CONSISTENCY_WAIT_MS = 4000; // buffer for Drive eventual consistency after compaction

/** Downloaded-content summary for one file (doc/entry counts, approximate on-disk size). */
interface ContentSummary {
    docCount?: number;      // snapshot-data / local-docs: number of document bodies in the chunk
    docIds?: string[];      // ids contained in this file (used to detect cross-file duplication)
    entryCount?: number;    // changes-log: number of change entries in the ndjson file
    approxBytes: number;    // length of the downloaded content, as a stand-in for storage cost
}

interface CategorizedFile {
    id: string;
    name: string;
    category: string;
    modifiedTime?: string;
    content?: ContentSummary;
}

interface FolderAudit {
    label: string;
    fileCount: number;
    byCategory: Record<string, number>;
    files: CategorizedFile[];
    meta: any;
    orphans: CategorizedFile[];
    /** Sum of approxBytes across every inspected file (undefined if content inspection was skipped). */
    totalBytes?: number;
    /** Sum of approxBytes across orphaned files only - the concrete storage cost of the clutter. */
    orphanBytes?: number;
    /** Doc IDs that appear in more than one snapshot-data/local-docs file at once. Should always
     *  be empty - if it isn't, the same document body is being stored redundantly in Drive. */
    duplicateDocIds?: string[];
}

function categorize(name: string): string {
    if (name === '_meta.json') return 'meta';
    if (name === '_local_docs.json') return 'local-docs';
    if (name.startsWith('snapshot-index-')) return 'snapshot-index';
    if (name.startsWith('snapshot-data-')) return 'snapshot-data';
    if (name.startsWith('changes-')) return 'changes-log';
    return 'unknown';
}

/** Downloads a file's actual content and summarizes it (doc/entry count, byte size, doc IDs
 *  present) so redundancy/clutter can be judged by bytes and doc overlap, not just file counts. */
async function inspectFileContent(
    client: GoogleDriveClient,
    file: CategorizedFile,
    record: (...args: any[]) => void
): Promise<ContentSummary | undefined> {
    if (!['snapshot-data', 'local-docs', 'changes-log'].includes(file.category)) return undefined;

    try {
        const raw = await client.getFile(file.id);

        if (file.category === 'changes-log') {
            // Stored as newline-delimited JSON; getFile() returns it as raw text since its
            // content-type isn't application/json.
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
            const entries = text.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
                try { return JSON.parse(line); } catch { return null; }
            }).filter(Boolean);
            return {
                entryCount: entries.length,
                docIds: entries.map((e: any) => e.id),
                approxBytes: text.length
            };
        }

        // snapshot-data / local-docs: a single JSON object of { docs: { id: body } }
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const docIds = Object.keys(parsed?.docs || {});
        return {
            docCount: docIds.length,
            docIds,
            approxBytes: (typeof raw === 'string' ? raw : JSON.stringify(raw)).length
        };
    } catch (e: any) {
        record(`WARNING: failed to inspect content of ${file.name} (${file.id}):`, e.message);
        return undefined;
    }
}

async function findFolderId(client: GoogleDriveClient, dbName: string): Promise<string> {
    const q = `name = '${dbName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const folders = await client.listFiles(q);
    if (!folders.length) throw new Error(`Could not find Drive folder for db "${dbName}"`);
    return folders[0].id;
}

/** Lists the DB folder directly via the Drive API and cross-references files against
 *  _meta.json + the snapshot index to find anything left behind ("orphans"). */
async function auditFolder(
    client: GoogleDriveClient,
    folderId: string,
    label: string,
    record: (...args: any[]) => void
): Promise<FolderAudit> {
    const files: DriveFile[] = await client.listFiles(`'${folderId}' in parents and trashed = false`);
    const categorized: CategorizedFile[] = files.map(f => ({
        id: f.id,
        name: f.name,
        category: categorize(f.name),
        modifiedTime: f.modifiedTime
    }));

    const metaFile = categorized.find(f => f.category === 'meta');
    let meta: any = null;
    const referenced = new Set<string>();

    if (metaFile) {
        meta = await client.getFile(metaFile.id);
        referenced.add(metaFile.id);
        if (meta.snapshotIndexId) referenced.add(meta.snapshotIndexId);
        (meta.changeLogIds || []).forEach((id: string) => referenced.add(id));
        if (meta.localDocsId) referenced.add(meta.localDocsId);

        if (meta.snapshotIndexId) {
            try {
                const index = await client.getFile(meta.snapshotIndexId);
                const entries = index?.entries || {};
                for (const key of Object.keys(entries)) {
                    const fileId = entries[key]?.location?.fileId;
                    if (fileId) referenced.add(fileId);
                }
            } catch (e: any) {
                record(`[${label}] WARNING: failed to load snapshot index for reference resolution:`, e.message);
            }
        }
    } else {
        record(`[${label}] WARNING: no _meta.json found in folder`);
    }

    const orphans = categorized.filter(f => !referenced.has(f.id));
    const byCategory: Record<string, number> = {};
    categorized.forEach(f => { byCategory[f.category] = (byCategory[f.category] || 0) + 1; });

    record(`[${label}] files=${files.length} byCategory=${JSON.stringify(byCategory)} orphans=${orphans.length}`);
    if (orphans.length) {
        record(`[${label}] orphaned files (present on Drive, not referenced by _meta.json or the snapshot index):`);
        orphans.forEach(o => record(`    - ${o.name}  (${o.id}, ${o.category})`));
    }

    const audit: FolderAudit = { label, fileCount: files.length, byCategory, files: categorized, meta, orphans };

    if (INSPECT_CONTENT) {
        await Promise.all(categorized.map(async f => {
            f.content = await inspectFileContent(client, f, record);
        }));

        audit.totalBytes = categorized.reduce((sum, f) => sum + (f.content?.approxBytes || 0), 0);
        audit.orphanBytes = orphans.reduce((sum, f) => sum + (f.content?.approxBytes || 0), 0);

        // Cross-file duplication: the same doc ID showing up in more than one
        // snapshot-data/local-docs file means that document's body is stored redundantly.
        const dataFiles = categorized.filter(f => f.category === 'snapshot-data' || f.category === 'local-docs');
        const seenIn: Record<string, number> = {};
        for (const f of dataFiles) {
            for (const id of f.content?.docIds || []) {
                seenIn[id] = (seenIn[id] || 0) + 1;
            }
        }
        audit.duplicateDocIds = Object.keys(seenIn).filter(id => seenIn[id] > 1);

        const orphanPct = audit.totalBytes ? ((audit.orphanBytes / audit.totalBytes) * 100).toFixed(1) : '0.0';
        record(
            `[${label}] content: totalBytes=${audit.totalBytes} orphanBytes=${audit.orphanBytes} ` +
            `(${orphanPct}% clutter) duplicateDocIds=${audit.duplicateDocIds.length}`
        );
        if (audit.duplicateDocIds.length) {
            record(`[${label}] WARNING: these doc IDs are stored redundantly in more than one data file:`, audit.duplicateDocIds);
        }
    }

    return audit;
}

const maybeDescribe = isProd ? describe : describe.skip;

maybeDescribe('Production Drive Explorer', () => {
    let client: GoogleDriveClient;
    let dbName: string;
    let folderId: string | undefined;
    let db: any;
    const logLines: string[] = [];
    const audits: FolderAudit[] = [];

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
        dbName = 'prod-explore-' + RUN_TS;
    });

    afterAll(async () => {
        if (db) {
            try { await db.close(); } catch (e) { record('Error closing db:', e); }
        }
        if (folderId) {
            if (KEEP_TEST_DATA) {
                record('KEEP_TEST_DATA=1 set — leaving Drive folder in place for manual inspection:', folderId);
            } else {
                record('Cleaning up: deleting Drive folder', folderId);
                try {
                    await client.deleteFile(folderId);
                    record('Folder deleted.');
                } catch (e: any) {
                    record('WARNING: cleanup failed, folder may still exist:', e.message);
                }
            }
        }
        flushLog();
        console.log(`\nProduction Drive Explorer report written to: ${REPORT_DIR}`);
    }, 60000);

    it('writes docs, queries via PouchDB, compacts, and audits the raw Drive structure', async () => {
        record('=== Production Drive Explorer ===');
        record('dbName:', dbName);
        record('docCount (round 1):', DOC_COUNT);

        const options = getTestOptions(dbName);
        db = new PouchDB(dbName, options as any);

        // --- Phase 1: writes -------------------------------------------------
        record('--- Phase 1: writing documents ---');
        for (let i = 0; i < DOC_COUNT; i++) {
            const kind = i % 3 === 0 ? 'alpha' : i % 3 === 1 ? 'beta' : 'gamma';
            const doc = { _id: `doc-${i}`, seq: i, kind, payload: 'x'.repeat(200) };
            const res = await db.put(doc);
            record('put', doc._id, '->', res.rev);
        }

        // Update a couple of docs so they get a second revision.
        for (const id of ['doc-0', 'doc-1']) {
            const existing: any = await db.get(id);
            existing.updated = true;
            const res = await db.put(existing);
            record('update', id, '->', res.rev);
        }

        // Delete one doc.
        const toDelete: any = await db.get('doc-2');
        await db.remove(toDelete);
        record('deleted doc-2');

        // Resolve the Drive folder now, before any assertion below can throw —
        // otherwise a failed assertion skips cleanup and leaks the test folder.
        folderId = await findFolderId(client, dbName);
        record('resolved Drive folderId:', folderId);

        // --- Phase 2: query via PouchDB --------------------------------------
        record('--- Phase 2: querying via PouchDB ---');
        const allDocs = await db.allDocs({ include_docs: true });
        const info = await db.info();
        record('allDocs rows:', allDocs.rows.length);
        record('info:', info);

        expect(allDocs.rows.length).toBe(DOC_COUNT - 1);
        expect(info.doc_count).toBe(DOC_COUNT - 1);

        const preCompaction = await auditFolder(client, folderId, 'pre-compaction', record);
        audits.push(preCompaction);

        // --- Phase 3: first compaction ----------------------------------------
        record('--- Phase 3: triggering compaction #1 ---');
        await db.compact();
        await new Promise(r => setTimeout(r, CONSISTENCY_WAIT_MS));

        const postCompaction1 = await auditFolder(client, folderId, 'post-compaction-1', record);
        audits.push(postCompaction1);

        // --- Phase 4: second write + compact round -----------------------------
        record('--- Phase 4: second write/compact round (checking if clutter accumulates) ---');
        const round2Count = 5;
        for (let i = DOC_COUNT; i < DOC_COUNT + round2Count; i++) {
            await db.put({ _id: `doc-${i}`, seq: i, kind: 'delta' });
        }
        await db.compact();
        await new Promise(r => setTimeout(r, CONSISTENCY_WAIT_MS));

        const postCompaction2 = await auditFolder(client, folderId, 'post-compaction-2', record);
        audits.push(postCompaction2);

        // --- Phase 5: content diff (PouchDB view vs raw Drive bytes) -----------
        record('--- Phase 5: verifying content directly against raw Drive files ---');
        const finalAllDocs = await db.allDocs({ include_docs: true });
        expect(finalAllDocs.rows.length).toBe(DOC_COUNT - 1 + round2Count);

        const sampleId = 'doc-0';
        const viaPouch: any = await db.get(sampleId);
        const finalMeta = postCompaction2.meta;
        if (finalMeta?.snapshotIndexId) {
            const index = await client.getFile(finalMeta.snapshotIndexId);
            const entry = index?.entries?.[sampleId];
            if (entry?.location?.fileId) {
                const dataChunk = await client.getFile(entry.location.fileId);
                const viaDriveRaw = dataChunk?.docs?.[sampleId];
                record(`${sampleId} via PouchDB:`, viaPouch);
                record(`${sampleId} via raw Drive file (${entry.location.fileId}):`, viaDriveRaw);
                expect(viaDriveRaw).toBeTruthy();
                expect(viaDriveRaw.updated).toBe(true);
                expect(viaDriveRaw.seq).toBe(viaPouch.seq);
            } else {
                record(`${sampleId} not present in snapshot index — skipping raw content diff`);
            }
        }

        // --- Report -------------------------------------------------------------
        const report = {
            dbName,
            folderId,
            runTimestamp: RUN_TS,
            docCountRound1: DOC_COUNT,
            docCountRound2: round2Count,
            finalDocCount: finalAllDocs.rows.length,
            audits
        };
        fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2));
        flushLog();

        const growingOrphans = postCompaction2.orphans.length > postCompaction1.orphans.length;
        if (postCompaction1.orphans.length > 0 || postCompaction2.orphans.length > 0) {
            record(
                'WARNING: compaction left orphaned files behind on Drive ' +
                `(post-compaction-1: ${postCompaction1.orphans.length}, post-compaction-2: ${postCompaction2.orphans.length}).`
            );
            if (growingOrphans) {
                record('Orphan count grew between compaction rounds — this looks like a persistent leak, not a one-off.');
            }
        } else {
            record('No orphaned files detected after either compaction round.');
        }

        if (INSPECT_CONTENT) {
            if ((postCompaction2.orphanBytes || 0) > 0) {
                record(`WARNING: ~${postCompaction2.orphanBytes} bytes of clutter sitting in orphaned files after the final compaction.`);
            }
            if ((postCompaction2.duplicateDocIds?.length || 0) > 0) {
                record('WARNING: document bodies duplicated across multiple data files:', postCompaction2.duplicateDocIds);
            }
        }
    }, 480000);
});
