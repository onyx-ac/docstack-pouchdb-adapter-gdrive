
import { DriveHandler } from '../src/drive';
import { GoogleDriveClient } from '../src/client';

jest.mock('../src/client');

/**
 * Shared storage for mocked client
 */
const mockStorage: Record<string, any> = {};
const mockEtags: Record<string, string> = {};

const delay = () => new Promise(r => setTimeout(r, 10));

describe('Concurrency & Race Conditions', () => {
    let driveHandler1: DriveHandler;
    let driveHandler2: DriveHandler;

    beforeEach(() => {
        // Clear storage
        for (const k in mockStorage) delete mockStorage[k];
        for (const k in mockEtags) delete mockEtags[k];

        // Setup Mock Implementation for GoogleDriveClient
        (GoogleDriveClient as jest.Mock).mockImplementation(() => {
            return {
                listFiles: jest.fn(async (q: string) => {
                    await delay();
                    return Object.values(mockStorage).filter((f: any) => {
                        if (q.includes(`name = '${f.name}'`)) return true;
                        return false;
                    });
                }),
                getFile: jest.fn(async (fileId: string) => {
                    await delay();
                    const file = mockStorage[fileId];
                    if (!file) throw { status: 404 };
                    return file.content;
                }),
                createFile: jest.fn(async (name: string, parents: string[] | undefined, mimeType: string, content: string) => {
                    await delay();
                    const id = 'file-' + Date.now() + Math.random();
                    const etag = 'etag-' + Date.now();
                    let parsedContent: any;
                    try {
                        parsedContent = content ? JSON.parse(content) : {};
                    } catch {
                        parsedContent = content; // NDJSON or raw
                    }
                    const file = { id, name, content: parsedContent, etag };
                    mockStorage[id] = file;
                    mockEtags[id] = etag;
                    return { id, etag };
                }),
                updateFile: jest.fn(async (fileId: string, content: string, expectedEtag?: string) => {
                    await delay();
                    const id = fileId;
                    const file = mockStorage[id];

                    if (expectedEtag && expectedEtag !== mockEtags[id]) {
                        const err: any = new Error('Precondition Failed');
                        err.status = 412;
                        throw err;
                    }

                    try {
                        file.content = content ? JSON.parse(content) : {};
                    } catch {
                        file.content = content;
                    }
                    const newEtag = 'etag-' + Date.now();
                    mockEtags[id] = newEtag;
                    file.etag = newEtag;

                    return { id, etag: newEtag };
                }),
                deleteFile: jest.fn(async (fileId: string) => {
                    delete mockStorage[fileId];
                    delete mockEtags[fileId];
                })
            };
        });

        // Two handlers sharing the same folder
        driveHandler1 = new DriveHandler({ accessToken: 'token', folderName: 'test-db' }, 'test-db');
        driveHandler2 = new DriveHandler({ accessToken: 'token', folderName: 'test-db' }, 'test-db');
    });

    it('should handle race condition when two clients append simultaneously', async () => {
        // 1. Initialize DB
        await driveHandler1.load();
        await driveHandler2.load(); // Both see empty state

        // 2. Both try to append different docs at the same time
        const p1 = driveHandler1.appendChange({ seq: 1, id: 'doc1', rev: '1-a', timestamp: Date.now(), doc: { val: 1 } });
        const p2 = driveHandler2.appendChange({ seq: 1, id: 'doc2', rev: '1-b', timestamp: Date.now(), doc: { val: 2 } });

        // 3. Both should eventually succeed (one might retry due to ETag mismatch in atomicUpdateMeta)
        await Promise.all([p1, p2]);

        // 4. Verify data integrity
        await driveHandler1.load();

        const doc1 = await driveHandler1.get('doc1');
        const doc2 = await driveHandler1.get('doc2');

        expect(doc1).toBeDefined();
        expect(doc2).toBeDefined();
        expect(driveHandler1.seq).toBe(2);
    });

    it('should detect conflicting updates', async () => {
        await driveHandler1.load();
        await driveHandler2.load();

        // 1. Client 1 updates doc1
        await driveHandler1.appendChange({ seq: 1, id: 'doc1', rev: '1-a', timestamp: Date.now(), doc: { val: 1 } });

        // 2. Client 2 (stale) tries to update doc1 with same rev (or different)
        try {
            await driveHandler2.appendChange({ seq: 1, id: 'doc1', rev: '1-b', timestamp: Date.now(), doc: { val: 2 } });
            throw new Error('Should have thrown conflict');
        } catch (e: any) {
            expect(e.status).toBe(409); // Conflict
        }
    });
});
