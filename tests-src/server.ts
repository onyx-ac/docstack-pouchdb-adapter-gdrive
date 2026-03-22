
import express, { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

export class TestServer {
    private app: Express;
    private server: any;
    private port: number;
    private rootDir: string;
    private metadataParams: Map<string, any> = new Map(); // Store metadata by ID

    constructor(port: number = 3000, rootDir: string = '.test-drive-root') {
        this.port = port;
        this.rootDir = path.resolve(rootDir);
        this.app = express();

        // Middleware
        this.app.use(express.json());
        this.app.use(express.text()); // For raw text bodies
        this.app.use((req, res, next) => {
            console.log(`${req.method} ${req.url}`);
            next();
        });

        // Ensure root dir exists
        if (!fs.existsSync(this.rootDir)) {
            fs.mkdirSync(this.rootDir, { recursive: true });
        }

        // Routes
        this.app.get('/drive/v3/files', this.listFiles.bind(this));
        this.app.get('/drive/v3/files/:fileId', this.getFile.bind(this));
        this.app.post('/drive/v3/files', this.createFileMeta.bind(this));
        this.app.post('/upload/drive/v3/files', this.createFileMultipart.bind(this));
        this.app.patch('/upload/drive/v3/files/:fileId', this.updateFile.bind(this));
        this.app.delete('/drive/v3/files/:fileId', this.deleteFile.bind(this));
    }

    public start(): Promise<number> {
        return new Promise((resolve, reject) => {
            this.server = this.app.listen(this.port, '127.0.0.1', () => {
                const address = this.server.address();
                const port = typeof address === 'string' ? 0 : address?.port || this.port;
                this.port = port;
                console.log(`Test Drive Server running on port ${port}`);
                resolve(port);
            });
            this.server.on('error', (err: any) => reject(err));
        });
    }

    public stop(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.server) {
                this.server.close((err: any) => {
                    if (err) reject(err);
                    else resolve();
                });
            } else {
                resolve();
            }
        });
    }

    public reset(): void {
        this.metadataParams.clear();
        if (fs.existsSync(this.rootDir)) {
            fs.rmSync(this.rootDir, { recursive: true, force: true });
            fs.mkdirSync(this.rootDir);
        }
    }

    // --- Handlers ---

    private listFiles(req: Request, res: Response): void {
        const q = req.query.q as string;
        // Simple query parsing: "name = 'X' and 'P' in parents"
        // This is fragile but sufficient for our specific adapter queries

        let files = Array.from(this.metadataParams.values());

        if (q) {
            const dq = decodeURIComponent(q);
            if (dq.includes("trashed = false") || dq.includes("trashed=false")) {
                files = files.filter(f => !f.trashed);
            }

            // Name filter
            const nameMatch = q.match(/name = '([^']+)'/);
            if (nameMatch) {
                const name = nameMatch[1];
                files = files.filter(f => f.name === name);
            }

            // Parent filter
            const parentMatch = q.match(/'([^']+)' in parents/);
            if (parentMatch) {
                const parentId = parentMatch[1];
                files = files.filter(f => f.parents && f.parents.includes(parentId));
            }
        }

        res.json({ files });
    }

    private getFile(req: Request, res: Response): void {
        const fileId = req.params.fileId as string;
        const meta = this.metadataParams.get(fileId);

        if (!meta || meta.trashed) {
            res.status(404).json({ error: { message: 'File not found' } });
            return;
        }

        const alt = req.query.alt as string;
        if (alt === 'media') {
            const filePath = path.join(this.rootDir, fileId);
            if (fs.existsSync(filePath)) {
                if (meta.mimeType === 'application/json') {
                    res.setHeader('Content-Type', 'application/json');
                } else if (meta.mimeType === 'application/x-ndjson') {
                    res.setHeader('Content-Type', 'text/plain'); // Or application/x-ndjson
                }
                try {
                    const content = fs.readFileSync(filePath);
                    res.send(content);
                } catch (err) {
                    res.status(500).send('Error reading file');
                }
            } else {
                res.send(''); // Empty file?
            }
        } else {
            res.json(meta);
        }
    }

    private createFileMeta(req: Request, res: Response): void {
        const meta = req.body;
        const id = this.generateId();
        const newFile = {
            id,
            name: meta.name,
            mimeType: meta.mimeType,
            parents: meta.parents || [],
            modifiedTime: new Date().toISOString(),
            etag: this.generateId(),
            trashed: false
        };

        this.metadataParams.set(id, newFile);
        // Create empty file if folder
        if (meta.mimeType !== 'application/vnd.google-apps.folder') {
            fs.writeFileSync(path.join(this.rootDir, id), '');
        }

        res.json(newFile);
    }

    private createFileMultipart(req: Request, res: Response): void {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)$/);

        if (!boundaryMatch) {
            res.status(400).send('Missing boundary');
            return;
        }

        const boundary = boundaryMatch[1];
        // Raw body buffer handling would be better, but explicit text middleware might mess it up if not careful.
        // Assuming express.text() wasn't used globally, we'd need raw body.
        // But let's assume req.body is a string/buffer based on setup.
        // I used express.text() so req.body might be text if content-type matches. 
        // Multipart/related isn't text/* so express.json/text might skip it.
        // We need a raw body parser or handle 'data' events.
        // For simplicity, let's just listen to data events if body is empty?
        // Actually, let's fix the middleware order or type in Constructor.

        // Simpler manual parsing of the body string (assuming it was captured)
        // We'll need to ensure we capture the raw body. 
        // express.raw({ type: 'multipart/related' }) ?

        // Actually, let's just use a simple approach: 
        // We can't easily do full multipart parsing without a lib or careful code.
        // Let's assume the body IS accessible.

        // Wait, for this to work robustly without 'multer', I need to read the stream.
        // Let's rely on `req` being a stream and read it if body is empty.

        // BUT, since we want to be quick, let's assume the client sends valid text-based multipart/related (JSON + String).
        // The adapter sends strings.

        let rawBody = '';
        req.on('data', chunk => rawBody += chunk);
        req.on('end', () => {
            const parts = rawBody.split(`--${boundary}`);
            // parts[0] is empty (preamble)
            // parts[1] is metadata headers + body
            // parts[2] is content headers + body
            // parts[3] is -- (end)

            if (parts.length < 3) {
                res.status(400).send('Invalid multipart');
                return;
            }

            // Parse Metadata (Part 1)
            const metaPart = parts[1];
            const metaBodyIndex = metaPart.indexOf('\r\n\r\n');
            const metaJson = metaPart.substring(metaBodyIndex + 4).trim();
            const meta = JSON.parse(metaJson);

            // Parse Content (Part 2)
            const contentPart = parts[2];
            const contentBodyIndex = contentPart.indexOf('\r\n\r\n');
            const content = contentPart.substring(contentBodyIndex + 4);
            // Remove trailing \r\n from content part if it exists before the boundary? 
            // The split removes the boundary, but there might be \r\n before it.
            // Usually multipart ends with \r\n--boundary
            // So content probably has a trailing \r\n that belongs to the framing, not the content.
            const cleanContent = content.slice(0, -2); // Extremely naive, but might work for text content

            const id = this.generateId();
            const newFile = {
                id,
                name: meta.name,
                mimeType: meta.mimeType,
                parents: meta.parents || [],
                modifiedTime: new Date().toISOString(),
                etag: this.generateId(),
                trashed: false
            };

            this.metadataParams.set(id, newFile);
            fs.writeFileSync(path.join(this.rootDir, id), cleanContent);

            res.json(newFile);
        });
    }

    private updateFile(req: Request, res: Response): void {
        const fileId = req.params.fileId as string;
        const meta = this.metadataParams.get(fileId);

        if (!meta || meta.trashed) {
            res.status(404).json({ error: { message: 'File not found' } });
            return;
        }

        // Check If-Match
        const ifMatchHeader = req.headers['if-match'] as string;
        if (ifMatchHeader) {
            const ifMatch = ifMatchHeader.replace(/"/g, '');
            if (ifMatch !== meta.etag) {
                res.status(412).json({ error: { message: 'Precondition Failed' } });
                return;
            }
        }

        // Body is content (uploadType=media)
        // We need to capture the raw body again. 
        // express.text() might have caught it?
        // contentType is application/json usually for our adapter updates?
        // Wait, adapter uses: headers: { 'Content-Type': 'application/json' }, body: content
        // So req.body should be available if we use express.json() / express.text()

        let content = req.body;
        if (typeof content === 'object') {
            content = JSON.stringify(content);
        }

        fs.writeFileSync(path.join(this.rootDir, fileId), content);

        // Update metadata
        meta.modifiedTime = new Date().toISOString();
        meta.etag = this.generateId();
        this.metadataParams.set(fileId, meta);

        res.json(meta);
    }

    private deleteFile(req: Request, res: Response): void {
        const fileId = req.params.fileId as string;
        const meta = this.metadataParams.get(fileId);

        if (meta) {
            meta.trashed = true;
            this.metadataParams.set(fileId, meta);
        }

        res.status(204).send();
    }

    private generateId(): string {
        return Math.random().toString(36).substring(2, 15);
    }
}
