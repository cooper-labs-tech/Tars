import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as net from 'node:net';
import * as http from 'node:http';

/**
 * A call to the Hermes gateway that never gets an answer is a refusal with its
 * reason, never a throw through IPC.
 *
 * The defect (found by the Frontend on 27/11): Schedules showed Electron's raw
 * "Error invoking remote method 'hermes:crons:list'". hermesRequest rejects on a
 * network failure (the request's 'error', Tars's own timeout, a URL it cannot
 * call), and viaGateway, in hermes-handlers.ts, handed the rejection to IPC as
 * it was, where every other refusal (not configured, unusable) answers
 * { success: false, error }.
 *
 * How it can fail, written before the fix (2026-11-27):
 * 1. A channel that reaches the gateway through viaGateway rejects through IPC
 *    when nothing listens at the gateway's address (ECONNREFUSED): the window
 *    shows Electron's words (Schedules), or nothing, the rejection unhandled (a
 *    Schedules action, a Kanban task action, the memory providers).
 * 2. The same when the gateway takes the connection and never answers: Tars's
 *    own timeout, 10 s.
 * 3. The same when what answers is not HTTP (an SSH server on a tunnel's port),
 *    or closes the connection without answering.
 * 4. The same when the saved gateway URL is not one Tars can call.
 * 5. The refusal that replaces the throw says nothing a user can act on: not
 *    which gateway, or not why.
 * 6. The refusal carries a secret: the URL's user name or password, its query
 *    string, or the dashboard token.
 * 7. The overseer's channels that reach the gateway (its model list, its
 *    reasoning effort read and written, a model chosen in its settings) reject
 *    the same way.
 * 8. A question to the overseer whose gateway answers its status and then stops
 *    answering mid-turn rejects through IPC, where a gateway that does not
 *    answer already has its reason: gateway_unreachable.
 * 9. The Kanban board's own read stops rejecting, or rejects with other words:
 *    HermesBoard.load reads that rejection and says which gateway went silent
 *    and how (describeHermesFailure), so its contract is kept as it is.
 * 10. A failure that is not the network's (a bug reading an answer) is passed
 *    off as "could not reach Hermes".
 * 11. A gateway that cuts the connection after its answer has begun (200 and
 *    its headers sent, then the socket destroyed, with a length or chunked)
 *    never settles: hermesRequest listened to the answer's data and end only,
 *    and its timeout cannot fire on a socket that is gone. The channel never
 *    answers, and an overseer question awaiting it holds the turn for good:
 *    every later question is "busy" until Tars restarts (the Audit's M1 on
 *    #660, measured on main too). Added after the fix of 1 to 10.
 * 12. A gateway that trickles its answer, a byte at a time, each one within the
 *    idle timeout, holds a call for good: hermesRequest's timeout is an idle
 *    one, and nothing bounds the whole request (the Audit's I-2 on #660). A
 *    whole-request deadline settles it, marked, in words, and leaves an answer
 *    that ends in time alone. Added after the fix of 1 to 11.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn); } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.6' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));
vi.mock('child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => cb(Object.assign(new Error('not installed'), { code: 'ENOENT' })),
}));

type Refusal = { success?: boolean; ok?: boolean; reason?: string; error?: string; settings?: unknown };
let writeHermesConnection: (conn: object) => void;

beforeAll(async () => {
  ({ writeHermesConnection } = await import('../../../electron/services/hermes-config') as never);
  (await import('../../../electron/handlers/hermes-handlers')).registerHermesHandlers();
  (await import('../../../electron/handlers/overseer-handlers')).registerOverseerHandlers();
}, 120_000);

const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args) as Promise<Refusal>;

/** The gateway the connection file names, in token mode with a token, as Settings saves it. */
function gatewayAt(url: string): void {
  writeHermesConnection({ mode: 'remote', url, authMode: 'token', token: 'tok-secret-123' });
}

/** A loopback port nothing listens on. */
async function refusingPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(open.splice(0).map(close => close())); });

/** A loopback server that does `onSocket` with each connection, closed after the test. */
async function standIn(onSocket: (socket: net.Socket) => void): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    onSocket(socket);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  open.push(() => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }));
  return (server.address() as net.AddressInfo).port;
}

/** The gateway's channels that go through viaGateway, with what a page sends them. The board is apart (9). */
const VIA_GATEWAY: Array<[string, ...unknown[]]> = [
  ['hermes:crons:list'],
  ['hermes:crons:action', { action: 'pause', jobId: 'j1' }],
  ['hermes:crons:update', { jobId: 'j1', updates: { name: 'n' } }],
  ['hermes:crons:delete', { jobId: 'j1' }],
  ['hermes:kanban:createTask', { title: 't' }],
  ['hermes:kanban:updateTask', { taskId: 't1', patch: { status: 'done' } }],
  ['hermes:kanban:getTask', { taskId: 't1' }],
  ['hermes:kanban:deleteTask', { taskId: 't1' }],
  ['hermes:kanban:addComment', { taskId: 't1', body: 'b' }],
  ['hermes:mcp:servers'],
  ['hermes:memory:providers'],
  ['hermes:memory:setProvider', { provider: 'holographic' }],
];

