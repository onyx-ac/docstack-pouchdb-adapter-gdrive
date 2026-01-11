
export interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    parents?: string[];
    etag?: string;
}

export interface DriveClientOptions {
    accessToken: string | (() => Promise<string>);
}

const BASE_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

export class GoogleDriveClient {
    constructor(private options: DriveClientOptions) { }

    private async getToken(): Promise<string> {
        if (typeof this.options.accessToken === 'function') {
            return await this.options.accessToken();
        }
        return this.options.accessToken;
    }

    private async fetch(url: string, init: RequestInit): Promise<Response> {
        const token = await this.getToken();
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${token}`);

        const res = await fetch(url, { ...init, headers });
        const method = init.method || 'GET';

        if (!res.ok) {
            // Basic error handling
            const text = await res.text();
            let errorMsg = `Drive API Error: ${res.status} ${res.statusText} (${method} ${url})`;
            try {
                const json = JSON.parse(text);
                if (json.error && json.error.message) {
                    errorMsg += ` - ${json.error.message}`;
                }
            } catch { }

            const err: any = new Error(errorMsg);
            err.status = res.status;
            throw err;
        }
        return res;
    }

    async listFiles(q: string): Promise<DriveFile[]> {
        const params = new URLSearchParams({
            q,
            fields: 'files(id, name, mimeType, parents, etag)',
            spaces: 'drive',
            pageSize: '1000' // Ensure we get enough
        });

        const res = await this.fetch(`${BASE_URL}?${params.toString()}`, { method: 'GET' });
        const data = await res.json();
        return data.files || [];
    }

    async getFile(fileId: string): Promise<any> {
        // Try getting media
        try {
            const params = new URLSearchParams({ alt: 'media' });
            const res = await this.fetch(`${BASE_URL}/${fileId}?${params.toString()}`, { method: 'GET' });
            // Standard fetch handles JSON/Text transparency? 
            // We expect JSON mostly, but sometimes we might want text.
            // PouchDB adapter flow: downloadJson, downloadNdjson
            // Let's rely on content-type or caller expectation?
            // The usage in `drive.ts` expects parsed JSON/NDJSON lines.
            // Let's return the raw Text or JSON based on Content-Type?
            const contentType = res.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                return await res.json();
            }
            return await res.text();
        } catch (e: any) {
            throw e;
        }
    }

    // Single metadata get (for etag check)
    async getFileMetadata(fileId: string): Promise<DriveFile> {
        const params = new URLSearchParams({ fields: 'id, name, mimeType, parents, etag' });
        const res = await this.fetch(`${BASE_URL}/${fileId}?${params.toString()}`, { method: 'GET' });
        return await res.json();
    }

    async createFile(name: string, parents: string[] | undefined, mimeType: string, content: string): Promise<{ id: string, etag: string }> {
        const metadata = {
            name,
            mimeType,
            parents
        };

        // Folders or empty content can use simple metadata-only POST
        if (!content && mimeType === 'application/vnd.google-apps.folder') {
            const res = await this.fetch(`${BASE_URL}?fields=id,etag`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(metadata)
            });
            return await res.json();
        }

        const multipartBody = this.buildMultipart(metadata, content, mimeType);

        const res = await this.fetch(`${UPLOAD_URL}?uploadType=multipart&fields=id,etag`, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/related; boundary=${multipartBody.boundary}`
            },
            body: multipartBody.body
        });
        return await res.json();
    }

    async updateFile(fileId: string, content: string, expectedEtag?: string): Promise<{ id: string, etag: string }> {
        // Update content (media) usually, but sometimes meta?
        // In our usage (saveMeta), we update body.
        const res = await this.fetch(`${UPLOAD_URL}/${fileId}?uploadType=media&fields=id,etag`, {
            method: 'PATCH',
            headers: expectedEtag ? { 'If-Match': expectedEtag, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
            body: content
        });
        return await res.json();
    }

    async deleteFile(fileId: string): Promise<void> {
        await this.fetch(`${BASE_URL}/${fileId}`, { method: 'DELETE' });
    }

    private buildMultipart(metadata: any, content: string, contentType: string): { body: string, boundary: string } {
        const boundary = '-------' + Math.random().toString(36).substring(2);
        const delimiter = `\r\n--${boundary}\r\n`;
        const closeDelimiter = `\r\n--${boundary}--`;

        const body = delimiter +
            'Content-Type: application/json\r\n\r\n' +
            JSON.stringify(metadata) +
            delimiter +
            `Content-Type: ${contentType}\r\n\r\n` +
            content +
            closeDelimiter;

        return { body, boundary };
    }
}
