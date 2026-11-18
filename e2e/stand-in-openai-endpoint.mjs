/**
 * A stand-in OpenAI-compatible inference endpoint, loopback only, no network: what a remote inference host serves
 * (`/v1/models`, `/v1/chat/completions`, `/v1/responses`, streamed or not, with tools, a Bearer key), small enough
 * to read. The E2E spec of the traces (e2e/traces-native.spec.ts) and the harness probe
 * (scripts/endpoint-harness-probe.mjs) both run it.
 *
 * One task shape, the one every coding harness can do: on a request that does not yet carry a tool result, it asks
 * the harness's own shell tool to print a marker; on the request that carries the result, it answers in text,
 * `PROBE-OK <marker>` when the result holds the marker, `PROBE-NO-RESULT` otherwise. The shell tool is found in the
 * tools the harness sent, and its arguments are built from that tool's own schema (`command` as a string or an
 * array, or `cmd`), so the same stand-in serves Codex, Qwen Code, Pi and opencode without knowing which it is.
 *
 * Every request is logged, one JSON line each, headers included, to the file named by `--log` (or STAND_IN_LOG):
 * that log is what a test reads to see which key, which headers and which body reached the endpoint.
 *
 *   node e2e/stand-in-openai-endpoint.mjs --port 0 --key <key> --log <file>
 *
 * prints `stand-in listening on http://127.0.0.1:<port>/v1` once it listens. Also importable: startStandIn().
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MODEL_ID = 'stand-in-coder';
const SHELL_NAMES = /^(shell|bash|exec_command|run_shell_command|exec|local_shell|shell_command)$/i;

const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const asArr = (v) => (Array.isArray(v) ? v : []);

/** The tools as `{ name, parameters }`, from either API's shape. */
export function toolsOf(body) {
  return asArr(body.tools).map((t) => {
    const o = asObj(t);
    const fn = asObj(o.function);
    return { name: String(fn.name || o.name || o.type || ''), parameters: asObj(fn.parameters || o.parameters) };
  }).filter((t) => t.name);
}

/** The harness's shell tool: an exact name first, then any whose name says shell, bash or exec. */
export function shellToolOf(tools) {
  return tools.find((t) => SHELL_NAMES.test(t.name)) || tools.find((t) => /shell|bash|exec|command/i.test(t.name));
}

/** Arguments for that tool that print the marker, built from its schema. */
export function shellArgsFor(tool, marker) {
  const props = asObj(tool.parameters.properties);
  const line = `echo ${marker}`;
  const args = {};
  if (asObj(props.command).type === 'array') args.command = ['sh', '-c', line];
  else if (props.cmd) args.cmd = line;
  else args.command = line;
  for (const req of asArr(tool.parameters.required)) {
    if (args[req] !== undefined) continue;
    const type = asObj(props[req]).type;
    if (type === 'string') args[req] = req === 'description' ? 'Print the probe marker' : '';
    else if (type === 'number' || type === 'integer') args[req] = 30000;
    else if (type === 'boolean') args[req] = false;
  }
  return args;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return asArr(content).map((p) => (typeof p === 'string' ? p : String(asObj(p).text ?? asObj(p).output ?? ''))).join('\n');
}

/**
 * A user message that is only a harness's own reminder, not an instruction: Qwen Code 0.25.2 sends one as a user
 * message right after a tool result (measured 19/11), so "the last user message" is not where a turn starts.
 */
export function isReminderOnly(message) {
  const text = textOf(asObj(message).content).trim();
  return text.length > 0 && text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim() === '';
}

/** Where the messages since the last real user instruction start. */
function sinceLastInstruction(list) {
  let at = -1;
  list.forEach((m, i) => { if (m.role === 'user' && !isReminderOnly(m)) at = i; });
  return list.slice(at + 1);
}

/** Chat completions: the tool results since the last user instruction, as text; null when there is none. */
export function chatToolResult(messages) {
  const results = sinceLastInstruction(asArr(messages).map(asObj)).filter((m) => m.role === 'tool');
  return results.length ? results.map((m) => textOf(m.content)).join('\n') : null;
}

/** Responses: the function_call_output items since the last user instruction, as text; null when there is none. */
export function responsesToolResult(input) {
  if (typeof input === 'string') return null;
  const results = sinceLastInstruction(asArr(input).map(asObj))
    .filter((m) => m.type === 'function_call_output' || m.type === 'custom_tool_call_output');
  return results.length ? results.map((m) => textOf(m.output)).join('\n') : null;
}

/** What the model "decides": a call to the shell tool, or the final text. */
export function decide(body, toolResult, marker) {
  if (toolResult !== null) {
    const m = /TARS-PROBE-[0-9a-f]{8}/.exec(toolResult);
    return { text: m ? `PROBE-OK ${m[0]}` : 'PROBE-NO-RESULT' };
  }
  const tool = shellToolOf(toolsOf(body));
  if (!tool) return { text: 'PROBE-NO-SHELL-TOOL' };
  return { call: { id: `call_${randomBytes(6).toString('hex')}`, name: tool.name, arguments: JSON.stringify(shellArgsFor(tool, marker)) } };
}

const USAGE = { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132, prompt_tokens_details: { cached_tokens: 100 } };
const RESP_USAGE = { input_tokens: 120, output_tokens: 12, total_tokens: 132, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 0 } };

