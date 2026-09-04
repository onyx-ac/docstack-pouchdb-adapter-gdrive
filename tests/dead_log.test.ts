import { DriveHandler } from '../src/drive';
import { GoogleDriveClient } from '../src/client';
import { ChangeEntry } from '../src/types';
import { FakeDrive } from './fake-drive';

jest.mock('../src/client');

/**
 * Cover for finding 0007.
 *
 * A change log referenced by `_meta.json` that answers 404 on every read - damage
 * the 0.1.8 verify-blip bug left behind in real folders - used to convert one lost
 * change into a permanent, silent write outage: the read path tolerated the missing
 * log but never marked it processed, so `hasUnprocessedLogs` stayed true for ever,
 * and every write burned its whole catch-up budget re-reading a file that cannot be
 * read, then threw a message blaming concurrent writers.
 *
 * A 404 is an answer, not an outage. Anything else stays retryable.
 */

const drive = new FakeDrive();
const FOLDER = 'folder-1';

function handler(dbName: string): DriveHandler {
    return new DriveHandler({ accessToken: 'token', folderId: FOLDER }, dbName);
}

function change(id: string, rev: string): ChangeEntry {
    return { seq: 1, id, rev, timestamp: Date.now(), doc: { _id: id, _rev: rev, value: id } };
}

/** Reference a change log that does not exist - the dangling-reference damage. */
function plantDanglingReference(id = 'file-ghost'): string {
    const meta = drive.meta();
    drive.writeMeta({ ...meta, changeLogIds: [...meta.changeLogIds, id] });
    return id;
}

describe('A missing change log must not stop future writes', () => {
    beforeEach(async () => {
        drive.reset();
        (GoogleDriveClient as unknown as jest.Mock).mockImplementation(() => drive.client());
        drive.addFolder('test-db', FOLDER);
        const seeder = handler('seeder');
        await seeder.load();
        await seeder.appendChange(change('doc-existing', '1-e'));
    });

    it('writes continue past a dangling reference (the outage)', async () => {
        plantDanglingReference();

        const w = handler('writer');
        await w.load();
        // Pre-fix this threw 'Could not catch up with concurrent writers': the 404
        // kept the log unprocessed, the catch-up loop re-read it until the budget
        // ran out, and the folder accepted no writes from any device, indefinitely.
        await expect(w.appendChange(change('doc-after', '1-a'))).resolves.toBeUndefined();

        const reader = handler('reader');
        await reader.load();
        expect(await reader.get('doc-after')).toMatchObject({ _id: 'doc-after' });
        expect(await reader.get('doc-existing')).toMatchObject({ _id: 'doc-existing' });
    });

    it('the folder heals: the dead reference is pruned and tombstoned', async () => {
        const ghost = plantDanglingReference();

        const w = handler('writer');
        await w.load();

        const meta = drive.meta();
        expect(meta.changeLogIds).not.toContain(ghost);
        // Tombstoned, so nobody restores or re-adopts it.
        expect(meta.retiredLogIds).toContain(ghost);
    });

    it("the log's own writer does not resurrect a pruned reference", async () => {
        // W's log is deleted out from under it - the shape the blip bug produced.
        // W itself never re-reads its own log, so a READER is who proves it dead.
        const w = handler('writer-w');
        await w.load();
        await w.appendChange(change('doc-w', '1-w'));
        const wLogId = drive.meta().changeLogIds.find(id => {
            const f = drive.files.get(id);
            return f && f.content.includes('doc-w');
        })!;
        drive.files.delete(wLogId);

        const reader = handler('reader');
        await reader.load(); // 404 -> pruned and tombstoned

        // W still remembers writing that log. Its next commit must respect the
        // tombstone instead of putting the dead reference back - otherwise the
        // pruning reader and the remembering writer ping-pong for ever.
        await w.appendChange(change('doc-w2', '1-w2'));
        expect(drive.meta().changeLogIds).not.toContain(wLogId);
    });

    it('a transient failure keeps its retry: not written off, applied next load', async () => {
        const w = handler('writer');
        await w.load();
        await w.appendChange(change('doc-flaky', '1-f'));
        const logId = drive.meta().changeLogIds.find(id => drive.files.get(id)?.content.includes('doc-flaky'))!;

        drive.failNextDownloadOf.add(logId); // one 429, then fine
        const reader = handler('reader');
        await reader.load(); // clipped, skipped, NOT pruned
        expect(drive.meta().changeLogIds).toContain(logId);

        await reader.load(); // retried and applied
        expect(await reader.get('doc-flaky')).toMatchObject({ _id: 'doc-flaky' });
    });

    it('the error names the unreadable log instead of blaming concurrent writers', async () => {
        const seederLog = drive.meta().changeLogIds[0];
        drive.permanentlyFailDownloadOf.add(seederLog); // 503 for ever - a real outage

        const w = handler('writer');
        await expect(w.appendChange(change('doc-blocked', '1-b')))
            .rejects.toThrow(new RegExp(`could not be read.*|${seederLog}`));
        await expect(w.appendChange(change('doc-blocked', '1-b')))
            .rejects.toThrow(seederLog);
    }, 30000);
});
