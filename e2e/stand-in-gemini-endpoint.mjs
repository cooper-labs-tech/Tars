/**
 * A stand-in of Gemini's API (generativelanguage.googleapis.com), loopback only, no network, for the real Gemini CLI
 * started with GOOGLE_GEMINI_BASE_URL pointing here and an API key (the gemini-api-key auth type): what
 * e2e/stand-in-openai-endpoint.mjs is to the OpenAI-compatible harnesses.
 *
 * Served: `POST /v1beta/models/<model>:streamGenerateContent` (server-sent events with `alt=sse`, a JSON array
 * otherwise), `:generateContent`, `:countTokens`, and `GET /v1beta/models`. The key is read from `x-goog-api-key` or
 * `?key=`; any other key is refused as Google refuses it (400, API_KEY_INVALID).
 *
 * One task shape. On a turn whose last part is not yet a function response, it calls a tool: the first declared
 * function whose name matches `tool` (Tars's `whoami` by default, an MCP tool of Tars's orchestrator server), else the
 * CLI's shell tool printing the marker. On the turn carrying the function response, it answers in text:
 * `PROBE-OK <marker>` when the response holds `expect` (the agent's own id, for whoami: proof the MCP call reached
 * Tars with the agent's own identity) or the marker, `PROBE-NO-RESULT <what came back>` otherwise. A request asking
 * for JSON (`responseMimeType: application/json`, the CLI's own side questions) is answered with a JSON object that
 * hands the turn back to the user.
 *
 * Every request is logged, one JSON line each, the key's header replaced by whether it matched, to the file `log`.
 * Importable: startGeminiStandIn({ key, log, tool?, expect? }) -> { baseUrl, marker, close }.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';

export const GEMINI_MODEL_ID = 'gemini-2.5-flash';

const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const asArr = (v) => (Array.isArray(v) ? v : []);

/** Every function the request declares: `{ name, parameters }`. */
export function declaredFunctions(body) {
  return asArr(body.tools).flatMap((t) => asArr(asObj(t).functionDeclarations)).map((f) => ({
    name: String(asObj(f).name ?? ''),
    parameters: asObj(asObj(f).parameters ?? asObj(f).parametersJsonSchema),
  })).filter((f) => f.name);
}

/** The last part of the conversation, if it is a function response: `{ name, response }`. */
export function lastFunctionResponse(body) {
  const contents = asArr(body.contents);
  const last = asObj(contents[contents.length - 1]);
  const parts = asArr(last.parts);
  const found = parts.map((p) => asObj(asObj(p).functionResponse)).find((r) => r.name);
  return found ? { name: String(found.name), response: found.response } : null;
}

/** What the stand-in answers for one request body: its parts. */
export function answerFor(body, { marker, tool = /whoami/i, expect }) {
  if (asObj(body.generationConfig).responseMimeType === 'application/json') {
    return [{ text: JSON.stringify({ reasoning: 'The model answered; the user speaks next.', next_speaker: 'user' }) }];
  }
  const done = lastFunctionResponse(body);
  if (done) {
    const said = JSON.stringify(done.response ?? '');
    const ok = expect ? said.includes(expect) : said.includes(marker);
    return [{ text: ok ? `PROBE-OK ${marker}` : `PROBE-NO-RESULT ${said.slice(0, 300)}` }];
  }
  const functions = declaredFunctions(body);
  const chosen = functions.find((f) => tool.test(f.name));
  if (chosen) return [{ functionCall: { name: chosen.name, args: {} } }];
  const shell = functions.find((f) => /shell|bash|command/i.test(f.name));
  if (shell) return [{ functionCall: { name: shell.name, args: { command: `echo ${marker}`, description: 'Print the probe marker' } } }];
  return [{ text: 'PROBE-NO-TOOL' }];
}

const response = (parts) => ({
  candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
  modelVersion: GEMINI_MODEL_ID,
});

export async function startGeminiStandIn({ key, log, tool, expect } = {}) {
  const marker = `TARS-PROBE-${randomBytes(4).toString('hex')}`;
  const note = (entry) => { if (log) fs.appendFileSync(log, `${JSON.stringify({ at: Date.now(), ...entry })}\n`); };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const given = String(req.headers['x-goog-api-key'] ?? url.searchParams.get('key') ?? '');
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'x-goog-api-key'));
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = { unparsed: raw.slice(0, 2000) }; }
      const keyOk = !key || given === key;
      note({ method: req.method, url: url.pathname + url.search, keyOk, headers, body });
      if (!keyOk) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } }));
        return;
      }
      const [, action] = url.pathname.match(/:([A-Za-z]+)$/) ?? [];
      if (req.method === 'GET' && /\/models\/?$/.test(url.pathname)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: `models/${GEMINI_MODEL_ID}`, displayName: 'Stand-in', supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'] }] }));
        return;
      }
      if (action === 'countTokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ totalTokens: 12 }));
        return;
      }
      if (action === 'generateContent' || action === 'streamGenerateContent') {
        const parts = answerFor(body, { marker, tool, expect });
        note({ answered: parts });
        if (action === 'generateContent') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(response(parts)));
        } else if (url.searchParams.get('alt') === 'sse') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.end(`data: ${JSON.stringify(response(parts))}\r\n\r\n`);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([response(parts)]));
        }
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 404, message: `Not served by the stand-in: ${req.method} ${url.pathname}`, status: 'NOT_FOUND' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, marker, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// Run as a command: read by its file name, not import.meta, which Playwright's CommonJS transform does not have.
if ((process.argv[1] || '').endsWith('stand-in-gemini-endpoint.mjs')) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const s = await startGeminiStandIn({ key: arg('key'), log: arg('log') ?? process.env.STAND_IN_LOG, expect: arg('expect') });
  console.log(`gemini stand-in listening on ${s.baseUrl} marker ${s.marker}`);
}
