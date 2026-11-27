import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * The readers outside the window's channels settle on an answer cut off once
 * it has begun, in words (the Audit's I-3 on #660, the gap M1 closed in
 * hermesRequest): the agents' X and SocialData routes (integration-routes.ts
 * call()), the tars-slot command line (resources/tars-slot.cjs) and the local
 * agent's runner (resources/local-agent-runner.js).
 *
 * How it can fail, written before the fix (2026-11-27):
 * 1. /api/x/request and /api/socialdata/request never answer the agent's tool,
 *    or answer in Node's one word ("aborted"), for an answer cut after the
 *    status and its headers.
 * 2. tars-slot ends without a word, and with 0, the code of a success, when
 *    Tars's answer is cut: the promise it awaits never settles, and nothing
 *    else holds the process.
 * 3. The local runner ends without a word in the middle of a session, its
 *    first question's answer cut: neither the stream nor its fallback settles.
 * 4. An answer that ends is no longer read by any of them.
 *
 * The stand-in sends 200, its headers and 9 bytes, then destroys the socket.
 */

const target = vi.hoisted(() => ({ port: 0 }));
vi.mock('https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('https')>();
  const plain = await import('node:http');
  const request = (options: Record<string, unknown>, cb?: (res: http.IncomingMessage) => void) =>
    plain.request({ ...options, protocol: 'http:', host: '127.0.0.1', hostname: '127.0.0.1', port: target.port, agent: undefined }, cb);
  return { ...actual, request, default: { ...actual, request } };
});

const root = path.resolve(__dirname, '..', '..', '..');
const closing: Array<() => Promise<void> | void> = [];
afterEach(async () => { await Promise.all(closing.splice(0).map(close => close())); });

/** A loopback host whose every answer is `answer(req, res)`; its port is also where https goes. */
async function host(answer: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<number> {
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => answer(req, res)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closing.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  target.port = (server.address() as net.AddressInfo).port;
  return target.port;
}

/** 200, its headers and 9 bytes of `type`, then the socket destroyed. */
function cutAfter(type: string, first: string) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': '1000' });
    res.write(first.slice(0, 9), () => setTimeout(() => req.socket.destroy(), 20));
  };
}

/** The answer, or 'still waiting' once `ms` have passed without one. */
function within<T>(answer: Promise<T>, ms: number): Promise<T | 'still waiting'> {
  return Promise.race([answer, new Promise<'still waiting'>(resolve => setTimeout(() => resolve('still waiting'), ms))]);
}

describe('the agents\' X and SocialData routes (1, 4)', () => {
  async function routes() {
    const { registerIntegrationRoutes } = await import('../../../electron/services/api-routes/integration-routes');
    const table = new Map<string, (req: { body: unknown }, send: (data: unknown, status?: number) => void) => Promise<void>>();
    const keys = { xPostingEnabled: true, xApiKey: 'k', xApiSecret: 's', xAccessToken: 't', xAccessTokenSecret: 'ts', socialDataApiKey: 'sd' };
    registerIntegrationRoutes({ post: (route: string, h: never) => table.set(route, h), get: () => {} } as never, { getAppSettings: () => keys } as never);
    return (route: string, body: unknown) => new Promise<{ status: number; data: unknown }>(resolve => {
      void table.get(route)!({ body }, (data, status = 200) => resolve({ status, data }));
    });
  }

  it('/api/x/request says the answer was cut off', async () => {
    await host(cutAfter('application/json', '{"data":{"id":"1"}}'));
    const ask = await routes();

    const answer = await within(ask('/api/x/request', { method: 'POST', endpoint: '/2/tweets', body: { text: 'hi' } }), 5_000);

    expect(answer).toEqual({ status: 502, data: { error: 'X API request failed: its answer was cut off before the end' } });
  }, 10_000);

  it('/api/socialdata/request says the answer was cut off', async () => {
    await host(cutAfter('application/json', '{"tweets":[]}'));
    const ask = await routes();

    const answer = await within(ask('/api/socialdata/request', { endpoint: '/twitter/search', query: { query: 'tars' } }), 5_000);

    expect(answer).toEqual({ status: 502, data: { error: 'SocialData API request failed: its answer was cut off before the end' } });
  }, 10_000);

  it('an answer that ends is read', async () => {
    await host((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"tweets":[]}'); });
    const ask = await routes();

    await expect(ask('/api/socialdata/request', { endpoint: '/twitter/search' })).resolves.toMatchObject({ status: 200 });
  });
});

/** A script run as it runs for real, by node, with an environment of its own; its output and its end. */
function run(args: string[], env: Record<string, string>): { child: ChildProcess; out: () => string; ended: Promise<number | null> } {
  const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH ?? '', HOME: os.homedir(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let text = '';
  child.stdout!.on('data', c => { text += c; });
  child.stderr!.on('data', c => { text += c; });
  const ended = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
  closing.push(() => { if (child.exitCode === null) child.kill(); });
  return { child, out: () => text, ended };
}

describe('tars-slot (2, 4)', () => {
  const SLOT = path.join(root, 'electron', 'resources', 'tars-slot.cjs');

  it('ends with 3, saying Tars\'s answer was cut off', async () => {
    const port = await host(cutAfter('application/json', '{"slots":4,"holders":[]}'));

    const slot = run([SLOT, 'status'], { CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: 'agent-token' });

    expect(await within(slot.ended, 5_000)).toBe(3);
    expect(slot.out()).toContain('tars-slot: Tars could not be reached: its answer was cut off before the end');
  }, 10_000);

  it('reads an answer that ends', async () => {
    const port = await host((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ slots: 4, holders: [], waiting: [] })); });

    const slot = run([SLOT, 'status'], { CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: 'agent-token' });

    expect(await within(slot.ended, 5_000)).toBe(0);
    expect(slot.out()).toContain('slots: at most 4 at once');
  }, 10_000);
});

describe('the local agent\'s runner (3, 4)', () => {
  const RUNNER = path.join(root, 'electron', 'resources', 'local-agent-runner.js');

  it('says its first answer was cut off, and stays for the next question', async () => {
    const port = await host(cutAfter('text/event-stream', 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));

    const runner = run([RUNNER, '--endpoint', `http://127.0.0.1:${port}/v1`, '--model', 'm', '--prompt', 'hello'], {});

    await within(new Promise<void>(resolve => { const t = setInterval(() => { if (/Error:/.test(runner.out()) || runner.child.exitCode !== null) { clearInterval(t); resolve(); } }, 50); }), 5_000);
    expect(runner.out()).toContain('Error: the endpoint cut its answer off before the end');
    expect(runner.child.exitCode).toBeNull();
    runner.child.stdin!.write('/exit\n');
    expect(await within(runner.ended, 5_000)).toBe(0);
  }, 15_000);

  it('reads an answer that ends', async () => {
    const port = await host((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"Hello there"}}]}\n\ndata: [DONE]\n\n');
    });

    const runner = run([RUNNER, '--endpoint', `http://127.0.0.1:${port}/v1`, '--model', 'm', '--prompt', 'hello'], {});

    await within(new Promise<void>(resolve => { const t = setInterval(() => { if (runner.out().includes('Hello there')) { clearInterval(t); resolve(); } }, 50); }), 5_000);
    expect(runner.out()).toContain('Hello there');
    expect(runner.out()).not.toContain('Error:');
    runner.child.stdin!.write('/exit\n');
    expect(await within(runner.ended, 5_000)).toBe(0);
  }, 15_000);
});
