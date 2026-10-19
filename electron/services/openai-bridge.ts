import * as http from 'http';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import { OPENAI_BRIDGE_PORT } from '../constants';
import { getApiToken } from './api-server';
import { readAppSettingsFromDisk, isValidOpenAIBaseUrl } from '../providers/cli-provider';
import type { AppSettings } from '../types';

/**
 * WHY THIS FILE EXISTS
 *
 * Some vendors are OpenAI-compatible only - /chat/completions, no
 * /v1/messages (Venice, confirmed against docs.venice.ai; any endpoint a user
 * points "Custom OpenAI-compatible" at, by definition). The claude binary
 * only ever speaks the Anthropic Messages wire format, so reaching them needs
 * a translator sitting between. This is that translator, both directions,
 * streaming and not - one process serving every such vendor, not one file per
 * vendor the way this started (see git history: it began as venice-shim.ts,
 * hardcoded to a single upstream, before the "custom" provider gave a second
 * caller the identical problem).
 *
 * WHY ONE SERVER FOR EVERY VENDOR, ADDRESSED BY PATH
 *
 * Three ways to tell the bridge which upstream a request is for: a port per
 * vendor, a header per vendor, or a path segment per vendor. A port per
 * vendor means allocating and reserving one for every future OpenAI-only
 * provider, and a sandboxed/E2E instance running beside the real app would
 * need its own block of them too - VENICE_SHIM_PORT was already one such
 * reservation for a single vendor. A header would work, but the claude binary
 * does not expose a way to add an arbitrary custom header to the request it
 * makes to ANTHROPIC_BASE_URL, only the two it already sends (`x-api-key` and
 * whatever ANTHROPIC_AUTH_TOKEN produces) - there is nowhere to put a vendor
 * id. A path segment costs nothing: ANTHROPIC_BASE_URL becomes
 * `http://127.0.0.1:<port>/<vendor>` (the claude binary appends `/v1/messages`
 * itself, same as every direct provider already relies on), and the vendor
 * falls out of the first path segment with no extra plumbing. So: one server,
 * one port, upstreams looked up by path segment in the UPSTREAMS map below.
 *
 * WHY IT IS ITS OWN SERVER, NOT A ROUTE UNDER /api/*
 *
 * api-server.ts guards every /api/* route with `Authorization: Bearer
 * <token>`, except exactly four paths (see its own comment and CLAUDE.md's
 * Backend Agent rules - that count is a hard invariant, not a suggestion).
 * The claude binary does not send an Authorization header to whatever
 * ANTHROPIC_BASE_URL points at by default; it sends `x-api-key`, as the
 * scheduled runs' scripts still have it. Putting this behind /api/* would mean
 * either breaking that invariant with a fifth exemption, or the bridge would
 * 401 those requests before its own handler ever ran. So this runs as a
 * second, separate, loopback-only http.Server, and authenticates the same way
 * in spirit, for every upstream alike: it requires Tars's own local API token
 * (the same secret api-server.ts already generates and guards at 0600), as a
 * Bearer or as `x-api-key`. Each provider that routes through here
 * (venice-provider.ts, custom-openai-provider.ts) hands it to the PTY as
 * ANTHROPIC_AUTH_TOKEN, the Bearer, since an API key in its environment is
 * asked about at launch (keyProviderEnv); a scheduled script exports it as
 * ANTHROPIC_API_KEY, which `claude -p` uses unasked. The real vendor key never leaves
 * this process: it is read from app-settings.json per request and attached
 * only to the outbound call to that vendor, never handed to the claude
 * binary.
 *
 * WHAT IS TRANSLATED
 *
 * Request: system prompt, message content blocks (text/image/tool_use/
 * tool_result), tools + tool_choice, streaming flag. Response: content
 * blocks, stop_reason, usage, and for streaming, Anthropic's block-delta SSE
 * events synthesized from OpenAI's chat-completion-chunk deltas.
 *
 * Left out on purpose, because a coding agent's turn loop does not exercise
 * them and the other alt providers already ship without them: prompt
 * caching (cache_control), the Batches API, PDF blocks, extended-thinking
 * blocks (dropped rather than round-tripped - OpenAI has no wire equivalent
 * and the turn loop does not need them echoed back), citations, and
 * tool_choice beyond auto/any/none/tool.
 *
 * /v1/messages/count_tokens: the claude binary preflights every turn with
 * this and an OpenAI-compatible vendor, by definition, has no equivalent
 * endpoint. Ollama hits the identical gap by returning 404, which multiple
 * users report makes Ollama's own server degrade into escalating 500s
 * (ollama/ollama#13949). Since this bridge is Tars's own code, the fix here
 * is simpler than working around a third party: just answer the preflight,
 * with a coarse characters/4 estimate, rather than 404ing and hoping the CLI
 * tolerates it.
 */

