import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The servers that call a service with a key of the user's (Telegram, X,
 * SocialData) go through Tars, with their agent's own token (2.0.4). They read
 * app-settings.json themselves, from inside the agent's process tree; the keys
 * are in ~/.tars-private now, which nothing handed to an agent reads, so Tars
 * makes the call and the key never leaves it.
 *
 * Every way it can fail, written before the code (2026-10-18):
 *  M1. A server still calls the service itself (api.telegram.org, api.x.com,
 *      api.socialdata.tools), with a key it found somewhere.
 *  M2. A server reads the private folder.
 *  M3. A call to Tars goes without the agent's own token, or with a key in it.
 *  M4. What the tool answers changes for the agent: a post's id, a search's
 *      tweets, Telegram's chat, and Tars's refusals (no key, posting off, a
 *      chat not authorized) said as the tool's error.
 *  M5. A file send names no chat, so Tars sends it to the default one when the
 *      agent named another.
 * (Telegram's cases, M5 and Telegram's part of M1 to M4, went with Tars's own
 * Telegram bot and mcp-telegram in 2.0.5.)
 */

const net = vi.hoisted(() => ({ outbound: [] as string[], reads: [] as string[] }));
vi.mock('https', () => {
  const request = (options: { hostname?: string; path?: string }) => {
    net.outbound.push(`${options.hostname}${options.path}`);
    throw new Error('no call leaves for a service');
  };
  return { default: { request, get: request }, request, get: request };
});
vi.mock('fs', async (original) => {
  const fs = await original<typeof import('fs')>();
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    net.reads.push(String(p));
    return (fs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync;
  return { ...fs, default: { ...fs, readFileSync }, readFileSync };
});

import * as fs from 'node:fs';

type Result = { content: Array<{ text: string }>; isError?: boolean };
const tools = new Map<string, (args: Record<string, unknown>) => Promise<Result>>();
const fakeServer = { tool: (name: string, _d: string, _s: unknown, handler: (a: Record<string, unknown>) => Promise<Result>) => { tools.set(name, handler); } } as never;

const INSTANCE = crypto.randomBytes(8).toString('hex');
const TOKEN = 'agent-own-token';
const received: Array<{ path: string; auth?: string; body: Record<string, unknown> }> = [];
let answer: (p: string, body: Record<string, unknown>) => { status: number; json: unknown } = () => ({ status: 200, json: { success: true } });
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/health') {
        const proof = crypto.createHash('sha256').update(`${INSTANCE}:${url.searchParams.get('challenge')}`).digest('hex');
        res.end(JSON.stringify({ ok: true, proof }));
        return;
      }
      const body = raw ? JSON.parse(raw) : {};
      received.push({ path: url.pathname, auth: req.headers.authorization, body });
      const a = answer(url.pathname, body);
      res.statusCode = a.status;
      res.end(JSON.stringify(a.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.CLAUDE_MGR_API_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.CLAUDE_MGR_API_TOKEN = TOKEN;
  process.env.TARS_INSTANCE_ID = INSTANCE;

  // The settings as 2.0.4 leaves them: the plain ones in ~/.tars, the keys in ~/.tars-private.
  const home = os.homedir();
  fs.mkdirSync(path.join(home, '.tars'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({ xPostingEnabled: true }));
  fs.mkdirSync(path.join(home, '.tars-private'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tars-private', 'settings-secrets.json'), JSON.stringify({ xApiKey: 'k', xApiSecret: 's', xAccessToken: 't', xAccessTokenSecret: 'ts', socialDataApiKey: 'sd' }));

  (await import('../../mcp-x/src/tools/post')).registerPostTools(fakeServer);
  (await import('../../mcp-socialdata/src/tools/search')).registerSearchTools(fakeServer);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  for (const k of ['CLAUDE_MGR_API_URL', 'CLAUDE_MGR_API_TOKEN', 'TARS_INSTANCE_ID']) delete process.env[k];
});

beforeEach(() => {
  received.length = 0;
  net.outbound.length = 0;
  net.reads.length = 0;
  answer = () => ({ status: 200, json: { success: true } });
});

function expectThroughTars(): void {
  expect(net.outbound, 'a call left for the service itself').toEqual([]);
  expect(net.reads.filter((p) => p.includes('.tars-private')), 'the private folder was read').toEqual([]);
  for (const r of received) {
    expect(r.auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(r.body)).not.toMatch(/"sd"|"ts"/);
  }
}

describe('X, through Tars', () => {
  it('M1 to M4. a post goes to /api/x/request, and its id comes back', async () => {
    answer = () => ({ status: 200, json: { status: 201, data: JSON.stringify({ data: { id: '42', text: 'hello' } }) } });
    const r = await tools.get('x_post_tweet')!({ text: 'hello' });
    expect(r.content[0].text).toContain('ID: 42');
    expect(received).toEqual([expect.objectContaining({ path: '/api/x/request', body: { method: 'POST', endpoint: '/2/tweets', body: { text: 'hello' } } })]);
    answer = () => ({ status: 403, json: { error: 'Posting is off in Tars Settings > X (Twitter), so nothing was sent.' } });
    const refused = await tools.get('x_delete_tweet')!({ tweet_id: '42' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Posting is off');
    expectThroughTars();
  });
});

describe('SocialData, through Tars', () => {
  it('M1 to M4. a search goes to /api/socialdata/request, and its tweets come back', async () => {
    answer = () => ({ status: 200, json: { status: 200, data: JSON.stringify({ tweets: [], next_cursor: null }) } });
    const r = await tools.get('twitter_search')!({ query: 'tars' });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(received).toEqual([expect.objectContaining({ path: '/api/socialdata/request', body: { endpoint: '/twitter/search', query: expect.objectContaining({ query: 'tars' }) } })]);
    answer = () => ({ status: 400, json: { error: 'SocialData API key not configured. Please add your API key in Tars Settings > SocialData.' } });
    const refused = await tools.get('twitter_search')!({ query: 'tars' });
    expect(refused.content[0].text).toContain('SocialData API key not configured');
    expectThroughTars();
  });
});
