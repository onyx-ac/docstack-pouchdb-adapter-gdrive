import { DriveHandler } from '../src/drive';
import { GoogleDriveClient } from '../src/client';
import { ChangeEntry } from '../src/types';
import { FakeDrive, waitFor } from './fake-drive';

jest.mock('../src/client');

/**
 * `pollingIntervalMs` - watching _meta.json for other clients' writes.
 *
 * This is what makes a live changes feed fire for a *remote* write; without it a
 * client only ever hears about what it wrote itself. The call site was lost in a
 * refactor (2105386) and the feature sat dead until it was reconnected; these are
 * the tests it never had.
 *
 * Detection is by md5Checksum, falling back to modifiedTime - never by ETag, which
 * Drive API v3 does not have. The fake here has none, so the tests exercise the same
 * path production does.
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

describe('Polling for remote changes', () => {
    beforeEach(() => {
        drive.reset();
        (GoogleDriveClient as unknown as jest.Mock).mockImplementation(() => drive.client());
        drive.addFolder('test-db', FOLDER);
    });

    afterEach(() => {
        // Every handler, polling or not - an interval left running keeps Jest alive.
        while (started.length) started.pop()!.stopPolling();
    });

    it('delivers another client\'s write to a change listener', async () => {
        const writer = handler('writer');
        const watcher = handler('watcher', INTERVAL);
        await writer.load();
        await watcher.load();

        const seen: Record<string, any>[] = [];
        watcher.onChange(c => seen.push(c));

        await writer.appendChange(change('doc-a', '1-a'));

        await waitFor(() => seen.length > 0, 3000, 'the watcher to be told about doc-a');
        expect(Object.keys(seen[0])).toContain('doc-a');
        expect(await watcher.get('doc-a')).toMatchObject({ _id: 'doc-a' });
    });

    it('does not announce the client\'s own writes twice', async () => {
        const watcher = handler('watcher', INTERVAL);
        await watcher.load();

        const seen: Record<string, any>[] = [];
        watcher.onChange(c => seen.push(c));

        await watcher.appendChange(change('doc-a', '1-a'));
        expect(seen).toHaveLength(1); // the append itself

        // The md5 this client recorded when it wrote matches what is on Drive, so
        // several ticks later there is still nothing new to report.
        await new Promise(r => setTimeout(r, INTERVAL * 5));
        expect(seen).toHaveLength(1);
    });

    it('stops when the database is closed', async () => {
        const writer = handler('writer');
        const watcher = handler('watcher', INTERVAL);
        await writer.load();
        await watcher.load();

        const seen: Record<string, any>[] = [];
        watcher.onChange(c => seen.push(c));
        watcher.stopPolling();

        await writer.appendChange(change('doc-a', '1-a'));
        await new Promise(r => setTimeout(r, INTERVAL * 5));

        expect(seen).toHaveLength(0);
    });

    it('does not restart the interval every time load() runs', async () => {
        const watcher = handler('watcher', INTERVAL);
        await watcher.load();
        const interval = (watcher as any).pollingInterval;
        expect(interval).not.toBeNull();

        // load() runs again on every catch-up and retry. Restarting the timer each
        // time would push the next tick out for as long as the client stays busy.
        await watcher.load();
        await watcher.load();
        expect((watcher as any).pollingInterval).toBe(interval);
    });

    it('stays off when no interval is configured', async () => {
        const quiet = handler('quiet');
        await quiet.load();
        expect((quiet as any).pollingInterval).toBeNull();
    });
});
