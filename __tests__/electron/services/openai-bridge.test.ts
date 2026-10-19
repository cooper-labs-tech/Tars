import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';

/**
 * The OpenAI-compatible bridge, driven end to end.
 *
 * Every provider that does not speak the Anthropic wire format reaches its
 * vendor through this one process: Venice, and any base URL the user types
 * into the custom provider. Unit-testing the translation functions alone would
 * miss the three things most likely to break it - that the upstream is picked
 * from the path segment, that Tars's own token is required, and that the real
 * vendor key is attached to the outbound call and never handed back - so a
 * fake OpenAI server stands in for the vendor and the assertions are made on
 * what it actually received.
 */

const TOKEN = 'a'.repeat(64);
const VENDOR_KEY = 'sk-vendor-secret';
const BRIDGE_PORT = 31896;

/** Everything the fake vendor was asked, so the outbound side can be asserted. */
const received: { path: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
let upstream: http.Server;
let upstreamUrl = '';

vi.mock('../../../electron/constants', () => ({
  API_PORT: BRIDGE_PORT - 1,
  OPENAI_BRIDGE_PORT: BRIDGE_PORT,
  DATA_DIR: '/tmp/tars-bridge-test',
  DATA_DIR_SHELL: '/tmp/tars-bridge-test',
  dataPath: (f: string) => `/tmp/tars-bridge-test/${f}`,
}));
vi.mock('../../../electron/services/api-server', () => ({ getApiToken: () => TOKEN }));
vi.mock('../../../electron/providers/cli-provider', () => ({
  readAppSettingsFromDisk: () => ({
    customOpenAIBaseUrl: upstreamUrl,
    customOpenAIApiKey: VENDOR_KEY,
    veniceApiKey: 'venice-key',
  }),
  // The real rule, not a stand-in: the bridge now gates on it before fetch(),
  // so a permissive fake here would test a guard that does not ship.
  isValidOpenAIBaseUrl: (u: string) => {
    try {
      const p = new URL(u);
      return (p.protocol === 'http:' || p.protocol === 'https:')
        && !p.username && !p.password
        && !/^169\.254\./.test(p.hostname);
    } catch { return false; }
  },
  safeEffort: (e: string) => e,
}));

let bridge: typeof import('../../../electron/services/openai-bridge');

/** One request to the bridge, as the claude binary would make it. */
async function callBridge(
  path: string,
  body: unknown,
  headers: Record<string, string> = { 'x-api-key': TOKEN },
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      received.push({ path: req.url || '', auth: req.headers['authorization'] as string | undefined, body });

      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const delta of ['Hello', ' world']) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta } }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      }));
    });
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

  bridge = await import('../../../electron/services/openai-bridge');
  bridge.startOpenAIBridgeServer();
  // The server binds asynchronously; give the listen callback a turn.
  await new Promise(r => setTimeout(r, 300));
});

afterAll(async () => {
  bridge.stopOpenAIBridgeServer();
  await new Promise<void>(r => upstream.close(() => r()));
});

