
import PouchDB from 'pouchdb-core';
import GoogleDriveAdapter from '../src/index';
import { TestServer } from '../tests-src/server';
import { getTestOptions, isProd } from '../tests-src/test-config';

// Register the adapter factory
PouchDB.plugin(GoogleDriveAdapter({ accessToken: 'placeholder' } as any));

describe('Google Drive Adapter', () => {
    let server: TestServer;
    let port: number;
    let dbName: string;

    beforeAll(async () => {
        dbName = 'test-db-' + Date.now();
        if (!isProd) {
            server = new TestServer(0); // Random port
            port = await server.start();
        }
    });

    afterAll(async () => {
        if (server) {
            await server.stop();
        }
    });

    it('should create a database and write a document', async () => {
        const options = getTestOptions(dbName, port);
        const db = new PouchDB(dbName, options as any);

        try {
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
        } finally {
            await db.close();
        }
    }, 60000);
});
