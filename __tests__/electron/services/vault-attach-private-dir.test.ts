import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { cannotSymlink } from '../../setup/symlink-privilege';

/**
 * The vault does not copy the private directory back into the agents' one.
 *
 * `POST /api/vault/documents/:id/attach` copies whatever path its caller names
 * into `~/.dorothy/vault/attachments`, and `/api/local-file` serves that copy
 * with no token at all. Measured on this branch before the guard, with the
 * shared token: a file in the private directory was copied in, 200, and served
 * back, 200. That is one `vault_attach_file` call from an agent to put JeanBrasse's
 * conversation, or the webhook secret, back in the directory it was moved out
 * of. The same gap as the Telegram guards, closed here for the same directory.
 *
 * The server, the routes and the vault database are the real ones; the private
 * directory is the real constant, under this run's own HOME.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-vault-attach-'));
let port = 0;

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return {
    ...actual,
    get API_PORT() { return port; },
    DATA_DIR: tmp,
    dataPath: (...segments: string[]) => path.join(tmp, ...segments),
    AGENTS_FILE: path.join(tmp, 'agents.json'),
    APP_SETTINGS_FILE: path.join(tmp, 'app-settings.json'),
    KANBAN_FILE: path.join(tmp, 'kanban-tasks.json'),
    VAULT_DIR: path.join(tmp, 'vault'),
    VAULT_DB_FILE: path.join(tmp, 'vault.db'),
    API_TOKEN_FILE: path.join(tmp, 'api-token'),
    BUS_FILE: path.join(tmp, 'bus.json'),
  };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

let api: typeof import('../../../electron/services/api-server');
let privateDir = '';
let sharedToken = '';
let documentId = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: picked } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(picked));
    });
  });
}

function call(method: string, pathname: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: payload ? { ...headers, 'content-type': 'application/json' } : headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const attachments = () => fs.readdirSync(path.join(tmp, 'vault', 'attachments'));

beforeAll(async () => {
  port = await freePort();
  ({ PRIVATE_DIR: privateDir } = await import('../../../electron/constants'));
  api = await import('../../../electron/services/api-server');
  (await import('../../../electron/services/vault-db')).initVaultDb();
  api.startApiServer(
    null, { notificationsEnabled: false } as never, () => null, () => null, null, null,
    () => {}, () => {}, async () => 'pty', () => ({ notificationsEnabled: false } as never),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`never listened: ${api.getApiServerState().phase}`)), 5000);
    const check = () => {
      if (api.getApiServerState().phase !== 'listening') return;
      clearTimeout(timer);
      api.apiServerEmitter.off('state', check);
      resolve();
    };
    api.apiServerEmitter.on('state', check);
    check();
  });
  sharedToken = api.getApiToken();
  const created = await call('POST', '/api/vault/documents', { authorization: `Bearer ${sharedToken}` }, { title: 'notes' });
  documentId = JSON.parse(created.text).document.id;
});

afterAll(async () => {
  api.stopApiServer();
  // Closed before its folder goes: Windows will not delete a database file
  // still open (EBUSY), where macOS and Linux unlink it from under the handle.
  (await import('../../../electron/services/vault-db')).closeVaultDb();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(privateDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of attachments()) fs.rmSync(path.join(tmp, 'vault', 'attachments', f), { force: true });
});

describe('attaching a file to a vault document', () => {
  it('refuses a file from the private directory, and copies nothing', async () => {
    expect(privateDir.startsWith(os.homedir() + path.sep), 'the private directory is not under this run\'s HOME').toBe(true);
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const conversation = path.join(privateDir, 'overseer.json');
    fs.writeFileSync(conversation, '{"messages":["what JeanBrasse said"]}', { mode: 0o600 });

    const { status, text } = await call('POST', `/api/vault/documents/${documentId}/attach`, {
      authorization: `Bearer ${sharedToken}`,
    }, { file_path: conversation });

    expect(status, text).toBe(403);
    expect(attachments(), 'the conversation was copied into the directory every agent is handed').toEqual([]);
  });

  // The same file under the other names the file system gives it (the audit's
  // lead #21, reproduced in a sandbox app on main b9a95b1: both copied the
  // webhook secret in, and /api/local-file served it without a token). A
  // prefix test on the string sees neither.
  const secretFile = () => {
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const secret = path.join(privateDir, 'hermes-webhook-secret');
    fs.writeFileSync(secret, 'the webhook secret', { mode: 0o600 });
    return secret;
  };
  const upperCased = (file: string) => file.replace(path.basename(privateDir), path.basename(privateDir).toUpperCase());
  const caseInsensitive = (() => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-case-probe-'));
    try { return fs.existsSync(probe.toUpperCase()) && fs.existsSync(probe.replace(/tars-case-probe/, 'TARS-CASE-PROBE')); } finally { fs.rmSync(probe, { recursive: true, force: true }); }
  })();

  it.runIf(caseInsensitive)('refuses the private directory spelled in another case, on a volume that does not care', async () => {
    const alias = upperCased(secretFile());
    expect(fs.existsSync(alias), 'the alias does not open the file here').toBe(true);

    const { status, text } = await call('POST', `/api/vault/documents/${documentId}/attach`, {
      authorization: `Bearer ${sharedToken}`,
    }, { file_path: alias });

    expect(status, text).toBe(403);
    expect(attachments()).toEqual([]);
  });

  it.runIf(fs.existsSync('/System/Volumes/Data'))('refuses the private directory reached through the Data volume', async () => {
    const alias = path.join('/System/Volumes/Data', fs.realpathSync(secretFile()));
    expect(fs.existsSync(alias), 'the firmlink does not open the file here').toBe(true);

    const { status, text } = await call('POST', `/api/vault/documents/${documentId}/attach`, {
      authorization: `Bearer ${sharedToken}`,
    }, { file_path: alias });

    expect(status, text).toBe(403);
    expect(attachments()).toEqual([]);
  });

  it('refuses the private directory reached through a symlink', async () => {
    const link = path.join(tmp, 'innocent-looking');
    fs.rmSync(link, { force: true });
    // A junction: Windows lets any account make one, where a symlink needs a privilege; the type is ignored off Windows.
    fs.symlinkSync(privateDir, link, 'junction');
    secretFile();

    const { status, text } = await call('POST', `/api/vault/documents/${documentId}/attach`, {
      authorization: `Bearer ${sharedToken}`,
    }, { file_path: path.join(link, 'hermes-webhook-secret') });

    expect(status, text).toBe(403);
    expect(attachments()).toEqual([]);
  });

  /**
   * A hard link is a second name for the file with no path back to the first,
   * so a check that follows paths finds it inside nothing (the audit's gate of
   * #137, measured on this route). How the check for it can fail, written
   * before it:
   * 1. a hard link made outside, to a file in the private directory, is copied in;
   * 2. every file with a second name is refused: a pnpm store is made of them;
   * 3. a copy, which is another file with the same bytes, is refused;
   * 4. the search leaves the private directory through a symlink inside it.
   */
  it('refuses a hard link, made outside, to a file in the private directory', async () => {
    const link = path.join(tmp, 'notes.txt');
    fs.rmSync(link, { force: true });
    fs.linkSync(secretFile(), link);

    const { status, text } = await call('POST', `/api/vault/documents/${documentId}/attach`, {
      authorization: `Bearer ${sharedToken}`,
    }, { file_path: link });

    expect(status, text).toBe(403);
    expect(attachments()).toEqual([]);
  });

  it('still attaches a file with two ordinary names, and a copy of a private file', async () => {
    const first = path.join(tmp, 'store-first.txt');
    const second = path.join(tmp, 'store-second.txt');
    fs.writeFileSync(first, 'one file, two names');
    fs.rmSync(second, { force: true });
    fs.linkSync(first, second);
    const copy = path.join(tmp, 'copy-of-the-secret.txt');
    fs.copyFileSync(secretFile(), copy);
    // A way out of the private directory, to where the pair lives: the search
    // must not take it.
    const exit = path.join(privateDir, 'to-the-pair');
    fs.rmSync(exit, { force: true });
    fs.symlinkSync(tmp, exit, 'junction');

    try {
      for (const file of [second, copy]) {
        const { status, text } = await call('POST', `/api/vault/documents/${documentId}/attach`, {
          authorization: `Bearer ${sharedToken}`,
        }, { file_path: file });
        expect(status, `${file}: ${text}`).toBe(200);
      }
      expect(attachments()).toHaveLength(2);
    } finally {
      fs.rmSync(exit, { force: true });
    }
  });

  /**
   * The mutant the gate left alive (V2): copying the name the caller gave
   * instead of the file that was checked passes every test above, because a
   * name opens the same file at the check and at the copy unless it is changed
   * in between, which no test can time. So the copy's source is read instead:
   * a symlink is checked by what it opens, and that file, never the symlink,
   * is what gets copied.
   */
  it.skipIf(cannotSymlink())('copies the file it checked, not the name it was given', async () => {
    const checked = path.join(tmp, 'checked.txt');
    fs.writeFileSync(checked, 'the file that was checked');
    const alias = path.join(tmp, 'alias-of-checked.txt');
    fs.rmSync(alias, { force: true });
    fs.symlinkSync(checked, alias);
    // The CommonJS object, which a spy can replace, and every ESM view of it
    // brought up to date, the route's included.
    const cjsFs = createRequire(import.meta.url)('fs') as typeof fs;
    const copies = vi.spyOn(cjsFs, 'copyFileSync');
    syncBuiltinESMExports();

    try {
      const { status, text } = await call('POST', `/api/vault/documents/${documentId}/attach`, {
        authorization: `Bearer ${sharedToken}`,
      }, { file_path: alias });

      expect(status, text).toBe(200);
      expect(copies.mock.calls.map(call => String(call[0]))).toEqual([fs.realpathSync.native(checked)]);
    } finally {
      copies.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('still attaches an ordinary file, which the copy above would otherwise prove nothing about', async () => {
    const ordinary = path.join(tmp, 'report.txt');
    fs.writeFileSync(ordinary, 'an ordinary report');

    const { status, text } = await call('POST', `/api/vault/documents/${documentId}/attach`, {
      authorization: `Bearer ${sharedToken}`,
    }, { file_path: ordinary });

    expect(status, text).toBe(200);
    expect(attachments()).toHaveLength(1);
  });
});
