import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';

/**
 * What a Hermes call says when the gateway refuses it.
 *
 * The gateway is FastAPI, and it spells a validation error as
 * `{ detail: [{ msg, loc, ... }, ...] }`. The Kanban calls read that shape;
 * eight others turned the array into a string, so the Schedules page, the
 * model picker, a memory write and the Chat itself said
 * "[object Object],[object Object]" where the gateway had said what was wrong.
 * Found while recording the D2 contract of hermes-client. The Audit then found
 * a ninth, after #146: the Chat's effort picker (setReasoningEffort, in
 * hermes-session.ts) still stringified the detail. It is held to the same
 * list below, written before its fix.
 *
 * How this can fail, written before the fix:
 * 1. a validation error in FastAPI's shape reaches the page as "[object Object]", on any of the eight calls;
 * 2. a plain string detail loses its words, or gains the quotes JSON wraps it in (the model picker's call);
 * 3. a refusal with no detail at all loses the status it falls back to;
 * 4. the 200-character cap two of the calls put on the text is lost;
 * 5. whether the page offers to sign in changes.
 *
 * The client is the real one; the gateway is a recorder with canned refusals.
 */

const { TMP_DATA_DIR } = vi.hoisted(() => {
  const base = process.getBuiltinModule('node:os').tmpdir();
  return { TMP_DATA_DIR: process.getBuiltinModule('node:path').join(base, `tars-hermes-errors-${process.pid}-${Date.now()}`) };
});
vi.mock('../../../electron/constants', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../electron/constants')>()),
  DATA_DIR: TMP_DATA_DIR,
}));

type Refusal = 'validation' | 'long' | 'string' | 'bare';
let refusal: Refusal = 'validation';
const LONG_MSG = 'x'.repeat(300);

let server: http.Server;
let port = 0;

beforeAll(async () => {
  fs.mkdirSync(TMP_DATA_DIR, { recursive: true });
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      // An append reads the file first; that read has to get through for the
      // write to be the call that is refused.
      if (req.method === 'GET' && (req.url ?? '').startsWith('/api/files/read')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Not Found' }));
        return;
      }
      // The effort picker reads the config before it writes it back.
      if (req.method === 'GET' && req.url === '/api/config') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ agent: { reasoning_effort: 'medium' } }));
        return;
      }
      if (refusal === 'bare') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Internal Server Error');
        return;
      }
      const [status, body] = refusal === 'validation'
        ? [422, { detail: [{ loc: ['body', 'name'], msg: 'name is required' }, { loc: ['body', 'schedule'], msg: 'schedule is not a cron expression' }] }]
        : refusal === 'long'
          ? [422, { detail: [{ msg: LONG_MSG }] }]
          : [401, { detail: 'Not signed in' }];
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

beforeEach(() => { refusal = 'validation'; });

/** The calls that read `detail` themselves, each as the app makes it. */
async function calls() {
  const c = await import('../../../electron/services/hermes-client');
  const session = await import('../../../electron/services/hermes-session');
  const conn = { mode: 'local' as const, localPort: port, authMode: 'token' as const, token: 'tok' };
  return {
    signInHermes: () => c.signInHermes(conn, { username: 'demo', password: 'pw' }),
    fetchHermesCrons: () => c.fetchHermesCrons(conn),
    updateHermesCron: () => c.updateHermesCron(conn, 'j1', { schedule: 'soon' }),
    setHermesModel: () => c.setHermesModel(conn, { provider: 'anthropic', model: 'm' }),
    createHermesCron: () => c.createHermesCron(conn, { name: '', schedule: 'soon', prompt: 'p' }),
    uploadHermesAttachment: () => c.uploadHermesAttachment(conn, { name: 'a.txt', mimeType: 'text/plain', base64: 'aGk=', bytes: 2 }),
    appendHermesMemory: () => c.appendHermesMemory(conn, 'a note'),
    setHermesMemoryProvider: () => c.setHermesMemoryProvider(conn, 'holographic'),
    setReasoningEffort: () => session.setReasoningEffort(conn, 'high'),
  };
}

const errorOf = (result: unknown) => (result as { error?: string }).error;

describe('what a refused Hermes call says', () => {
  it('reads a FastAPI validation error, on every call that reads the detail itself', async () => {
    for (const [name, call] of Object.entries(await calls())) {
      expect(errorOf(await call()), name).toBe('name is required; schedule is not a cron expression');
    }
  });

  it('keeps a plain detail as the gateway wrote it, quotes included in nothing, and still offers to sign in', async () => {
    refusal = 'string';
    for (const [name, call] of Object.entries(await calls())) {
      const result = await call() as { error?: string; needsSignIn?: boolean };
      expect(result.error, name).toBe('Not signed in');
      // Sign-in and the effort picker report no sign-in flag at all.
      if (!['signInHermes', 'setReasoningEffort'].includes(name)) expect(result.needsSignIn, name).toBe(true);
    }
  });

  it('falls back to the status when the refusal carries no detail', async () => {
    refusal = 'bare';
    for (const [name, call] of Object.entries(await calls())) {
      expect(errorOf(await call()), name).toBe('HTTP 500');
    }
  });

  it('keeps the 200-character cap of the upload, the model picker and the effort picker', async () => {
    refusal = 'long';
    const c = await calls();
    expect(errorOf(await c.uploadHermesAttachment())).toBe(LONG_MSG.slice(0, 200));
    expect(errorOf(await c.setHermesModel())).toBe(LONG_MSG.slice(0, 200));
    expect(errorOf(await c.setReasoningEffort())).toBe(LONG_MSG.slice(0, 200));
  });
});
