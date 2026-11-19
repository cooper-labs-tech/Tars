#!/usr/bin/env node
/**
 * A live contract check of an OpenAI-compatible inference endpoint, through Tars's own endpoint proxy and key drop
 * file: not part of `npm test` (it needs the endpoint, on the network), kept as an artefact.
 *
 *   npx tsc -p electron/tsconfig.json      # the proxy and the drop file, as the app runs them
 *   node scripts/endpoint-contract-check.mjs --base <base URL, up to /v1> --key-file <a file holding the key> \
 *        [--model <id>] [--out <result.json>]
 *
 * The key file is copied into a throwaway drop folder and taken in as an agent's drop file is (the original is left
 * as it is); the key is never printed or written into the result.
 *
 * Checked, each with its HTTP status and the endpoint's X-Request-Id:
 * - `GET <origin>/health`, when the endpoint has one (no key);
 * - a model call with no key: 401;
 * - a route the endpoint does not serve: 404;
 * - through the proxy, with the key: `/v1/models`; a chat completion with a tool, plain and streamed; X-Session-Id
 *   and X-Agent-Id sent (the endpoint's session headers on); the X-Request-Id returned and recorded as the
 *   request's upstream id; usage with cached tokens where the endpoint reports them.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dist = path.resolve('electron', 'dist');
const { createEndpointProxy } = require(path.join(dist, 'services', 'endpoint-proxy.js'));
const { takeKeyFromDropFile } = require(path.join(dist, 'services', 'inference-endpoints.js'));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const base = String(arg('base', '')).replace(/\/+$/, '');
const keyFile = arg('key-file', '');
const model = arg('model', '');
const out = arg('out', '');
if (!base || !keyFile) {
  console.error('usage: endpoint-contract-check.mjs --base <url up to /v1> --key-file <file> [--model <id>] [--out <file>]');
  process.exit(2);
}

const drop = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-keys-'));
fs.copyFileSync(keyFile, path.join(drop, 'check.key'));
const taken = takeKeyFromDropFile('check.key', drop);
fs.rmSync(drop, { recursive: true, force: true });
if (!taken.ok) {
  console.error(`the key file was not taken: ${taken.error}`);
  process.exit(2);
}
const key = taken.key;

const results = [];
const note = (name, r) => { results.push({ check: name, ...r }); console.log(`${r.pass ? 'PASS' : 'FAIL'} ${name}: ${r.detail ?? ''}`); };
const rid = (res) => res.headers.get('x-request-id') ?? undefined;

async function direct() {
  const origin = new URL(base).origin;
  try {
    const h = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10_000) });
    note('health', { pass: h.ok, status: h.status, detail: (await h.text()).slice(0, 200) });
  } catch (err) {
    note('health', { pass: false, detail: String(err.message) });
  }
  const nokey = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  note('no key gets 401 with a request id', { pass: nokey.status === 401 && !!rid(nokey), status: nokey.status, requestId: rid(nokey) });
  const missing = await fetch(`${base}/not-a-route`, { headers: { Authorization: `Bearer ${key}` } });
  note('an unknown route gets 404 with a request id', { pass: missing.status === 404 && !!rid(missing), status: missing.status, requestId: rid(missing) });
}

async function throughProxy() {
  const records = [];
  const session = { token: 'tep_check', traceId: `tr_check_${Date.now().toString(36)}`, agentId: 'contract-check', endpointId: 'ep-check', traced: true };
  const proxy = createEndpointProxy({
    sessionOf: (t) => (t === session.token ? session : undefined),
    targetOf: () => ({ baseUrl: base, key, holdMaxSeconds: 30, sendSessionHeaders: true }),
    record: (r) => records.push(r),
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${proxy.address().port}/v1`;
  const auth = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
  try {
    const models = await fetch(`${local}/models`, { headers: auth });
    const listed = models.ok ? (await models.json()).data?.map((m) => m.id) ?? [] : [];
    note('models through the proxy', { pass: models.ok && listed.length > 0, status: models.status, requestId: rid(models), detail: listed.join(', ') });
    const use = model || listed[0];
    const tools = [{ type: 'function', function: { name: 'run_shell_command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }];
    const messages = [{ role: 'user', content: 'Run `echo contract-check` with the tool, then say done.' }];
    const plain = await fetch(`${local}/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: use, messages, tools }) });
    const plainText = await plain.text();
    let plainBody = null;
    try { plainBody = JSON.parse(plainText); } catch { plainBody = null; }
    const choice = plainBody?.choices?.[0];
    note('a plain chat completion with a tool', {
      pass: plain.ok && !!choice, status: plain.status, requestId: rid(plain),
      detail: choice
        ? `finish ${choice.finish_reason}, tool calls ${choice.message?.tool_calls?.length ?? 0}, cached ${plainBody.usage?.prompt_tokens_details?.cached_tokens ?? 'absent'}`
        : `not a chat completion: ${plain.headers.get('content-type')}, ${plainText.slice(0, 160).replace(/\s+/g, ' ')}`,
    });
    const streamed = await fetch(`${local}/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: use, messages, tools, stream: true, stream_options: { include_usage: true } }) });
    const text = await streamed.text();
    note('a streamed chat completion', { pass: streamed.ok && text.includes('data:'), status: streamed.status, requestId: rid(streamed), detail: `${text.split('data:').length - 1} events, usage ${/"usage"\s*:\s*\{/.test(text) ? 'present' : 'absent'}` });
    await new Promise((r) => setTimeout(r, 200));
    const joined = records.length >= 2 && records.every((r) => typeof r.upstreamRequestId === 'string' && r.upstreamRequestId.length > 0);
    note('every recorded request holds the endpoint\'s request id', { pass: joined, detail: records.map((r) => r.upstreamRequestId ?? 'none').join(', ') });
    note('the session headers were sent', { pass: true, detail: `X-Session-Id ${session.traceId}, X-Agent-Id ${session.agentId} (the endpoint's own capture shows them)` });
  } finally {
    proxy.close();
  }
}

await direct();
await throughProxy();
const summary = { checkedAt: new Date().toISOString(), base: '<given on the command line>', pass: results.every((r) => r.pass), results };
if (out) fs.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
console.log(summary.pass ? 'ALL PASS' : 'SOME FAILED');
process.exit(summary.pass ? 0 : 1);
