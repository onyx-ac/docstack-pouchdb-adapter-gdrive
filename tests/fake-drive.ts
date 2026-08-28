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
    /** File ids whose next content download fails once - the shape of a change-log
     *  GET clipped by Drive's rate limiter during a bursty load(). */
    failNextDownloadOf: Set<string> = new Set();
    /** Peak number of content downloads in flight at once - what a rate limiter sees. */
    maxConcurrentDownloads = 0;
    private inFlightDownloads = 0;
    private counter = 0;

    reset() {
        this.files.clear();
        this.latencyMs = 0;
        this.jitter = false;
        this.severed = false;
        this.swallowWritesTo = null;
        this.killAfterCreateMatching = null;
        this.killAfterUpdateOf = null;
        this.blipReadAfterUpdateOf = null;
        this.failNextDownloadOf = new Set();
        this.maxConcurrentDownloads = 0;
        this.inFlightDownloads = 0;
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

    /** Give every call a random slice of latencyMs instead of all of it. Real
     *  networks do not deliver every round trip in the same time, and uniform latency
     *  explores a far narrower set of interleavings than jittered latency does. */
    jitter = false;

    /** Calls that reject with this once armed - standing in for a browser context
     *  that goes away mid-write. */
    private severed = false;

    /** When set, the connection is severed the moment a createFile whose name
     *  contains this string completes - a tab killed right after an upload, before
     *  whatever was supposed to come next. */
    killAfterCreateMatching: string | null = null;

    /** When set, severed the moment an updateFile of this file id completes - a tab
     *  killed right after a metadata commit, before the read that verifies it. */
    killAfterUpdateOf: string | null = null;

    /** When set, an updateFile of this file id arms a fail-once on downloading the
     *  same file - a connectivity blip that hits exactly the read verifying a
     *  metadata commit, and nothing before it. */
    blipReadAfterUpdateOf: string | null = null;

    /** Stop answering, the way a closed tab stops answering. */
    sever() { this.severed = true; }

    /** Connectivity comes back. */
    restore() { this.severed = false; this.killAfterCreateMatching = null; this.killAfterUpdateOf = null; }

    private tick() {
        if (this.severed) {
            return Promise.reject(Object.assign(new Error('Network Error: context gone'), { code: 'network_error' }));
        }
        if (this.latencyMs <= 0) return Promise.resolve();
        const ms = this.jitter ? Math.random() * this.latencyMs : this.latencyMs;
        return new Promise(r => setTimeout(r, ms));
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

    /**
     * Why a document might be unreadable. The two failures look identical from the
     * outside and have opposite causes:
     *
     *   - **orphaned**: the file is in the folder, nothing references it.
     *   - **dangling**: _meta.json references a file that is not in the folder.
     *     load() logs the failed download and moves on, so this one leaves no
     *     evidence in the folder at all.
     */
    diagnose(docId: string) {
        const meta = this.meta();
        const referenced = new Set(meta.changeLogIds);
        const present = new Map(this.changeLogs().map(f => [f.id, f]));

        const dangling = meta.changeLogIds.filter(id => !present.has(id));
        const orphaned = [...present.values()].filter(f => !referenced.has(f.id));
        const holding = [...present.values()]
            .filter(f => this.entriesIn(f).some(c => c.id === docId))
            .map(f => ({ name: f.name, referenced: referenced.has(f.id) }));

        return {
            docId,
            metaSeq: meta.seq,
            referencedCount: meta.changeLogIds.length,
            presentCount: present.size,
            danglingReferences: dangling,
            orphanedLogs: orphaned.map(f => f.name),
            logsHoldingDoc: holding,
            verdict: holding.length === 0
                ? (dangling.length > 0 ? 'DANGLING - its log was deleted after being referenced' : 'GONE - no surviving log holds it')
                : holding.some(h => h.referenced) ? 'READABLE - present and referenced' : 'ORPHANED - present, unreferenced'
        };
    }

    /** Every sequence number in the folder, with the logs that minted it. A
     *  sequence number claimed twice is what stops a replication target from ever
     *  seeing the second document: `_changes` filters on `seq > since`. */
    duplicateSeqs(): Array<{ seq: number; logs: string[] }> {
        const bySeq = new Map<number, string[]>();
        for (const file of this.changeLogs()) {
            for (const entry of this.entriesIn(file)) {
                const logs = bySeq.get(entry.seq) || [];
                if (!logs.includes(file.name)) logs.push(file.name);
                bySeq.set(entry.seq, logs);
            }
        }
        return [...bySeq.entries()]
            .filter(([, logs]) => logs.length > 1)
            .map(([seq, logs]) => ({ seq, logs }));
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
                const contains = q.match(/name contains '([^']+)'/);
                const parent = q.match(/'([^']+)' in parents/);
                return [...drive.files.values()]
                    .filter(f => !name || f.name === name[1])
                    .filter(f => !contains || f.name.includes(contains[1]))
                    .filter(f => !parent || f.parents.includes(parent[1]))
                    .map(strip);
            }),
            getFile: jest.fn(async (fileId: string) => {
                drive.inFlightDownloads++;
                drive.maxConcurrentDownloads = Math.max(drive.maxConcurrentDownloads, drive.inFlightDownloads);
                try {
                    await drive.tick();
                    if (drive.failNextDownloadOf.delete(fileId)) {
                        throw Object.assign(new Error('Rate limit exceeded'), { status: 429 });
                    }
                    const file = drive.files.get(fileId);
                    if (!file) throw Object.assign(new Error('Not found'), { status: 404 });
                    return file.content;
                } finally {
                    drive.inFlightDownloads--;
                }
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
                if (drive.killAfterCreateMatching && name.includes(drive.killAfterCreateMatching)) {
                    drive.severed = true; // the upload landed; the writer is gone
                }
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
                if (drive.killAfterUpdateOf === fileId) {
                    drive.severed = true; // the write landed; the writer is gone
                }
                if (drive.blipReadAfterUpdateOf === fileId) {
                    drive.failNextDownloadOf.add(fileId);
                    drive.blipReadAfterUpdateOf = null;
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
