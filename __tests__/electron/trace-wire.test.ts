import { describe, it, expect } from 'vitest';
import {
  surfaceOf, parseRequest, parseResponse, opensTurn, instructionText, hashOf, canonicalJson, firstContentEnd,
} from '../../electron/services/trace-wire';

/**
 * Reading what crossed the wire into a trace (native traces): the request a harness sent and the
 * response the endpoint gave, on the three protocols the proxy passes (chat completions, Responses, Anthropic
 * Messages), streamed or not. The proxy relays the bytes unchanged; this only reads a copy of them afterwards.
 *
 * How it fails, written before the code (19/11):
 * 1. A path is read as a traced surface when it is not one (`/v1/models`, count_tokens, an unknown path).
 * 2. A body that is not JSON throws instead of reading as nothing.
 * 3. The system prompt is lost or counted as a history message: chat's leading system or developer messages,
 *    Responses' `instructions`, Messages' `system`.
 * 4. Unknown request params are dropped from `params` (an endpoint may add vendor fields; nothing is stripped).
 * 5. A streamed chat answer loses its tool call: the arguments come in pieces, keyed by index.
 * 6. Reasoning (`reasoning_content` or `reasoning`) is dropped from a streamed chat answer.
 * 7. Usage is missing: chat's final usage chunk with `prompt_tokens_details.cached_tokens`, Responses'
 *    `response.completed` usage with `input_tokens_details.cached_tokens`, Messages' `message_start` input and
 *    `cache_read_input_tokens` plus `message_delta` output.
 * 8. A Responses stream with no `response.completed` (cut) loses the items it did finish.
 * 9. A Messages stream loses its tool_use input, sent as `input_json_delta` pieces.
 * 10. An error response is read as a success with no output.
 * 11. A tool result opens a turn; Qwen Code's reminder-only user message after a tool result opens a turn
 *     (measured 19/11); a Messages user turn holding a tool_result block opens a turn; a real instruction does not.
 * 12. Two messages equal in content but with keys in another order hash differently, so the history resent on every
 *     request is stored twice.
 * 13. The instruction's text, read for authorship, includes the harness's reminders.
 * Added before their code, the owner's decision of 26/11 (TTFT measures the model):
 * 14. Chat completions: a chunk with only a role, an empty content, or only usage is taken for the first token; or a
 *     first chunk of reasoning (`reasoning_content`, `reasoning`) or of a tool call is not.
 * 15. Responses: `response.created`, a message item added, or an empty delta is taken for the first token; or the
 *     first non-empty text, reasoning or tool-call arguments delta, or a function call item added, is not.
 * 16. Anthropic Messages: `message_start`, a text block started, `ping` or an empty text delta is taken for the first
 *     token; or a thinking delta, a tool_use block started or an input_json delta is not.
 * 17. A body that is not streamed, or a stream with no content at all, gives a place for the first token.
 * 18. The place is not in bytes (a multibyte character before it moves it), or is before the end of its event.
 */