/** One entry per OpenAI-only vendor this bridge serves, keyed by the path
 *  segment ANTHROPIC_BASE_URL is pointed at (see providers/venice-provider.ts,
 *  providers/custom-openai-provider.ts). `resolveApiKey` returning null means
 *  "send no Authorization header" (some self-hosted OpenAI-compatible servers
 *  take none) rather than a hard failure - only a missing base URL is fatal. */
interface BridgeUpstream {
  resolveBaseUrl(settings: Partial<AppSettings>): string | null;
  resolveApiKey(settings: Partial<AppSettings>): string | null;
}

const UPSTREAMS: Record<string, BridgeUpstream> = {
  venice: {
    resolveBaseUrl: () => 'https://api.venice.ai/api/v1',
    resolveApiKey: (s) => s.veniceApiKey || null,
  },
  custom: {
    // User-supplied, so it is trimmed of trailing slashes the same way every
    // other base-url field in this codebase is, and validated (protocol +
    // parses at all) before it is ever handed to fetch(); see
    // isValidOpenAIBaseUrl in providers/cli-provider.ts, which
    // custom-openai-provider.ts also uses to decide whether to wire this
    // upstream up at all.
    // Re-validated here, not only in Settings: app-settings.json is a plain
    // file on disk and can be edited around the screen that wrote it, and
    // whatever this returns is called with the stored vendor key attached.
    // This is the last point before fetch(), so it is the one that has to hold.
    resolveBaseUrl: (s) => {
      const raw = s.customOpenAIBaseUrl ? s.customOpenAIBaseUrl.replace(/\/+$/, '') : '';
      return raw && isValidOpenAIBaseUrl(raw) ? raw : null;
    },
    resolveApiKey: (s) => s.customOpenAIApiKey || null,
  },
};

let bridgeServer: http.Server | null = null;

// ── Anthropic -> OpenAI (request) ───────────────────────────────────

interface OAMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

function flattenSystemText(system: unknown): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => b.text)
      .join('\n\n');
  }
  return '';
}

/**
 * The wire payloads are parsed JSON, so their properties are `unknown` until
 * something checks them. These readers are that check, in one place: they keep
 * the translation below readable without `any` standing in for "I have not
 * looked". A field that is missing or the wrong type reads as absent, which is
 * how a translator should treat it.
 */
type Json = Record<string, unknown>;

const asObj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function blockToOpenAIContentPart(block: Json): Record<string, unknown> {
  if (block.type === 'text') return { type: 'text', text: asStr(block.text) };
  if (block.type === 'image') {
    const src = asObj(block.source);
    if (src.type === 'base64') {
      return { type: 'image_url', image_url: { url: `data:${asStr(src.media_type)};base64,${asStr(src.data)}` } };
    }
    if (src.type === 'url') {
      return { type: 'image_url', image_url: { url: asStr(src.url) } };
    }
  }
  // Fail loudly rather than silently drop: a block Tars doesn't understand
  // is a turn the agent will misinterpret if it goes through half-translated.
  throw new Error(`Unsupported Anthropic content block type for Venice: ${block.type}`);
}

