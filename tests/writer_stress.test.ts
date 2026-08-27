import { DriveHandler } from '../src/drive';
import { GoogleDriveClient } from '../src/client';
import { ChangeEntry } from '../src/types';
import { FakeDrive } from './fake-drive';

jest.mock('../src/client');

/**
 * Many writers, jittered latency, and writers that vanish mid-write.
 *
 * The invariant under test is not "the folder stays tidy" - an interrupted write may
 * well leave a file nothing references. It is the narrower, load-bearing one:
 *
 *   **an append whose promise resolved must be readable by whoever comes next.**
 *
 * A log left behind by a write that was never acknowledged is garbage. A log left
 * behind holding the only copy of a document whose write *was* acknowledged is data
 * loss, and is what the Tokido finding of 2026-08-27 describes.
 */

const drive = new FakeDrive();
const FOLDER = 'folder-1';

function handler(dbName: string): DriveHandler {
    return new DriveHandler({ accessToken: 'token', folderId: FOLDER }, dbName);
}

function change(id: string, rev: string): ChangeEntry {
    return { seq: 1, id, rev, timestamp: Date.now(), doc: { _id: id, _rev: rev, value: id } };
}

async function readBackAll(ids: string[]): Promise<string[]> {
    const reader = handler('reader');
    await reader.load();
    const missing: string[] = [];
    for (const id of ids) {
        if (!(await reader.get(id))) missing.push(id);
    }
    return missing;
}

describe('Writer stress', () => {
    beforeEach(() => {
        drive.reset();
        (GoogleDriveClient as unknown as jest.Mock).mockImplementation(() => drive.client());
        drive.addFolder('test-db', FOLDER);
    });

    it('three writers, eight rounds, jittered latency', async () => {
        drive.latencyMs = 6;
        drive.jitter = true;

        const writers = ['a', 'b', 'c'].map(n => handler('client-' + n));
        for (const w of writers) await w.load();

        const acknowledged: string[] = [];
        for (let round = 0; round < 8; round++) {
            const batch = writers.map((w, i) => {
                const id = `doc-${i}-${round}`;
                return w.appendChange(change(id, `1-${i}${round}`)).then(() => {
                    acknowledged.push(id);
                });
            });
            await Promise.all(batch);
        }

        const missing = await readBackAll(acknowledged);
        if (missing.length) console.error("DIAGNOSIS", JSON.stringify(missing.map(id => drive.diagnose(id)), null, 1));
        expect(missing).toEqual([]);
        expect(drive.orphanedLogs()).toEqual([]);
        // Two writers sharing a sequence number is how a replication target silently
        // stops seeing one of them.
        expect(drive.duplicateSeqs()).toEqual([]);
    }, 120000);

    it('a writer that vanishes mid-append loses nothing it had acknowledged', async () => {
        drive.latencyMs = 4;
        drive.jitter = true;

        const a = handler('client-a');
        const b = handler('client-b');
        await a.load();
        await b.load();

        const acknowledged: string[] = [];
        for (let round = 0; round < 3; round++) {
            const id = `doc-${round}`;
            await a.appendChange(change(id, `1-a${round}`));
            acknowledged.push(id);
        }

        // B starts a write and the context goes away underneath it. Whatever B was
        // doing is forfeit - but nothing A was told had succeeded may go with it.
        const doomed = b.appendChange(change('doc-doomed', '1-doomed')).catch(() => 'severed');
        drive.sever();
        await doomed;

        // The folder is readable again for everyone else.
        (drive as any).severed = false;

        expect(await readBackAll(acknowledged)).toEqual([]);
    }, 60000);
});
