import { DriveHandler } from '../src/drive';
import { GoogleDriveClient } from '../src/client';
import { ChangeEntry } from '../src/types';
import { FakeDrive } from './fake-drive';

jest.mock('../src/client');

/**
 * Writers that overlap in time, rather than one-after-another.
 *
 * `meta_concurrency.test.ts` drives its clients in sequence: A finishes, then B goes,
 * holding metadata it read before A wrote. That is the stale-writer shape. This file
 * is the other one - several appends genuinely in flight at once, which is what two
 * replicating browser contexts against one folder actually do.
 *
 * Reported from Tokido on 2026-08-27: seventeen change logs in the folder, fourteen
 * referenced, duplicate sequence numbers in the filenames.
 */

const drive = new FakeDrive();
const FOLDER = 'folder-1';

function handler(dbName: string): DriveHandler {
    return new DriveHandler({ accessToken: 'token', folderId: FOLDER }, dbName);
}

function change(id: string, rev: string): ChangeEntry {
    return { seq: 1, id, rev, timestamp: Date.now(), doc: { _id: id, _rev: rev, value: id } };
}

/** Every document written must be readable by a client that arrives afterwards. */
async function expectAllReadable(ids: string[]) {
    const reader = handler('reader');
    await reader.load();
    const missing: string[] = [];
    for (const id of ids) {
        if (!(await reader.get(id))) missing.push(id);
    }
    expect(missing).toEqual([]);
}

describe('Writers appending at the same time', () => {
    beforeEach(() => {
        drive.reset();
        (GoogleDriveClient as unknown as jest.Mock).mockImplementation(() => drive.client());
        drive.addFolder('test-db', FOLDER);
    });

    it('two clients appending at once orphan nothing', async () => {
        drive.latencyMs = 3; // overlap the round trips

        const a = handler('client-a');
        const b = handler('client-b');
        await a.load();
        await b.load();

        await Promise.all([
            a.appendChange(change('doc-a', '1-a')),
            b.appendChange(change('doc-b', '1-b'))
        ]);

        expect(drive.orphanedLogs()).toEqual([]);
        await expectAllReadable(['doc-a', 'doc-b']);
    }, 30000);

    it('survives several rounds of overlapping appends', async () => {
        drive.latencyMs = 3;

        const a = handler('client-a');
        const b = handler('client-b');
        await a.load();
        await b.load();

        const ids: string[] = [];
        for (let round = 0; round < 4; round++) {
            const idA = `doc-a${round}`;
            const idB = `doc-b${round}`;
            ids.push(idA, idB);
            await Promise.all([
                a.appendChange(change(idA, '1-a' + round)),
                b.appendChange(change(idB, '1-b' + round))
            ]);
        }

        expect(drive.orphanedLogs()).toEqual([]);
        await expectAllReadable(ids);
    }, 60000);

    it('hands out no duplicate sequence numbers under overlap', async () => {
        drive.latencyMs = 3;

        const a = handler('client-a');
        const b = handler('client-b');
        await a.load();
        await b.load();

        await Promise.all([
            a.appendChange(change('doc-a', '1-a')),
            b.appendChange(change('doc-b', '1-b'))
        ]);

        // Every sequence number in the folder, referenced or not - an unreferenced
        // log is adopted on the next read now, so its numbers count too.
        expect(drive.duplicateSeqs()).toEqual([]);
        const seqs = drive.changeLogs().flatMap(f => drive.entriesIn(f)).map(c => c.seq);
        expect(new Set(seqs).size).toBe(seqs.length);
    }, 30000);
});
