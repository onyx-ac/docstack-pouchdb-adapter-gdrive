
import PouchDB from 'pouchdb-core';
import * as dotenv from 'dotenv';
import { google } from 'googleapis';
import GoogleDriveAdapter from '../src/index';

dotenv.config();

// Register the adapter
GoogleDriveAdapter(PouchDB);

describe('Compaction & Append-Log', () => {
    let drive: any;
    let dbName: string;

    beforeAll(() => {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const redirectUrl = process.env.GOOGLE_REDIRECT_URL;
        const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
        const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

        if (!clientId || !clientSecret || !accessToken) {
            console.warn('Skipping tests requiring Google Drive credentials');
            return;
        }

        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUrl);
        oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });

        drive = google.drive({ version: 'v3', auth: oauth2Client });
        dbName = 'test-compaction-' + Date.now();
    });

    it('should auto-compact after threshold is reached', async () => {
        if (!drive) return;

        // Set low threshold for testing
        const db = new PouchDB(dbName, {
            adapter: 'googledrive',
            drive: drive,
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
        const q = `name = '${dbName}' and mimeType = 'application/vnd.google-apps.folder'`;
        const folderRes = await drive.files.list({ q });
        const folderId = folderRes.data.files[0].id;

        const filesRes = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false`
        });

        const fileNames = filesRes.data.files.map((f: any) => f.name);
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
        if (!drive) return;
        // Cleanup folder
        const q = `name = '${dbName}' and mimeType = 'application/vnd.google-apps.folder'`;
        const res = await drive.files.list({ q });
        if (res.data.files.length > 0) {
            await drive.files.delete({ fileId: res.data.files[0].id });
        }
    });
});
