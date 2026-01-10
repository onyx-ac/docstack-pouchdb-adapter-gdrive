
import { GoogleDriveAdapter } from '../src/adapter';
import { DriveHandler } from '../src/drive';

// Mock PouchDB interface
const PouchDB = {
    plugin: (adapter: any) => { }
};

// Reuse MockDrive from concurrency test or simple mock
class MockDrive {
    public files = {
        list: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        get: jest.fn(),
        delete: jest.fn()
    };
    private storage: Record<string, any> = {};

    constructor() {
        this.setupMocks();
    }

    // ... Minimal Mocks for Replication ...
    private setupMocks() {
        // Simple storage mock needed for adapter to work
        this.files.list.mockResolvedValue({ data: { files: [] } }); // Start empty
        this.files.create.mockImplementation(async (opts) => {
            const id = 'file-' + Date.now() + Math.random();
            const body = opts.media ? opts.media.body : '{}';
            // Store raw string for NDJSON, or object for others? 
            // Real Drive stores bytes. downloadFileAny(alt=media) returns string usually? 
            // Or axios returns object if internal json parsing happens?
            // Adapter expects string for NDJSON.
            this.storage[id] = { id, content: body };
            return { data: { id, etag: 'etag' } };
        });
        this.files.get.mockImplementation(async (opts) => {
            if (!this.storage[opts.fileId]) throw { code: 404 };
            return { data: this.storage[opts.fileId].content };
        });
        this.files.update.mockResolvedValue({ data: { id: 'file', etag: 'new' } });
        // Need to mock list find for meta
        this.files.list.mockImplementation(async (opts) => {
            if (opts.q.includes('name = \'_meta.json\'')) {
                const found = Object.values(this.storage).find((f: any) => f.content && f.content.dbName);
                if (found) return { data: { files: [{ id: found.id, etag: 'etag' }] } };
            }
            return { data: { files: [] } };
        });
    }
}

describe('Replication Compatibility', () => {
    let mockDrive: MockDrive;
    let adapter: any;

    beforeEach((done) => {
        mockDrive = new MockDrive();
        const DriveAdapter = GoogleDriveAdapter(PouchDB);

        // Initialize Adapter
        const opts = {
            drive: mockDrive as any,
            name: 'test-repl',
            folderName: 'test-repl'
        };

        // Manual initialization as in PouchDB
        const AdapterConstructor = DriveAdapter;
        // @ts-ignore
        new AdapterConstructor(opts, (err: any, api: any) => {
            if (err) return done(err);
            adapter = api;
            done();
        });
    });

    it('should support _changes feed with include_docs (Replication Style)', (done) => {
        // 1. Put some docs
        const docs = [
            { _id: 'doc1', val: 1 },
            { _id: 'doc2', val: 2 }
        ];

        adapter._bulkDocs({ docs }, { new_edits: true }, (err: any, res: any) => {
            expect(err).toBeNull();

            // 2. Replication calls _changes({ since: 0, include_docs: true })
            adapter._changes({
                since: 0,
                include_docs: true,
                return_docs: true,
                limit: 100, // Batch size
                complete: (err: any, res: any) => {
                    expect(err).toBeNull();
                    expect(res.results.length).toBe(2);
                    expect(res.results[0].id).toBe('doc1');
                    expect(res.results[0].doc.val).toBe(1);
                    expect(res.results[1].id).toBe('doc2');
                    done();
                }
            });
        });
    });

    it('should support incremental updates via _changes', (done) => {
        // 1. Put doc1
        adapter._bulkDocs({ docs: [{ _id: 'doc1', val: 1 }] }, {}, (err: any, res: any) => {
            const rev1 = res[0].rev;
            const seq1 = 1; // approximate knowing impl

            // 2. Put doc2
            adapter._bulkDocs({ docs: [{ _id: 'doc2', val: 2 }] }, {}, (err: any, res: any) => {

                // 3. Get changes since seq1 (Should only see doc2)
                adapter._changes({
                    since: seq1,
                    include_docs: true,
                    complete: (err: any, res: any) => {
                        expect(res.results.length).toBe(1); // Should only be doc2?
                        // Wait, since lazy index loads everything, does _changes filter by seq?
                        // My implementation in adapter.ts lines 369+ tries to filter:
                        // if (entry.seq <= since) continue;

                        // Verification:
                        expect(res.results[0].id).toBe('doc2');
                        done();
                    }
                });
            });
        });
    });
});
