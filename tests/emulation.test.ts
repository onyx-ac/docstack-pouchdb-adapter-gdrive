import PouchDB from 'pouchdb-core';
import GoogleDriveAdapter from '../src/adapter';
import Replication from 'pouchdb-replication';
import MemoryAdapter from 'pouchdb-adapter-memory';
import { TestServer } from '../tests-src/server';
import { getTestOptions, isProd } from '../tests-src/test-config';

PouchDB.plugin(Replication);
PouchDB.plugin(MemoryAdapter);

// Register adapter manually since we are using source directly and not the index wrapper
const AdapterConstructor = GoogleDriveAdapter(PouchDB);
(PouchDB as any).adapter('googledrive', AdapterConstructor);

describe('Google Drive Emulation Integration', () => {
    let server: TestServer;
    let PORT: number;

    beforeAll(async () => {
        if (!isProd) {
            server = new TestServer(0, '.test-drive-integration'); // Use random port
            PORT = await server.start();
        }
    });

    afterAll(async () => {
        if (server) await server.stop();
    });

    beforeEach(() => {
        if (server) server.reset();
    });

    test('should create database and write documents', async () => {
        const dbName = 'testdb-' + Date.now();
        const options = getTestOptions(dbName, PORT);
        const db = new PouchDB(dbName, options as any);

        try {
            await db.post({ _id: 'doc1', title: 'Start' });
            const doc = await db.get('doc1');
            expect((doc as any).title).toBe('Start');
        } finally {
            await db.close();
        }
    }, 60000);

    test('should replicate from remote to local (memory)', async () => {
        const remoteName = 'remote-repl-' + Date.now();
        const options = getTestOptions(remoteName, PORT);
        const remote = new PouchDB(remoteName, options as any);
        const local = new PouchDB('local-repl-' + Date.now(), { adapter: 'memory' });

        try {
            await remote.post({ _id: 'doc_repl_1', title: 'Replicate Me' });

            await new Promise<void>((resolve, reject) => {
                remote.replicate.to(local)
                    .on('complete', () => resolve())
                    .on('error', (err) => reject(err));
            });

            const doc = await local.get('doc_repl_1');
            expect((doc as any).title).toBe('Replicate Me');
        } finally {
            await remote.close();
            await local.close();
        }
    }, 60000);

    test('should live replicate from remote to local', async () => {
        const remoteName = 'live-remote-' + Date.now();
        const options = {
            ...getTestOptions(remoteName, PORT),
            pollingIntervalMs: 1000 // Very short interval for test
        };
        const remote = new PouchDB(remoteName, options as any);
        const local = new PouchDB('live-local-' + Date.now(), { adapter: 'memory' });

        try {
            // Replication from remote to local
            const rep = remote.replicate.to(local, { live: true });
            
            // Wait for initial sync setup
            await new Promise(resolve => setTimeout(resolve, 500));

            // Write to remote (Google Drive instance)
            const docId = 'live-doc-' + Date.now();
            await remote.put({ _id: docId, title: 'Live Update from GDrive' });

            // Wait for polling + replication (1s polling + some buffer)
            // Note: In real GDrive this could take 10s+, but on TestServer it's fast.
            await new Promise(resolve => setTimeout(resolve, 3000));

            const doc = await local.get(docId);
            expect((doc as any).title).toBe('Live Update from GDrive');

            rep.cancel();
        } finally {
            await remote.close();
            await local.close();
        }
    }, 60000);
});
