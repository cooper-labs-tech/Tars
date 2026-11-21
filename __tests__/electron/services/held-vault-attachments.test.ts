import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Deleting a vault document, or a folder of them, deletes its attachment
 * files, and ignores a file it cannot delete: the document goes either way.
 * On Windows an attachment just opened (a preview, an antivirus, the indexer)
 * is held for a moment, and the delete gave up at once, leaving the file on
 * disk with no document pointing at it: a copy of something the user deleted.
 *
 * How it can fail, written before the change:
 * 1. an attachment held for a moment is left behind by the IPC delete of a
 *    document, of a folder, or by the API's DELETE /api/vault/documents/:id;
 * 2. a failure to delete it now fails the call, where it was ignored before;
 * 3. the test proves nothing: the file was not held when the delete ran (each
 *    call starts once the holder says it holds it, and a witness shows the
 *    plain unlink refused under the same hold).
 *
 * The database is a fake answering the attachment rows; the files and the
 * holds are real. The hold is PowerShell with FileShare.None, let go 150 ms
 * after the call may start, well inside the 1 s budget.
 */

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn); } },
  BrowserWindow: class {},
}));

/** The rows each query answers: attachments by the file list, folders by `folderDocs`, subfolders none. */
let attachmentFiles: string[] = [];
const fakeDb = {
  prepare: (sql: string) => ({
    all: () => {
      if (/FROM attachments/.test(sql)) return attachmentFiles.map((filepath, i) => ({ id: `att-${i}`, document_id: 'doc-1', filepath }));
      if (/SELECT id FROM documents WHERE folder_id/.test(sql)) return [{ id: 'doc-1' }];
      return [];
    },
    get: () => undefined,
    run: () => ({ changes: 1 }),
  }),
};
vi.mock('../../../electron/services/vault-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/services/vault-db')>()),
  getVaultDb: () => fakeDb,
}));

import { registerVaultHandlers } from '../../../electron/handlers/vault-handlers';
import { registerVaultRoutes } from '../../../electron/services/api-routes/vault-routes';
import type { RouteApp, RouteContext, RouteHandler } from '../../../electron/services/api-routes/types';

const holders: ChildProcess[] = [];

/** PowerShell holding `file` with no sharing for `ms` after it says ready; resolves once it holds it. */
function hold(file: string, ms: number): Promise<ChildProcess> {
  const script = [
    `$f = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'None')`,
    "[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()",
    `Start-Sleep -Milliseconds ${ms}`,
    '$f.Close()',
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  holders.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => { if (String(d).includes('ready')) resolve(child); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`the holder exited (${code}) before it held the file`)));
  });
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-vault-held-'));
});
afterEach(async () => {
  await Promise.all(holders.splice(0).map(c => new Promise<void>(r => (c.exitCode !== null ? r() : c.once('exit', () => r())))));
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function attachment(name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'attachment bytes');
  attachmentFiles = [file];
  return file;
}

const window = { webContents: { send: () => {} }, isDestroyed: () => false };

function routes(): Map<string, RouteHandler> {
  const found = new Map<string, RouteHandler>();
  const add = (method: string) => (pattern: string | RegExp, handler: RouteHandler) => { found.set(`${method} ${String(pattern)}`, handler); };
  const app = { routes: [], add: (m: string, p: string | RegExp, h: RouteHandler) => add(m)(p, h), get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') } as unknown as RouteApp;
  registerVaultRoutes(app, { mainWindow: window } as unknown as RouteContext);
  return found;
}

describe.runIf(process.platform === 'win32')('a vault attachment held for a moment is deleted with its document (win32)', () => {
  it('3. the witness: the plain unlink is refused under the hold', async () => {
    const witness = attachment('witness.png');
    await hold(witness, 300);
    expect((() => { try { fs.unlinkSync(witness); return 'deleted'; } catch (e) { return (e as NodeJS.ErrnoException).code; } })()).toBe('EBUSY');
  }, 30_000);

  it('1, 2. vault:deleteDocument', async () => {
    registerVaultHandlers({ getMainWindow: () => window as never });
    const file = attachment('doc.png');
    await hold(file, 150);
    expect(await handlers.get('vault:deleteDocument')!({}, 'doc-1')).toEqual({ success: true });
    expect(fs.existsSync(file)).toBe(false);
  }, 30_000);

  it('1, 2. vault:deleteFolder, recursive', async () => {
    registerVaultHandlers({ getMainWindow: () => window as never });
    const file = attachment('folder.png');
    await hold(file, 150);
    expect(await handlers.get('vault:deleteFolder')!({}, { id: 'f-1', recursive: true })).toMatchObject({ success: true });
    expect(fs.existsSync(file)).toBe(false);
  }, 30_000);

  it('1, 2. DELETE /api/vault/documents/:id', async () => {
    const del = [...routes()].find(([key]) => key.startsWith('DELETE') && key.includes('documents'))![1];
    const file = attachment('api.png');
    await hold(file, 150);
    const sent: Array<[unknown, number | undefined]> = [];
    await del({ params: { id: 'doc-1' } } as never, ((body: unknown, status?: number) => { sent.push([body, status]); }) as never, {} as never);
    expect(sent).toEqual([[{ success: true }, undefined]]);
    expect(fs.existsSync(file)).toBe(false);
  }, 30_000);
});
