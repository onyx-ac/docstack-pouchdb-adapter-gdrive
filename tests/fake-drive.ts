import crypto from 'crypto';
import { ChangeEntry, MetaData } from '../src/types';

/**
 * A Drive that behaves like the real one.
 *
 * The difference from the fake in `concurrency_mock.test.ts` is `If-Match`: that one
 * enforces it, so every read-modify-write of `_meta.json` is a real compare-and-swap.
 * Drive API v3 dropped ETags, so in production nothing enforces it and the adapter's
 * writes are unconditional. This one never returns an ETag and never honours one -
 * `md5Checksum` is the only content fingerprint it offers, exactly as Drive does.
 *
 * See docs/adr/0001-metadata-writes-without-compare-and-swap.md.
 */

export interface FakeFile {
    id: string;
    name: string;
    parents: string[];
    mimeType: string;
    content: string;
    modifiedTime: string;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class FakeDrive {
    files = new Map<string, FakeFile>();
    latencyMs = 0;
    /** File id whose writes are accepted and thrown away - a lost update. */
    swallowWritesTo: string | null = null;
    private counter = 0;

    reset() {
        this.files.clear();
        this.latencyMs = 0;
        this.swallowWritesTo = null;
        this.counter = 0;
    }

    /** Create the database folder and return its id. */
    addFolder(name: string, id = 'folder-1'): string {
        this.files.set(id, {
            id, name, parents: [], mimeType: FOLDER_MIME,
            content: '', modifiedTime: new Date().toISOString()
        });
        return id;
    }

    private tick() {
        return this.latencyMs > 0
            ? new Promise(r => setTimeout(r, this.latencyMs))
            : Promise.resolve();
    }

    private nextId() {
        // Zero-padded so lexicographic order matches creation order - the _meta.json
        // race is settled by lowest id, and the tests want to know which that is.
        return 'file-' + String(++this.counter).padStart(4, '0');
    }

    private md5(file: FakeFile): string | undefined {
        if (file.mimeType === FOLDER_MIME) return undefined;
        return crypto.createHash('md5').update(file.content).digest('hex');
    }

    named(name: string): FakeFile[] {
        return [...this.files.values()].filter(f => f.name === name);
    }

    meta(): MetaData {
        const files = this.named('_meta.json');
        if (files.length !== 1) throw new Error(`expected exactly one _meta.json, found ${files.length}`);
        return JSON.parse(files[0].content);
    }

    writeMeta(meta: MetaData) {
        const file = this.named('_meta.json')[0];
        file.content = JSON.stringify(meta);
        file.modifiedTime = new Date().toISOString();
    }

    changeLogs(): FakeFile[] {
        return [...this.files.values()].filter(f => f.name.startsWith('changes-'));
    }

    entriesIn(file: FakeFile): ChangeEntry[] {
        return file.content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    }

    /** Every change log in the folder is reachable from _meta.json. */
    orphanedLogs(): string[] {
        const referenced = new Set(this.meta().changeLogIds);
        return this.changeLogs().filter(f => !referenced.has(f.id)).map(f => f.name);
    }

    /** The stub standing in for GoogleDriveClient. */
    client() {
        const drive = this;
        const strip = (f: FakeFile) => ({
            id: f.id,
            name: f.name,
            parents: f.parents,
            mimeType: f.mimeType,
            modifiedTime: f.modifiedTime,
            md5Checksum: drive.md5(f)
            // No `etag`, exactly like Drive v3.
        });

        return {
            listFiles: jest.fn(async (q: string) => {
                await drive.tick();
                const name = q.match(/name = '([^']+)'/);
                const parent = q.match(/'([^']+)' in parents/);
                return [...drive.files.values()]
                    .filter(f => !name || f.name === name[1])
                    .filter(f => !parent || f.parents.includes(parent[1]))
                    .map(strip);
            }),
            getFile: jest.fn(async (fileId: string) => {
                await drive.tick();
                const file = drive.files.get(fileId);
                if (!file) throw Object.assign(new Error('Not found'), { status: 404 });
                return file.content;
            }),
            getFileMetadata: jest.fn(async (fileId: string) => {
                await drive.tick();
                const file = drive.files.get(fileId);
                if (!file) throw Object.assign(new Error('Not found'), { status: 404 });
                return { ...strip(file), etag: '' };
            }),
            createFile: jest.fn(async (name: string, parents: string[] | undefined, mimeType: string, content: string) => {
                await drive.tick();
                const id = drive.nextId();
                const file: FakeFile = {
                    id, name, mimeType,
                    parents: parents || [],
                    content: content || '',
                    modifiedTime: new Date().toISOString()
                };
                drive.files.set(id, file);
                return { id, etag: '', modifiedTime: file.modifiedTime, md5Checksum: drive.md5(file) };
            }),
            updateFile: jest.fn(async (fileId: string, content: string, _expectedEtag?: string) => {
                await drive.tick();
                const file = drive.files.get(fileId);
                if (!file) throw Object.assign(new Error('Not found'), { status: 404 });
                // `_expectedEtag` is deliberately ignored: Drive v3 has no
                // compare-and-swap, so the write always lands.
                if (drive.swallowWritesTo !== fileId) {
                    file.content = content;
                    file.modifiedTime = new Date().toISOString();
                }
                return { id: fileId, etag: '', modifiedTime: file.modifiedTime, md5Checksum: drive.md5(file) };
            }),
            deleteFile: jest.fn(async (fileId: string) => {
                await drive.tick();
                drive.files.delete(fileId);
            })
        };
    }
}

/** Poll `predicate` until it holds, or fail after `timeoutMs`. */
export async function waitFor(predicate: () => boolean, timeoutMs = 3000, label = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}
