import { DriveHandler, SEQ_SLOTS, writerSlotFor, writerIdFromLogName } from '../src/drive';
import { GoogleDriveClient } from '../src/client';
import { ChangeEntry } from '../src/types';
import { FakeDrive } from './fake-drive';

jest.mock('../src/client');

/**
 * Sequence-slot collisions - ADR-0003's residual, closed.
 *
 * Slots make collisions impossible only between writers on *different* slots; two
 * ids hashing to the same one are back to dense allocation. Filenames carry every
 * writer's id and load() lists the folder anyway, so a contested slot is visible
 * before this writer mints anything - it re-rolls to a free one.
 */

const drive = new FakeDrive();
const FOLDER = 'folder-1';

function handler(dbName: string): DriveHandler {
    return new DriveHandler({ accessToken: 'token', folderId: FOLDER }, dbName);
}

function change(id: string, rev: string): ChangeEntry {
    return { seq: 1, id, rev, timestamp: Date.now(), doc: { _id: id, _rev: rev, value: id } };
}

/** A writer id, distinct from `notThis`, hashing to exactly `slot`. */
function idColliding(slot: number, notThis: string): string {
    for (let i = 0; ; i++) {
        const candidate = ('w' + i.toString(36)).padEnd(8, 'x');
        if (candidate !== notThis && writerSlotFor(candidate) === slot) return candidate;
    }
}

/** Plant a change log in the folder as if `writerId` had written it. */
function plantRivalLog(writerId: string, seq: number, docId: string) {
    const entry: ChangeEntry = { seq, id: docId, rev: '1-rival', timestamp: Date.now(), doc: { _id: docId, _rev: '1-rival' } };
    const name = `changes-${seq}-${writerId}-planted.ndjson`;
    const id = 'file-rival-' + writerId;
    drive.files.set(id, {
        id, name, parents: [FOLDER], mimeType: 'application/x-ndjson',
        content: JSON.stringify(entry) + '\n', modifiedTime: new Date().toISOString()
    });
    return id;
}

describe('Sequence-slot collision avoidance', () => {
    beforeEach(() => {
        drive.reset();
        (GoogleDriveClient as unknown as jest.Mock).mockImplementation(() => drive.client());
        drive.addFolder('test-db', FOLDER);
    });

    it('re-rolls off a slot another writer is seen using', async () => {
        const h = handler('client-a');
        const mySlot: number = (h as any).writerSlot;
        const rival = idColliding(mySlot, (h as any).writerId);
        plantRivalLog(rival, 1 * SEQ_SLOTS + mySlot, 'doc-rival');

        await h.load();

        expect((h as any).writerSlot).not.toBe(mySlot);
        expect(writerSlotFor((h as any).writerId)).toBe((h as any).writerSlot);
        // The rival's document still replayed - the log was adopted, not shunned.
        expect(await h.get('doc-rival')).toMatchObject({ _id: 'doc-rival' });
    });

    it('mints on the new slot, so the numbers cannot collide', async () => {
        const h = handler('client-a');
        const mySlot: number = (h as any).writerSlot;
        const rival = idColliding(mySlot, (h as any).writerId);
        plantRivalLog(rival, 1 * SEQ_SLOTS + mySlot, 'doc-rival');

        await h.load();
        await h.appendChange(change('doc-mine', '1-a'));

        expect(drive.duplicateSeqs()).toEqual([]);
        const mine = drive.changeLogs().find(f => f.name.includes('-planted') === false)!;
        expect(mine.name).toContain((h as any).writerId);
        expect(drive.entriesIn(mine)[0].seq % SEQ_SLOTS).toBe((h as any).writerSlot);
    });

    it('keeps its slot when no one contests it', async () => {
        const h = handler('client-a');
        const idBefore: string = (h as any).writerId;
        // A rival on some other slot is not a reason to move.
        const other = idColliding(((h as any).writerSlot + 1) % SEQ_SLOTS, idBefore);
        plantRivalLog(other, 1 * SEQ_SLOTS + writerSlotFor(other), 'doc-other');

        await h.load();

        expect((h as any).writerId).toBe(idBefore);
    });

    it('does not mistake its own logs for a rival', async () => {
        const h = handler('client-a');
        await h.load();
        await h.appendChange(change('doc-1', '1-a'));

        const idBefore: string = (h as any).writerId;
        await h.load(); // the folder now shows our own id

        expect((h as any).writerId).toBe(idBefore);
    });

    it('ignores old-format filenames without a writer id', () => {
        expect(writerIdFromLogName('changes-5-ab12cd.ndjson')).toBeNull();
        expect(writerIdFromLogName('changes-5-writer99-r4nd0m.ndjson')).toBe('writer99');
        expect(writerIdFromLogName('snapshot-data-123.json')).toBeNull();
    });
});
