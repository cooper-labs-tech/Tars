// A Messages API for the live specs: real Claude Code talks to it through
// ANTHROPIC_BASE_URL, with no credentials and no network. `LINES <n> <tag>` in
// the last user turn is answered with n numbered lines, anything else with
// "ok", streamed the way the real API streams. `RUNBASH <tag>` asks for one Bash
// call, `echo <tag> > ran-<tag>.txt`, and the turn that brings its result back
// is answered with that result, which the log keeps (`toolResult`). `RUNBG <tag>`
// asks for one Bash call left running in the background (`sleep 600`).
// `NESTED <tag>` asks for one Bash call that runs Claude Code inside the agent's
// own terminal, `<FAKE_NESTED_CLI> -p "LINES 1 inner<tag>"`, whose own requests
// come here too (the nested CLI of #380's gate).
// Every request is logged as one JSON line to FAKE_LOG, which is how a spec
// knows a turn reached the model (`full`: the whole last user turn, 8000
// characters at most, for messages Claude Code joins into one turn), with the effort Claude Code asked for
// (`output_config.effort`) and the credential it presented, by its role
// (`auth`, against FAKE_KEY when a spec sets one). Adapted from the Frontend's
// #132 proof.
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.FAKE_PORT);
const LOG = process.env.FAKE_LOG;
if (!PORT || !LOG) throw new Error('FAKE_PORT and FAKE_LOG are required');

const log = entry => fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
// The credential a request carried, by its role and never its value: the key a spec handed the agent (FAKE_KEY),
// another one (a subscription's OAuth token, a key from the user's shell), or none.
const roleOf = given => (given === undefined ? null : process.env.FAKE_KEY && given === process.env.FAKE_KEY ? 'the key' : 'another');
const authOf = headers => ({
  bearer: roleOf(/^Bearer /i.test(headers.authorization ?? '') ? headers.authorization.slice(7) : undefined),
  xApiKey: roleOf(headers['x-api-key']),
});
const sse = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

function textOf(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content || []).map(block => (block.type === 'text' ? block.text : block.type === 'tool_result' ? '[tool_result]' : '')).join('\n');
}

/** The text of the last tool_result the request carries, or null. */
function lastToolResult(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = Array.isArray(messages[i].content) ? messages[i].content : [];
    const result = blocks.filter(b => b.type === 'tool_result').pop();
    if (result) {
      return typeof result.content === 'string' ? result.content
        : (result.content || []).map(c => c.text || '').join('\n');
    }
    if (messages[i].role === 'assistant') return null;
  }
  return null;
}

function toolUse(res, model, tag, command = `echo ${tag} > ran-${tag}.txt`, description = `Write ran-${tag}.txt`) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, 'message_start', {
    message: {
      id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  const input = { command, description };
  sse(res, 'content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${tag}_${Date.now()}`, name: 'Bash', input: {} } });
  sse(res, 'content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
  sse(res, 'content_block_stop', { index: 0 });
  sse(res, 'message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
  sse(res, 'message_stop', {});
  res.end();
}

function reply(res, model, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, 'message_start', {
    message: {
      id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  sse(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  sse(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  sse(res, 'content_block_stop', { index: 0 });
  sse(res, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  sse(res, 'message_stop', {});
  res.end();
}

/** `RUNBG <tag>`: one Bash call left running in the background, `sleep 600`. */
function backgroundBash(res, model, tag) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, 'message_start', {
    message: {
      id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  const input = { command: 'sleep 600', description: `Wait in the background (${tag})`, run_in_background: true };
  sse(res, 'content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${tag}_${Date.now()}`, name: 'Bash', input: {} } });
  sse(res, 'content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
  sse(res, 'content_block_stop', { index: 0 });
  sse(res, 'message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
  sse(res, 'message_stop', {});
  res.end();
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    let json = {};
    try { json = JSON.parse(body || '{}'); } catch { /* an empty or odd body is answered like any other */ }
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); return res.end('{}'); }
    if (req.url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"input_tokens":10}');
    }
    const model = json.model || 'model';
    const messages = json.messages || [];
    let k = messages.length - 1;
    while (k >= 0 && messages[k].role !== 'assistant') k--;
    const last = messages.slice(k + 1).map(textOf).join('\n').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
    const side = String(model).includes('haiku');
    // The command the turn carries, which Claude Code follows with context of its
    // own: logging the end of the turn would lose it. And the end as well: the
    // caveat of a local command run just before (`/effort low`, claude 2.1.300)
    // can open the turn, ahead of what was typed after it.
    log({ url: req.url, model, stream: !!json.stream, side, effort: json.output_config?.effort ?? null, last: (last.match(/LINES \d+ \w+/) || [last.slice(0, 200)])[0], tail: last.slice(-200), full: last.slice(0, 8000), auth: authOf(req.headers) });
    if (!json.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'msg_x', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
      }));
    }
    const result = !side ? lastToolResult(messages) : null;
    if (result !== null) {
      log({ toolResult: result.slice(0, 500) });
      return reply(res, model, `tool said: ${result.slice(0, 300)}`);
    }
    const run = !side && last.match(/RUNBASH (\w+)/);
    if (run) return toolUse(res, model, run[1]);
    const nested = !side && process.env.FAKE_NESTED_CLI && last.match(/NESTED (\w+)/);
    if (nested) {
      return toolUse(res, model, nested[1], `'${process.env.FAKE_NESTED_CLI}' -p "LINES 1 inner${nested[1]}" > nested-${nested[1]}.txt 2>&1`, `Run Claude Code inside this terminal (${nested[1]})`);
    }
    const background = !side && last.match(/RUNBG (\w+)/);
    if (background) return backgroundBash(res, model, background[1]);
    const lines = !side && last.match(/LINES (\d+) (\w+)/);
    if (lines) {
      return reply(res, model, Array.from({ length: Number(lines[1]) }, (_, i) => `${lines[2]} line ${i + 1} of ${lines[1]}`).join('\n'));
    }
    return reply(res, model, 'ok');
  });
}).listen(PORT, '127.0.0.1', () => log({ listening: PORT }));
