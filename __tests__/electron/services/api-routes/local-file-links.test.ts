import '../../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * /api/local-file serves only what really lies in the vault's attachments
 * (security, every platform).
 *
 * The one route besides /api/health that takes no token: any process on this
 * machine that can reach the loopback can call it, another account's
 * included. It compared the SPELLED path with ~/.tars/vault/attachments,
 * then streamed whatever that path led to. Every agent can write under
 * ~/.tars, so one symlink in the attachments folder served the home,
 * ~/.ssh or ~/.tars-private to anyone who asked, with no token, and a hard
 * link served the file it names.
 *
 * How it can fail, written before the fix (2026-09-28):
 * 1. A folder link in the attachments folder to the home serves a file of the
 *    home.
 * 2. A folder link there to ~/.ssh or to ~/.tars-private serves a key or a
 *    secret.
 * 3. A real attachment is no longer served: the vault's previews break.
 * 4. The dotfiles exception of the renderer's file channels (one file link to
 *    a markdown file) applies here too: a link planted in the attachments
 *    serves any note in the home. It must not: this route serves nothing but
 *    copies the vault made.
 * 5. A hard link in the attachments to a file outside is served: a hard link
 *    has no path back to the file it names, so no path check sees it
 *    (SECURITY.md §5). An attachment is a copy (vault_attach_file), its file's
 *    only name, so a file there with another name is refused.
 *
 * Folder links are junctions where the type is read (Windows, no privilege
 * needed) and symlinks elsewhere; 4 needs a FILE symlink, which Windows gives
 * only in Developer Mode or to an administrator, and is skipped, saying so,
 * where it is refused. Hard links need no privilege anywhere.
 */

vi.mock('../../../../electron/services/vault-db', () => ({
  getVaultDb: () => { throw new Error('no database in this test'); },
  ftsSearch: vi.fn(),
}));

import { registerVaultRoutes } from '../../../../electron/services/api-routes/vault-routes';
import { VAULT_DIR, PRIVATE_DIR } from '../../../../electron/constants';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';

const home = os.homedir();
const attachments = path.join(VAULT_DIR, 'attachments');
const ssh = path.join(home, '.ssh');
const linkDir = (to: string, at: string) => { if (!fs.existsSync(at)) fs.symlinkSync(to, at, 'junction'); };

/** Why a file symlink cannot be made here, or undefined when it can. */
function fileLinksRefused(): string | undefined {
  fs.mkdirSync(attachments, { recursive: true });
  const probe = path.join(attachments, 'probe-link');
  try {
    fs.symlinkSync(path.join(attachments, 'probe-target'), probe, 'file');
    fs.unlinkSync(probe);
    return undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM') throw err;
    return `skipped: file symlinks are refused here (${code}), which Windows does without Developer Mode; they run on macOS, Linux and a Windows runner that has the privilege`;
  }
}
const NO_FILE_LINKS = fileLinksRefused();
if (NO_FILE_LINKS) console.warn(`local-file-links.test.ts: ${NO_FILE_LINKS}`);

let server: http.Server;
let port: number;

beforeEach(async () => {
  expect(VAULT_DIR.startsWith(home), 'the vault is not under the throwaway home').toBe(true);
  fs.mkdirSync(attachments, { recursive: true });
  fs.mkdirSync(ssh, { recursive: true });
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(ssh, 'id_ed25519'), 'the key');
  fs.writeFileSync(path.join(PRIVATE_DIR, 'hermes-webhook-secret'), 'the secret');
  fs.writeFileSync(path.join(home, '.bashrc'), 'the profile');
  fs.writeFileSync(path.join(attachments, 'photo.png'), 'a real attachment');
  linkDir(home, path.join(attachments, 'h'));
  linkDir(ssh, path.join(attachments, 's'));
  linkDir(PRIVATE_DIR, path.join(attachments, 'p'));

  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  registerVaultRoutes(app, {} as RouteContext);
  const route = app.routes.find(r => r.method === 'GET' && r.pattern === '/api/local-file')!;
  // What api-server.ts does around a handler, and nothing more.
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const sendJson = (data: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const routeReq = { method: 'GET', pathname: url.pathname, url, body: {}, raw: req, res, params: {} } as unknown as RouteRequest;
    void route.handler(routeReq, sendJson, {} as RouteContext);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

function get(file: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/api/local-file?path=${encodeURIComponent(file)}` }, res => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

describe('/api/local-file and folder links in the attachments', () => {
  it('1. refuses a file of the home through a link to the home', async () => {
    const out = await get(path.join(attachments, 'h', '.bashrc'));
    expect(out.status).toBe(403);
    expect(out.body).not.toContain('the profile');
  });

  it('2. refuses a key through a link to ~/.ssh, and a secret through a link to ~/.tars-private', async () => {
    for (const file of [path.join(attachments, 's', 'id_ed25519'), path.join(attachments, 'h', '.ssh', 'id_ed25519'), path.join(attachments, 'p', 'hermes-webhook-secret')]) {
      const out = await get(file);
      expect(out.status, file).toBe(403);
      expect(out.body, file).not.toMatch(/the key|the secret/);
    }
  });

  it('3. still serves a real attachment', async () => {
    expect(await get(path.join(attachments, 'photo.png'))).toEqual({ status: 200, body: 'a real attachment' });
  });
});

describe('/api/local-file and other names for a file outside', () => {
  const notes = path.join(home, 'notes');
  const aws = path.join(home, '.aws');
  const hardLink = (to: string, at: string) => { if (!fs.existsSync(at)) fs.linkSync(to, at); };

  it.skipIf(NO_FILE_LINKS)('4. refuses a file link to a markdown file outside: no dotfiles exception here', async () => {
    fs.mkdirSync(notes, { recursive: true });
    fs.writeFileSync(path.join(notes, 'journal.md'), 'the journal');
    const at = path.join(attachments, 'journal.md');
    if (!fs.existsSync(at)) fs.symlinkSync(path.join(notes, 'journal.md'), at, 'file');
    const out = await get(at);
    expect(out.status).toBe(403);
    expect(out.body).not.toContain('the journal');
  });

  it('5. refuses a hard link to a file outside, whatever it is, and serves a copy', async () => {
    fs.mkdirSync(notes, { recursive: true });
    fs.mkdirSync(aws, { recursive: true });
    fs.writeFileSync(path.join(notes, 'journal.md'), 'the journal');
    fs.writeFileSync(path.join(aws, 'credentials'), 'the aws key');
    hardLink(path.join(ssh, 'id_ed25519'), path.join(attachments, 'key.png'));
    hardLink(path.join(aws, 'credentials'), path.join(attachments, 'aws.png'));
    hardLink(path.join(notes, 'journal.md'), path.join(attachments, 'journal-hard.md'));
    for (const name of ['key.png', 'aws.png', 'journal-hard.md']) {
      const out = await get(path.join(attachments, name));
      expect(out.status, name).toBe(403);
      expect(out.body, name).not.toMatch(/the key|the aws key|the journal/);
    }
    // A copy, as vault_attach_file makes, is still served.
    fs.copyFileSync(path.join(notes, 'journal.md'), path.join(attachments, 'copied.md'));
    expect(await get(path.join(attachments, 'copied.md'))).toEqual({ status: 200, body: 'the journal' });
  });
});
