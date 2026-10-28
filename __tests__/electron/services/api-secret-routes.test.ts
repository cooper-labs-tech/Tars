import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * The calls Tars makes for the MCP servers that used to hold a key of the
 * user's (2.0.4): X and SocialData, and Telegram's file sends, which now name
 * their chat as its message send does. The keys stay in the main process.
 *
 * Every way it can fail, written before the code (2026-10-18):
 *  R1. /api/x/request posts while Posting is off in Settings, or for anything
 *      but the three writes the X tools make (a post, a reply, a delete): any
 *      agent could otherwise read the account's DMs with the user's keys.
 *  R2. Without the four credentials it calls X anyway, or says nothing useful.
 *  R3. The X call is not signed with the credentials, or the answer the tool
 *      parses (X's status and body) does not come back as X gave it.
 *  R4. /api/socialdata/request calls something else than SocialData's Twitter
 *      reads: another host, a path that climbs (`..`), a write.
 *  R5. Without its key it calls SocialData anyway; with it, the key is not the
 *      Bearer, or the answer does not come back as given.
 *  R6. A Telegram file send ignores the chat the agent named, or sends to one
 *      the user did not authorize.
 *  R7. An answer carries a key.
 * (R6 went with Tars's own Telegram bot in 2.0.5, and its file sends with it.)
 */

const out = vi.hoisted(() => ({ calls: [] as Array<{ host?: string; method?: string; path?: string; auth?: string; body?: string }>, status: 200, body: '{}' }));
vi.mock('https', () => {
  const request = (options: { hostname?: string; method?: string; path?: string; headers?: Record<string, string> }, onResponse: (res: EventEmitter & { statusCode: number }) => void) => {
    const call = { host: options.hostname, method: options.method, path: options.path, auth: options.headers?.Authorization, body: '' };
    out.calls.push(call);
    const req = Object.assign(new EventEmitter(), {
      write: (b: string) => { call.body += b; },
      end: () => {
        const res = Object.assign(new EventEmitter(), { statusCode: out.status, setEncoding: () => {} });
        onResponse(res);
        res.emit('data', out.body);
        res.emit('end');
      },
      setTimeout: () => req, destroy: () => {},
    });
    return req;
  };
  return { default: { request }, request };
});

import { registerIntegrationRoutes } from '../../../electron/services/api-routes/integration-routes';
import type { AppSettings } from '../../../electron/types';

type Handler = (req: { body: Record<string, unknown> }, sendJson: (data: unknown, status?: number) => void) => Promise<void> | void;
const handlers = new Map<string, Handler>();
const CREDS = { xApiKey: 'ck', xApiSecret: 'cs', xAccessToken: 'at', xAccessTokenSecret: 'ats' };
let live: Partial<AppSettings>;

async function post(route: string, body: Record<string, unknown>) {
  let answer: { data: Record<string, unknown>; status: number } = { data: {}, status: 0 };
  await handlers.get(route)!({ body }, (data, status = 200) => { answer = { data: data as Record<string, unknown>, status }; });
  return answer;
}

beforeEach(() => {
  handlers.clear();
  out.calls.length = 0;
  out.status = 200;
  out.body = '{}';
  live = { ...CREDS, xPostingEnabled: true, socialDataApiKey: 'sd-key' };
  const app = { post: (route: string, h: Handler) => handlers.set(route, h), get: () => {} } as never;
  const ctx = { getAppSettings: () => live } as never;
  registerIntegrationRoutes(app, ctx);
});

describe('POST /api/x/request', () => {
  it('R1. refuses with Posting off, and anything but a post, a reply or a delete', async () => {
    live = { ...live, xPostingEnabled: false };
    expect((await post('/api/x/request', { method: 'POST', endpoint: '/2/tweets', body: { text: 'hi' } })).status).toBe(403);
    live = { ...live, xPostingEnabled: true };
    for (const [method, endpoint] of [['GET', '/2/dm_events'], ['GET', '/2/users/me'], ['POST', '/2/dm_conversations'], ['DELETE', '/2/tweets/1/../../users'], ['DELETE', '/2/tweets/abc'], ['PUT', '/2/tweets']]) {
      expect((await post('/api/x/request', { method, endpoint })).status, `${method} ${endpoint}`).toBe(400);
    }
    expect(out.calls).toEqual([]);
  });

  it('R2. without the four credentials, says so and calls nothing', async () => {
    live = { xPostingEnabled: true, xApiKey: 'ck' };
    const r = await post('/api/x/request', { method: 'POST', endpoint: '/2/tweets', body: { text: 'hi' } });
    expect(r.status).toBe(400);
    expect(String(r.data.error)).toContain('X API credentials not configured');
    expect(out.calls).toEqual([]);
  });

  it('R3, R7. signs the call, and hands back X\'s status and body, no key', async () => {
    out.status = 201;
    out.body = '{"data":{"id":"7","text":"hi"}}';
    const r = await post('/api/x/request', { method: 'POST', endpoint: '/2/tweets', body: { text: 'hi' } });
    expect(r).toEqual({ status: 200, data: { status: 201, data: out.body } });
    expect(out.calls).toEqual([expect.objectContaining({ host: 'api.x.com', method: 'POST', path: '/2/tweets', body: '{"text":"hi"}' })]);
    expect(out.calls[0].auth).toMatch(/^OAuth .*oauth_consumer_key="ck".*oauth_signature="[^"]+".*oauth_token="at"/);
    expect((await post('/api/x/request', { method: 'DELETE', endpoint: '/2/tweets/7' })).status).toBe(200);
    expect(JSON.stringify(r.data)).not.toMatch(/"cs"|"ats"/);
  });
});

describe('POST /api/socialdata/request', () => {
  it('R4. only SocialData\'s Twitter reads', async () => {
    for (const endpoint of ['/user/me', '/twitter/../billing', '//evil.example/twitter/search', 'https://evil.example/twitter/search', '/twitter/search?x=1']) {
      expect((await post('/api/socialdata/request', { endpoint })).status, endpoint).toBe(400);
    }
    expect(out.calls).toEqual([]);
  });

  it('R5, R7. its key is the Bearer, the answer comes back as given; without it, nothing is called', async () => {
    out.body = '{"tweets":[],"next_cursor":null}';
    const r = await post('/api/socialdata/request', { endpoint: '/twitter/search', query: { query: 'tars', type: 'Latest' } });
    expect(r).toEqual({ status: 200, data: { status: 200, data: out.body } });
    expect(out.calls).toEqual([expect.objectContaining({ host: 'api.socialdata.tools', method: 'GET', path: '/twitter/search?query=tars&type=Latest', auth: 'Bearer sd-key' })]);
    live = {};
    out.calls.length = 0;
    const none = await post('/api/socialdata/request', { endpoint: '/twitter/search', query: { query: 'tars' } });
    expect(none.status).toBe(400);
    expect(String(none.data.error)).toContain('SocialData API key not configured');
    expect(out.calls).toEqual([]);
  });
});
