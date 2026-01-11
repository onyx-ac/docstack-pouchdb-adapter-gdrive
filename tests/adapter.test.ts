
import PouchDB from 'pouchdb-core';
import * as dotenv from 'dotenv';

import GoogleDriveAdapter from '../src/index';

dotenv.config();

// Register the adapter factory
PouchDB.plugin(GoogleDriveAdapter({ accessToken: 'placeholder' } as any));

describe('Google Drive Adapter', () => {
    let accessToken: string;
    let dbName: string;

    beforeAll(() => {
        const accessTokenEnv = process.env.GOOGLE_ACCESS_TOKEN;

        if (!accessTokenEnv) {
            console.warn('Skipping tests requiring Google Drive credentials. Please set them in .env');
            return;
        }

        accessToken = accessTokenEnv;
        dbName = 'test-db-' + Date.now();
    });

    it('should create a database and write a document', async () => {
        if (!accessToken) {
            console.log("No credentials provided, skipping integration test");
            return;
        }

        const db = new PouchDB(dbName, {
            adapter: 'googledrive',
            accessToken: accessToken,
            pollingIntervalMs: 0
        } as any);

        const info = await db.info();
        expect(info.db_name).toBe(dbName);
        // @ts-ignore
        expect(info.backend_adapter).toBe('googledrive');

        const doc = { _id: 'test-doc', title: 'Start Wars' };
        const response = await db.put(doc);
        expect(response.ok).toBe(true);
        expect(response.id).toBe('test-doc');

        const fetched: any = await db.get('test-doc');
        expect(fetched.title).toBe('Start Wars');
    });

    afterAll(async () => {
        // Cleanup would ideally delete the created file
    });
});
