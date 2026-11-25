import '../../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * The stop reason the bridge hands back to the claude binary.
 *
 * An OpenAI-compatible vendor says why a turn ended in `finish_reason`, and the
 * bridge translates it through a plain object. A plain object answers for the
 * names every object has: an upstream saying `constructor` got Object's own
 * function back, which JSON drops, so the reply went out with no stop_reason at
 * all. The vendor is the one other party this bridge talks to, and the only
 * one it does not control. Found while reviewing the bridge for D2.
 *
 * How this can fail, written before the fix:
 * 1. a finish reason that names a property every object has comes back as no stop_reason, or as something that is not a string, in a plain reply;
 * 2. the same in a streamed reply's closing message_delta;
 * 3. the four reasons the map knows stop translating as they did;
 * 4. an unknown reason, or none, stops falling back to end_turn.
 *
 * The bridge is the real one, started on a free port; the vendor is a fake
 * that ends each turn with the reason the request's model names.
 */

const TOKEN = 'b'.repeat(64);
let bridgePort = 0;
let upstreamUrl = '';

vi.mock('../../../electron/constants', () => ({
  // The bridge's own token (services/bridge-token.ts), in the suite's throwaway home.
  get BRIDGE_TOKEN_FILE() { return `${process.env.HOME}/.tars-private/bridge-token`; },
  get API_PORT() { return bridgePort - 1; },
  get OPENAI_BRIDGE_PORT() { return bridgePort; },
  DATA_DIR: '/tmp/tars-bridge-stop-reason',
  DATA_DIR_SHELL: '/tmp/tars-bridge-stop-reason',
  dataPath: (f: string) => `/tmp/tars-bridge-stop-reason/${f}`,
}));
vi.mock('../../../electron/services/api-server', () => ({ getApiToken: () => TOKEN }));
vi.mock('../../../electron/providers/cli-provider', () => ({
  readAppSettingsFromDisk: () => ({ customOpenAIBaseUrl: upstreamUrl, customOpenAIApiKey: 'vendor-key' }),
  isValidOpenAIBaseUrl: (u: string) => /^https?:\/\//.test(u),
  safeEffort: (e: string) => e,
}));

let bridge: typeof import('../../../electron/services/openai-bridge');
let upstream: http.Server;

const HOSTILE = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];
const KNOWN: Array<[string, string]> = [
  ['stop', 'end_turn'], ['tool_calls', 'tool_use'], ['length', 'max_tokens'], ['content_filter', 'end_turn'],
];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** One turn through the bridge; the model names the reason the vendor ends it with. */
async function turn(finishReason: string, stream: boolean): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${bridgePort}/custom/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
    body: JSON.stringify({ model: `finish:${finishReason}`, max_tokens: 10, stream, messages: [{ role: 'user', content: 'hi' }] }),
  });
  return res.text();
}

/** The stop reason the claude binary would read, from a plain or a streamed reply. */
function stopReasonIn(text: string, stream: boolean): unknown {
  if (!stream) return (JSON.parse(text) as { stop_reason?: unknown }).stop_reason;
  const delta = text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)))
    .find(e => e.type === 'message_delta');
  return delta?.delta?.stop_reason;
}

beforeAll(async () => {
  fs.mkdirSync(`${process.env.HOME}/.tars-private`, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${process.env.HOME}/.tars-private/bridge-token`, TOKEN, { mode: 0o600 });
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { model: string; stream?: boolean };
      const named = body.model.replace(/^finish:/, '');
      const finishReason = named === '(none)' ? null : named;
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: finishReason }] }));
    });
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  bridgePort = await freePort();

  bridge = await import('../../../electron/services/openai-bridge');
  bridge.startOpenAIBridgeServer();
  // The server binds asynchronously.
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${bridgePort}/`); break; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
});

afterAll(async () => {
  bridge.stopOpenAIBridgeServer();
  await new Promise<void>(r => upstream.close(() => r()));
});

describe('the stop reason the bridge returns', () => {
  for (const stream of [false, true]) {
    const shape = stream ? 'a streamed reply' : 'a plain reply';

    it(`is end_turn for a finish reason that names a property of every object, in ${shape}`, async () => {
      for (const reason of HOSTILE) {
        expect(stopReasonIn(await turn(reason, stream), stream), reason).toBe('end_turn');
      }
    });

    it(`translates the four known reasons as before, and falls back to end_turn, in ${shape}`, async () => {
      for (const [reason, expected] of KNOWN) {
        expect(stopReasonIn(await turn(reason, stream), stream), reason).toBe(expected);
      }
      for (const reason of ['something_new', '(none)']) {
        expect(stopReasonIn(await turn(reason, stream), stream), reason).toBe('end_turn');
      }
    });
  }
});
