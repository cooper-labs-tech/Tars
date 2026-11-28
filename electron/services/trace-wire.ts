import { createHash } from 'crypto';

/**
 * Reading what crossed the wire into a trace (native traces).
 *
 * The endpoint proxy (services/endpoint-proxy.ts) relays a harness's request and the endpoint's response unchanged;
 * once the response has ended, it hands a copy of both here. This reads them on the three protocols the proxy
 * passes, chat completions, Responses and Anthropic Messages, streamed or not:
 * - the request as its system prompt, its tools, its history (one entry per message or input item, as the harness
 *   sent it, so the history resent on every request is stored once by its hash), and every other param, kept;
 * - the response as one output (the assistant message, or Responses' output items, put back together from the
 *   stream), its usage, its finish reason and the model that served it;
 * - for a stream, where its first event carrying text, reasoning or a tool call ends (firstContentEnd), which the
 *   proxy turns into the time of the model's first token (TTFT).
 *
 * Nothing here changes a byte that goes to the harness or to the endpoint.
 */

export type Surface = 'openai_chat' | 'openai_responses' | 'anthropic_messages';

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/**
 * A token count as the back-office takes it, a whole number of 0 or more: an endpoint's fraction is rounded (the Audit
 * of #678, I-1), and a negative count from a broken endpoint is 0 (the Audit of #687 at e534063f4).
 */
const tokenCount = (v: unknown): number => Math.max(0, Math.round(asNum(v)));

/** The traced surface a request path is, or null for anything else (models, count_tokens, unknown routes). */
export function surfaceOf(pathname: string): Surface | null {
  if (pathname === '/v1/chat/completions') return 'openai_chat';
  if (pathname === '/v1/responses') return 'openai_responses';
  if (pathname === '/v1/messages') return 'anthropic_messages';
  return null;
}

/** JSON with every object's keys sorted: equal content, equal text, whatever order a harness wrote it in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Json;
    return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The content hash a message, a tool set or a system prompt is stored under. */
export function hashOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** A harness's installation id, by its name (codex 0.170: `x-codex-installation-id`, and `installation_id`). */
const INSTALL_ID_KEY = /installation[-_]?id/i;

/**
 * A value with every installation id taken out, at any depth, and inside a string that holds a JSON object (codex's
 * turn metadata): a stable id of the computer, which a trace never keeps. Everything else is left as it was, and the
 * value given is not changed. A string that only looks like JSON stays as it is.
 */
export function withoutInstallIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutInstallIds);
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) if (!INSTALL_ID_KEY.test(k)) out[k] = withoutInstallIds(v);
    return out;
  }
  if (typeof value === 'string' && value.startsWith('{') && INSTALL_ID_KEY.test(value)) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return JSON.stringify(withoutInstallIds(parsed));
    } catch { /* not JSON: kept as it is */ }
  }
  return value;
}

export interface WireRequest {
  /** Every field but the system prompt, the tools and the history, as sent, but for installation ids (withoutInstallIds). */
  params: Json;
  system?: unknown;
  tools?: unknown[];
  /** The history, one entry per message or input item. */
  input: unknown[];
  stream: boolean;
  model?: string;
}

/** A request body read as a trace reads it; null when it is not a JSON object. */
export function parseRequest(surface: Surface, body: Buffer): WireRequest | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const b = parsed as Json;
  const params: Json = {};
  const skip = new Set(['tools', surface === 'openai_chat' ? 'messages' : surface === 'openai_responses' ? 'input' : 'messages',
    surface === 'openai_responses' ? 'instructions' : 'system']);
  for (const [k, v] of Object.entries(b)) if (!skip.has(k) && !INSTALL_ID_KEY.test(k)) params[k] = withoutInstallIds(v);
  let system: unknown;
  let input: unknown[];
  if (surface === 'openai_chat') {
    const messages = asArr(b.messages);
    let lead = 0;
    while (lead < messages.length && ['system', 'developer'].includes(asStr(asObj(messages[lead]).role))) lead++;
    system = lead > 0 ? messages.slice(0, lead) : undefined;
    input = messages.slice(lead);
  } else if (surface === 'openai_responses') {
    system = b.instructions;
    input = typeof b.input === 'string' ? [{ role: 'user', content: b.input }] : asArr(b.input);
  } else {
    system = b.system;
    input = asArr(b.messages);
  }
  return {
    params, system, input,
    tools: Array.isArray(b.tools) ? b.tools : undefined,
    stream: b.stream === true,
    model: typeof b.model === 'string' ? b.model : undefined,
  };
}

