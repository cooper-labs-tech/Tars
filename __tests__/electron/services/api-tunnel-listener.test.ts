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
 *
 * The short re-read of #600 at f239aa7bd, written before the fixes:
 * 6. The listener's ceiling is shared by every host: one host's idle connections starve the agents of another. Each
 *    host must have a listener, and a ceiling, of its own.
 * 7. With a listener per host, the token of an agent placed on another host is let in: only an agent placed on this
 *    host passes this host's listener.
 * 8. The per-token cap sits under what a real Claude Code holds at its peak, and a busy turn of a real agent is
 *    refused. Measured on 20/11/2026 (reports/remote-agents/sample-real-claude*.txt, sample-hook-curls.txt):
 *    Claude Code 2.1.329, a worker with Tars's five HTTP MCP servers, held 6 connections to Tars's API, steady through
 *    bursts of 6 and of 10 MCP calls at once. Its shell hooks, which a host runs (that session ran the state mod
 *    instead, inside the CLI), open one connection each, and run at most as many at once as tools do:
 *    `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY ?? 10` in that binary; then a turn's own hooks, 2. Twice that peak, under
 *    one token at once, must all be answered.
 */

/** A real Claude Code's peak under one token on a host, as measured (8 above): its MCP pool, its hooks, its turn's. */
const MCP_CONNECTIONS_MEASURED = 6;
const HOOKS_AT_ONCE = 10;
const TURN_HOOKS = 2;
const REAL_SESSION_PEAK = MCP_CONNECTIONS_MEASURED + HOOKS_AT_ONCE + TURN_HOOKS;

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
let otherHostPort = 0;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  apiPort = await freePort();
  api = await import('../../../electron/services/api-server');
  tunnel = await import('../../../electron/services/api-tunnel');
  const { agents } = await import('../../../electron/core/agent-manager');
  const { mintAgentToken } = await import('../../../electron/core/agent-tokens');
  for (const [id, hostId] of [['r1', 'h'], ['r2', 'h'], ['o1', 'h2']]) {
    agents.set(id, { id, name: id, status: 'idle', provider: 'claude', projectPath: '/p', skills: [], remote: { hostId, folder: '/w/p' } } as never);
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
  tunnelPort = await tunnel.tunnelListenerPort('h');
  otherHostPort = await tunnel.tunnelListenerPort('h2');
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

  it("6. one host's idle connections at its ceiling leave another host's listener its own room", async () => {
    expect(otherHostPort).not.toBe(tunnelPort);
    const idle = await Promise.all(Array.from({ length: tunnel.TUNNEL_MAX_CONNECTIONS }, () => connect(tunnelPort)));
    try {
      await new Promise((r) => setTimeout(r, 300));
      const other = await connect(otherHostPort);
      expect(await ask(other, get('/api/health', tokens.o1))).toBe(200);
      other.destroy();
    } finally {
      for (const s of idle) s.destroy();
    }
  }, 60_000);

  it('7. a host\'s listener lets in only an agent placed on that host', async () => {
    const wrongHost = await connect(otherHostPort);
    expect(await ask(wrongHost, get('/api/health', tokens.r1))).toBe(401);
    wrongHost.destroy();
    const rightHost = await connect(tunnelPort);
    expect(await ask(rightHost, get('/api/health', tokens.r1))).toBe(200);
    rightHost.destroy();
  }, 30_000);

  it("8. twice a real Claude Code's measured peak, under one token at once, is all answered", async () => {
    const at = await Promise.all(Array.from({ length: 2 * REAL_SESSION_PEAK }, () => connect(tunnelPort)));
    try {
      const answers = await Promise.all(at.map((s) => ask(s, get('/api/health', tokens.r2))));
      expect(answers.filter((a) => a !== 200), JSON.stringify(answers)).toEqual([]);
    } finally {
      for (const s of at) s.destroy();
    }
  }, 60_000);
});
