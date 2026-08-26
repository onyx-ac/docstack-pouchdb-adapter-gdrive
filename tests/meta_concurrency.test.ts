import { DriveHandler } from '../src/drive';
import { GoogleDriveClient } from '../src/client';
import { ChangeEntry } from '../src/types';
import { FakeDrive } from './fake-drive';

jest.mock('../src/client');

/**
 * Concurrency against a Drive that behaves like the real one - no ETags, so no
 * compare-and-swap on `_meta.json`.
 *
 * See docs/adr/0001-metadata-writes-without-compare-and-swap.md.
 */

const drive = new FakeDrive();
const FOLDER = 'folder-1';

function handler(dbName: string): DriveHandler {
    return new DriveHandler({ accessToken: 'token', folderId: FOLDER }, dbName);
}

function change(id: string, rev: string): ChangeEntry {
    return { seq: 1, id, rev, timestamp: Date.now(), doc: { _id: id, _rev: rev, value: id } };
}

describe('Shared _meta.json without compare-and-swap', () => {
    beforeEach(() => {
        drive.reset();
        (GoogleDriveClient as unknown as jest.Mock).mockImplementation(() => drive.client());
        drive.addFolder('test-db', FOLDER);
    });

    it('does not orphan a change log written by a client it never saw', async () => {
        const a = handler('client-a');
        const b = handler('client-b');
        await a.load();
        await b.load(); // both see an empty folder

        await a.appendChange(change('doc-a', '1-a'));
        // B still holds the metadata it read before A wrote. Building its own
        // changeLogIds on that copy is what used to drop A's log.
        await b.appendChange(change('doc-b', '1-b'));

        expect(drive.changeLogs()).toHaveLength(2);
        expect(drive.orphanedLogs()).toEqual([]);
    });

    it('lets a third client read what both writers wrote', async () => {
        const a = handler('client-a');
        const b = handler('client-b');
        await a.load();
        await b.load();

        await a.appendChange(change('doc-a', '1-a'));
        await b.appendChange(change('doc-b', '1-b'));

        const reader = handler('client-c');
        await reader.load();
        expect(await reader.get('doc-a')).toMatchObject({ _id: 'doc-a' });
        expect(await reader.get('doc-b')).toMatchObject({ _id: 'doc-b' });
    });

    it('never hands the same sequence number to two writers', async () => {
        const a = handler('client-a');
        const b = handler('client-b');
        await a.load();
        await b.load();

        await a.appendChange(change('doc-a', '1-a'));
        await b.appendChange(change('doc-b', '1-b'));

        const seqs = drive.changeLogs().flatMap(f => drive.entriesIn(f)).map(c => c.seq);
        expect(seqs.slice().sort()).toEqual([1, 2]);
        expect(new Set(seqs).size).toBe(seqs.length);
        expect(drive.meta().seq).toBe(2);
    });

    it('restores a change log that another writer dropped', async () => {
        const a = handler('client-a');
        await a.load();
        await a.appendChange(change('doc-a', '1-a'));

        const logId = drive.meta().changeLogIds[0];
        expect(logId).toBeDefined();

        // Some other client read _meta.json before that append and wrote its own
        // view back afterwards. Nothing references A's log any more.
        drive.writeMeta({ ...drive.meta(), changeLogIds: [] });

        await a.load();

        expect(drive.meta().changeLogIds).toContain(logId);
        expect(drive.orphanedLogs()).toEqual([]);

        const reader = handler('client-c');
        await reader.load();
        expect(await reader.get('doc-a')).toMatchObject({ _id: 'doc-a' });
    });

    it('leaves a retired change log retired', async () => {
        const a = handler('client-a');
        await a.load();
        await a.appendChange(change('doc-a', '1-a'));
        await a.compact();

        expect(drive.meta().changeLogIds).toEqual([]);
        expect(drive.meta().retiredLogIds).toHaveLength(1);

        // A wrote that log, but a compaction has folded it into the snapshot - the
        // tombstone has to stop A putting it back.
        await a.load();
        expect(drive.meta().changeLogIds).toEqual([]);
    });

    it('keeps every change log when compaction cannot commit its metadata', async () => {
        const a = handler('client-a');
        await a.load();
        await a.appendChange(change('doc-a', '1-a'));
        await a.appendChange(change('doc-b', '1-b'));

        const logsBefore = drive.changeLogs().map(f => f.id);
        const metaBefore = drive.meta();
        expect(logsBefore).toHaveLength(2);

        // Every write to _meta.json is accepted and discarded - the shape a lost
        // update takes when another client overwrites us the moment we commit.
        drive.swallowWritesTo = drive.named('_meta.json')[0].id;
        await a.compact();
        drive.swallowWritesTo = null;

        // The logs are still the only copy of these changes. Deleting them on the
        // strength of a metadata write nothing confirmed is how compaction turns a
        // lost update into lost documents.
        expect(drive.changeLogs().map(f => f.id).sort()).toEqual(logsBefore.sort());
        expect(drive.meta().changeLogIds).toEqual(metaBefore.changeLogIds);

        const reader = handler('client-c');
        await reader.load();
        expect(await reader.get('doc-a')).toMatchObject({ _id: 'doc-a' });
        expect(await reader.get('doc-b')).toMatchObject({ _id: 'doc-b' });
    }, 30000);

    it('converges on one _meta.json when two clients open the same empty folder', async () => {
        drive.latencyMs = 5; // let both get past "is there a _meta.json?" before either creates one

        const a = handler('client-a');
        const b = handler('client-b');
        await Promise.all([a.load(), b.load()]);

        expect(drive.named('_meta.json')).toHaveLength(1);

        drive.latencyMs = 0;
        await a.appendChange(change('doc-a', '1-a'));
        await b.appendChange(change('doc-b', '1-b'));
        expect(drive.orphanedLogs()).toEqual([]);
    });
});
