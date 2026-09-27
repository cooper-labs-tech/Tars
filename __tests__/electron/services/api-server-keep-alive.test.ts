import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The local API and the connections it keeps alive between two requests.
 *
 * Node's server says `Keep-Alive: timeout=5` and closes an idle connection a
 * second after that. A client closes its own end before, on a timer, but only
 * if its event loop gets to run that timer. A local client (an MCP server, a
 * hook, a test) held by a synchronous call or a starved machine comes back
 * after the server has closed, has not read the close yet, and writes its next
 * request onto the dead connection: the server's system answers with a reset,
 * and the caller gets `fetch failed` / ECONNRESET for a request the server
 * never saw. Measured on 2026-09-26 while porting Tars to Windows, in an ACP
 * delegation E2E spec whose client runs a synchronous child process: 8 resets
 * in 30 run-task POSTs whose client was held 3.5 to 7 s, each on a connection
 * the server had destroyed in socketOnTimeout at 6.0 s of idleness.
 *
 * Every way this can fail:
 *  1. The server closes an idle kept-alive connection within seconds, so a
 *     client held past its own keep-alive timer reuses a closed connection and
 *     its next request is reset (the defect).
 *  2. The hold is lengthened by raising the timeout the server advertises:
 *     clients then keep their connections as long, and the same race moves to
 *     the new boundary. What the server says must stay `timeout=5`.
 *  3. A longer hold keeps the quit waiting on idle connections: stopping the
 *     server must still end an idle connection at once.
 *
 * Raw sockets on purpose: they have no idle timer of their own, which is
 * exactly the client whose timer did not run, and they reuse one connection
 * deterministically where fetch's pool picks among several.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-api-keepalive-'));
let port = 0;

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

beforeAll(async () => {
  port = await freePort();
});

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return { ...actual, get API_PORT() { return port; }, API_TOKEN_FILE: path.join(tmp, 'api-token') };
});

let api: typeof import('../../../electron/services/api-server');

/**
 * The server listening on a free port. The port picked in beforeAll was free
 * then, and only then: vitest's other workers bind random ports of their own,
 * and one can take it before a test binds it again. The server then retries the
 * same port on its own schedule, so a port taken meanwhile is dropped here for
 * another one, three picks at most.
 */
async function start(): Promise<void> {
  for (let pick = 1; ; pick++) {
    const phase = await bind();
    if (phase === 'listening') return;
    api.stopApiServer();
    if (pick === 3) throw new Error(`never listened, ${pick} ports picked: ${phase}`);
    port = await freePort();
  }
}

/** Starts the server on `port`: 'listening', or what it came to instead ('retrying' once the port is taken). */
function bind(): Promise<string> {
  api.startApiServer(
    null,
    { notificationsEnabled: false } as never,
    () => null,
    () => null,
    null,
    null,
    () => {},
    () => {},
    async () => 'pty',
    () => ({ notificationsEnabled: false } as never),
  );
  return new Promise((resolve) => {
    const settle = (phase: string) => {
      clearTimeout(timer);
      api.apiServerEmitter.off('state', check);
      resolve(phase);
    };
    const timer = setTimeout(() => settle(api.getApiServerState().phase), 3000);
    const check = () => {
      const { phase } = api.getApiServerState();
      if (phase === 'listening' || phase === 'retrying' || phase === 'failed') settle(phase);
    };
    api.apiServerEmitter.on('state', check);
    check();
  });
}

/** One connection, kept alive, whose requests and closing are all observed. */
class Connection {
  readonly socket: net.Socket;
  private received = '';
  private waiter: (() => void) | null = null;
  closedAt: number | null = null;
  error: NodeJS.ErrnoException | null = null;

  constructor() {
    this.socket = net.connect(port, '127.0.0.1');
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => { this.received += chunk; this.waiter?.(); });
    this.socket.on('error', (err) => { this.error = err; this.waiter?.(); });
    this.socket.on('close', () => { this.closedAt ??= Date.now(); this.waiter?.(); });
  }

  /** GET /api/health on this connection: its status line and headers, or what ended the connection instead. */
  request(): Promise<{ head: string } | { failed: string }> {
    this.received = '';
    this.socket.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
    return new Promise((resolve) => {
      const settle = () => {
        const end = this.received.indexOf('\r\n\r\n');
        if (end !== -1 && this.received.includes('{"ok":true}')) {
          this.waiter = null;
          resolve({ head: this.received.slice(0, end) });
        } else if (this.error || this.closedAt !== null) {
          this.waiter = null;
          resolve({ failed: this.error?.code ?? 'closed by the server' });
        }
      };
      this.waiter = settle;
      settle();
    });
  }
}

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

// The first import compiles the API server's whole module graph: 14 s on a
// loaded machine, past vitest's 10 s for a hook. Three port picks fit too.
beforeEach(async () => {
  vi.resetModules();
  api = await import('../../../electron/services/api-server');
  await start();
}, 60_000);

afterEach(() => {
  api?.stopApiServer();
});

describe('a connection the local API kept alive', () => {
  it('still answers a client that comes back to it after its own keep-alive ran out', async () => {
    const conn = new Connection();
    const first = await conn.request();
    expect(first).toHaveProperty('head');

    // Past the 5 s the server advertises and the second Node adds to it: the
    // client that was held, and did not get to close its end in time.
    await pause(7_500);
    const second = await conn.request();

    expect(conn.closedAt, 'the server closed the idle connection').toBeNull();
    expect(second, 'the reused connection was reset').toHaveProperty('head');
    expect((second as { head: string }).head).toMatch(/^HTTP\/1\.1 200 /);
    conn.socket.destroy();
  }, 20_000);

  it('still tells clients to let it go after five seconds', async () => {
    const conn = new Connection();
    const first = await conn.request();
    expect((first as { head: string }).head).toMatch(/\r\nKeep-Alive: timeout=5\r\n/i);
    conn.socket.destroy();
  });

  it('is ended at once when the server stops, however long it may be held', async () => {
    const conn = new Connection();
    expect(await conn.request()).toHaveProperty('head');
    const stoppedAt = Date.now();
    api.stopApiServer();
    for (let waited = 0; conn.closedAt === null && waited < 2_000; waited += 20) await pause(20);
    expect(conn.closedAt, 'the idle connection outlived the server').not.toBeNull();
    expect(conn.closedAt! - stoppedAt).toBeLessThan(1_000);
  });
});
