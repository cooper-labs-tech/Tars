import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { VAULT_DIR, MIME_TYPES, PRIVATE_DIR } from '../../constants';
import { getVaultDb, ftsSearch } from '../vault-db';
import { RouteApp, RouteContext } from './types';
import { isHardLinkInto, isWithinDir } from '../../utils/path-identity';
import { landsUnderSafeRoot } from '../../utils/real-target';
import { unlinkRetryingSync } from '../../platform/rename-replacing';

export function registerVaultRoutes(app: RouteApp, ctx: RouteContext): void {
  // GET /api/vault/documents
  app.get('/api/vault/documents', (req, sendJson) => {
    try {
      const db = getVaultDb();
      const folderId = req.url.searchParams.get('folder_id');
      const tagsParam = req.url.searchParams.get('tags');

      let query = 'SELECT * FROM documents';
      const conditions: string[] = [];
      const queryParams: unknown[] = [];

      if (folderId) {
        conditions.push('folder_id = ?');
        queryParams.push(folderId);
      }
      if (tagsParam) {
        const tags = tagsParam.split(',');
        const tagConditions = tags.map(() => "tags LIKE ?");
        conditions.push(`(${tagConditions.join(' OR ')})`);
        tags.forEach(tag => queryParams.push(`%"${tag.trim()}"%`));
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }
      query += ' ORDER BY updated_at DESC';

      const documents = db.prepare(query).all(...queryParams);
      sendJson({ documents });
    } catch (err) {
      sendJson({ error: String(err) }, 500);
    }
  });

  // POST /api/vault/documents
  app.post('/api/vault/documents', (req, sendJson) => {
    try {
      const db = getVaultDb();
      const { title, content, folder_id, author, agent_id, tags } = req.body as {
        title: string; content: string; folder_id?: string;
        author?: string; agent_id?: string; tags?: string[];
      };

      if (!title) {
        sendJson({ error: 'title is required' }, 400);
        return;
      }

      const id = uuidv4();
      const now = new Date().toISOString();
      const tagsJson = JSON.stringify(tags || []);

      db.prepare(`
        INSERT INTO documents (id, title, content, folder_id, author, agent_id, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, title, content || '', folder_id || null, author || 'api', agent_id || null, tagsJson, now, now);

      const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);

      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('vault:document-created', document);
      }

      sendJson({ success: true, document });
    } catch (err) {
      sendJson({ error: String(err) }, 500);
    }
  });

  // GET /api/vault/documents/:id
  app.get(/^\/api\/vault\/documents\/([^/]+)$/, (req, sendJson) => {
    try {
      const db = getVaultDb();
      const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
      if (!document) {
        sendJson({ error: 'Document not found' }, 404);
        return;
      }
      const attachments = db.prepare('SELECT * FROM attachments WHERE document_id = ? ORDER BY created_at DESC').all(req.params.id);
      sendJson({ document, attachments });
    } catch (err) {
      sendJson({ error: String(err) }, 500);
    }
  });

  // PUT /api/vault/documents/:id
  app.put(/^\/api\/vault\/documents\/([^/]+)$/, (req, sendJson) => {
    try {
      const db = getVaultDb();
      const docId = req.params.id;
      const existing = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
      if (!existing) {
        sendJson({ error: 'Document not found' }, 404);
        return;
      }

      const { title, content, tags, folder_id } = req.body as {
        title?: string; content?: string; tags?: string[]; folder_id?: string | null;
      };

      const now = new Date().toISOString();
      const updates: string[] = ['updated_at = ?'];
      const values: unknown[] = [now];

      if (title !== undefined) { updates.push('title = ?'); values.push(title); }
      if (content !== undefined) { updates.push('content = ?'); values.push(content); }
      if (tags !== undefined) { updates.push('tags = ?'); values.push(JSON.stringify(tags)); }
      if (folder_id !== undefined) { updates.push('folder_id = ?'); values.push(folder_id); }

      values.push(docId);
      db.prepare(`UPDATE documents SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);

      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('vault:document-updated', document);
      }

      sendJson({ success: true, document });
    } catch (err) {
      sendJson({ error: String(err) }, 500);
    }
  });

  // DELETE /api/vault/documents/:id
  app.delete(/^\/api\/vault\/documents\/([^/]+)$/, (req, sendJson) => {
    try {
      const db = getVaultDb();
      const docId = req.params.id;

      const attachments = db.prepare('SELECT filepath FROM attachments WHERE document_id = ?').all(docId) as { filepath: string }[];
      for (const att of attachments) {
        try { if (fs.existsSync(att.filepath)) unlinkRetryingSync(att.filepath); } catch { /* ignore */ }
      }

      db.prepare('DELETE FROM documents WHERE id = ?').run(docId);

      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('vault:document-deleted', { id: docId });
      }

      sendJson({ success: true });
    } catch (err) {
      sendJson({ error: String(err) }, 500);
    }
  });

  // GET /api/vault/search
  app.get('/api/vault/search', (req, sendJson) => {
    try {
      const db = getVaultDb();
      const query = req.url.searchParams.get('q');
      const limit = parseInt(req.url.searchParams.get('limit') || '20', 10);

      if (!query) {
        sendJson({ error: 'q parameter is required' }, 400);
        return;
      }

      const results = ftsSearch(db, query, limit);
      sendJson({ results });
    } catch (err) {
      sendJson({ error: String(err) }, 500);
    }
  });

  // GET /api/vault/folders
  app.get('/api/vault/folders', (req, sendJson) => {
    try {
      const db = getVaultDb();
      const folders = db.prepare('SELECT * FROM folders ORDER BY name').all();
      sendJson({ folders });
    } catch (err) {
      sendJson({ error: String(err) }, 500);
    }
  });

  // POST /api/vault/folders
  app.post('/api/vault/folders', (req, sendJson) => {
    try {
      const db = getVaultDb();
      const { name, parent_id } = req.body as { name: string; parent_id?: string };

      if (!name) {
        sendJson({ error: 'name is required' }, 400);
        return;
      }

      const id = uuidv4();
      const now = new Date().toISOString();
      db.prepare('INSERT INTO folders (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, name, parent_id || null, now, now);

      const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
      sendJson({ success: true, folder });
    } catch (err) {
      sendJson({ error: String(err) }, 500);
    }
  });

  // DELETE /api/vault/folders/:id
  app.delete(/^\/api\/vault\/folders\/([^/]+)$/, (req, sendJson) => {
    try {
      const db = getVaultDb();
      const folderId = req.params.id;

      db.prepare('UPDATE documents SET folder_id = NULL WHERE folder_id = ?').run(folderId);
      db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);

      sendJson({ success: true });
    } catch (err) {
      sendJson({ error: String(err) }, 500);
    }
  });

  // POST /api/vault/documents/:id/attach
  app.post(/^\/api\/vault\/documents\/([^/]+)\/attach$/, (req, sendJson) => {
    try {
      const db = getVaultDb();
      const docId = req.params.id;
      const { file_path } = req.body as { file_path: string };

      const doc = db.prepare('SELECT id FROM documents WHERE id = ?').get(docId);
      if (!doc) {
        sendJson({ error: 'Document not found' }, 404);
        return;
      }

      if (!file_path || !fs.existsSync(file_path)) {
        sendJson({ error: 'File not found' }, 400);
        return;
      }
      // Nothing from the private directory. The copy lands in the vault, under
      // ~/.dorothy, the directory every agent is handed, and /api/local-file
      // serves it without a token: one vault_attach_file call put JeanBrasse's
      // conversation, or the webhook secret, back where the move had taken it
      // from. Measured while closing the Telegram side of the same gap.
      // Asked of the file, not of its name: a case variant, the Data volume's
      // firmlink or a symlink opened the same file past a prefix test (the
      // audit's lead #21). And the file copied is the one that was checked.
      // A hard link has no path back to it at all, so it is looked for by
      // inode among the private files (the audit's gate of #137).
      const resolved = path.resolve(file_path);
      const real = fs.realpathSync.native(file_path);
      if (resolved === PRIVATE_DIR || resolved.startsWith(PRIVATE_DIR + path.sep) || isWithinDir(real, PRIVATE_DIR)
        || isHardLinkInto(real, PRIVATE_DIR)) {
        sendJson({ error: 'Access denied: path not allowed' }, 403);
        return;
      }

      const id = uuidv4();
      const filename = path.basename(file_path);
      const destPath = path.join(VAULT_DIR, 'attachments', `${id}-${filename}`);
      fs.copyFileSync(real, destPath);

      const stats = fs.statSync(destPath);
      const ext = path.extname(filename).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain',
        '.md': 'text/markdown', '.json': 'application/json',
      };
      const mimetype = mimeMap[ext] || 'application/octet-stream';
      const now = new Date().toISOString();

      db.prepare('INSERT INTO attachments (id, document_id, filename, filepath, mimetype, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, docId, filename, destPath, mimetype, stats.size, now);

      const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
      sendJson({ success: true, attachment });
    } catch (err) {
      sendJson({ error: String(err) }, 500);
    }
  });

  // GET /api/local-file?path=...: serve local files (for vault image previews)
  app.get('/api/local-file', (req, sendJson) => {
    const filePath = req.url.searchParams.get('path');
    if (!filePath) {
      sendJson({ error: 'File not found' }, 404);
      return;
    }

    const resolved = path.resolve(filePath);
    const allowedDir = path.join(VAULT_DIR, 'attachments');
    // Where the file really lies, links followed: a link planted in the
    // attachments served the home to anyone on the loopback, with no token
    // (utils/real-target.ts).
    if (!landsUnderSafeRoot(resolved, [allowedDir], (root, p) => p === root || p.startsWith(root + path.sep))) {
      sendJson({ error: 'Access denied: path outside allowed directory' }, 403);
      return;
    }
    if (!fs.existsSync(resolved)) {
      sendJson({ error: 'File not found' }, 404);
      return;
    }
    try {
      const ext = path.extname(resolved).toLowerCase();
      const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
      const stat = fs.statSync(resolved);
      // The guard above lets the attachments folder itself through, and a
      // folder read as a file is EISDIR.
      if (!stat.isFile()) {
        sendJson({ error: 'File not found' }, 404);
        return;
      }
      // A hard link has no path back to the file it names, so no path check
      // sees one (SECURITY.md §5). An attachment is a copy the vault made, its
      // file's only name: a file here with another name is refused, whatever
      // the other name is.
      if (stat.nlink > 1) {
        sendJson({ error: 'Access denied: path outside allowed directory' }, 403);
        return;
      }
      const stream = fs.createReadStream(resolved);
      // A read stream reports a file it cannot open or read with 'error', and
      // an 'error' nobody listens to is thrown: in the main process, the
      // "Uncaught Exception" window, from the one route that takes no token.
      // The headers wait for the file to open, so a file that will not open
      // gets an answer rather than a 200 cut short.
      stream.on('error', () => {
        if (req.res.headersSent) req.res.destroy();
        else sendJson({ error: 'Could not read the file' }, 500);
      });
      stream.on('open', () => {
        req.res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Length': stat.size,
          'Cache-Control': 'public, max-age=3600',
        });
        stream.pipe(req.res);
      });
    } catch (err) {
      sendJson({ error: String(err) }, 500);
    }
  });
}
