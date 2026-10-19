import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import * as http from 'http';
import { EventEmitter } from 'events';
import type { AddressInfo } from 'net';
import { tunnelTo, closeTunnels, openTunnels, sweepIdleTunnels, tunnelArgs, answersWithoutToken, type Spawn } from '../../../electron/services/hermes-tunnel';
import type { HermesConnection } from '../../../electron/types/hermes';

/**
 * The tunnel to an MCP server Hermes registered on its own machine's loopback (gbrain, Honcho on `localhost:<port>`
 * there), when Tars reaches Hermes over SSH (2.0.4, "Memory in one picture"; the Audit's R3.1 and R3.2,
 * audit-requirements-2-0-4-1810.md, section 3).
 *
 * How it fails, written before the code:
 * 1. The forward listens on another address than 127.0.0.1 (no bind address, 0.0.0.0, `*`), or ssh is told `-g` or
 *    GatewayPorts: another machine reaches the server through this Mac.
 * 2. The local port is a fixed, known one, or the same each time, so that it can be guessed or squatted.
 * 3. ssh may stop on a question nobody answers (no BatchMode, no StrictHostKeyChecking), keeps running when its
 *    forward failed (no ExitOnForwardFailure), or ignores the key or the port saved in Connection; or it is run
 *    through a shell.
 * 4. The tunnel is said open before it answers, or when ssh exited (the host refused, its key is unknown): the
 *    answer must say what ssh said, without a key or a token in it.
 * 5. A tunnel outlives its use: it stays open once closed, past its idle time, or after Tars quits.
 * 6. Two tunnels are opened for one server, or one server's tunnel is handed out for another.
 * 7. A server that answers through the tunnel without a token is used: any process on this Mac would read and write
 *    the user's memory through the tunnel's port (R3.2). It must be told apart from one that asks for its token.
 */

const conn: HermesConnection = { mode: 'ssh', ssh: { host: 'hermes.example', user: 'jb', port: 2222, keyPath: '/Users/jb/.ssh/id_hermes' } };

type Fake = EventEmitter & { stderr: EventEmitter; kill: () => void; killed: boolean; args: string[] };
let spawned: Fake[];
let listeners: net.Server[];
let behaviour: 'forward' | 'refused' | 'silent';

/** ssh as a test stands it in: it opens the forward's port for real, or says why it could not and exits. */
const fakeSsh: Spawn = (file, args) => {
  expect(file).toBe('ssh');
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), killed: false, args }) as Fake;
  child.kill = () => {
    child.killed = true;
    for (const l of listeners) l.close();
    setImmediate(() => child.emit('exit', null, 'SIGTERM'));
  };
  spawned.push(child);
  const forward = args[args.indexOf('-L') + 1];
  const port = Number(forward.split(':')[1]);
  setTimeout(() => {
    if (behaviour === 'refused') {
      child.stderr.emit('data', Buffer.from('ssh: connect to host hermes.example port 2222: Connection refused\r\n'));
      child.emit('exit', 255, null);
    } else if (behaviour === 'forward') {
      const server = net.createServer((s) => s.end());
      server.listen(port, '127.0.0.1');
      listeners.push(server);
    }
  }, 20);
  return child as never;
};

beforeEach(() => { spawned = []; listeners = []; behaviour = 'forward'; });
afterEach(() => { closeTunnels(); for (const l of listeners) l.close(); });

describe('the tunnel to a server on Hermes\'s loopback', () => {
  it('1 and 3. ssh as an argument list: the forward bound to 127.0.0.1, keys only, no question, the saved key and port', () => {
    const args = tunnelArgs(conn, 51234, { host: 'localhost', port: 8484 });

    expect(args).toEqual(['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-L', '127.0.0.1:51234:localhost:8484',
      '-p', '2222', '-i', '/Users/jb/.ssh/id_hermes', '-o', 'IdentitiesOnly=yes', 'jb@hermes.example']);
    expect(args).not.toContain('-g');
    expect(args.join(' ')).not.toMatch(/GatewayPorts|0\.0\.0\.0|\*:/);
  });

  it('2 and 4. a free port each time, said open only once it answers', async () => {
    const first = await tunnelTo(conn, { host: 'localhost', port: 8484 }, { spawn: fakeSsh });
    expect(first.ok).toBe(true);
    const port = (first as { localPort: number }).localPort;
    await new Promise<void>((resolve, reject) => { const s = net.connect(port, '127.0.0.1', () => { s.end(); resolve(); }); s.on('error', reject); });
    closeTunnels();

    const second = await tunnelTo(conn, { host: 'localhost', port: 8484 }, { spawn: fakeSsh });
    expect((second as { localPort: number }).localPort).not.toBe(port);
    expect(spawned[0].args).not.toContain('-g');
  });

  it('4. ssh refused: not open, and the answer says what ssh said', async () => {
    behaviour = 'refused';
    const answer = await tunnelTo(conn, { host: 'localhost', port: 8484 }, { spawn: fakeSsh });

    expect(answer).toEqual({ ok: false, why: expect.stringMatching(/hermes\.example port 2222: Connection refused/) });
    expect(openTunnels()).toEqual([]);
  });

  it('4. ssh that never opens the forward: not open after its time, and ended', async () => {
    behaviour = 'silent';
    const answer = await tunnelTo(conn, { host: 'localhost', port: 8484 }, { spawn: fakeSsh, readyWithinMs: 300 });

    expect(answer).toEqual({ ok: false, why: expect.stringMatching(/did not open/) });
    expect(spawned[0].killed).toBe(true);
  });

  it('5 and 6. one tunnel per server, reused, closed when idle and when Tars quits', async () => {
    const a = await tunnelTo(conn, { host: 'localhost', port: 8484 }, { spawn: fakeSsh, now: () => 1_000 });
    const again = await tunnelTo(conn, { host: 'localhost', port: 8484 }, { spawn: fakeSsh, now: () => 2_000 });
    const b = await tunnelTo(conn, { host: '127.0.0.1', port: 8000 }, { spawn: fakeSsh, now: () => 2_000 });

    expect(spawned).toHaveLength(2);
    expect((again as { localPort: number }).localPort).toBe((a as { localPort: number }).localPort);
    expect((b as { localPort: number }).localPort).not.toBe((a as { localPort: number }).localPort);
    expect(openTunnels().map(t => t.remote).sort()).toEqual(['127.0.0.1:8000', 'localhost:8484']);

    sweepIdleTunnels(2_000 + 10 * 60_000 + 1);
    expect(openTunnels()).toEqual([]);
    expect(spawned.every(c => c.killed)).toBe(true);
  });

  it('7. a server that answers without a token is told apart from one that asks for it', async () => {
    const open = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'); });
    const guarded = http.createServer((req, res) => { res.writeHead(req.headers.authorization ? 200 : 401); res.end('{}'); });
    await Promise.all([open, guarded].map(s => new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()))));
    try {
      expect(await answersWithoutToken(`http://127.0.0.1:${(open.address() as AddressInfo).port}/mcp`)).toBe(true);
      expect(await answersWithoutToken(`http://127.0.0.1:${(guarded.address() as AddressInfo).port}/mcp`)).toBe(false);
    } finally {
      open.close();
      guarded.close();
    }
  });
});
