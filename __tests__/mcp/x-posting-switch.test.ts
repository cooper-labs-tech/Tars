import '../setup/home-guard';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The X server posts only while Posting is on in Settings > X (Twitter).
 *
 * The switch has been on the Settings page, off by default, since the X server
 * shipped, and nothing read it: every agent handed `x_post_tweet`,
 * `x_reply_tweet` and `x_delete_tweet` could publish and delete on JeanBrasse's
 * account whatever the page said (the audit's lead #12). The privacy policy
 * says Tars posts only when JeanBrasse has turned it on.
 *
 * How this can fail, written before the fix:
 * 1. with Posting off, a post, a reply or a delete goes out anyway;
 * 2. a settings file written before the switch existed, which has no value for it, posts;
 * 3. a value that is not the switch's own `true` (the string "true", a 1) turns posting on;
 * 4. the switch is read once: turned off after the server started, posting goes on, and turned on, it stays refused;
 * 5. a settings file that cannot be read lets the call through;
 * 6. a refused call still reaches the network, because the check comes after the request;
 * 7. with Posting on, the call no longer reaches X at all: the fix refuses everything.
 *
 * The tools are the real ones, registered on a server that keeps their
 * handlers. The network is a recorder: nothing here reaches X, nor Tars.
 */

const net = vi.hoisted(() => ({ requests: [] as Array<{ method?: string; path?: string }> }));
// Since 2.0.4 the server asks Tars to make the call (POST /api/x/request,
// with the keys Tars keeps in ~/.tars-private): the recorder stands in for
// Tars and X both, and reads the X call out of what was asked of Tars. Tars
// refuses with Posting off too; this file proves the server's own refusal,
// which comes before any call.
vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
  const asked = JSON.parse(init.body ?? '{}') as { method?: string; endpoint?: string };
  net.requests.push({ method: asked.method, path: asked.endpoint });
  const data = asked.method === 'DELETE' ? { data: { deleted: true } } : { data: { id: '42', text: 'hello' } };
  return { ok: true, status: 200, json: async () => ({ status: asked.method === 'DELETE' ? 200 : 201, data: JSON.stringify(data) }) };
});

type Result = { content: Array<{ text: string }>; isError?: boolean };
const tools = new Map<string, (args: Record<string, unknown>) => Promise<Result>>();
const SETTINGS = path.join(os.homedir(), '.tars', 'app-settings.json');
const CREDENTIALS = { xApiKey: 'k', xApiSecret: 's', xAccessToken: 't', xAccessTokenSecret: 'ts' };

function settings(value: Record<string, unknown> | string): void {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, typeof value === 'string' ? value : JSON.stringify(value));
}

/** Each of the three tools that write to the account, called as an agent would. */
const WRITES: Array<[string, Record<string, unknown>]> = [
  ['x_post_tweet', { text: 'hello' }],
  ['x_reply_tweet', { text: 'hello', reply_to_id: '41' }],
  ['x_delete_tweet', { tweet_id: '41' }],
];
async function everyWrite(): Promise<Array<[string, Result]>> {
  const out: Array<[string, Result]> = [];
  for (const [name, args] of WRITES) out.push([name, await tools.get(name)!(args)]);
  return out;
}

function expectRefused(results: Array<[string, Result]>): void {
  for (const [name, result] of results) {
    expect(result.isError, name).toBe(true);
    expect(result.content[0].text, name).toContain('Posting is off');
  }
  expect(net.requests, 'a refused call reached the network').toEqual([]);
}

beforeAll(async () => {
  const { registerPostTools } = await import('../../mcp-x/src/tools/post');
  registerPostTools({
    tool: (name: string, _description: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<Result>) => {
      tools.set(name, handler);
    },
  } as never);
});

beforeEach(() => { net.requests.length = 0; });

describe('the X tools, with Posting off', () => {
  it('refuse to post, reply or delete, and send nothing', async () => {
    settings({ ...CREDENTIALS, xPostingEnabled: false });
    expectRefused(await everyWrite());
  });

  it('refuse on a settings file that predates the switch', async () => {
    settings({ ...CREDENTIALS });
    expectRefused(await everyWrite());
  });

  it('refuse for a value that is not the switch\'s own true', async () => {
    for (const value of ['true', 1, 'yes']) {
      settings({ ...CREDENTIALS, xPostingEnabled: value });
      expectRefused(await everyWrite());
    }
  });

  it('refuse when the settings cannot be read', async () => {
    settings('{ not json');
    expectRefused(await everyWrite());
  });
});

describe('the X tools, with Posting on', () => {
  it('post, reply and delete, and follow the switch as it changes', async () => {
    settings({ ...CREDENTIALS, xPostingEnabled: true });
    for (const [name, result] of await everyWrite()) {
      expect(result.isError, `${name}: ${result.content[0].text}`).toBeFalsy();
    }
    expect(net.requests).toEqual([
      { method: 'POST', path: '/2/tweets' },
      { method: 'POST', path: '/2/tweets' },
      { method: 'DELETE', path: '/2/tweets/41' },
    ]);

    // Turned off in Settings while the server runs: read at every call.
    net.requests.length = 0;
    settings({ ...CREDENTIALS, xPostingEnabled: false });
    expectRefused(await everyWrite());
  });
});
