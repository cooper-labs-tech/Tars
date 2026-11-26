// An OpenAI-style API for the live specs: real codex (the Responses API) and real Qwen Code (chat completions) talk to
// it through their own configuration, with no account and no network. Every turn is answered with the text "ok",
// streamed the way each API streams; no tool is ever called. Each request is logged as one JSON line to FAKE_LOG:
// its protocol, the names of the tools it offered the model, and its body as text (the last 30000 characters), which
// is how a spec knows a message reached the model. GET /v1/models lists the one model, FAKE_MODEL. The shapes are those
// codex 0.163 and Qwen Code 0.25.2 took from the agent-inbox bench's stand-in (2026-11-26).
import http from 'node:http';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.FAKE_PORT);
const LOG = process.env.FAKE_LOG;
const MODEL = process.env.FAKE_MODEL || 'stand-in-coder';
if (!PORT || !LOG) throw new Error('FAKE_PORT and FAKE_LOG are required');

const log = entry => fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
const sse = (res, data, event) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
const toolNames = body => (Array.isArray(body.tools) ? body.tools : [])
  .map(t => t?.name ?? t?.function?.name).filter(name => typeof name === 'string');
const id = prefix => `${prefix}${randomBytes(6).toString('hex')}`;

function chat(body, res) {
  const cid = id('chatcmpl-');
  const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: cid, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const base = { id: cid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL };
  sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] });
  sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  sse(res, { ...base, choices: [], usage });
  res.end('data: [DONE]\n\n');
}

function responses(body, res) {
  const item = { type: 'message', id: id('msg_'), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] };
  const response = { id: id('resp_'), object: 'response', created_at: Math.floor(Date.now() / 1000), model: MODEL, status: 'completed', output: [item],
    usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(response));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, 'response.created');
  sse(res, { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } }, 'response.output_item.added');
  sse(res, { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: 'ok' }, 'response.output_text.delta');
  sse(res, { type: 'response.output_item.done', output_index: 0, item }, 'response.output_item.done');
  sse(res, { type: 'response.completed', response }, 'response.completed');
  res.end();
}

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { body = {}; }
    const url = (req.url || '').split('?')[0].replace(/\/+$/, '');
    const proto = /\/chat\/completions$/.test(url) ? 'chat' : /\/responses$/.test(url) ? 'responses' : /\/models$/.test(url) ? 'models' : 'other';
    if (proto !== 'models') log({ url: req.url, proto, tools: toolNames(body), text: JSON.stringify(body).slice(-30000) });
    if (req.method === 'GET' && proto === 'models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'stand-in' }] }));
    }
    if (req.method === 'POST' && proto === 'chat') return chat(body, res);
    if (req.method === 'POST' && proto === 'responses') return responses(body, res);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url}` } }));
  });
}).listen(PORT, '127.0.0.1', () => log({ listening: PORT }));
