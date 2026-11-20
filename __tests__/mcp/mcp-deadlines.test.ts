import '../setup/home-guard';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EventEmitter } from 'node:events';

/**
 * The MCP servers that had no deadline at all: a host that stops answering
 * left the tool waiting until Claude Code gave up on the call, about half an
 * hour later, with nothing said to the agent (QA's gate of #207). mcp-vault
 * calls Tars; mcp-socialdata and mcp-x called their APIs, and since 2.0.4 Tars
 * calls them for the two (services/api-routes/integration-routes.ts, with the
 * keys it keeps in ~/.tars-private): the deadline read here is the one Tars's
 * route sets, and its words are what the tool says. mcp-telegram's two
 * requests are proven elsewhere, since its tools live in its index.ts, which
 * starts the server as it loads: by the contract (__tests__/mcp/contracts),
 * and by telegram-upload-deadline.test.ts, which loads it with a fake SDK.
 *
 * How this can fail, written before the code:
 * 1. the request sets no deadline, so a silent host is waited on for ever;
 * 2. the deadline passes and the request goes on;
 * 3. it ends without saying how long it waited, in the words every server here
 *    shares ("no answer within N s", noAnswerWithin in mcp-shared), or without
 *    the server's own words for the host that did not answer;
 * 4. the deadline is out of proportion: over two minutes, which is no deadline
 *    to an agent waiting on a tool, or under ten seconds, which cuts off an
 *    answer that is only slow.
 *
 * The transport is replaced and nothing else, as in kanban-api-timeout.test.ts:
 * the real clients build their requests, and these read the deadline each one
 * set and what it does when that deadline passes. Nothing leaves the process.
 */

type FakeRequest = EventEmitter & { destroyed: boolean };
const sent = vi.hoisted(() => [] as Array<{ options: Record<string, unknown>; req: FakeRequest }>);

async function transport(actual: Record<string, unknown>) {
  const { EventEmitter } = await import('node:events');
  const request = (options: Record<string, unknown>) => {
    const req = Object.assign(new EventEmitter(), {
      destroyed: false,
      write: () => {},
      end: () => {},
      setTimeout(ms: number) { options.timeout = ms; return req; },
      destroy(err?: Error) { req.destroyed = true; if (err) req.emit('error', err); return req; },
    });
    sent.push({ options, req });
    return req;
  };
  return { ...actual, request, default: { ...actual, request } };
}
vi.mock('http', async importOriginal => transport(await importOriginal()));
vi.mock('https', async importOriginal => transport(await importOriginal()));

const SETTINGS = path.join(os.homedir(), '.tars', 'app-settings.json');

const NAMES = ['mcp-vault (Tars)', 'mcp-socialdata (SocialData, through Tars)', 'mcp-x (X, through Tars)'];
/** Each client, as its tools call it, and the words it has for a host it could not reach. */
const CLIENTS = new Map<string, [RegExp, () => Promise<unknown>]>();

beforeAll(async () => {
  // A vault client with no token of its own, whatever the shell running this
  // suite carries (an agent's terminal has one): an agent token is first
  // proven to the port (mcp-proves-tars.test.ts), a call this file does not count.
  delete process.env.CLAUDE_MGR_API_TOKEN;
  delete process.env.TARS_INSTANCE_ID;
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  const vault = await import('../../mcp-vault/src/utils/api');
  // The calls Tars makes for mcp-socialdata and mcp-x, with the keys it holds.
  const { registerIntegrationRoutes } = await import('../../electron/services/api-routes/integration-routes');
  const routes = new Map<string, (req: { body: Record<string, unknown> }, send: (data: unknown, status?: number) => void) => Promise<void>>();
  const keys = { socialDataApiKey: 'key', xApiKey: 'k', xApiSecret: 's', xAccessToken: 't', xAccessTokenSecret: 'ts', xPostingEnabled: true };
  registerIntegrationRoutes({ post: (route: string, h: never) => routes.set(route, h), get: () => {} } as never, { getAppSettings: () => keys } as never);
  /** A route, as the tool meets it: a refusal or a failure is the tool's error. */
  const route = (name: string, body: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    void routes.get(name)!({ body }, (data, status = 200) => (status >= 400 ? reject(new Error(String((data as { error?: unknown }).error))) : resolve(data)));
  });
  CLIENTS.set(NAMES[0], [/^API request failed: /, () => vault.apiRequest('GET', '/api/vault/documents/d1')]);
  CLIENTS.set(NAMES[1], [/^SocialData API request failed: /, () => route('/api/socialdata/request', { endpoint: '/twitter/search', query: { query: 'tars' } })]);
  CLIENTS.set(NAMES[2], [/^X API request failed: /, () => route('/api/x/request', { method: 'POST', endpoint: '/2/tweets', body: { text: 'Hi' } })]);
});

beforeEach(() => { sent.length = 0; });

/** Until the client has sent its request: a client may look something up first. */
async function sentOne(): Promise<void> {
  for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
}

/** What became of a call 200 ms after its deadline passed: its error, or that it is still waiting. */
async function afterTheDeadline(call: () => Promise<unknown>): Promise<{ deadline: unknown; outcome: unknown; req: FakeRequest }> {
  const pending = call();
  // The vault client looks up the token it presents before it sends (tars-api.ts tokenToPresent).
  await sentOne();
  expect(sent).toHaveLength(1);
  const { options, req } = sent[0];
  req.emit('timeout');
  const outcome = await Promise.race([
    pending.then(() => 'answered', (err: unknown) => err),
    new Promise(resolve => setTimeout(() => resolve('still waiting'), 200)),
  ]);
  return { deadline: options.timeout, outcome, req };
}

describe('the MCP servers that call out, when the host does not answer', () => {
  it.each(NAMES)('%s sets a deadline in proportion (1, 4)', async (name) => {
    const [, call] = CLIENTS.get(name)!;
    void call().catch(() => {});
    await sentOne();
    const deadline = sent[0]?.options.timeout;
    expect(typeof deadline, `${name} sets no deadline`).toBe('number');
    expect(deadline as number, name).toBeGreaterThanOrEqual(10_000);
    expect(deadline as number, name).toBeLessThanOrEqual(120_000);
  });

  it.each(NAMES)('%s ends the request when its deadline passes, and says how long it waited, in its own words (2, 3)', async (name) => {
    const [words, call] = CLIENTS.get(name)!;
    const { deadline, outcome, req } = await afterTheDeadline(call);
    expect(outcome, `${name} is still waiting`).toBeInstanceOf(Error);
    expect(req.destroyed, name).toBe(true);
    const message = (outcome as Error).message;
    expect(message, name).toMatch(words);
    expect(message, name).toContain(`no answer within ${(deadline as number) / 1000} s`);
  });
});