function anthropicMessagesToOpenAI(messages: Json[]): OAMessage[] {
  const out: OAMessage[] = [];

  for (const msg of messages) {
    const role = asStr(msg.role);
    if (typeof msg.content === 'string') {
      out.push({ role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const parts: Record<string, unknown>[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    const toolResultMessages: OAMessage[] = [];

    for (const raw of msg.content) {
      const block = asObj(raw);
      switch (block.type) {
        case 'text':
        case 'image':
          parts.push(blockToOpenAIContentPart(block));
          break;
        case 'tool_use':
          toolCalls.push({
            id: asStr(block.id),
            type: 'function',
            function: { name: asStr(block.name), arguments: JSON.stringify(block.input ?? {}) },
          });
          break;
        case 'tool_result': {
          const content = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map(asObj).filter(c => c.type === 'text').map(c => asStr(c.text)).join('\n')
              : JSON.stringify(block.content ?? '');
          toolResultMessages.push({ role: 'tool', tool_call_id: asStr(block.tool_use_id), content });
          break;
        }
        case 'thinking':
        case 'redacted_thinking':
          // No OpenAI wire equivalent; the turn loop does not need it echoed
          // back, so it is dropped rather than failed (see file header).
          break;
        default:
          throw new Error(`Unsupported Anthropic content block type for Venice: ${block.type}`);
      }
    }

    if (toolCalls.length > 0) {
      out.push({ role: 'assistant', content: parts.length ? parts : null, tool_calls: toolCalls });
    } else if (parts.length > 0) {
      // A lone text part collapses to a plain string: most Venice models were
      // tuned against plain-string content, only vision needs the array form.
      const content = parts.length === 1 && parts[0].type === 'text' ? (parts[0] as { text: string }).text : parts;
      out.push({ role, content });
    }

    out.push(...toolResultMessages);
  }

  return out;
}

function anthropicToolsToOpenAI(tools: Json[] | undefined): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function anthropicToolChoiceToOpenAI(choice: Json | undefined): unknown {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return { type: 'function', function: { name: choice.name } };
    default: return 'auto';
  }
}

export function anthropicRequestToOpenAI(body: Json): Record<string, unknown> {
  const messages: OAMessage[] = [];
  const systemText = flattenSystemText(body.system);
  if (systemText) messages.push({ role: 'system', content: systemText });
  messages.push(...anthropicMessagesToOpenAI(asArr(body.messages).map(asObj)));

  const stream = !!body.stream;
  return {
    model: body.model,
    messages,
    ...(body.tools ? { tools: anthropicToolsToOpenAI(asArr(body.tools).map(asObj)) } : {}),
    ...(body.tool_choice ? { tool_choice: anthropicToolChoiceToOpenAI(asObj(body.tool_choice)) } : {}),
    max_tokens: body.max_tokens,
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    stream,
    // Only meaningful with stream:true; asks Venice for a final usage-only
    // chunk so the translated message_delta can carry real output_tokens.
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
}

// ── OpenAI -> Anthropic (response, non-streaming) ───────────────────

const STOP_REASON_MAP: Record<string, string> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'end_turn',
};

/**
 * The Anthropic stop reason for an OpenAI finish reason, read from the map's
 * own keys. A plain lookup answers for the names every object has: a vendor
 * saying `constructor` got Object's own function back, which JSON drops, and
 * the reply reached the claude binary with no stop_reason at all.
 */
function stopReasonFor(finishReason: string): string {
  return Object.hasOwn(STOP_REASON_MAP, finishReason) ? STOP_REASON_MAP[finishReason] : 'end_turn';
}

export function openAIResponseToAnthropic(json: Json, requestedModel: string): Record<string, unknown> {
  const choice = asObj(asArr(json.choices)[0]);
  const message = asObj(choice.message);
  const content: Record<string, unknown>[] = [];

  if (message.content) {
    content.push({ type: 'text', text: typeof message.content === 'string' ? message.content : String(message.content) });
  }
  for (const raw of asArr(message.tool_calls)) {
    const tc = asObj(raw);
    const fn = asObj(tc.function);
    let input: unknown = {};
    try { input = JSON.parse(asStr(fn.arguments) || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: asStr(tc.id), name: asStr(fn.name), input });
  }

  return {
    id: asStr(json.id) || `msg_${crypto.randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: asStr(json.model) || requestedModel,
    content,
    stop_reason: stopReasonFor(asStr(choice.finish_reason)),
    stop_sequence: null,
    usage: {
      input_tokens: asNum(asObj(json.usage).prompt_tokens),
      output_tokens: asNum(asObj(json.usage).completion_tokens),
    },
  };
}

// ── OpenAI -> Anthropic (response, streaming) ───────────────────────

function sseWrite(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamOpenAIAsAnthropic(upstream: Response, res: http.ServerResponse, requestedModel: string): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  sseWrite(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId, type: 'message', role: 'assistant', model: requestedModel,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let nextIndex = 0;
  let textIndex = -1;
  let textOpen = false;
  const toolBlocks = new Map<number, { index: number; id: string; name: string }>();
  let finishReason: string | null = null;
  let outputTokens = 0;

  // Response.body is a web ReadableStream; Readable.fromWeb gives it a typed,
  // guaranteed async iterator rather than relying on lib.dom for one.
  const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of nodeStream) {
    buffer += decoder.decode(chunk as Buffer, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = rawEvent.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;

      let parsed: Json;
      try { parsed = JSON.parse(data); } catch { continue; }

      if (parsed.usage) {
        outputTokens = asNum(asObj(parsed.usage).completion_tokens) || outputTokens;
      }

      const choice = asObj(asArr(parsed.choices)[0]);
      if (!choice.delta && !choice.finish_reason) continue;
      const delta = asObj(choice.delta);

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!textOpen) {
          textIndex = nextIndex++;
          textOpen = true;
          sseWrite(res, 'content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } });
        }
        sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } });
      }

      for (const rawCall of asArr(delta.tool_calls)) {
        const tc = asObj(rawCall);
        const fn = asObj(tc.function);
        const slot = asNum(tc.index);
        let block = toolBlocks.get(slot);
        if (!block) {
          const index = nextIndex++;
          block = { index, id: asStr(tc.id) || `call_${slot}`, name: asStr(fn.name) };
          toolBlocks.set(slot, block);
          sseWrite(res, 'content_block_start', {
            type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
          });
        }
        if (fn.arguments) {
          sseWrite(res, 'content_block_delta', {
            type: 'content_block_delta', index: block.index, delta: { type: 'input_json_delta', partial_json: asStr(fn.arguments) },
          });
        }
      }

      if (choice.finish_reason) finishReason = asStr(choice.finish_reason);
    }
  }

  if (textOpen) sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: textIndex });
  for (const block of toolBlocks.values()) {
    sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: block.index });
  }

  sseWrite(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReasonFor(finishReason || 'stop'), stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  sseWrite(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

// ── /v1/messages/count_tokens ────────────────────────────────────────

/** Anthropic's own rule of thumb for English text; good enough to keep the
 *  CLI's preflight satisfied when there is no real endpoint to ask. */
function estimateTokens(body: Json): number {
  const parts: string[] = [];
  if (typeof body.system === 'string') parts.push(body.system);
  else if (Array.isArray(body.system)) parts.push(...body.system.map(b => asStr(asObj(b).text)));
  for (const rawMsg of asArr(body.messages)) {
    const msg = asObj(rawMsg);
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b?.type === 'text') parts.push(b.text || '');
        if (b?.type === 'tool_result' && typeof b.content === 'string') parts.push(b.content);
      }
    }
  }
  const chars = parts.join('\n').length;
  return Math.max(1, Math.ceil(chars / 4));
}

// ── Request handling ─────────────────────────────────────────────────

function sendError(res: http.ServerResponse, status: number, type: string, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

async function handleMessages(
  anthropicBody: Json,
  res: http.ServerResponse,
  baseUrl: string,
  apiKey: string | null,
  signal: AbortSignal,
): Promise<void> {
  let openAIBody: Record<string, unknown>;
  try {
    openAIBody = anthropicRequestToOpenAI(anthropicBody);
  } catch (err) {
    sendError(res, 400, 'invalid_request_error', (err as Error).message);
    return;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Omitted, not sent empty: some self-hosted OpenAI-compatible servers
  // (vLLM, llama.cpp, LM Studio with auth off) reject an Authorization header
  // that carries nothing rather than treating it as absent.
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(openAIBody),
    signal,
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    sendError(res, upstream.status, 'api_error', text || `Upstream returned HTTP ${upstream.status}`);
    return;
  }

  if (openAIBody.stream) {
    await streamOpenAIAsAnthropic(upstream, res, asStr(anthropicBody.model));
    return;
  }

  const json = asObj(await upstream.json());
  const anthropicResponse = openAIResponseToAnthropic(json, asStr(anthropicBody.model));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(anthropicResponse));
}

function handleCountTokens(anthropicBody: Json, res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: estimateTokens(anthropicBody) }));
}

// ── Server lifecycle ─────────────────────────────────────────────────

export function startOpenAIBridgeServer(): void {
  if (bridgeServer) return;

  bridgeServer = http.createServer(async (req, res) => {
    const expected = getApiToken();
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (req.headers['x-api-key'] !== expected && bearer !== expected) {
      sendError(res, 401, 'authentication_error', "Not Tars's token, as a Bearer or as x-api-key");
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${OPENAI_BRIDGE_PORT}`);
    // First path segment is the upstream id (see UPSTREAMS above); everything
    // after it must match the Anthropic Messages routes the claude binary
    // itself appends to ANTHROPIC_BASE_URL.
    const segments = url.pathname.split('/').filter(Boolean);
    const upstreamId = segments[0];
    const rest = `/${segments.slice(1).join('/')}`;
    const upstream = upstreamId ? UPSTREAMS[upstreamId] : undefined;

    const isMessages = rest === '/v1/messages';
    const isCountTokens = rest === '/v1/messages/count_tokens';
    if (req.method !== 'POST' || !upstream || (!isMessages && !isCountTokens)) {
      sendError(res, 404, 'not_found_error', 'Not found');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Json = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      sendError(res, 400, 'invalid_request_error', 'Invalid JSON body');
      return;
    }

    if (isCountTokens) {
      handleCountTokens(body, res);
      return;
    }

    const settings = readAppSettingsFromDisk();
    const baseUrl = upstream.resolveBaseUrl(settings);
    if (!baseUrl) {
      sendError(res, 401, 'authentication_error', `No base URL configured for "${upstreamId}" in Tars settings`);
      return;
    }

    const controller = new AbortController();
    res.on('close', () => controller.abort());

    try {
      await handleMessages(body, res, baseUrl, upstream.resolveApiKey(settings), controller.signal);
    } catch (err) {
      console.error(`OpenAI bridge error (${upstreamId}):`, err);
      if (!res.headersSent) {
        sendError(res, 500, 'api_error', String(err));
      } else {
        res.end();
      }
    }
  });

  bridgeServer.listen(OPENAI_BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`OpenAI-compatible bridge running on http://127.0.0.1:${OPENAI_BRIDGE_PORT}`);
  });

  bridgeServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${OPENAI_BRIDGE_PORT} is in use, OpenAI-compatible bridge not started`);
    } else {
      console.error('OpenAI-compatible bridge error:', err);
    }
  });
}

export function stopOpenAIBridgeServer(): void {
  if (bridgeServer) {
    bridgeServer.close();
    bridgeServer = null;
  }
}