export interface WireResponse {
  output: unknown | null;
  usage: { input: number; cached: number; output: number };
  finishReason?: string;
  modelServed?: string;
  toolCalls: number;
  error?: string;
}

/** The `data:` payloads of an SSE body, parsed; lines that are not JSON are skipped. */
function sseEvents(text: string): Json[] {
  const out: Json[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    try { out.push(asObj(JSON.parse(data))); } catch { /* not JSON: skipped */ }
  }
  return out;
}

function chatUsage(u: unknown): WireResponse['usage'] {
  const o = asObj(u);
  return { input: tokenCount(o.prompt_tokens), cached: tokenCount(asObj(o.prompt_tokens_details).cached_tokens), output: tokenCount(o.completion_tokens) };
}

function responsesUsage(u: unknown): WireResponse['usage'] {
  const o = asObj(u);
  return { input: tokenCount(o.input_tokens), cached: tokenCount(asObj(o.input_tokens_details).cached_tokens), output: tokenCount(o.output_tokens) };
}

const RESPONSES_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'computer_call', 'mcp_call']);

function readChat(streamed: boolean, text: string): WireResponse {
  if (!streamed) {
    const b = asObj(JSON.parse(text));
    const choice = asObj(asArr(b.choices)[0]);
    const message = choice.message === undefined ? null : choice.message;
    return { output: message, usage: chatUsage(b.usage), finishReason: asStr(choice.finish_reason) || undefined, modelServed: asStr(b.model) || undefined, toolCalls: asArr(asObj(message).tool_calls).length };
  }
  let content = '';
  let reasoning = '';
  let role = 'assistant';
  let finish: string | undefined;
  let model: string | undefined;
  let usage = { input: 0, cached: 0, output: 0 };
  const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  for (const e of sseEvents(text)) {
    if (e.model) model = asStr(e.model);
    if (e.usage) usage = chatUsage(e.usage);
    for (const raw of asArr(e.choices)) {
      const choice = asObj(raw);
      const delta = asObj(choice.delta);
      if (delta.role) role = asStr(delta.role);
      content += asStr(delta.content);
      reasoning += asStr(delta.reasoning_content) + asStr(delta.reasoning);
      for (const rawCall of asArr(delta.tool_calls)) {
        const tc = asObj(rawCall);
        const fn = asObj(tc.function);
        const at = asNum(tc.index);
        const call = calls.get(at) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) call.id = asStr(tc.id);
        if (tc.type) call.type = asStr(tc.type);
        if (fn.name) call.function.name += asStr(fn.name);
        call.function.arguments += asStr(fn.arguments);
        calls.set(at, call);
      }
      if (choice.finish_reason) finish = asStr(choice.finish_reason);
    }
  }
  const output: Json = { role, content: content || null };
  if (reasoning) output.reasoning_content = reasoning;
  if (calls.size) output.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  return { output, usage, finishReason: finish, modelServed: model, toolCalls: calls.size };
}

function readResponses(streamed: boolean, text: string): WireResponse {
  const fromResponse = (r: Json, finish?: string): WireResponse => {
    const output = asArr(r.output);
    return {
      output, usage: responsesUsage(r.usage), finishReason: finish ?? (asStr(r.status) || undefined), modelServed: asStr(r.model) || undefined,
      toolCalls: output.filter(i => RESPONSES_CALLS.has(asStr(asObj(i).type))).length,
    };
  };
  if (!streamed) return fromResponse(asObj(JSON.parse(text)));
  const done: unknown[] = [];
  let model: string | undefined;
  for (const e of sseEvents(text)) {
    const type = asStr(e.type);
    if (type === 'response.created' || type === 'response.in_progress') model = asStr(asObj(e.response).model) || model;
    if (type === 'response.output_item.done') done.push(e.item);
    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') return fromResponse(asObj(e.response));
  }
  return {
    output: done, usage: { input: 0, cached: 0, output: 0 }, finishReason: 'incomplete', modelServed: model,
    toolCalls: done.filter(i => RESPONSES_CALLS.has(asStr(asObj(i).type))).length,
  };
}

