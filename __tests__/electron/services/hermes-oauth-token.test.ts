import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';

/**
 * Under OAuth, a call to the gateway carries the session cookie and nothing else.
 *
 * The connection keeps `token` when Auth is switched from Token to OAuth: the
 * form only hides the field ("OAuth has no static token to reveal"), and the
 * saved file still holds it. The client sent `conn.token` as
 * X-Hermes-Session-Token on every call regardless of the auth mode, so a
 * gateway signed in by cookie also received the token typed for the other
 * mode, one the user can no longer see or clear. Hermes Desktop, whose
 * contract types/hermes.ts mirrors, drops the stored token in OAuth mode
 * (`route.authMode === 'oauth' ? null : ...` in its main.ts).
 *
 * How this can fail, written before the fix:
 * 1. a data call (the board, the schedules, memory) sends the token-mode token under OAuth;
 * 2. the status probe, or the session check it makes, sends it;
 * 3. the Chat's calls (the WebSocket ticket, the effort picker's config) send it;
 * 4. the fix overreaches: in token mode the token is no longer sent;
 * 5. the fix overreaches the other way: under OAuth the session cookie is no longer sent.
 *
 * The client is the real one; the gateway is a recorder that says what each
 * request carried.
 */

const { TMP_DATA_DIR } = vi.hoisted(() => {
  const base = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]$/, '');
  return { TMP_DATA_DIR: `${base}/tars-hermes-oauth-${process.pid}-${Date.now()}` };
});
vi.mock('../../../electron/constants', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../electron/constants')>()),
  DATA_DIR: TMP_DATA_DIR,
}));

const STALE_TOKEN = 'typed-in-token-mode';
const COOKIE = 'cookie-session-1';

interface Seen { path: string; token: string | null; cookie: string | null }
let seen: Seen[] = [];

let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  fs.mkdirSync(TMP_DATA_DIR, { recursive: true });
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = req.url ?? '';
      const token = req.headers['x-hermes-session-token'];
      seen.push({
        path: url.split('?')[0],
        token: typeof token === 'string' ? token : null,
        cookie: req.headers.cookie ?? null,
      });
      const json = (status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (url === '/auth/password-login') return json(200, {}, { 'set-cookie': [`hermes_session_at=${COOKIE}; Path=/; HttpOnly`] });
      if (url === '/api/status') return json(200, { version: '0.20.0', auth_required: true, auth_flows: ['cookie'] });
      if (url.startsWith('/api/cron/jobs')) return json(200, { jobs: [] });
      if (url.startsWith('/api/plugins/kanban/board')) return json(200, { columns: [] });
      if (url === '/api/config') return json(200, { agent: { reasoning_effort: 'medium' } });
      // Refused, so openConversation stops after the one request this reads.
      if (url === '/api/auth/ws-ticket') return json(403, { detail: 'no ticket here' });
      return json(404, { detail: 'Not Found' });
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>(done => server.close(() => done()));
  fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  seen = [];
  const c = await import('../../../electron/services/hermes-client');
  c.clearHermesSession(baseUrl);
});

const conn = (authMode: 'token' | 'oauth') => ({ mode: 'remote' as const, url: baseUrl, authMode, token: STALE_TOKEN });

/** Every call this file holds the client to, each as the app makes it. */
async function everyCall(authMode: 'token' | 'oauth') {
  const c = await import('../../../electron/services/hermes-client');
  const s = await import('../../../electron/services/hermes-session');
  const target = conn(authMode);
  await c.fetchHermesBoard(target);
  await c.fetchHermesCrons(target);
  await c.probeHermes(target);
  await s.getReasoningEffort(target);
  await s.openConversation(target).catch(() => { /* refused on purpose */ });
}

describe('the token of the other auth mode', () => {
  it('is sent on no call under OAuth (1, 2, 3)', async () => {
    const c = await import('../../../electron/services/hermes-client');
    // Signed in by cookie, as an OAuth gateway is.
    await c.signInHermes(conn('oauth'), { username: 'u', password: 'p' });
    seen = [];

    await everyCall('oauth');

    const paths = seen.map(r => r.path);
    // Each kind of call reached the gateway, so none passes by not being made.
    expect(paths).toEqual(expect.arrayContaining([
      '/api/plugins/kanban/board', '/api/cron/jobs', '/api/status', '/api/config', '/api/auth/ws-ticket',
    ]));
    expect(seen.filter(r => r.token !== null)).toEqual([]);
  });

  it('is still sent on every call in token mode (4)', async () => {
    await everyCall('token');

    expect(seen.length).toBeGreaterThanOrEqual(6);
    expect(seen.filter(r => r.token !== STALE_TOKEN)).toEqual([]);
  });

  it('leaves the session cookie on every call under OAuth (5)', async () => {
    const c = await import('../../../electron/services/hermes-client');
    await c.signInHermes(conn('oauth'), { username: 'u', password: 'p' });
    seen = [];

    await everyCall('oauth');

    expect(seen.length).toBeGreaterThanOrEqual(6);
    expect(seen.filter(r => !(r.cookie ?? '').includes(`hermes_session_at=${COOKIE}`))).toEqual([]);
  });
});
