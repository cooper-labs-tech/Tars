import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The contract of hermes-client, recorded before the refactor (group D2) and
 * held byte for byte after it: for every exported call, what it sends to the
 * gateway (method, path, the headers that carry meaning, body) and what it
 * returns, when the gateway answers 200, 401, 403, 404 and 500. The client is
 * the real one; the gateway is a recorder with canned answers.
 */

const { TMP_DATA_DIR } = vi.hoisted(() => {
  const base = process.getBuiltinModule('node:os').tmpdir();
  return { TMP_DATA_DIR: process.getBuiltinModule('node:path').join(base, `tars-d2-hermes-contract-${process.pid}-${Date.now()}`) };
});
vi.mock('../../../../electron/constants', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../electron/constants')>()),
  DATA_DIR: TMP_DATA_DIR,
}));

type Mode = 'ok' | 'auth' | 'forbidden' | 'missing' | 'fail';
let mode: Mode = 'ok';
const requests: Array<Record<string, unknown>> = [];

/** A body per path for the 200 case, shaped like the gateway's own. */
function okBody(url: string): unknown {
  if (url.startsWith('/api/status')) return { version: '0.9.0', auth_required: false };
  if (url.includes('/kanban/board')) return { columns: [{ name: 'todo', tasks: [{ id: 't1', title: 'first' }] }] };
  if (url.includes('/kanban/tasks/') && url.endsWith('/comments')) return { ok: true };
  if (url.includes('/kanban/tasks')) return { id: 't1', title: 'first', status: 'todo' };
  if (url.includes('/runs')) return { runs: [{ id: 'cron_j1_20260923_120000', status: 'ok', started_at: '2026-09-23T12:00:00Z' }] };
  if (url.includes('/cron')) return { jobs: [{ id: 'j1', name: 'Overseer', schedule: '0 * * * *', profile: 'default' }] };
  if (url.includes('/model')) return { provider: 'anthropic', model: 'claude-opus-5-5', providers: [{ slug: 'anthropic', name: 'Anthropic', models: ['claude-opus-5-5'], is_current: true }] };
  if (url.includes('/messages')) return { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] };
  if (url.includes('/memory/providers')) return { active: 'builtin', providers: [{ name: 'builtin', label: 'Built-in' }], builtin_bytes: 12 };
  if (url.includes('/memory')) return { files: [{ name: 'MEMORY.md', content: 'data:text/plain;base64,aGVsbG8=' }], ok: true, path: 'memory/MEMORY.md' };
  if (url.includes('/mcp')) return { servers: [{ name: 'tars', status: 'connected', tools: 3 }] };
  if (url.includes('/sessions/search') || url.includes('search')) return { results: [{ session_id: 's1', snippet: 'match', title: 'A session' }] };
  if (url.includes('/upload') || url.includes('attachment')) return { path: '/uploads/a.txt' };
  return { ok: true };
}

let server: http.Server;
let port = 0;

beforeAll(async () => {
  fs.mkdirSync(TMP_DATA_DIR, { recursive: true });
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const type = String(req.headers['content-type'] ?? '');
      const boundary = type.match(/boundary=(.+)$/)?.[1];
      requests.push({
        mode,
        method: req.method,
        url: req.url,
        contentType: boundary ? type.replace(boundary, '<boundary>') : type,
        token: req.headers['x-hermes-session-token'] ?? null,
        authorization: req.headers.authorization ?? null,
        cookie: req.headers.cookie ?? null,
        body: boundary ? raw.split(boundary).join('<boundary>') : raw,
      });
      // 403 is a sign-in failure too, and 404 answers in plain text with no
      // `detail` at all: the two shapes that decide the fallbacks.
      if (mode === 'missing') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      const [status, body] = mode === 'ok' ? [200, okBody(req.url ?? '')]
        : mode === 'auth' ? [401, { detail: 'Not signed in' }]
          : mode === 'forbidden' ? [403, { detail: 'Forbidden' }]
            : [500, { detail: [{ msg: 'boom' }, { msg: 'again' }] }];
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>(done => server.close(() => done()));
  fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
});