function readMessages(streamed: boolean, text: string): WireResponse {
  if (!streamed) {
    const b = asObj(JSON.parse(text));
    const u = asObj(b.usage);
    const content = asArr(b.content);
    return {
      output: { role: 'assistant', content }, finishReason: asStr(b.stop_reason) || undefined, modelServed: asStr(b.model) || undefined,
      usage: { input: tokenCount(u.input_tokens), cached: tokenCount(u.cache_read_input_tokens), output: tokenCount(u.output_tokens) },
      toolCalls: content.filter(c => asObj(c).type === 'tool_use').length,
    };
  }
  const blocks = new Map<number, Json & { _json?: string }>();
  const usage = { input: 0, cached: 0, output: 0 };
  let finish: string | undefined;
  let model: string | undefined;
  for (const e of sseEvents(text)) {
    const type = asStr(e.type);
    if (type === 'message_start') {
      const m = asObj(e.message);
      model = asStr(m.model) || undefined;
      const u = asObj(m.usage);
      usage.input = tokenCount(u.input_tokens);
      usage.cached = tokenCount(u.cache_read_input_tokens);
      usage.output = tokenCount(u.output_tokens);
    } else if (type === 'content_block_start') {
      blocks.set(asNum(e.index), { ...asObj(e.content_block) });
    } else if (type === 'content_block_delta') {
      const block = blocks.get(asNum(e.index));
      const d = asObj(e.delta);
      if (!block) continue;
      if (d.type === 'text_delta') block.text = asStr(block.text) + asStr(d.text);
      else if (d.type === 'thinking_delta') block.thinking = asStr(block.thinking) + asStr(d.thinking);
      else if (d.type === 'signature_delta') block.signature = asStr(block.signature) + asStr(d.signature);
      else if (d.type === 'input_json_delta') block._json = (block._json ?? '') + asStr(d.partial_json);
    } else if (type === 'message_delta') {
      finish = asStr(asObj(e.delta).stop_reason) || finish;
      const u = asObj(e.usage);
      if (u.output_tokens !== undefined) usage.output = tokenCount(u.output_tokens);
    }
  }
  const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => {
    const { _json, ...rest } = b;
    if (_json !== undefined) {
      try { rest.input = JSON.parse(_json || '{}'); } catch { rest.input = _json; }
    }
    return rest;
  });
  return { output: { role: 'assistant', content }, usage, finishReason: finish, modelServed: model, toolCalls: content.filter(c => c.type === 'tool_use').length };
}

/** Whether a response body is a stream (SSE), by its content type or, failing that, its first line. */
export function isStreamed(contentType: string | undefined, text: string): boolean {
  return /text\/event-stream/i.test(contentType ?? '') || /^\s*(event|data):/.test(text);
}

const filled = (v: unknown): boolean => (typeof v === 'string' ? v.length > 0 : Array.isArray(v) && v.length > 0);

/**
 * Whether a stream event carries something the model produced: text, reasoning or a tool call (TTFT measures the
 * model, the owner's decision of 26/11). A chunk with only a role, an empty delta, usage, `ping`, the stream's own
 * bookkeeping (`response.created`, `message_start`, a text or message block opened empty) carries nothing.
 */
