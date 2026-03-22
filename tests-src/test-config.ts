import * as dotenv from 'dotenv';
dotenv.config();

/**
 * Test Environment Configuration
 * 
 * To run tests against the real Google Drive API:
 * 1. Set TEST_ENV=production
 * 2. Set GOOGLE_ACCESS_TOKEN in your .env file
 */
export const isProd = process.env.TEST_ENV === 'production';
export const accessToken = isProd ? (process.env.GOOGLE_ACCESS_TOKEN || '') : 'mock-token';

if (isProd && !accessToken) {
    console.warn('WARNING: TEST_ENV is set to production but GOOGLE_ACCESS_TOKEN is missing.');
}

export interface TestOptions {
    adapter: string;
    accessToken: string;
    testMode: boolean;
    testServerUrl?: string;
    pollingIntervalMs?: number;
    compactionThreshold?: number;
    folderName?: string;
}

export function getTestOptions(dbName: string, port?: number): TestOptions {
    if (isProd) {
        return {
            adapter: 'googledrive',
            accessToken: accessToken,
            testMode: false,
            folderName: dbName, // Use dbName as folder name in real Drive
            pollingIntervalMs: 0
        };
    } else {
        return {
            adapter: 'googledrive',
            accessToken: 'mock-token',
            testMode: true,
            testServerUrl: `http://127.0.0.1:${port}`,
            pollingIntervalMs: 0
        };
    }
}
