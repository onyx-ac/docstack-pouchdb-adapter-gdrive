import PouchDB from 'pouchdb-core';
import * as dotenv from 'dotenv';
import GoogleDriveAdapter from '../src/index';
import { GoogleDriveClient } from '../src/client';
import { TestServer } from '../tests-src/server';
import { getTestOptions, isProd, accessToken } from '../tests-src/test-config';

dotenv.config();

// Register the adapter factory
PouchDB.plugin(GoogleDriveAdapter({ accessToken: 'placeholder' } as any));

describe('Compaction & Append-Log', () => {
    let client: GoogleDriveClient;
    let dbName: string;
    let server: TestServer;
    let port: number;

    beforeAll(async () => {
        dbName = 'test-compaction-' + Date.now();
        if (!isProd) {
            server = new TestServer(0);
            port = await server.start();

            client = new GoogleDriveClient({
                accessToken: 'mock-token',
                baseUrl: `http://127.0.0.1:${port}/drive/v3/files`,
                uploadUrl: `http://127.0.0.1:${port}/upload/drive/v3/files`
            });
        } else {
            client = new GoogleDriveClient({ accessToken });
        }
    });

    afterAll(async () => {
        if (server) await server.stop();
    });

    it('should auto-compact after threshold is reached', async () => {
        // Set low threshold for testing
        const options = getTestOptions(dbName, port);
        const db = new PouchDB(dbName, {
            ...options,
            compactionThreshold: 3, // Very low threshold
        } as any);

        try {
            // 1. Create 3 docs (threshold is 3)
            await db.put({ _id: 'doc1', val: 1 });
            await db.put({ _id: 'doc2', val: 2 });
            await db.put({ _id: 'doc3', val: 3 });

            // Wait a bit for potential async operations
            await new Promise(r => setTimeout(r, 100));

            // 2. Add one more to trigger compaction check
            await db.put({ _id: 'doc4', val: 4 });

            // Allow compaction to finish
            // Increased to 35s for real GDrive eventual consistency
            await new Promise(r => setTimeout(r, 35000));

            // 3. Verify all data is still there
            const allDocs = await db.allDocs({ include_docs: true });
            expect(allDocs.rows.length).toBe(4);
            expect(allDocs.rows.find((r: any) => r.id === 'doc1')).toBeTruthy();

            // 4. Verify internal storage structure (snapshot exists, logs cleared)
            const q = `name = '${dbName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
            const folders = await client.listFiles(q);
            expect(folders.length).toBeGreaterThan(0);
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
        } finally {
            await db.close();
        }
    }, 90000); // 90s timeout
});