function carriesContent(surface: Surface, e: Json): boolean {
  if (surface === 'openai_chat') {
    return asArr(e.choices).some(c => {
      const d = asObj(asObj(c).delta);
      return filled(d.content) || filled(d.reasoning_content) || filled(d.reasoning) || filled(d.refusal) || filled(d.tool_calls);
    });
  }
  const type = asStr(e.type);
  if (surface === 'openai_responses') {
    if (type.endsWith('.delta')) return filled(e.delta);
    if (type === 'response.output_item.added') {
      const item = asStr(asObj(e.item).type);
      // A tool call item (a function, custom or built-in tool) is the model's choice; a message or reasoning item is
      // opened empty and fills in with deltas.
      return item !== '' && item !== 'message' && item !== 'reasoning';
    }
    return false;
  }
  if (type === 'content_block_delta') {
    const d = asObj(e.delta);
    return filled(d.text) || filled(d.thinking) || filled(d.partial_json);
  }
  if (type === 'content_block_start') {
    const b = asObj(e.content_block);
    return /tool_use$/.test(asStr(b.type)) || filled(b.text) || filled(b.thinking);
  }
  return false;
}

/**
 * Where, in bytes, the first stream event carrying content ends (its blank line included), so the time it arrived
 * can be read from when each chunk came: the proxy's TTFT. Null for a body that is not streamed, or a stream with no
 * such event that ended.
 */
export function firstContentEnd(surface: Surface, contentType: string | undefined, body: Buffer): number | null {
  const text = body.toString('utf8');
  if (!isStreamed(contentType, text)) return null;
  const boundary = /\r?\n\r?\n/g;
  let start = 0;
  for (let m = boundary.exec(text); m; m = boundary.exec(text)) {
    const block = text.slice(start, m.index);
    const end = m.index + m[0].length;
    start = end;
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    let event: Json;
    try { event = asObj(JSON.parse(data)); } catch { continue; }
    if (carriesContent(surface, event)) return Buffer.byteLength(text.slice(0, end));
  }
  return null;
}

/** A response read as a trace reads it. Never throws: what cannot be read is an error with its first bytes. */
export function parseResponse(surface: Surface, status: number, contentType: string | undefined, body: Buffer): WireResponse {
  const text = body.toString('utf8');
  const empty: WireResponse = { output: null, usage: { input: 0, cached: 0, output: 0 }, toolCalls: 0 };
  if (status < 200 || status >= 300) return { ...empty, error: `HTTP ${status}: ${text.slice(0, 500)}` };
  const streamed = isStreamed(contentType, text);
  try {
    if (surface === 'openai_chat') return readChat(streamed, text);
    if (surface === 'openai_responses') return readResponses(streamed, text);
    return readMessages(streamed, text);
  } catch (err) {
    return { ...empty, error: `unreadable response: ${(err as Error).message}` };
  }
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return asArr(content).map(p => {
    const o = asObj(p);
    return asStr(o.text) || (typeof p === 'string' ? p : '');
  }).filter(Boolean).join('\n');
}

const withoutReminders = (text: string): string => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

/** The last input entry if it is a user instruction (not a tool result, not a reminder alone), else null. */
function lastInstruction(surface: Surface, input: unknown[]): Json | null {
  const last = asObj(input[input.length - 1]);
  if (surface === 'openai_responses') {
    if (last.type && last.type !== 'message') return null;
  }
  if (last.role !== 'user') return null;
  if (surface === 'anthropic_messages' && asArr(last.content).some(c => asObj(c).type === 'tool_result')) return null;
  return withoutReminders(textOfContent(last.content)) ? last : null;
}

/** Whether a request opens a turn: its last history entry is a new user instruction (the reader's trace format). */
export function opensTurn(surface: Surface, input: unknown[]): boolean {
  return lastInstruction(surface, input) !== null;
}

/** A history item that carries a tool's result: Responses' outputs, a chat `tool` message, Anthropic's tool_result. */
function isToolResult(surface: Surface, item: unknown): boolean {
  const o = asObj(item);
  if (o.type === 'function_call_output' || o.type === 'custom_tool_call_output' || o.role === 'tool') return true;
  return surface === 'anthropic_messages' && o.role === 'user' && asArr(o.content).some(c => asObj(c).type === 'tool_result');
}

/** A history item the model said: an assistant message, or one of Responses' output items. */
function isModelItem(item: unknown): boolean {
  const o = asObj(item);
  return o.role === 'assistant' || o.type === 'function_call' || o.type === 'custom_tool_call' || o.type === 'reasoning';
}

