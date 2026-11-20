import '../../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { makeUnreadable } from '../../../setup/file-access';

/**
 * /api/local-file answers a file it cannot read. It does not throw.
 *
 * The route streamed the file with nothing listening for the stream's
 * 'error', and a stream throws an 'error' nobody hears: in the main process,
 * the "Uncaught Exception" window, the same class as the ACP launch that
 * brought it up on 2026-09-18. Two ways in, both through the one route that
 * takes no token: the attachments folder itself, which the path guard lets
 * through (it reads EISDIR), and a file there that cannot be opened (EACCES).
 *
 * Served over a real socket, because what matters happens after the handler
 * has returned, in the stream it left behind.
 */

vi.mock('../../../../electron/services/vault-db', () => ({
  getVaultDb: () => { throw new Error('no database in this test'); },
  ftsSearch: vi.fn(),
}));

import { registerVaultRoutes } from '../../../../electron/services/api-routes/vault-routes';
import { VAULT_DIR } from '../../../../electron/constants';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';

const attachments = path.join(VAULT_DIR, 'attachments');

let server: http.Server;
let port: number;
const uncaught: Error[] = [];
const record = (err: Error) => { uncaught.push(err); };

beforeEach(async () => {
  expect(VAULT_DIR.startsWith(process.env.HOME!), 'the vault is not under the throwaway HOME').toBe(true);
  fs.mkdirSync(attachments, { recursive: true });
  uncaught.length = 0;
  process.on('uncaughtException', record);

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
  await new Promise(resolve => setTimeout(resolve, 250));
  process.off('uncaughtException', record);
  // A response left open would hold close() forever.
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  expect(uncaught.map(e => String(e)), 'an error reached the top of the process').toEqual([]);
});

/** GET the file; a response cut short comes back as `cut`, and one that never ends as `hung`. */
function get(file: string): Promise<{ status: number; body: string } | { cut: string } | { hung: string }> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ hung: 'no end to the response after 3 s' }), 3_000);
    const done = (value: { status: number; body: string } | { cut: string }) => { clearTimeout(timer); resolve(value); };
    const req = http.get({ host: '127.0.0.1', port, path: `/api/local-file?path=${encodeURIComponent(file)}` }, res => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => done({ status: res.statusCode ?? 0, body }));
      res.on('error', err => done({ cut: `${res.statusCode} then ${err.message}` }));
    });
    req.on('error', err => done({ cut: err.message }));
  });
}

describe('GET /api/local-file on something it cannot read', { timeout: 15_000 }, () => {
  it('serves a file it can read, byte for byte', async () => {
    const file = path.join(attachments, 'note.txt');
    fs.writeFileSync(file, 'hello from the vault');

    expect(await get(file)).toEqual({ status: 200, body: 'hello from the vault' });
  });

  it('answers 404 for the attachments folder itself', async () => {
    const answer = await get(attachments);
    await new Promise(resolve => setTimeout(resolve, 250));

    expect(uncaught.map(e => String(e)), 'reading the folder threw at the top of the process').toEqual([]);
    expect(answer).toMatchObject({ status: 404 });
  });

  it('answers an error for a file it may not open, rather than a 200 cut short', async () => {
    const file = path.join(attachments, 'locked.png');
    fs.writeFileSync(file, 'not for you');
    const readable = makeUnreadable(file, 0o600);
    try {
      const answer = await get(file);
      await new Promise(resolve => setTimeout(resolve, 250));

      expect(uncaught.map(e => String(e)), 'opening the file threw at the top of the process').toEqual([]);
      expect(answer).toMatchObject({ status: 500 });
    } finally {
      readable();
    }
  });
});
