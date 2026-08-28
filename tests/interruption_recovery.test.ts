import { DriveHandler } from '../src/drive';
import { GoogleDriveClient } from '../src/client';
import { ChangeEntry } from '../src/types';
import { FakeDrive, waitFor } from './fake-drive';

jest.mock('../src/client');

/**
 * Interruption recovery: a tab killed mid-write, a frozen script resuming, and
 * connectivity dropping and coming back.
 *
 * The invariant throughout is the acknowledgement contract, in both directions:
 *
 *   - a write whose promise RESOLVED must survive any interruption that follows;
 *   - a write whose promise REJECTED may either vanish or - because its upload
 *     already landed and the folder is the index (ADR-0002) - become visible later.
 *     Both are honest. What it must never do is take an acknowledged write with it.
 */

const drive = new FakeDrive();
const FOLDER = 'folder-1';
const INTERVAL = 40;

const started: DriveHandler[] = [];

function handler(dbName: string, pollingIntervalMs?: number): DriveHandler {
    const h = new DriveHandler({ accessToken: 'token', folderId: FOLDER, pollingIntervalMs }, dbName);
    started.push(h);
    return h;
}

function change(id: string, rev: string): ChangeEntry {
    return { seq: 1, id, rev, timestamp: Date.now(), doc: { _id: id, _rev: rev, value: id } };
}

async function readable(ids: string[]): Promise<string[]> {
    const reader = handler('reader-' + Math.random().toString(36).slice(2, 6));
    await reader.load();
    const found: string[] = [];
    for (const id of ids) {
        if (await reader.get(id)) found.push(id);
    }
    return found;
}

describe('Interruption recovery', () => {
    beforeEach(() => {
        drive.reset();
        (GoogleDriveClient as unknown as jest.Mock).mockImplementation(() => drive.client());
        drive.addFolder('test-db', FOLDER);
    });

    afterEach(() => {
        while (started.length) started.pop()!.stopPolling();
    });

    it('tab killed after the log upload, before the metadata commit', async () => {
        const a = handler('client-a');
        await a.load();
        await a.appendChange(change('doc-acked', '1-a'));

        // The change log lands on Drive; the tab dies before _meta.json is touched.
        drive.killAfterCreateMatching = 'changes-';
        await expect(a.appendChange(change('doc-doomed', '1-d'))).rejects.toThrow();
        drive.restore();

        // The acknowledged write survives, and the interrupted one becomes visible -
        // its upload landed, the folder is the index, so the next reader adopts it.
        expect(await readable(['doc-acked', 'doc-doomed'])).toEqual(['doc-acked', 'doc-doomed']);
        expect(drive.orphanedLogs()).toEqual([]);
    });

    it('tab killed after the metadata commit, before the verify read', async () => {
        const a = handler('client-a');
        await a.load();

        const metaId = drive.named('_meta.json')[0].id;
        drive.killAfterUpdateOf = metaId;
        // The commit landed; the caller may see an error, but the write is durable.
        await a.appendChange(change('doc-committed', '1-c')).catch(() => undefined);
        drive.restore();

        // The committed log must not have been "cleaned up" as unpublished - deleting
        // it here would leave _meta.json referencing a file that no longer exists,
        // and the document would be gone despite a successful commit.
        const meta = drive.meta();
        const present = new Set(drive.changeLogs().map(f => f.id));
        const dangling = meta.changeLogIds.filter(id => !present.has(id));
        expect(dangling).toEqual([]);
        expect(await readable(['doc-committed'])).toEqual(['doc-committed']);
    });

    it('a verify-read blip must not delete a committed log', async () => {
        const a = handler('client-a');
        await a.load();

        // Connectivity hiccups on exactly one read: the one that verifies the
        // metadata commit. The commit itself succeeded. (Armed BY the commit write,
        // so the reads before the upload are untouched.)
        const metaId = drive.named('_meta.json')[0].id;
        drive.blipReadAfterUpdateOf = metaId;
        await a.appendChange(change('doc-blip', '1-b')).catch(() => undefined);

        const meta = drive.meta();
        const present = new Set(drive.changeLogs().map(f => f.id));
        expect(meta.changeLogIds.filter(id => !present.has(id))).toEqual([]);
        expect(await readable(['doc-blip'])).toEqual(['doc-blip']);
    });

    it('a connectivity pause fails writes cleanly and the writer works after it', async () => {
        const a = handler('client-a');
        await a.load();
        await a.appendChange(change('doc-before', '1-a'));

        drive.sever();
        await expect(a.appendChange(change('doc-during', '1-b'))).rejects.toThrow();
        drive.restore();

        // The same handler, same session, writes again without a reload.
        await a.appendChange(change('doc-after', '1-c'));

        expect(await readable(['doc-before', 'doc-after'])).toEqual(['doc-before', 'doc-after']);
        // The paused write never uploaded anything, so it stays gone.
        expect(await readable(['doc-during'])).toEqual([]);
        expect(drive.orphanedLogs()).toEqual([]);
    });

    it('a frozen client resumes against a folder that moved on', async () => {
        const a = handler('client-a');
        const b = handler('client-b');
        await a.load();
        await b.load();

        // A freezes (a suspended tab, a blocked event loop). B keeps working.
        await b.appendChange(change('doc-b1', '1-b1'));
        await b.appendChange(change('doc-b2', '1-b2'));

        // A thaws and writes with no reload in between - the catch-up inside the
        // append has to absorb B's logs first.
        await a.appendChange(change('doc-a1', '1-a1'));

        expect(await readable(['doc-a1', 'doc-b1', 'doc-b2'])).toEqual(['doc-a1', 'doc-b1', 'doc-b2']);
        expect(drive.orphanedLogs()).toEqual([]);
        expect(drive.duplicateSeqs()).toEqual([]);
    });

    it('polling survives a connectivity pause and catches up after it', async () => {
        const writer = handler('writer');
        const watcher = handler('watcher', INTERVAL);
        await writer.load();
        await watcher.load();

        const seen: Record<string, any>[] = [];
        watcher.onChange(c => seen.push(c));

        // Ticks fail for a while; the interval must keep running, not die.
        drive.sever();
        await new Promise(r => setTimeout(r, INTERVAL * 3));
        drive.restore();

        await writer.appendChange(change('doc-late', '1-l'));

        await waitFor(() => seen.some(batch => 'doc-late' in batch), 3000, 'the watcher to catch up after the pause');
        expect(await watcher.get('doc-late')).toMatchObject({ _id: 'doc-late' });
    });
});