const buf = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));
const sse = (events: Array<unknown>, named = false) => buf(events.map((e) => {
  const o = e as { type?: string };
  return `${named && o.type ? `event: ${o.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`;
}).join('') + (named ? '' : 'data: [DONE]\n\n'));

describe('surfaces', () => {
  it('1: only the three model routes are traced surfaces', () => {
    expect(surfaceOf('/v1/chat/completions')).toBe('openai_chat');
    expect(surfaceOf('/v1/responses')).toBe('openai_responses');
    expect(surfaceOf('/v1/messages')).toBe('anthropic_messages');
    for (const p of ['/v1/models', '/v1/messages/count_tokens', '/v1/embeddings', '/chat/completions', '/v1/responses/abc']) {
      expect(surfaceOf(p), p).toBeNull();
    }
  });
});

describe('requests', () => {
  it('2: a body that is not JSON reads as nothing', () => {
    expect(parseRequest('openai_chat', buf('not json'))).toBeNull();
    expect(parseRequest('openai_chat', buf('[1,2]'))).toBeNull();
  });

  it('3 and 4: the system prompt is apart from the history, and every other param is kept', () => {
    const chat = parseRequest('openai_chat', buf({
      model: 'm', stream: true, temperature: 0.2, vendor_x: { a: 1 },
      tools: [{ type: 'function', function: { name: 'bash', parameters: {} } }],
      messages: [{ role: 'system', content: 'S' }, { role: 'developer', content: 'D' }, { role: 'user', content: 'U' }],
    }))!;
    expect(chat.system).toEqual([{ role: 'system', content: 'S' }, { role: 'developer', content: 'D' }]);
    expect(chat.input).toEqual([{ role: 'user', content: 'U' }]);
    expect(chat.params).toEqual({ model: 'm', stream: true, temperature: 0.2, vendor_x: { a: 1 } });
    expect(chat.tools).toHaveLength(1);
    expect(chat.stream).toBe(true);

    const resp = parseRequest('openai_responses', buf({ model: 'm', instructions: 'I', input: 'hello', prompt_cache_key: 'k' }))!;
    expect(resp.system).toBe('I');
    expect(resp.input).toEqual([{ role: 'user', content: 'hello' }]);
    expect(resp.params.prompt_cache_key).toBe('k');

    const msgs = parseRequest('anthropic_messages', buf({ model: 'm', system: [{ type: 'text', text: 'Y' }], messages: [{ role: 'user', content: 'hi' }], max_tokens: 9 }))!;
    expect(msgs.system).toEqual([{ type: 'text', text: 'Y' }]);
    expect(msgs.input).toEqual([{ role: 'user', content: 'hi' }]);
    expect(msgs.params.max_tokens).toBe(9);
  });
});

describe('responses', () => {
  it('5, 6 and 7: a streamed chat answer keeps its tool call, its reasoning and its usage', () => {
    const base = { id: 'c', object: 'chat.completion.chunk', model: 'served-m' };
    const body = sse([
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'think ' } }] },
      { ...base, choices: [{ index: 0, delta: { reasoning: 'more' } }] },
      { ...base, choices: [{ index: 0, delta: { content: 'Running.' } }] },
      { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '' } }] } }] },
      { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"comm' } }] } }] },
      { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 80 } } },
    ]);
    const r = parseResponse('openai_chat', 200, 'text/event-stream', body);
    expect(r.output).toEqual({
      role: 'assistant', content: 'Running.', reasoning_content: 'think more',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
    });
    expect(r.usage).toEqual({ input: 100, cached: 80, output: 7 });
    expect(r.finishReason).toBe('tool_calls');
    expect(r.modelServed).toBe('served-m');
    expect(r.toolCalls).toBe(1);
  });

  it('7: a plain chat answer, its usage and finish reason', () => {
    const r = parseResponse('openai_chat', 200, 'application/json', buf({
      model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    }));
    expect(r.output).toEqual({ role: 'assistant', content: 'ok' });
    expect(r.usage).toEqual({ input: 5, cached: 0, output: 1 });
    expect(r.finishReason).toBe('stop');
  });

  it('7: a streamed Responses answer takes its output and usage from response.completed', () => {
    const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell', arguments: '{"command":["ls"]}', status: 'completed' };
    const response = { id: 'resp_1', model: 'served', status: 'completed', output: [item], usage: { input_tokens: 50, output_tokens: 4, input_tokens_details: { cached_tokens: 40 } } };
    const r = parseResponse('openai_responses', 200, 'text/event-stream', sse([
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ], true));
    expect(r.output).toEqual([item]);
    expect(r.usage).toEqual({ input: 50, cached: 40, output: 4 });
    expect(r.toolCalls).toBe(1);
    expect(r.finishReason).toBe('completed');
  });

  it('8: a Responses stream cut before response.completed keeps the items it finished', () => {
    const item = { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'half' }] };
    const r = parseResponse('openai_responses', 200, 'text/event-stream', sse([
      { type: 'response.output_item.done', output_index: 0, item },
    ], true));
    expect(r.output).toEqual([item]);
    expect(r.finishReason).toBe('incomplete');
  });

  it('7 and 9: a streamed Messages answer keeps its text, thinking, tool input and usage', () => {
    const r = parseResponse('anthropic_messages', 200, 'text/event-stream', sse([
      { type: 'message_start', message: { id: 'msg', model: 'served', usage: { input_tokens: 30, cache_read_input_tokens: 20, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Go.' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu', name: 'Bash', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"ls"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ], true));
    expect(r.output).toEqual({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Go.' }, { type: 'tool_use', id: 'tu', name: 'Bash', input: { command: 'ls' } },
    ] });
    expect(r.usage).toEqual({ input: 30, cached: 20, output: 12 });
    expect(r.finishReason).toBe('tool_use');
    expect(r.toolCalls).toBe(1);
  });

  it('10: an error response is an error, with its body', () => {
    const r = parseResponse('openai_chat', 503, 'application/json', buf({ error: { type: 'endpoint_busy', message: 'not a fleet window' } }));
    expect(r.output).toBeNull();
    expect(r.error).toContain('endpoint_busy');
  });
});

describe('turns and authorship', () => {
  const reminder = { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nmemory catalog\n</system-reminder>' }] };

  it('11: a user instruction opens a turn; a tool result or a reminder alone does not', () => {
    expect(opensTurn('openai_chat', [{ role: 'user', content: 'do it' }])).toBe(true);
    expect(opensTurn('openai_chat', [{ role: 'user', content: 'do it' }, { role: 'assistant', tool_calls: [] }, { role: 'tool', content: 'x' }])).toBe(false);
    expect(opensTurn('openai_chat', [{ role: 'user', content: 'do it' }, { role: 'tool', content: 'x' }, reminder])).toBe(false);
    expect(opensTurn('openai_responses', [{ role: 'user', content: 'do it' }, { type: 'function_call_output', call_id: 'c', output: 'x' }])).toBe(false);
    expect(opensTurn('openai_responses', [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] }])).toBe(true);
    expect(opensTurn('anthropic_messages', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content: 'x' }] }])).toBe(false);
    expect(opensTurn('anthropic_messages', [{ role: 'user', content: [{ type: 'text', text: 'again' }] }])).toBe(true);
  });

  it('12: equal content hashes the same whatever the key order', () => {
    expect(hashOf({ role: 'user', content: 'a' })).toBe(hashOf({ content: 'a', role: 'user' }));
    expect(canonicalJson({ b: [2, { d: 1, c: 0 }], a: 1 })).toBe('{"a":1,"b":[2,{"c":0,"d":1}]}');
    expect(hashOf({ role: 'user', content: 'a' })).not.toBe(hashOf({ role: 'user', content: 'b' }));
  });

  it('13: the instruction text leaves the reminders out', () => {
    const msg = { role: 'user', content: [{ type: 'text', text: '<system-reminder>skills</system-reminder>' }, { type: 'text', text: 'Fix the bug' }] };
    expect(instructionText('openai_chat', [msg])).toBe('Fix the bug');
    expect(instructionText('openai_responses', [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }])).toBe('Hello');
  });
});

describe('the first token (TTFT)', () => {
  const SSE = 'text/event-stream';
  const blocks = (events: unknown[], named = false) => events.map((e) => {
    const o = e as { type?: string };
    return `${named && o.type ? `event: ${o.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`;
  });
  /** The byte just past the k-th event, its blank line included. */
  const endOf = (list: string[], k: number) => Buffer.byteLength(list.slice(0, k).join(''));
  const at = (surface: Parameters<typeof firstContentEnd>[0], list: string[], tail = '') => firstContentEnd(surface, SSE, buf(list.join('') + tail));
  const chunk = (delta: unknown, more: object = {}) => ({ choices: [{ index: 0, delta, finish_reason: null }], ...more });

  it('14: chat: past a role-only chunk and an empty content, at the first content', () => {
    const list = blocks([chunk({ role: 'assistant' }), chunk({ content: '' }), chunk({ content: 'Hi' }), chunk({ content: ' there' })]);
    expect(at('openai_chat', list, 'data: [DONE]\n\n')).toBe(endOf(list, 3));
  });

  it('14: chat: a first chunk of reasoning or of a tool call is the first token; usage alone is not', () => {
    for (const first of [{ role: 'assistant', reasoning_content: 'Thinking' }, { reasoning: 'Thinking' }, { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'bash', arguments: '' } }] }]) {
      const list = blocks([{ choices: [], usage: { prompt_tokens: 1 } }, chunk(first), chunk({ content: 'x' })]);
      expect(at('openai_chat', list), JSON.stringify(first)).toBe(endOf(list, 2));
    }
  });

  it('15: Responses: past created, a message item added and an empty delta, at the first non-empty delta', () => {
    const list = blocks([
      { type: 'response.created', response: { status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: '' },
      { type: 'response.output_text.delta', output_index: 0, delta: 'Hello' },
    ], true);
    expect(at('openai_responses', list)).toBe(endOf(list, 4));
  });

  it('15: Responses: a reasoning delta, a function call item added, or its arguments delta, is the first token', () => {
    const created = { type: 'response.created', response: { status: 'in_progress', output: [] } };
    for (const first of [
      { type: 'response.reasoning_summary_text.delta', delta: 'Plan' },
      { type: 'response.reasoning_text.delta', delta: 'Plan' },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'bash', arguments: '' } },
      { type: 'response.function_call_arguments.delta', delta: '{"cmd"' },
    ]) {
      const list = blocks([created, first], true);
      expect(at('openai_responses', list), first.type).toBe(endOf(list, 2));
    }
  });

  it('16: Messages: past message_start, a text block started, a ping and an empty text, at the first text', () => {
    const list = blocks([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'ping' },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
    ], true);
    expect(at('anthropic_messages', list)).toBe(endOf(list, 5));
  });

  it('16: Messages: a thinking delta, a tool_use block started or an input_json delta is the first token', () => {
    const start = { type: 'message_start', message: {} };
    for (const first of [
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hmm' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'bash', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"c' } },
    ]) {
      const list = blocks([start, first], true);
      expect(at('anthropic_messages', list), JSON.stringify(first)).toBe(endOf(list, 2));
    }
  });

  it('17: no place for a body that is not streamed, or a stream with no content', () => {
    expect(firstContentEnd('openai_chat', 'application/json', buf({ choices: [{ message: { content: 'Hi' } }] }))).toBeNull();
    expect(at('openai_chat', blocks([chunk({ role: 'assistant' }), chunk({}, { usage: { prompt_tokens: 1 } })]), 'data: [DONE]\n\n')).toBeNull();
    expect(at('anthropic_messages', blocks([{ type: 'message_start', message: {} }, { type: 'message_stop' }], true))).toBeNull();
  });

  it('18: the place is in bytes, past a multibyte character, and at the end of its event', () => {
    const list = blocks([chunk({ role: 'assistant', content: '' }), chunk({ content: 'été 東京' })]);
    const end = at('openai_chat', list);
    expect(end).toBe(endOf(list, 2));
    expect(end).toBeGreaterThan(list.join('').length);
    // A stream cut inside the event with content: the event never ended, so there is no place.
    const cut = list.join('').slice(0, -4);
    expect(firstContentEnd('openai_chat', SSE, buf(cut))).toBeNull();
  });
});