/** The overseer's channels that reach the gateway (7). */
const OVERSEER: Array<[string, ...unknown[]]> = [
  ['overseer:modelOptions'],
  ['overseer:effort'],
  ['overseer:setEffort', 'high'],
  ['overseer:setSettings', { provider: 'anthropic', model: 'claude-opus-5-5' }],
];

describe('nothing listens at the gateway address (1, 5, 7)', () => {
  for (const [channel, ...args] of [...VIA_GATEWAY, ...OVERSEER]) {
    it(`${channel} refuses, naming the gateway and the reason`, async () => {
      const port = await refusingPort();
      gatewayAt(`http://127.0.0.1:${port}`);

      const result = await call(channel, ...args);

      expect(result.success).toBe(false);
      expect(result.error).toBe(`Tars could not reach Hermes at http://127.0.0.1:${port}: connect ECONNREFUSED 127.0.0.1:${port}`);
    });
  }

  it('overseer:setSettings still answers the settings it stored, with the refusal', async () => {
    const port = await refusingPort();
    gatewayAt(`http://127.0.0.1:${port}`);

    const result = await call('overseer:setSettings', { provider: 'anthropic', model: 'claude-opus-5-5' });

    expect(result.settings).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
  });
});

describe('the gateway takes the connection and never answers (2)', () => {
  it('hermes:crons:list refuses after Tars\'s 10 s, and says so', async () => {
    const port = await standIn(() => { /* never answers */ });
    gatewayAt(`http://127.0.0.1:${port}`);

    const result = await call('hermes:crons:list');

    expect(result).toEqual({ success: false, error: `Tars could not reach Hermes at http://127.0.0.1:${port}: no answer within 10 s` });
  }, 20_000);
});

describe('what answers is not HTTP, or hangs up (3)', () => {
  for (const [channel, ...args] of VIA_GATEWAY) {
    it(`${channel} refuses an SSH server on the gateway port as an answer that is not HTTP`, async () => {
      const port = await standIn(socket => socket.end('SSH-2.0-OpenSSH_9.6\r\n'));
      gatewayAt(`http://127.0.0.1:${port}`);

      const result = await call(channel, ...args);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(new RegExp(`^Tars could not reach Hermes at http://127\\.0\\.0\\.1:${port}: its answer is not HTTP \\(.+\\)$`));
    });
  }

  it('hermes:crons:list refuses a gateway that closes the connection without answering', async () => {
    const port = await standIn(socket => socket.destroy());
    gatewayAt(`http://127.0.0.1:${port}`);

    const result = await call('hermes:crons:list');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(new RegExp(`^Tars could not reach Hermes at http://127\\.0\\.0\\.1:${port}: \\S`));
  });
});

describe('a saved gateway URL Tars cannot call (4, 6)', () => {
  it('refuses without quoting what was saved', async () => {
    gatewayAt('hermes box tok-secret-123');

    const result = await call('hermes:crons:list');

    expect(result).toEqual({ success: false, error: 'Tars could not reach Hermes: the gateway URL saved in Settings, Hermes is not one it can call.' });
  });
});

describe('no secret in the refusal (6)', () => {
  it('names the gateway without its user name, password or query, and never the token', async () => {
    const port = await refusingPort();
    gatewayAt(`http://jean:pw-secret@127.0.0.1:${port}/gw?key=q-secret`);

    const result = await call('hermes:crons:list');

    expect(result.error).toBe(`Tars could not reach Hermes at http://127.0.0.1:${port}/gw: connect ECONNREFUSED 127.0.0.1:${port}`);
    for (const secret of ['jean', 'pw-secret', 'q-secret', 'tok-secret-123']) expect(result.error).not.toContain(secret);
  });
});

describe('a question to the overseer when the gateway stops answering mid-turn (8)', () => {
  it('answers gateway_unreachable with the reason, never a throw', async () => {
    // Its public status answers, so the probe passes; every other request is cut.
    const server = http.createServer((req, res) => {
      if (req.url === '/api/status') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ version: '0.23.4', auth_required: false }));
        return;
      }
      req.socket.destroy();
    });
    server.on('upgrade', (_req, socket) => socket.destroy());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    open.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const { port } = server.address() as net.AddressInfo;
    gatewayAt(`http://127.0.0.1:${port}`);

    const result = await call('overseer:send', 'How is the fleet?');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('gateway_unreachable');
    expect(result.error).toMatch(new RegExp(`^Tars could not reach Hermes at http://127\\.0\\.0\\.1:${port}: \\S`));
  }, 30_000);
});

/** The answer, or 'still waiting' once `ms` have passed without one. */
function within<T>(answer: Promise<T>, ms: number): Promise<T | 'still waiting'> {
  return Promise.race([answer, new Promise<'still waiting'>(resolve => setTimeout(() => resolve('still waiting'), ms))]);
}

/**
 * A gateway that begins its answer, 200, its headers and 9 bytes, then cuts the
 * connection: with a Content-Length, or chunked. `status` keeps /api/status
 * whole, so the overseer's probe passes and its turn goes on.
 */
