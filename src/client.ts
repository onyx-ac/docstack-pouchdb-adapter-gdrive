
export interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    parents?: string[];
    etag?: string;
    modifiedTime?: string;
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
        const method = init.method || 'GET';
        const token = await this.getToken();
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${token}`);

        let res: Response;
        try {
            res = await fetch(url, { ...init, headers });
        } catch (networkErr: any) {
            const err: any = new Error(`Network Error: ${networkErr.message} (${method} ${url})`);
            err.code = 'network_error';
            err.url = url;
            err.method = method;
            throw err;
        }

        if (!res.ok) {
            const text = await res.text();
            let errorMsg = `Drive API Error: ${res.status} ${res.statusText} (${method} ${url})`;
            let reason = res.statusText;

            try {
                const json = JSON.parse(text);
                const gError = json.error;
                if (gError) {
                    errorMsg += ` - ${gError.message || 'Unknown Error'}`;
                    if (Array.isArray(gError.errors) && gError.errors.length > 0) {
                        reason = gError.errors[0].reason || reason;
                        if (gError.errors[0].message && gError.errors[0].message !== gError.message) {
                            errorMsg += ` (${gError.errors[0].message})`;
                        }
                    }
                }
            } catch { }

            const err: any = new Error(errorMsg);
            err.status = res.status;
            err.code = reason;
            err.url = url;
            err.method = method;
            throw err;
        }
        return res;
    }

    async listFiles(q: string): Promise<DriveFile[]> {
        const params = new URLSearchParams({
            q,
            fields: 'files(id,name,mimeType,parents,modifiedTime)'
        });
        // FIX: URLSearchParams uses '+', but Drive API is safer with '%20'
        const queryString = params.toString().replace(/\+/g, '%20');

        const res = await this.fetch(`${BASE_URL}?${queryString}`, { method: 'GET' });
        const data = await res.json();
        return data.files || [];
    }

    async getFile(fileId: string): Promise<any> {
        // Try getting media
        try {
            const params = new URLSearchParams({ alt: 'media' });
            const queryString = params.toString().replace(/\+/g, '%20');
            const res = await this.fetch(`${BASE_URL}/${fileId}?${queryString}`, { method: 'GET' });
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
        const params = new URLSearchParams({ fields: 'id,name,mimeType,parents,modifiedTime' });
        const queryString = params.toString().replace(/\+/g, '%20');
        const res = await this.fetch(`${BASE_URL}/${fileId}?${queryString}`, { method: 'GET' });
        return await res.json();
    }

    async createFile(name: string, parents: string[] | undefined, mimeType: string, content: string): Promise<{ id: string, etag: string, modifiedTime: string }> {
        const metadata = {
            name,
            mimeType,
            parents
        };

        // Folders or empty content can use simple metadata-only POST
        if (!content && mimeType === 'application/vnd.google-apps.folder') {
            const res = await this.fetch(`${BASE_URL}?fields=id,modifiedTime`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(metadata)
            });
            const data = await res.json();
            return {
                id: data.id,
                etag: data.etag || '',
                modifiedTime: data.modifiedTime || ''
            };
        }

        const multipartBody = this.buildMultipart(metadata, content, mimeType);

        const res = await this.fetch(`${UPLOAD_URL}?uploadType=multipart&fields=id,modifiedTime`, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/related; boundary=${multipartBody.boundary}`
            },
            body: multipartBody.body
        });
        const data = await res.json();
        return {
            id: data.id,
            etag: data.etag || '',
            modifiedTime: data.modifiedTime || ''
        };
    }

    async updateFile(fileId: string, content: string, expectedEtag?: string): Promise<{ id: string, etag: string, modifiedTime: string }> {
        // Update content (media) usually, but sometimes meta?
        // In our usage (saveMeta), we update body.
        const res = await this.fetch(`${UPLOAD_URL}/${fileId}?uploadType=media&fields=id,modifiedTime`, {
            method: 'PATCH',
            headers: expectedEtag ? { 'If-Match': expectedEtag, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
            body: content
        });
        const data = await res.json();
        return {
            id: data.id,
            etag: data.etag || '',
            modifiedTime: data.modifiedTime || ''
        };
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
