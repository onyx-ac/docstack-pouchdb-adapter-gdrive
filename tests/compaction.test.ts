
import PouchDB from 'pouchdb-core';
import * as dotenv from 'dotenv';
import GoogleDriveAdapter from '../src/index';
import { GoogleDriveClient } from '../src/client';

dotenv.config();

// Register the adapter factory
PouchDB.plugin(GoogleDriveAdapter({ accessToken: 'placeholder' } as any));

describe('Compaction & Append-Log', () => {
    let client: GoogleDriveClient;
    let accessToken: string;
    let dbName: string;

    beforeAll(() => {
        accessToken = process.env.GOOGLE_ACCESS_TOKEN || '';

        if (!accessToken) {
            console.warn('Skipping tests requiring Google Drive credentials');
            return;
        }

        client = new GoogleDriveClient({ accessToken });
        dbName = 'test-compaction-' + Date.now();
    });

    it('should auto-compact after threshold is reached', async () => {
        if (!client) return;

        // Set low threshold for testing
        const db = new PouchDB(dbName, {
            adapter: 'googledrive',
            accessToken: accessToken,
            compactionThreshold: 3, // Very low threshold
            folderName: dbName     // Separate folder
        } as any);

        // 1. Create 3 docs (threshold is 3)
        await db.put({ _id: 'doc1', val: 1 });
        await db.put({ _id: 'doc2', val: 2 });
        await db.put({ _id: 'doc3', val: 3 });

        // Wait a bit for potential async operations
        await new Promise(r => setTimeout(r, 1000));

        // 2. Add one more to trigger compaction check
        await db.put({ _id: 'doc4', val: 4 });

        // Allow compaction to finish
        await new Promise(r => setTimeout(r, 2000));

        // 3. Verify all data is still there
        const allDocs = await db.allDocs({ include_docs: true });
        expect(allDocs.rows.length).toBe(4);
        expect(allDocs.rows.find((r: any) => r.id === 'doc1')).toBeTruthy();

        // 4. Verify internal storage structure (snapshot exists, logs cleared)
        const q = `name = '${dbName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
        const folders = await client.listFiles(q);
        const folderId = folders[0].id;

        const files = await client.listFiles(`'${folderId}' in parents and trashed = false`);
        const fileNames = files.map((f: any) => f.name);

        // Expect new format
        const indexFile = fileNames.find((n: string) => n.startsWith('snapshot-index-'));
        const dataFile = fileNames.find((n: string) => n.startsWith('snapshot-data-'));
        expect(indexFile).toBeTruthy();
        expect(dataFile).toBeTruthy();
        expect(fileNames).toContain('_meta.json');

        // Log files should be cleared or minimal
        const logFiles = fileNames.filter((n: string) => n.startsWith('changes-'));
        expect(logFiles.length).toBeLessThan(2);
    }, 60000); // 60s timeout

    afterAll(async () => {
        if (!client) return;
        // Cleanup folder
        const q = `name = '${dbName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
        const res = await client.listFiles(q);
        if (res.length > 0) {
            await client.deleteFile(res[0].id);
        }
    });
});