describe('bridge authentication', () => {
  it('refuses a request with no key', async () => {
    const r = await callBridge('/custom/v1/messages', { model: 'm', messages: [] }, {});
    expect(r.status).toBe(401);
  });

  it('refuses a wrong key rather than passing it upstream', async () => {
    const before = received.length;
    const r = await callBridge('/custom/v1/messages', { model: 'm', messages: [] }, { 'x-api-key': 'wrong' });
    expect(r.status).toBe(401);
    expect(received.length).toBe(before);
  });

  // Claude Code sends ANTHROPIC_AUTH_TOKEN as `Authorization: Bearer`, which is how every key provider hands its
  // key over since 2.0.4: an API key in its environment is asked about at launch, and nothing answers that in an
  // agent's terminal (key-provider-auth.test.ts).
  it("takes Tars's own token as a Bearer, as Claude Code sends ANTHROPIC_AUTH_TOKEN", async () => {
    received.length = 0;
    const r = await callBridge('/custom/v1/messages', { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${TOKEN}` });
    expect(r.status, r.text).toBe(200);
    expect(received[0].auth, 'the vendor got something else than its own key').toBe(`Bearer ${VENDOR_KEY}`);
  });

  it('refuses a wrong Bearer rather than passing it upstream', async () => {
    const before = received.length;
    const r = await callBridge('/custom/v1/messages', { model: 'm', messages: [] }, { authorization: 'Bearer wrong' });
    expect(r.status).toBe(401);
    expect(received.length).toBe(before);
  });

  it('404s an upstream it does not know', async () => {
    const r = await callBridge('/nope/v1/messages', { model: 'm', messages: [] });
    expect(r.status).toBe(404);
  });

  it('404s a path that is not a Messages route', async () => {
    const r = await callBridge('/custom/v1/chat/completions', { model: 'm', messages: [] });
    expect(r.status).toBe(404);
  });
});

describe('translating a turn', () => {
  it('turns an Anthropic request into an OpenAI one and back', async () => {
    received.length = 0;
    const r = await callBridge('/custom/v1/messages', {
      model: 'some-model',
      max_tokens: 100,
      system: 'You are terse.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(r.status).toBe(200);
    const sent = received[0];
    // The system prompt becomes a leading system message, which is the whole
    // difference between the two formats for a plain turn.
    expect(sent.body.messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
    ]);

    const back = JSON.parse(r.text);
    expect(back.type).toBe('message');
    expect(back.role).toBe('assistant');
    expect(back.content).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(back.stop_reason).toBe('end_turn');
    expect(back.usage).toMatchObject({ input_tokens: 7, output_tokens: 2 });
    // The model echoed back is the one that was asked for, not the upstream's.
    expect(back.model).toBe('some-model');
  });

  it('attaches the vendor key outbound and never returns it', async () => {
    received.length = 0;
    const r = await callBridge('/custom/v1/messages', { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });

    expect(received[0].auth).toBe(`Bearer ${VENDOR_KEY}`);
    // The real key must not travel back to the claude binary, which only ever
    // holds Tars's own local token.
    expect(r.text).not.toContain(VENDOR_KEY);
  });

  it('translates tools', async () => {
    received.length = 0;
    await callBridge('/custom/v1/messages', {
      model: 'm',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    });

    const tools = received[0].body.tools as Array<Record<string, any>>;
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe('function');
    expect(tools[0].function.name).toBe('read_file');
    expect(tools[0].function.parameters).toMatchObject({ type: 'object' });
  });

  it('streams as Anthropic block-delta events', async () => {
    received.length = 0;
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/custom/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify({ model: 'm', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // The claude binary drives its turn loop off these event names; missing
    // any one of them leaves it waiting on a stream that already ended.
    for (const ev of ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']) {
      expect(text).toContain(`event: ${ev}`);
    }
    expect(text).toContain('Hello');
    expect(text).toContain(' world');
  });

  it('answers count_tokens without calling the vendor', async () => {
    received.length = 0;
    const r = await callBridge('/custom/v1/messages/count_tokens', {
      model: 'm',
      messages: [{ role: 'user', content: 'hello there' }],
    });

    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).input_tokens).toBeGreaterThan(0);
    // An estimate, so it must not cost a vendor call.
    expect(received.length).toBe(0);
  });

  it('refuses a base URL pointing at cloud metadata, without calling it', async () => {
    const saved = upstreamUrl;
    upstreamUrl = 'http://169.254.169.254/latest/meta-data';
    received.length = 0;
    try {
      const r = await callBridge('/custom/v1/messages', { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      expect(r.status).toBe(401);
      // The whole point: the stored vendor key never leaves for that host.
      expect(received.length).toBe(0);
    } finally {
      upstreamUrl = saved;
    }
  });

  it('reports a missing base URL rather than calling nowhere', async () => {
    const saved = upstreamUrl;
    upstreamUrl = '';
    try {
      const r = await callBridge('/custom/v1/messages', { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      expect(r.status).toBe(401);
      expect(r.text).toContain('custom');
    } finally {
      upstreamUrl = saved;
    }
  });
});
