import { GoogleDriveAdapter } from '../src/adapter';
import { GoogleDriveClient } from '../src/client';
import { DriveHandler } from '../src/drive';

jest.mock('../src/client');

// Mock PouchDB interface
const PouchDB = {
    plugin: (adapter: any) => { }
};

const mockStorage: Record<string, any> = {};

/**
 * The changes feed is what replication checkpoints against, so two of its properties
 * are load-bearing rather than cosmetic:
 *
 * 1. A batch has to be ordered by sequence. Replication records the highest seq it saw
 *    in a batch, and `limit` means most batches are partial - so an unordered batch can
 *    record a checkpoint past a change it never emitted, and that change is then never
 *    replicated again.
 * 2. `style: 'all_docs'` - which `pouchdb-replication` asks for by default - has to list
 *    every leaf of the revision tree. Reporting only the winner hides conflict leaves,
 *    so they are never fetched and never pushed.
 */
describe('Changes feed ordering and style', () => {
    let adapter: any;

    beforeEach((done) => {
        for (const k in mockStorage) delete mockStorage[k];

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
        const opts = {
            accessToken: 'mock-token',
            name: 'test-changes',
            folderName: 'test-changes'
        };

        const AdapterConstructor = DriveAdapter;
        // @ts-ignore
        new AdapterConstructor(opts, (err: any, api: any) => {
            if (err) return done(err);
            adapter = api;
            done();
        });
    });

    /** Promise wrapper so the sequencing below stays readable. */
    const bulkDocs = (docs: any[], options: any = {}): Promise<any[]> =>
        new Promise((resolve, reject) => {
            adapter._bulkDocs({ docs }, options, (err: any, res: any) => {
                if (err) return reject(err);
                resolve(res);
            });
        });

    /**
     * Writes with `new_edits: false` on the request envelope, the shape
     * `pouchdb-replication` uses.
     */
    const bulkDocsReplicationStyle = (docs: any[]): Promise<any[]> =>
        new Promise((resolve, reject) => {
            adapter._bulkDocs({ docs, new_edits: false }, {}, (err: any, res: any) => {
                if (err) return reject(err);
                resolve(res);
            });
        });

    const changes = (opts: any): Promise<{ results: any[]; last_seq: number }> =>
        new Promise((resolve, reject) => {
            adapter._changes({
                return_docs: true,
                ...opts,
                complete: (err: any, res: any) => {
                    if (err) return reject(err);
                    resolve(res);
                }
            });
        });

    describe('ordering', () => {
        it('emits a batch in sequence order, not index order', async () => {
            const [a] = await bulkDocs([{ _id: 'doc-a', v: 1 }]);
            await bulkDocs([{ _id: 'doc-b', v: 1 }]);
            await bulkDocs([{ _id: 'doc-c', v: 1 }]);

            // Updating doc-a moves it to the newest sequence while leaving it in the
            // first slot of the id-keyed index - the exact shape that makes insertion
            // order and sequence order disagree.
            await bulkDocs([{ _id: 'doc-a', _rev: a.rev, v: 2 }]);

            const res = await changes({ since: 0 });
            const seqs = res.results.map(change => change.seq);

            expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
            expect(res.results.map(change => change.id)).toEqual(['doc-b', 'doc-c', 'doc-a']);
        });

        it('never checkpoints past a change it did not emit', async () => {
            const [a] = await bulkDocs([{ _id: 'doc-a', v: 1 }]);
            await bulkDocs([{ _id: 'doc-b', v: 1 }]);
            await bulkDocs([{ _id: 'doc-c', v: 1 }]);
            await bulkDocs([{ _id: 'doc-a', _rev: a.rev, v: 2 }]);

            // A batch smaller than the change set, which is every batch replication cuts.
            const firstBatch = await changes({ since: 0, limit: 2 });

            expect(firstBatch.results.map(change => change.id)).toEqual(['doc-b', 'doc-c']);
            expect(firstBatch.last_seq).toBe(Math.max(...firstBatch.results.map(c => c.seq)));

            // Resuming from that checkpoint still yields the change that was cut off. An
            // unordered batch would have emitted doc-a's newest seq here and checkpointed
            // past doc-b and doc-c, losing them for good.
            const secondBatch = await changes({ since: firstBatch.last_seq });
            expect(secondBatch.results.map(change => change.id)).toEqual(['doc-a']);
        });

        it('covers every document across successive batches', async () => {
            const ids = ['doc-1', 'doc-2', 'doc-3', 'doc-4', 'doc-5'];
            const written: Record<string, string> = {};
            for (const _id of ids) {
                const [res] = await bulkDocs([{ _id, v: 1 }]);
                written[_id] = res.rev;
            }
            // Bump two of the earlier documents so index order and seq order diverge.
            await bulkDocs([{ _id: 'doc-1', _rev: written['doc-1'], v: 2 }]);
            await bulkDocs([{ _id: 'doc-2', _rev: written['doc-2'], v: 2 }]);

            const seen: string[] = [];
            let since = 0;
            for (let batch = 0; batch < 10; batch++) {
                const res = await changes({ since, limit: 2 });
                if (!res.results.length) break;
                seen.push(...res.results.map(change => change.id));
                since = res.last_seq;
            }

            expect(new Set(seen)).toEqual(new Set(ids));
        });
    });

    describe('include_docs', () => {
        it('fetches the batch in one grouped pass, not one get per change', async () => {
            for (const _id of ['doc-1', 'doc-2', 'doc-3', 'doc-4']) {
                await bulkDocs([{ _id, v: 1 }]);
            }

            const getMulti = jest.spyOn(DriveHandler.prototype, 'getMulti');
            const get = jest.spyOn(DriveHandler.prototype, 'get');

            try {
                const res = await changes({ since: 0, include_docs: true });

                expect(res.results).toHaveLength(4);
                expect(res.results.every(change => change.doc && change.doc._id === change.id)).toBe(true);

                // getMulti() groups ids by the file holding them; a serial get() per
                // change is what this replaces.
                expect(getMulti).toHaveBeenCalledTimes(1);
                expect(getMulti.mock.calls[0][0]).toHaveLength(4);
                expect(get).not.toHaveBeenCalled();
            } finally {
                getMulti.mockRestore();
                get.mockRestore();
            }
        });

        it('only fetches bodies for the changes it will emit', async () => {
            for (const _id of ['doc-1', 'doc-2', 'doc-3', 'doc-4', 'doc-5']) {
                await bulkDocs([{ _id, v: 1 }]);
            }

            const getMulti = jest.spyOn(DriveHandler.prototype, 'getMulti');

            try {
                const res = await changes({ since: 0, include_docs: true, limit: 2 });

                expect(res.results).toHaveLength(2);
                // The batch is cut before the fetch, so the three changes past `limit`
                // cost nothing.
                expect(getMulti.mock.calls[0][0]).toEqual(['doc-1', 'doc-2']);
            } finally {
                getMulti.mockRestore();
            }
        });

        it('emits a tombstone for a deleted document rather than a null body', async () => {
            // A null body is not harmless: pouchdb-replication substitutes `{}` for a
            // missing `change.doc`, and a filter handed `{}` has no id to judge, so the
            // deletion is dropped and never reaches the peer.
            const [created] = await bulkDocs([{ _id: 'doomed', v: 1 }]);
            await bulkDocs([{ _id: 'doomed', _rev: created.rev, _deleted: true }]);

            const res = await changes({ since: 0, include_docs: true });
            const change = res.results.find(c => c.id === 'doomed');

            expect(change.doc).toBeTruthy();
            expect(change.doc._id).toBe('doomed');
            expect(change.doc._deleted).toBe(true);
        });

        it('leaves change.doc off entirely when include_docs was not asked for', async () => {
            await bulkDocs([{ _id: 'doc-1', v: 1 }]);

            const res = await changes({ since: 0 });

            expect(res.results[0].doc).toBeUndefined();
        });
    });

    describe('new_edits', () => {
        const rev = '1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

        // `api.bulkDocs = api._bulkDocs` replaces the public method, so
        // AbstractPouchDB.prototype.bulkDocs never runs and its req->opts normalization
        // never happens. Reading only one side means writes meant to land verbatim get a
        // fresh revision instead - silently.
        it('honours the flag on the request envelope, as replication sends it', async () => {
            const res = await bulkDocsReplicationStyle([{ _id: 'verbatim-req', _rev: rev, v: 1 }]);
            expect(res[0].rev).toBe(rev);
        });

        it('honours the flag on the options, as put() and a direct bulkDocs send it', async () => {
            const res = await bulkDocs([{ _id: 'verbatim-opts', _rev: rev, v: 1 }], { new_edits: false });
            expect(res[0].rev).toBe(rev);
        });

        it('lets the options win over the envelope, the way pouchdb-core resolves it', async () => {
            const res = await new Promise<any[]>((resolve, reject) => {
                adapter._bulkDocs(
                    { docs: [{ _id: 'verbatim-both', _rev: rev, v: 1 }], new_edits: true },
                    { new_edits: false },
                    (err: any, r: any) => (err ? reject(err) : resolve(r))
                );
            });
            expect(res[0].rev).toBe(rev);
        });

        it('mints a revision when neither side says otherwise', async () => {
            const res = await bulkDocs([{ _id: 'minted', v: 1 }]);
            expect(res[0].rev).toMatch(/^1-/);
            expect(res[0].rev).not.toBe(rev);
        });

        it('accepts a bare array request, the common PouchDB call style', async () => {
            // Core turns `bulkDocs([doc])` into `{ docs: [doc] }` before any adapter sees
            // it; that normalization is bypassed here too.
            const res = await new Promise<any[]>((resolve, reject) => {
                adapter._bulkDocs(
                    [{ _id: 'array-form', v: 1 }],
                    {},
                    (err: any, r: any) => (err ? reject(err) : resolve(r))
                );
            });
            expect(res[0].ok).toBe(true);
            expect(res[0].id).toBe('array-form');
        });
    });

    describe("style: 'all_docs'", () => {
        const revA = '1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const revB = '1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

        const seedConflict = async () => {
            await bulkDocs([{ _id: 'conflicted', _rev: revA, v: 'a' }], { new_edits: false });
            await bulkDocs([{ _id: 'conflicted', _rev: revB, v: 'b' }], { new_edits: false });
        };

        it('reports only the winning revision by default', async () => {
            await seedConflict();

            const res = await changes({ since: 0 });
            const change = res.results.find(c => c.id === 'conflicted');

            expect(change.changes).toHaveLength(1);
            expect([revA, revB]).toContain(change.changes[0].rev);
        });

        it('reports every leaf when asked, winner first', async () => {
            await seedConflict();

            const winnerOnly = await changes({ since: 0 });
            const winner = winnerOnly.results.find(c => c.id === 'conflicted').changes[0].rev;

            const res = await changes({ since: 0, style: 'all_docs' });
            const change = res.results.find(c => c.id === 'conflicted');
            const revs = change.changes.map((entry: any) => entry.rev);

            expect(revs).toHaveLength(2);
            expect(revs[0]).toBe(winner);
            expect(new Set(revs)).toEqual(new Set([revA, revB]));
        });

        it('reports a single leaf as one entry', async () => {
            await bulkDocs([{ _id: 'unconflicted', v: 1 }]);

            const res = await changes({ since: 0, style: 'all_docs' });
            const change = res.results.find(c => c.id === 'unconflicted');

            expect(change.changes).toHaveLength(1);
        });
    });
});
