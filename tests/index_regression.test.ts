import { DriveHandler } from '../src/drive';
import { GoogleDriveClient } from '../src/client';
import { ChangeEntry } from '../src/types';
import { FakeDrive } from './fake-drive';

jest.mock('../src/client');

/**
 * A re-replayed old change log must not regress the reader's index.
 *
 * Field report 0006: a change-log download clipped by the rate limiter is skipped
 * and retried on a later load, AFTER higher logs have applied. updateIndex's legacy
 * path replaced entries blindly, so the retry rewrote rev/seq/location to an older
 * state; the regressed entry then failed the feed's `seq > since` gate, the newer
 * revision was never emitted, and the puller checkpointed past it. Silent, permanent
 * loss on the reading side while the folder held everything.
 */

const drive = new FakeDrive();
const FOLDER = 'folder-1';

function handler(dbName: string): DriveHandler {
    return new DriveHandler({ accessToken: 'token', folderId: FOLDER }, dbName);
}

/** Plant a change log holding `entries`, referenced from _meta.json. */
function plantLog(name: string, entries: ChangeEntry[]): string {
    const id = 'file-log-' + name;
    drive.files.set(id, {
        id, name: `changes-${entries[0].seq}-${name}.ndjson`,
        parents: [FOLDER], mimeType: 'application/x-ndjson',
        content: entries.map(e => JSON.stringify(e)).join('\n') + '\n',
        modifiedTime: new Date().toISOString()
    });
    const meta = drive.meta();
    drive.writeMeta({
        ...meta,
        changeLogIds: [...meta.changeLogIds, id],
        seq: Math.max(meta.seq, entries[entries.length - 1].seq)
    });
    return id;
}

function row(seq: number, id: string, rev: string, deleted = false): ChangeEntry {
    return deleted
        ? { seq, id, rev, deleted: true, timestamp: Date.now() }
        : { seq, id, rev, timestamp: Date.now(), doc: { _id: id, _rev: rev, value: rev } };
}

async function freshMeta() {
    // Seed the folder with a valid _meta.json by letting a throwaway handler create it.
    const seeder = handler('seeder');
    await seeder.load();
}

describe('Index regression on out-of-order replay', () => {
    beforeEach(async () => {
        drive.reset();
        (GoogleDriveClient as unknown as jest.Mock).mockImplementation(() => drive.client());
        drive.addFolder('test-db', FOLDER);
        await freshMeta();
    });

    it('a straggler log retried after newer logs does not regress the index', async () => {
        const oldLog = plantLog('old', [row(100, 'task-1', '1-aaa'), row(101, 'task-2', '1-bbb')]);
        plantLog('new', [row(200, 'task-1', '2-ccc'), row(201, 'task-2', '2-ddd', true)]);

        // First load: the old log's download is clipped, the new log applies.
        drive.failNextDownloadOf.add(oldLog);
        const reader = handler('reader');
        await reader.load();
        expect(reader.getIndexEntry('task-1')!.rev).toBe('2-ccc');

        // Second load: the straggler is retried - after logs with higher seqs.
        await reader.load();

        const t1 = reader.getIndexEntry('task-1')!;
        expect(t1.rev).toBe('2-ccc');           // not regressed to 1-aaa
        expect(t1.seq).toBeGreaterThanOrEqual(200); // the feed's gate still passes it
        const t2 = reader.getIndexEntry('task-2')!;
        expect(t2.rev).toBe('2-ddd');
        expect(t2.deleted).toBe(true);          // the deletion survived the replay
    });

    it('a writer echoing a stale revision at a fresh seq does not regress the winner', async () => {
        plantLog('mine', [row(100, 'task-1', '4-newer')]);
        // Another writer, working from a stale view, echoes rev 3 at a HIGHER seq -
        // seqs honestly ordered, revisions not. Replay order alone cannot save this.
        plantLog('echo', [row(200, 'task-1', '3-older')]);

        const reader = handler('reader');
        await reader.load();

        const entry = reader.getIndexEntry('task-1')!;
        expect(entry.rev).toBe('4-newer');
        expect(entry.seq).toBe(200);            // seq still advances past the echo
        // The stale revision stays reachable as a conflict, not erased.
        expect(Object.keys(entry.conflictLocations || {})).toContain('3-older');
    });

    it('an in-order deletion still wins over the live revision it follows', async () => {
        plantLog('create', [row(100, 'task-1', '1-aaa')]);
        plantLog('delete', [row(200, 'task-1', '2-bbb', true)]);

        const reader = handler('reader');
        await reader.load();

        const entry = reader.getIndexEntry('task-1')!;
        expect(entry.rev).toBe('2-bbb');
        expect(entry.deleted).toBe(true);
        expect(await reader.get('task-1')).toBeNull();
    });

    it('a re-replay of an already-known row only advances the seq', async () => {
        plantLog('first', [row(100, 'task-1', '2-abc')]);
        // The same document at the SAME rev appears again at a higher seq - the
        // no-op echo from the field report (its seq-78 row).
        plantLog('again', [row(200, 'task-1', '2-abc')]);

        const reader = handler('reader');
        await reader.load();

        const entry = reader.getIndexEntry('task-1')!;
        expect(entry.rev).toBe('2-abc');
        expect(entry.seq).toBe(200);
        expect(entry.conflictLocations).toBeUndefined();
    });

    it('bounds the download burst a cold boot fires at Drive', async () => {
        for (let i = 0; i < 30; i++) {
            plantLog('log' + i, [row(100 + i, 'doc-' + i, '1-a' + i)]);
        }
        drive.latencyMs = 2; // give the pool a chance to overlap

        const reader = handler('reader');
        await reader.load();

        expect(drive.maxConcurrentDownloads).toBeLessThanOrEqual(8);
        expect(reader.getIndexEntry('doc-29')).toBeDefined();
    }, 30000);
});