describe('hermes-client, as recorded before the D2 refactor', () => {
  it('exports the same names', async () => {
    const client = await import('../../../../electron/services/hermes-client');
    expect(Object.keys(client).sort()).toMatchSnapshot();
  });

  it('sends and returns the same thing for every call, in every answer the gateway can give', async () => {
    const c = await import('../../../../electron/services/hermes-client');
    const conn = { mode: 'local' as const, localPort: port, authMode: 'token' as const, token: 'tok' };
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['probeHermes', () => c.probeHermes(conn)],
      ['signInHermes', () => c.signInHermes(conn, { username: 'demo', password: 'pw' })],
      ['fetchHermesBoard', () => c.fetchHermesBoard(conn)],
      ['fetchHermesBoard board', () => c.fetchHermesBoard(conn, 'b 1')],
      // Added when main was merged in (#171 gave the board a tenant), recorded on main's own client first.
      ['fetchHermesBoard tenant', () => c.fetchHermesBoard(conn, 'b 1', '/Users/you/my project')],
      ['getHermesTask', () => c.getHermesTask(conn, 't 1')],
      ['createHermesTask', () => c.createHermesTask(conn, { title: 'x', column: 'todo' })],
      ['updateHermesTask', () => c.updateHermesTask(conn, 't1', { status: 'done' })],
      ['deleteHermesTask', () => c.deleteHermesTask(conn, 't1')],
      ['addHermesTaskComment', () => c.addHermesTaskComment(conn, 't1', 'hello')],
      ['fetchHermesCrons', () => c.fetchHermesCrons(conn)],
      ['hermesCronAction pause', () => c.hermesCronAction(conn, 'pause', 'j1')],
      ['hermesCronAction trigger profile', () => c.hermesCronAction(conn, 'trigger', 'j1', 'prof')],
      ['updateHermesCron', () => c.updateHermesCron(conn, 'j1', { prompt: 'p' }, 'prof')],
      ['deleteHermesCron', () => c.deleteHermesCron(conn, 'j1')],
      ['deleteHermesCron profile', () => c.deleteHermesCron(conn, 'j1', 'prof')],
      ['fetchHermesModelOptions', () => c.fetchHermesModelOptions(conn)],
      ['setHermesModel', () => c.setHermesModel(conn, { provider: 'anthropic', model: 'claude-opus-5-5' })],
      ['createHermesCron', () => c.createHermesCron(conn, { name: 'n', schedule: '0 * * * *', prompt: 'p', model: 'm', provider: 'pr' })],
      ['uploadHermesAttachment', () => c.uploadHermesAttachment(conn, { name: 'a b.txt', mimeType: 'text/plain', base64: 'aGVsbG8=', bytes: 5 })],
      ['fetchHermesCronRuns', () => c.fetchHermesCronRuns(conn, 'j1', { limit: 3, profile: 'prof' })],
      ['fetchHermesSessionMessages', () => c.fetchHermesSessionMessages(conn, 's 1')],
      ['fetchHermesMemoryFiles', () => c.fetchHermesMemoryFiles(conn)],
      ['appendHermesMemory', () => c.appendHermesMemory(conn, 'a note')],
      ['appendHermesMemory empty', () => c.appendHermesMemory(conn, '   ')],
      ['fetchHermesMcpServers', () => c.fetchHermesMcpServers(conn)],
      ['fetchHermesMemoryProviders', () => c.fetchHermesMemoryProviders(conn)],
      ['setHermesMemoryProvider', () => c.setHermesMemoryProvider(conn, 'honcho')],
      ['searchHermesSessions', () => c.searchHermesSessions(conn, 'what', 5)],
      ['fetchHermesMemoryState', () => c.fetchHermesMemoryState(conn)],
      ['hermesRequest', () => c.hermesRequest(`http://127.0.0.1:${port}`, '/x?y=1', { method: 'POST', body: { a: 1 }, token: 'tok' })],
    ];
    const results: Record<string, unknown> = {};
    for (const m of ['ok', 'auth', 'forbidden', 'missing', 'fail'] as Mode[]) {
      mode = m;
      for (const [name, call] of calls) {
        const at = requests.length;
        let result: unknown;
        try { result = await call(); } catch (err) { result = { threw: String(err) }; }
        // The port is the recorder's, different on every run.
        const text = JSON.stringify({ result, sent: requests.slice(at) }).split(String(port)).join('<port>');
        results[`${m} ${name}`] = JSON.parse(text);
      }
    }
    expect(results).toMatchSnapshot();
  });
});