/** A user message that says nothing but the harness's reminders (and holds no tool result or image). */
function isReminderOnly(item: unknown): boolean {
  const o = asObj(item);
  if (o.role !== 'user') return false;
  const parts = typeof o.content === 'string' ? [] : asArr(o.content).map(asObj);
  if (parts.some(p => p.type !== undefined && p.type !== 'text' && p.type !== 'input_text')) return false;
  const text = textOfContent(o.content);
  return text.trim() !== '' && withoutReminders(text) === '';
}

/** An item with its reminder blocks taken out of every text, and the parts they emptied dropped. */
function withoutReminderParts(item: unknown): unknown {
  const o = asObj(item);
  if (typeof o.content === 'string') return { ...o, content: withoutReminders(o.content) };
  if (!Array.isArray(o.content)) return item;
  const parts = o.content.map((p) => {
    const q = asObj(p);
    return typeof q.text === 'string' ? { ...q, text: withoutReminders(q.text) } : p;
  }).filter(p => !(typeof asObj(p).text === 'string' && asObj(p).text === '' && ['text', 'input_text'].includes(String(asObj(p).type))));
  return { ...o, content: parts };
}

/**
 * A history's keys, as the rewrite rule compares them (trace feature C2): each item's hash with the harness's reminder
 * blocks taken out, the messages that say nothing but reminders left out. Measured on Qwen Code 0.25.2 (28/11): a
 * reminder appended to the first user message moves into a trailing reminder-only message, which the next request
 * drops; the task, the answers and the tool results stay. 16 hex characters each; `index` is the item's place.
 */
export function historyKeys(input: unknown[]): Array<{ key: string; index: number }> {
  const out: Array<{ key: string; index: number }> = [];
  input.forEach((item, index) => {
    if (!isReminderOnly(item)) out.push({ key: hashOf(withoutReminderParts(item)).slice(0, 16), index });
  });
  return out;
}

/**
 * Whether a request's history rewrites the one before (trace feature C2), and how, from what crossed the wire only,
 * compared by their keys (historyKeys):
 * - kept whole at the head and grown as a conversation grows (the tool's result the last answer asked for, or after
 *   a plain answer the answer itself), or sent again as it was: no rewrite;
 * - kept at the head but grown with a new instruction instead of the tool's result or the answer (codex 0.163 after a
 *   compaction, measured 27/11: the old history, then the summary as a user message): `compact`, `kept: true`. An
 *   answer cut short then words typed through Tars look the same: the caller tells them apart (trace-store.ts);
 * - not kept at the head: `truncate` when only older items were dropped (nothing new before the items kept, no new
 *   instruction after them), else `compact` (a summary in place of what went).
 * `previous` is the earlier main request's keys, and whether its answer asked for a tool.
 */
export function historyRewrite(surface: Surface, previous: { keys: string[]; askedTool: boolean }, input: unknown[]): { kind: 'compact' | 'truncate'; kept: boolean } | null {
  const prev = previous.keys;
  if (!prev.length) return null;
  const cur = historyKeys(input);
  if (prev.every((k, i) => cur[i]?.key === k)) {
    const grown = cur.slice(prev.length).map(c => input[c.index]);
    if (!grown.length) return null;
    const continues = previous.askedTool ? grown.some(i => isToolResult(surface, i)) : grown.some(isModelItem);
    if (continues) return null;
    return grown.some(i => lastInstruction(surface, [i]) !== null) ? { kind: 'compact', kept: true } : null;
  }
  const kept = new Set(prev);
  let lastKept = -1;
  cur.forEach((c, i) => { if (kept.has(c.key)) lastKept = i; });
  if (lastKept < 0) return { kind: 'compact', kept: false };
  const newBefore = cur.slice(0, lastKept + 1).some(c => !kept.has(c.key));
  const newInstruction = cur.slice(lastKept + 1).some(c => lastInstruction(surface, [input[c.index]]) !== null);
  return { kind: newBefore || newInstruction ? 'compact' : 'truncate', kept: false };
}

/** The instruction's own words, the harness's reminders left out: what authorship is matched on. */
export function instructionText(surface: Surface, input: unknown[]): string {
  const last = lastInstruction(surface, input);
  return last ? withoutReminders(textOfContent(last.content)) : '';
}
