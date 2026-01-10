
import { DriveHandler } from '../src/drive';

/**
 * Mock Google Drive API client
 * Simulates latency and race conditions
 */
class MockDrive {
    public files = {
        list: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        get: jest.fn(),
        delete: jest.fn()
    };

    private storage: Record<string, any> = {};
    private etags: Record<string, string> = {};

    constructor() {
        this.setupMocks();
    }

    private setupMocks() {
        // LIST
        this.files.list.mockImplementation(async (opts) => {
            await this.delay();
            const results = Object.values(this.storage).filter((f: any) => {
                if (opts.q.includes(`name = '${f.name}'`)) return true;
                return false;
            });
            return { data: { files: results } };
        });

        // GET
        this.files.get.mockImplementation(async (opts) => {
            await this.delay();
            const file = this.storage[opts.fileId];
            if (!file) throw { code: 404 };
            return { data: file.content };
        });

        // CREATE
        this.files.create.mockImplementation(async (opts) => {
            await this.delay();
            const id = 'file-' + Date.now() + Math.random();
            const body = opts.media ? opts.media.body : '{}';
            const name = opts.requestBody.name;
            const etag = 'etag-' + Date.now();

            this.storage[id] = { id, name, content: typeof body === 'string' ? JSON.parse(body) : body, etag };
            this.etags[id] = etag;

            return { data: { id, etag } };
        });

        // UPDATE
        this.files.update.mockImplementation(async (opts) => {
            await this.delay();
            const id = opts.fileId;
            const file = this.storage[id];

            // Check ETag
            if (opts.headers && opts.headers['If-Match']) {
                if (opts.headers['If-Match'] !== this.etags[id]) {
                    const err: any = new Error('Precondition Failed');
                    err.code = 412;
                    throw err;
                }
            }

            const body = opts.media.body;
            file.content = typeof body === 'string' ? JSON.parse(body) : body;
            const newEtag = 'etag-' + Date.now();
            this.etags[id] = newEtag;
            file.etag = newEtag;

            return { data: { id, etag: newEtag } };
        });

        // DELETE
        this.files.delete.mockImplementation(async (opts) => {
            delete this.storage[opts.fileId];
            delete this.etags[opts.fileId];
            return { data: {} };
        });
    }

    private async delay() {
        await new Promise(r => setTimeout(r, 10));
    }
}

describe('Concurrency & Race Conditions', () => {
    let mockDrive: MockDrive;
    let driveHandler1: DriveHandler;
    let driveHandler2: DriveHandler;

    beforeEach(() => {
        mockDrive = new MockDrive();
        // Two handlers sharing the same mock drive (same folder)
        driveHandler1 = new DriveHandler({ drive: mockDrive as any, folderName: 'test-db' }, 'test-db');
        driveHandler2 = new DriveHandler({ drive: mockDrive as any, folderName: 'test-db' }, 'test-db');
    });

    it('should handle race condition when two clients append simultaneously', async () => {
        // 1. Initialize DB
        await driveHandler1.load();
        await driveHandler2.load(); // Both see empty state

        // 2. Both try to append different docs at the same time
        const p1 = driveHandler1.appendChange({ seq: 1, id: 'doc1', rev: '1-a', timestamp: Date.now(), doc: { val: 1 } });
        const p2 = driveHandler2.appendChange({ seq: 1, id: 'doc2', rev: '1-b', timestamp: Date.now(), doc: { val: 2 } });

        // 3. Both should eventually succeed (one might retry)
        await Promise.all([p1, p2]);

        // 4. Verify data integrity
        // Reload to be sure we see the final state from server
        await driveHandler1.load();

        const doc1 = await driveHandler1.get('doc1');
        const doc2 = await driveHandler1.get('doc2');

        expect(doc1).toBeDefined();
        expect(doc2).toBeDefined();
        // Check seq using the public getter
        expect(driveHandler1.seq).toBe(2);
    });

    it('should detect conflicting updates', async () => {
        await driveHandler1.load();
        await driveHandler2.load();

        // 1. Client 1 updates doc1
        await driveHandler1.appendChange({ seq: 1, id: 'doc1', rev: '1-a', timestamp: Date.now(), doc: { val: 1 } });

        // 2. Client 2 (stale) tries to update doc1 with same rev (or different) but expecting empty
        // Client 2 thinks doc1 doesn't exist (because it hasn't reloaded)

        try {
            await driveHandler2.appendChange({ seq: 1, id: 'doc1', rev: '1-b', timestamp: Date.now(), doc: { val: 2 } });
            throw new Error('Should have thrown conflict');
        } catch (e: any) {
            expect(e.status).toBe(409); // Conflict
        }
    });
});
