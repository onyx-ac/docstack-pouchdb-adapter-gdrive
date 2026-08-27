/**
 * Production Multi-Writer Invariants
 * ==================================
 * Development tool (packaged as a Jest test, same as the other production.* files),
 * exercising the concurrency machinery against a REAL Google Drive account.
 *
 * The entire ADR series this adapter carries (0001 metadata without compare-and-swap,
 * 0002 the folder is the index, 0003 writer slots, 0006 index regression) was proven
 * against `tests/fake-drive.ts` - a simulation of how Drive behaves, ETag-less and
 * eventually surprising. This file re-checks the load-bearing invariants against the
 * genuine article, because every one of those findings shipped after a fake had said
 * the previous fix was fine:
 *
 *   1. Two writers sharing one folder never orphan each other's change logs.
 *   2. No sequence number is ever claimed twice.
 *   3. A metadata lost-update (simulated by writing a stale changeLogIds back,
 *      through the raw client - the very race Drive cannot prevent) costs nothing:
 *      a fresh reader still finds every document, and repairs the metadata.
 *   4. Acknowledged writes survive: everything appendChanges() confirmed is readable
 *      by a cold reader afterwards.
 *
 * Skipped entirely unless TEST_ENV=production - only runs when explicitly invoked.
 *
 * Usage:
 *   npm run test:prod:concurrency
 *   (on Windows, run through Git Bash: TEST_ENV=production npx jest tests/production.concurrency.test.ts)
 *
 * Env vars:
 *   KEEP_TEST_DATA=1   Skip deleting the Drive folder at the end.
 */
import { DriveHandler } from '../src/drive';
import { GoogleDriveClient } from '../src/client';
import { ChangeEntry, MetaData } from '../src/types';
import { isProd, accessToken } from '../tests-src/test-config';

const describeProd = isProd ? describe : describe.skip;

const RUN_TS = Date.now();
const FOLDER_NAME = `adapter-prod-concurrency-${RUN_TS}`;

jest.setTimeout(300000);

function change(id: string, rev: string): ChangeEntry {
    return { seq: 1, id, rev, timestamp: Date.now(), doc: { _id: id, _rev: rev, value: id } };
}

describeProd('Production multi-writer invariants', () => {
    let folderId: string;
    let raw: GoogleDriveClient;
    let a: DriveHandler;
    let b: DriveHandler;

    /** The folder's state, read through the raw client - never through a handler. */
    async function folderState() {
        const files = await raw.listFiles(`'${folderId}' in parents and trashed = false`);
        const metaFile = files.find(f => f.name === '_meta.json');
        if (!metaFile) throw new Error('no _meta.json in folder');
        // The real client parses JSON bodies itself when Drive labels them; be
        // indifferent to which shape arrives.
        const rawMeta = await raw.getFile(metaFile.id);
        const meta = (typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta) as MetaData;
        const logs = files.filter(f => f.name.startsWith('changes-'));
        return { files, metaFile, meta, logs };
    }

    async function orphanedLogs() {
        const { meta, logs } = await folderState();
        const referenced = new Set(meta.changeLogIds);
        return logs.filter(f => !referenced.has(f.id)).map(f => f.name);
    }

    async function allSeqs(): Promise<number[]> {
        const { logs } = await folderState();
        const seqs: number[] = [];
        for (const log of logs) {
            const content = await raw.getFile(log.id);
            const rows: ChangeEntry[] = typeof content === 'string'
                ? content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
                : (Array.isArray(content) ? content : [content]);
            for (const row of rows) seqs.push(row.seq);
        }
        return seqs;
    }

    beforeAll(async () => {
        raw = new GoogleDriveClient({ accessToken });
        const res = await raw.createFile(FOLDER_NAME, undefined, 'application/vnd.google-apps.folder', '');
        folderId = res.id;
        console.log(`[prod-concurrency] folder ${FOLDER_NAME} (${folderId})`);

        a = new DriveHandler({ accessToken, folderId }, 'writer-a');
        b = new DriveHandler({ accessToken, folderId }, 'writer-b');
        await a.load();
        await b.load();
    });

    afterAll(async () => {
        a?.stopPolling();
        b?.stopPolling();
        if (process.env.KEEP_TEST_DATA) {
            console.log(`[prod-concurrency] keeping folder ${folderId}`);
            return;
        }
        try {
            await raw.deleteFile(folderId);
        } catch (e) {
            console.warn('[prod-concurrency] folder cleanup failed', e);
        }
    });

    it('interleaved writers orphan nothing and never share a sequence number', async () => {
        const acknowledged: string[] = [];

        // Alternating single appends - the stale-writer shape.
        for (let round = 0; round < 3; round++) {
            await a.appendChange(change(`doc-a${round}`, `1-a${round}`));
            acknowledged.push(`doc-a${round}`);
            await b.appendChange(change(`doc-b${round}`, `1-b${round}`));
            acknowledged.push(`doc-b${round}`);
        }

        // Overlapping appends - the simultaneous shape.
        for (let round = 3; round < 6; round++) {
            await Promise.all([
                a.appendChange(change(`doc-a${round}`, `1-a${round}`)).then(() => acknowledged.push(`doc-a${round}`)),
                b.appendChange(change(`doc-b${round}`, `1-b${round}`)).then(() => acknowledged.push(`doc-b${round}`))
            ]);
        }

        // Invariant 1: every change log in the folder is referenced.
        expect(await orphanedLogs()).toEqual([]);

        // Invariant 2: no sequence number claimed twice.
        const seqs = await allSeqs();
        expect(new Set(seqs).size).toBe(seqs.length);

        // Invariant 4: a cold reader sees everything that was acknowledged.
        const reader = new DriveHandler({ accessToken, folderId }, 'reader');
        await reader.load();
        const missing: string[] = [];
        for (const id of acknowledged) {
            if (!(await reader.get(id))) missing.push(id);
        }
        expect(missing).toEqual([]);
        reader.stopPolling();
    });

    it('a real metadata lost-update costs no documents', async () => {
        await a.appendChange(change('doc-lost-update', '1-lu'));

        // Overwrite _meta.json with a stale changeLogIds through the raw client -
        // exactly what a slower concurrent writer's read-modify-write does, since
        // Drive v3 gives it nothing to notice us with.
        const { metaFile, meta } = await folderState();
        const clobbered = { ...meta, changeLogIds: [] as string[] };
        await raw.updateFile(metaFile.id, JSON.stringify(clobbered));

        // Invariant 3: a fresh reader finds the document anyway, from the folder
        // listing, and writes the reference back for everyone.
        const reader = new DriveHandler({ accessToken, folderId }, 'repair-reader');
        await reader.load();
        expect(await reader.get('doc-lost-update')).toMatchObject({ _id: 'doc-lost-update' });
        reader.stopPolling();

        expect(await orphanedLogs()).toEqual([]);
    });
});
