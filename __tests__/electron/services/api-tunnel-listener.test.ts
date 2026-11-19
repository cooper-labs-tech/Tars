import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/**
 * The local API's second listener, the one a remote agent's tunnel reaches (2.0.7, services/api-tunnel.ts), and the
 * API's own port, after the Audit's re-audit of #600 at 3b3748587. Written before the fixes.
 *
 * How it fails:
 * 1. (L5) A request target that does not parse as a URL ("//", "//[", "/\", "//:99999") throws in the tunnel's gate,
 *    before any token is read: an uncaught exception any user of the host triggers with one curl, the request left
 *    unanswered and its socket held. It must be answered 400, and the connection closed.
 * 2. (L5) The same target on the API's own port rejects the request handler's promise: unanswered, unhandled. 400 too.
 * 3. (I-g) One agent's token holds more of the listener's sockets than its CLI ever needs: a flood from the host, each
 *    connection a socket of this Tars's main process. Past TUNNEL_SOCKETS_PER_AGENT, a new connection under that token
 *    is answered 429 and closed; another agent keeps its own room; a socket closed gives its place back.
 * 4. (I-g) A connection with no token is kept open after its 401, for the next request of a flood.
 * 5. (I-g) Connections that send nothing pile up: past TUNNEL_MAX_CONNECTIONS the listener takes no more.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-api-tunnel-'));
let apiPort = 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return { ...actual, get API_PORT() { return apiPort; }, API_TOKEN_FILE: path.join(tmp, 'api-token') };
});

let api: typeof import('../../../electron/services/api-server');
let tunnel: typeof import('../../../electron/services/api-tunnel');
let tunnelPort = 0;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  apiPort = await freePort();
  api = await import('../../../electron/services/api-server');
  tunnel = await import('../../../electron/services/api-tunnel');
  const { agents } = await import('../../../electron/core/agent-manager');
  const { mintAgentToken } = await import('../../../electron/core/agent-tokens');
  for (const id of ['r1', 'r2']) {
    agents.set(id, { id, name: id, status: 'idle', provider: 'claude', projectPath: '/p', skills: [], remote: { hostId: 'h', folder: '/w/p' } } as never);
    tokens[id] = mintAgentToken(id);
  }
  api.startApiServer(null, {} as never, () => null, null, null, () => {}, () => {}, async () => 'pty', () => ({} as never));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the API never listened')), 20_000);
    const check = () => {
      if (api.getApiServerState().phase === 'listening') { clearTimeout(timer); api.apiServerEmitter.off('state', check); resolve(); }
    };
    api.apiServerEmitter.on('state', check);
    check();
  });
  tunnelPort = await tunnel.tunnelListenerPort();
}, 60_000);

afterAll(() => {
  api.stopApiServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A raw connection, so the request target goes as written. */
function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
}

/** The status line's code of the answer to `request`, or undefined after 5 s. */
function ask(socket: net.Socket, request: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    let got = '';
    const timer = setTimeout(() => { socket.off('data', onData); resolve(undefined); }, 5_000);
    const onData = (d: Buffer) => {
      got += String(d);
      const m = /^HTTP\/1\.1 (\d{3})/.exec(got);
      if (m) { clearTimeout(timer); socket.off('data', onData); resolve(Number(m[1])); }
    };
    socket.on('data', onData);
    socket.write(request);
  });
}

/** Whether the other side closes `socket` within `ms`. */
function closedWithin(socket: net.Socket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.destroyed || socket.readableEnded) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    socket.once('close', () => { clearTimeout(timer); resolve(true); });
    socket.once('end', () => { clearTimeout(timer); resolve(true); });
    socket.resume();
  });
}

const get = (target: string, token?: string) =>
  `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n${token ? `Authorization: Bearer ${token}\r\n` : ''}\r\n`;
const BAD_TARGETS = ['//', '//[', '/\\', '//:99999'];

describe('a request target that does not parse', () => {
  it('1. the tunnel listener answers 400 and closes, with no token, nothing thrown', async () => {
    for (const target of BAD_TARGETS) {
      const s = await connect(tunnelPort);
      expect(await ask(s, get(target)), target).toBe(400);
      expect(await closedWithin(s, 2_000), target).toBe(true);
      s.destroy();
    }
  }, 60_000);

  it("2. the API's own port answers 400 as well", async () => {
    for (const target of BAD_TARGETS) {
      const s = await connect(apiPort);
      expect(await ask(s, get(target)), target).toBe(400);
      s.destroy();
    }
  }, 60_000);
});

describe("the tunnel listener's room", () => {
  it('3. one agent holds at most TUNNEL_SOCKETS_PER_AGENT sockets; another keeps its own; a closed one gives its place back', async () => {
    expect(tunnel.TUNNEL_SOCKETS_PER_AGENT).toBeGreaterThan(0);
    const held = await Promise.all(Array.from({ length: tunnel.TUNNEL_SOCKETS_PER_AGENT }, () => connect(tunnelPort)));
    try {
      const answers = await Promise.all(held.map((s) => ask(s, get('/api/health', tokens.r1))));
      expect(answers.every((a) => a === 200), JSON.stringify(answers)).toBe(true);
      const extra = await connect(tunnelPort);
      expect(await ask(extra, get('/api/health', tokens.r1))).toBe(429);
      expect(await closedWithin(extra, 2_000)).toBe(true);
      const other = await connect(tunnelPort);
      expect(await ask(other, get('/api/health', tokens.r2))).toBe(200);
      other.destroy();
      held.pop()!.destroy();
      await new Promise((r) => setTimeout(r, 200));
      const again = await connect(tunnelPort);
      expect(await ask(again, get('/api/health', tokens.r1))).toBe(200);
      again.destroy();
    } finally {
      for (const s of held) s.destroy();
    }
  }, 60_000);

  it('4. a connection with no token is closed with its 401', async () => {
    const s = await connect(tunnelPort);
    expect(await ask(s, get('/api/health'))).toBe(401);
    expect(await closedWithin(s, 2_000)).toBe(true);
  }, 30_000);

  it('5. past TUNNEL_MAX_CONNECTIONS connections that send nothing, the listener takes no more', async () => {
    expect(tunnel.TUNNEL_MAX_CONNECTIONS).toBeGreaterThan(0);
    const idle = await Promise.all(Array.from({ length: tunnel.TUNNEL_MAX_CONNECTIONS }, () => connect(tunnelPort)));
    try {
      await new Promise((r) => setTimeout(r, 300));
      const one = await connect(tunnelPort);
      expect(await closedWithin(one, 2_000)).toBe(true);
      expect(idle.filter((s) => !s.destroyed).length).toBe(tunnel.TUNNEL_MAX_CONNECTIONS);
    } finally {
      for (const s of idle) s.destroy();
    }
  }, 60_000);
});