async function cutsMidAnswer(framing: 'length' | 'chunked', status = false): Promise<number> {
  const server = http.createServer((req, res) => {
    if (status && req.url === '/api/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ version: '0.23.4', auth_required: false }));
      return;
    }
    res.writeHead(200, framing === 'length' ? { 'Content-Type': 'application/json', 'Content-Length': '100' } : { 'Content-Type': 'application/json' });
    res.write('{"jobs":[', () => setTimeout(() => req.socket.destroy(), 20));
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  open.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return (server.address() as net.AddressInfo).port;
}

describe('a gateway that cuts its answer off once it has begun (11)', () => {
  for (const framing of ['length', 'chunked'] as const) {
    it(`hermes:crons:list refuses, with a ${framing === 'length' ? 'Content-Length' : 'chunked'} answer`, async () => {
      const port = await cutsMidAnswer(framing);
      gatewayAt(`http://127.0.0.1:${port}`);

      const answer = await within(call('hermes:crons:list'), 5_000);

      expect(answer).toEqual({ success: false, error: `Tars could not reach Hermes at http://127.0.0.1:${port}: its answer was cut off before the end` });
    }, 10_000);
  }

  it('an overseer question answers gateway_unreachable, and the next one is not "busy"', async () => {
    const port = await cutsMidAnswer('length', true);
    gatewayAt(`http://127.0.0.1:${port}`);

    const first = await within(call('overseer:send', 'How is the fleet?'), 10_000);
    const second = await within(call('overseer:send', 'And now?'), 10_000);

    for (const answer of [first, second]) {
      expect(answer).toMatchObject({ ok: false, reason: 'gateway_unreachable' });
      expect((answer as Refusal).error).toMatch(new RegExp(`^Tars could not reach Hermes at http://127\\.0\\.0\\.1:${port}: \\S`));
    }
  }, 30_000);
});

/** A gateway that answers 200 and then one byte every `everyMs`, of a body of `length`; ends it once all are sent. */
async function trickles(everyMs: number, length = 1000): Promise<number> {
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(length) });
    let sent = 0;
    const timer = setInterval(() => {
      if (res.destroyed) { clearInterval(timer); return; }
      sent += 1;
      if (sent < length) res.write(' ');
      else { clearInterval(timer); res.end(' '); }
    }, everyMs);
    timers.add(timer);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  open.push(() => new Promise<void>(resolve => { for (const t of timers) clearInterval(t); server.closeAllConnections(); server.close(() => resolve()); }));
  return (server.address() as net.AddressInfo).port;
}

describe('a gateway that trickles its answer, each byte within the idle timeout (12)', () => {
  it('hermes:crons:list refuses at its 30 s deadline, and says so', async () => {
    const port = await trickles(2_000);
    gatewayAt(`http://127.0.0.1:${port}`);

    const answer = await within(call('hermes:crons:list'), 40_000);

    expect(answer).toEqual({ success: false, error: `Tars could not reach Hermes at http://127.0.0.1:${port}: its answer did not end within 30 s` });
  }, 50_000);

  it('a request given a deadline is settled at it, marked, in words', async () => {
    const { hermesRequest, noAnswerSentence } = await import('../../../electron/services/hermes-client');
    const port = await trickles(300);

    const settled = await within(hermesRequest(`http://127.0.0.1:${port}`, '/api/cron/jobs', { timeoutMs: 1_000, deadlineMs: 2_000 } as never).then(() => 'resolved', err => err), 5_000);

    expect(noAnswerSentence(settled)).toBe(`Tars could not reach Hermes at http://127.0.0.1:${port}: its answer did not end within 2 s`);
  }, 10_000);

  it('an answer that is slow but ends before its deadline is read', async () => {
    const { hermesRequest } = await import('../../../electron/services/hermes-client');
    const port = await trickles(100, 5);

    await expect(hermesRequest(`http://127.0.0.1:${port}`, '/api/cron/jobs', { timeoutMs: 1_000, deadlineMs: 2_000 } as never)).resolves.toMatchObject({ status: 200 });
  }, 10_000);
});

describe('the Kanban board keeps its contract (9)', () => {
  it('still rejects, with the transport\'s own words, which HermesBoard reads', async () => {
    const port = await refusingPort();
    gatewayAt(`http://127.0.0.1:${port}`);

    await expect(call('hermes:kanban:board')).rejects.toThrow(new RegExp(`^connect ECONNREFUSED 127\\.0\\.0\\.1:${port}$`));
  });
});

describe('only a call that got no answer is a refusal (10)', () => {
  it('a failure that is not the network\'s still throws', async () => {
    const { reachingHermes } = await import('../../../electron/services/hermes-client') as { reachingHermes?: (call: () => Promise<unknown>) => Promise<unknown> };
    expect(typeof reachingHermes).toBe('function');

    await expect(reachingHermes!(() => Promise.reject(new TypeError('Cannot read properties of null (reading \'name\')'))))
      .rejects.toThrow(TypeError);
  });
});
