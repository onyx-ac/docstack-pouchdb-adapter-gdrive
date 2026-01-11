
import { GoogleDriveAdapter } from '../src/adapter';
import { GoogleDriveClient } from '../src/client';
import { DriveHandler } from '../src/drive';

jest.mock('../src/client');

// Mock PouchDB interface
const PouchDB = {
    plugin: (adapter: any) => { }
};

const mockStorage: Record<string, any> = {};

describe('Replication Compatibility', () => {
    let adapter: any;

    beforeEach((done) => {
        // Clear storage
        for (const k in mockStorage) delete mockStorage[k];

        // Setup Mock Implementation
        (GoogleDriveClient as jest.Mock).mockImplementation(() => {
            return {
                listFiles: jest.fn(async (q: string) => {
                    if (q.includes('name = \'_meta.json\'')) {
                        const found = Object.values(mockStorage).find((f: any) => f.name === '_meta.json');
                        if (found) return [{ id: found.id, etag: 'etag' }];
                    }
                    return [];
                }),
                getFile: jest.fn(async (fileId: string) => {
                    const file = mockStorage[fileId];
                    if (!file) throw { status: 404 };
                    return file.content;
                }),
                createFile: jest.fn(async (name: string, parents: string[] | undefined, mimeType: string, content: string) => {
                    const id = 'file-' + Date.now() + Math.random();
                    let parsedContent: any;
                    try {
                        parsedContent = content ? JSON.parse(content) : {};
                    } catch {
                        parsedContent = content;
                    }
                    mockStorage[id] = { id, name, content: parsedContent, mimeType };
                    return { id, etag: 'etag' };
                }),
                updateFile: jest.fn(async (fileId: string, content: string, expectedEtag?: string) => {
                    try {
                        mockStorage[fileId].content = content ? JSON.parse(content) : {};
                    } catch {
                        mockStorage[fileId].content = content;
                    }
                    return { id: fileId, etag: 'new-etag' };
                }),
                deleteFile: jest.fn(async (fileId: string) => {
                    delete mockStorage[fileId];
                })
            };
        });

        const DriveAdapter = GoogleDriveAdapter(PouchDB);

        // Initialize Adapter
        const opts = {
            accessToken: 'mock-token',
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
                        expect(res.results.length).toBe(1);
                        expect(res.results[0].id).toBe('doc2');
                        done();
                    }
                });
            });
        });
    });
});
