
import PouchDB from 'pouchdb-core';
import * as dotenv from 'dotenv';
import { google } from 'googleapis';
import GoogleDriveAdapter from '../src/index';

dotenv.config();

// Register the adapter
GoogleDriveAdapter(PouchDB);

describe('Google Drive Adapter', () => {
    let drive: any;
    let dbName: string;

    beforeAll(() => {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const redirectUrl = process.env.GOOGLE_REDIRECT_URL;
        const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
        const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

        if (!clientId || !clientSecret || !accessToken) {
            console.warn('Skipping tests requiring Google Drive credentials. Please set them in .env');
            return;
        }

        const oauth2Client = new google.auth.OAuth2(
            clientId,
            clientSecret,
            redirectUrl
        );

        oauth2Client.setCredentials({
            access_token: accessToken,
            refresh_token: refreshToken
        });

        drive = google.drive({ version: 'v3', auth: oauth2Client });
        dbName = 'test-db-' + Date.now();
    });

    it('should create a database and write a document', async () => {
        if (!drive) {
            console.log("No credentials provided, skipping integration test");
            return;
        }

        const db = new PouchDB(dbName, {
            adapter: 'googledrive',
            drive: drive,
            pollingIntervalMs: 0
        });

        const info = await db.info();
        expect(info.db_name).toBe(dbName);
        expect(info.backend_adapter).toBe('googledrive');

        const doc = { _id: 'test-doc', title: 'Start Wars' };
        const response = await db.put(doc);
        expect(response.ok).toBe(true);
        expect(response.id).toBe('test-doc');

        const fetched = await db.get('test-doc');
        expect(fetched.title).toBe('Start Wars');
    });

    afterAll(async () => {
        // Cleanup would ideally delete the created file
    });
});
