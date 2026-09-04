import { DriveHandler } from '../src/drive';
import { GoogleDriveClient } from '../src/client';
import { ChangeEntry } from '../src/types';
import { FakeDrive } from './fake-drive';
import GoogleDriveAdapter from '../src/index';
import PouchDB from 'pouchdb-core';
import Replication from 'pouchdb-replication';
import MemoryAdapter from 'pouchdb-adapter-memory';

jest.mock('../src/client');

/**
 * Sync progress feedback — what a consumer builds a progress bar from.
 *
 * Two sources, one per phase where the UI otherwise lies:
 *
 *   - `_changes` reports `pending` in its complete response, the CouchDB field
 *     PouchDB's progress pipeline (replication 'change' events, activeTasks) runs
 *     on: percentage = docs_written / (docs_written + pending).
 *   - `onSyncProgress` reports change-log replay during load(), the cold-connect
 *     phase where a busy folder (72 logs in one field report) looks frozen.
 */

const drive = new FakeDrive();
const FOLDER = 'folder-1';

function handler(dbName: string, opts: Record<string, any> = {}): DriveHandler {
    return new DriveHandler({ accessToken: 'token', folderId: FOLDER, ...opts }, dbName);
}

function change(id: string, rev: string): ChangeEntry {
    return { seq: 1, id, rev, timestamp: Date.now(), doc: { _id: id, _rev: rev, value: id } };
}

describe('Sync progress feedback', () => {
    beforeEach(() => {
        drive.reset();
        (GoogleDriveClient as unknown as jest.Mock).mockImplementation(() => drive.client());
        drive.addFolder('test-db', FOLDER);
    });

    describe('_changes reports pending', () => {
        let db: any;

        beforeAll(() => {
            // Plugins register once - PouchDB refuses to redefine 'replicate'.
            PouchDB.plugin(Replication as any);
            PouchDB.plugin(MemoryAdapter as any);
            PouchDB.plugin(GoogleDriveAdapter({ accessToken: 'token', folderId: FOLDER }) as any);
        });

        beforeEach(async () => {
            db = new (PouchDB as any)('progress-db-' + Date.now() + Math.random().toString(36).slice(2, 6), { adapter: 'googledrive' });
            await db.info(); // wait for load
            for (let i = 0; i < 5; i++) {
                await db.bulkDocs([{ _id: 'doc-' + i, value: i }]);
            }
        });

        afterEach(async () => {
            await db.close().catch(() => undefined);
        });

        function changesOnce(opts: Record<string, any>): Promise<any> {
            return new Promise((resolve, reject) => {
                (db as any)._changes({
                    ...opts,
                    complete: (err: any, res: any) => err ? reject(err) : resolve(res)
                });
            });
        }

        it('counts what remains beyond the batch', async () => {
            const first = await changesOnce({ since: 0, limit: 2 });
            expect(first.results).toHaveLength(2);
            expect(first.pending).toBe(3);

            const second = await changesOnce({ since: first.last_seq, limit: 2 });
            expect(second.results).toHaveLength(2);
            expect(second.pending).toBe(1);

            const third = await changesOnce({ since: second.last_seq, limit: 2 });
            expect(third.results).toHaveLength(1);
            expect(third.pending).toBe(0);
        });

        it('reaches replication change events, where progress bars live', async () => {
            const target = new (PouchDB as any)('target-' + Date.now(), { adapter: 'memory' });
            const infos: any[] = [];
            await new Promise<void>((resolve, reject) => {
                (PouchDB as any).replicate(db, target, { batch_size: 2 })
                    .on('change', (info: any) => infos.push(info))
                    .on('complete', () => resolve())
                    .on('error', reject);
            });
            await target.destroy();

            // Every batch reported how much was left; the last one reported none.
            expect(infos.length).toBeGreaterThan(1);
            for (const info of infos) expect(typeof info.pending).toBe('number');
            expect(infos[infos.length - 1].pending).toBe(0);
            // Monotone non-increasing across batches - the bar only moves forward.
            for (let i = 1; i < infos.length; i++) {
                expect(infos[i].pending).toBeLessThanOrEqual(infos[i - 1].pending);
            }
        });

        it('is zero when the feed is drained', async () => {
            const all = await changesOnce({ since: 0, limit: 100 });
            expect(all.results).toHaveLength(5);
            expect(all.pending).toBe(0);
            const empty = await changesOnce({ since: all.last_seq, limit: 100 });
            expect(empty.results).toHaveLength(0);
            expect(empty.pending).toBe(0);
        });
    });

    describe('onSyncProgress reports change-log replay', () => {
        async function plantLogs(count: number) {
            const writer = handler('writer');
            await writer.load();
            for (let i = 0; i < count; i++) {
                await writer.appendChange(change('doc-' + i, '1-a' + i));
            }
        }

        it('walks a cold load from 0 to total', async () => {
            await plantLogs(4);

            const seen: Array<{ phase: string; done: number; total: number }> = [];
            const reader = handler('reader', { onSyncProgress: (p: any) => seen.push(p) });
            await reader.load();

            expect(seen[0]).toEqual({ phase: 'replay', done: 0, total: 4 });
            expect(seen[seen.length - 1]).toEqual({ phase: 'replay', done: 4, total: 4 });
            // Monotone - a progress bar must never move backwards within a cycle.
            for (let i = 1; i < seen.length; i++) {
                expect(seen[i].done).toBeGreaterThanOrEqual(seen[i - 1].done);
            }
        });

        it('reaches total even when a straggler download fails', async () => {
            await plantLogs(3);
            const anyLog = drive.changeLogs()[0];
            drive.failNextDownloadOf.add(anyLog.id);

            const seen: Array<{ done: number; total: number }> = [];
            const reader = handler('reader', { onSyncProgress: (p: any) => seen.push(p) });
            await reader.load();

            // The failed log is retried on a LATER load; this cycle still completes
            // its bar instead of hanging one short of the end.
            expect(seen[seen.length - 1]).toEqual({ phase: 'replay', done: 3, total: 3 });
        });

        it('a throwing callback cannot fail the load', async () => {
            await plantLogs(2);
            const reader = handler('reader', {
                onSyncProgress: () => { throw new Error('consumer bug'); }
            });
            await expect(reader.load()).resolves.toBeUndefined();
            expect(reader.getIndexEntry('doc-1')).toBeDefined();
        });

        it('stays silent when there is nothing to replay', async () => {
            const seen: any[] = [];
            const reader = handler('reader', { onSyncProgress: (p: any) => seen.push(p) });
            await reader.load();
            expect(seen).toEqual([]);
        });
    });
});