function sse(res, data, event) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function answerChat(body, res, marker, chunkDelayMs = 0) {
  const d = decide(body, chatToolResult(body.messages), marker);
  const id = `chatcmpl-${randomBytes(6).toString('hex')}`;
  const finish = d.call ? 'tool_calls' : 'stop';
  if (!body.stream) {
    const message = d.call
      ? { role: 'assistant', content: null, tool_calls: [{ id: d.call.id, type: 'function', function: { name: d.call.name, arguments: d.call.arguments } }] }
      : { role: 'assistant', content: d.text };
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': `standin-${id}` });
    res.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL_ID, choices: [{ index: 0, message, finish_reason: finish }], usage: USAGE }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Request-Id': `standin-${id}` });
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL_ID };
  sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Thinking about the probe.' }, finish_reason: null }] });
  // A model takes its time between tokens: with a delay, a relay that buffers shows (the first chunk would reach the
  // client only once the last is sent).
  if (chunkDelayMs) await pause(chunkDelayMs);
  if (d.call) {
    sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: d.call.id, type: 'function', function: { name: d.call.name, arguments: '' } }] }, finish_reason: null }] });
    const half = Math.floor(d.call.arguments.length / 2);
    for (const piece of [d.call.arguments.slice(0, half), d.call.arguments.slice(half)]) {
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null }] });
    }
  } else {
    for (const word of d.text.split(/(?= )/)) sse(res, { ...base, choices: [{ index: 0, delta: { content: word }, finish_reason: null }] });
  }
  sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  sse(res, { ...base, choices: [], usage: USAGE });
  res.end('data: [DONE]\n\n');
  return { lastChunkAt: Date.now(), requestId: `standin-${id}` };
}

function answerResponses(body, res, marker) {
  const d = decide(body, responsesToolResult(body.input), marker);
  const id = `resp_${randomBytes(6).toString('hex')}`;
  const item = d.call
    ? { type: 'function_call', id: `fc_${randomBytes(6).toString('hex')}`, call_id: d.call.id, name: d.call.name, arguments: d.call.arguments, status: 'completed' }
    : { type: 'message', id: `msg_${randomBytes(6).toString('hex')}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: d.text, annotations: [] }] };
  const response = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: MODEL_ID, status: 'completed', output: [item], usage: RESP_USAGE };
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': `standin-${id}` });
    res.end(JSON.stringify(response));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Request-Id': `standin-${id}` });
  sse(res, { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, 'response.created');
  sse(res, { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } }, 'response.output_item.added');
  if (d.call) {
    sse(res, { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: d.call.arguments }, 'response.function_call_arguments.delta');
  } else {
    sse(res, { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: d.text }, 'response.output_text.delta');
  }
  sse(res, { type: 'response.output_item.done', output_index: 0, item }, 'response.output_item.done');
  sse(res, { type: 'response.completed', response }, 'response.completed');
  res.end();
}

/**
 * Starts the stand-in. `key` set: any other Bearer gets a 401. `failFirst`: the statuses the first model calls get
 * (503 endpoint_busy, 429 rate_limited, 502), each with `Retry-After: 1`, before any is served, as a remote host
 * outside its window or at its cap answers. `chunkDelayMs`: the pause between a stream's first and next chunks.
 * Resolves with its base URL and a close().
 */
export function startStandIn({ port = 0, key = '', log = '', failFirst = [], chunkDelayMs = 0 } = {}) {
  const marker = `TARS-PROBE-${randomBytes(4).toString('hex')}`;
  const failing = [...failFirst];
  const note = (entry) => { if (log) fs.appendFileSync(log, `${JSON.stringify({ at: Date.now(), ...entry })}\n`); };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString();
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = { unparsed: raw.slice(0, 200) }; }
      if (log) fs.appendFileSync(log, `${JSON.stringify({ at: Date.now(), method: req.method, url: req.url, headers: req.headers, body })}\n`);
      if (key && req.headers.authorization !== `Bearer ${key}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key', type: 'invalid_request_error' } }));
        return;
      }
      const url = (req.url || '').split('?')[0].replace(/\/+$/, '');
      if (req.method === 'GET' && url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL_ID, object: 'model', owned_by: 'stand-in' }] }));
      } else if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/responses') && failing.length) {
        const status = failing.shift();
        const type = status === 503 ? 'endpoint_busy' : status === 429 ? 'rate_limited' : 'engine_unreachable';
        res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '1', 'X-Request-Id': `standin-fail-${status}` });
        res.end(JSON.stringify({ error: { type, message: `stand-in ${type}` } }));
        note({ answered: status });
      } else if (req.method === 'POST' && url === '/v1/chat/completions') {
        const done = await answerChat(asObj(body), res, marker, chunkDelayMs);
        note({ answered: 200, ...(done ?? {}) });
      } else if (req.method === 'POST' && url === '/v1/responses') {
        answerResponses(asObj(body), res, marker);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url}` } }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: bound } = server.address();
      resolve({ baseUrl: `http://127.0.0.1:${bound}/v1`, port: bound, marker, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const s = await startStandIn({ port: Number(arg('port', '0')), key: arg('key', process.env.STAND_IN_KEY || ''), log: arg('log', process.env.STAND_IN_LOG || '') });
  console.log(`stand-in listening on ${s.baseUrl}`);
}
