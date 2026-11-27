import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { DATA_DIR } from '../constants';
import { isValidOpenAIBaseUrl } from '../providers/cli-provider';
import type { AgentStatus, AppSettings, InferenceEndpoint } from '../types';
import { isRefusedExtraHeader, type ProxyTarget } from './endpoint-proxy';
import { twoZones } from '../utils/two-zones';
import { limitsError } from './endpoint-harness';

/**
 * Inference endpoints (native traces): OpenAI-compatible endpoints an open harness runs
 * on, per agent, through Tars's endpoint proxy.
 *
 * - **Where things are kept.** The records are in `app-settings.json` (`inferenceEndpoints`), with no secret. Each
 *   key is in the settings' secrets (`endpointKeys`, ~/.tars-private/settings-secrets.json), read by the proxy per
 *   request and never handed to an agent, a CLI or the window, which only learns `keySet`.
 * - **Who changes what.** The owner, in the window, adds and changes anything; an address or extra headers the
 *   owner types there are approved by that act, while a save of another field leaves an agent's change pending
 *   until the owner approves exactly what the window showed (approveEndpoint). Any agent,
 *   through the API or its MCP tools, may list them, add one, change one and rotate a key (the owner's word of 19/11:
 *   the agents of one project tune another project's).
 * - **The approval guard** (the orchestrator's decision, 19/11). An endpoint an agent adds, or whose base URL an
 *   agent changes, is unusable until the owner approves it once in the window: it is where an agent's whole context
 *   would go, and an injected agent could otherwise point any agent at its own server in two calls. The same for
 *   the extra headers an agent adds or changes (the owner's decision of 26/11): they go out with the owner's key, and
 *   may route or bill the requests at the endpoint, so the owner sees them first; the key stays, since the address
 *   does not change. A key, the models, the name or the ceiling keep the approval. An agent may turn traces off for
 *   an endpoint, never on.
 * - **Extra headers** (cleanExtraHeaders) are a small fixed map, at most 16 names, never the credential, the hop, the
 *   body's framing or the session headers (endpoint-proxy.ts REFUSED_EXTRA_HEADERS). They are kept with the record,
 *   not with the secrets, and every agent reads them: never a credential there.
 * - **Keys from agents** come through a drop file only (readKeyFromDropFile, taken away once saved): never through a prompt or a tool
 *   argument, and from no other path, so no argument can make Tars read ~/.tars-private, ~/.ssh or any other file
 *   and send it out as a Bearer. The macOS keychain is never read: the key path is the same on every system.
 */

export const ENDPOINT_KEYS_DIR = path.join(DATA_DIR, 'endpoint-keys');
/**
 * The hold ceiling for a general endpoint: two minutes. A standard 503 or 429 says in Retry-After how long to wait,
 * usually seconds to a minute; two minutes rides out several such answers, and stays under the request timeouts the
 * harnesses keep by default, so a held request does not turn into a harness's own failure. An endpoint that pauses
 * for longer (a maintenance window) takes a longer ceiling in its settings, up to an hour.
 */
export const DEFAULT_HOLD_SECONDS = 120;
export const MAX_HOLD_SECONDS = 3600;
const MAX_NAME = 60;
const MAX_KEY_BYTES = 8 * 1024;
const DROP_NAME = /^[A-Za-z0-9._-]{1,64}\.key$/;
const ENDPOINT_ID = /^ep-[0-9a-f]{6}$/;
export const MAX_EXTRA_HEADERS = 16;
export const MAX_EXTRA_HEADER_VALUE = 1024;
/** An HTTP header name (RFC 9110 token), 64 characters at most. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
/** A header value: printable ASCII, spaces and tabs, never CR, LF or another control character. */
const HEADER_VALUE = /^[\x20-\x7e\t]+$/;

/**
 * An endpoint's extra headers, as saved, or why not: a plain object of names to strings, at most 16, each a header
 * token of 64 characters at most whose value is 1 to 1024 printable characters, no name refused
 * (isRefusedExtraHeader), no two equal but for case.
 */
export function cleanExtraHeaders(raw: unknown): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Extra headers are a map of header names to values.' };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_EXTRA_HEADERS) return { ok: false, error: `An endpoint takes ${MAX_EXTRA_HEADERS} extra headers at most.` };
  const seen = new Set<string>();
  const headers: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name)) return { ok: false, error: 'An extra header\'s name is one header token (letters, digits and - _ . ! # $ % & \' * + ^ ` | ~), 64 characters at most.' };
    if (isRefusedExtraHeader(name)) return { ok: false, error: `${name} cannot be an extra header: Tars sets the key, the session headers and the connection's own headers itself.` };
    if (seen.has(name.toLowerCase())) return { ok: false, error: `${name} is given twice.` };
    seen.add(name.toLowerCase());
    if (typeof value !== 'string' || !HEADER_VALUE.test(value) || Buffer.byteLength(value) > MAX_EXTRA_HEADER_VALUE) {
      return { ok: false, error: `The value of ${name} is 1 to ${MAX_EXTRA_HEADER_VALUE} printable characters on one line.` };
    }
    headers[name] = value;
  }
  return { ok: true, headers };
}

/** Whether two maps of extra headers send the same thing: names compared without case, values exactly. */
export function sameExtraHeaders(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const norm = (m: Record<string, string> | undefined) => JSON.stringify(Object.entries(m ?? {}).map(([k, v]) => [k.toLowerCase(), v]).sort());
  return norm(a) === norm(b);
}

/** The harnesses an endpoint can run, and how each measured. */
export const ENDPOINT_HARNESSES = ['codex', 'pi', 'qwen-code', 'opencode'] as const;
export type EndpointHarness = typeof ENDPOINT_HARNESSES[number];
export type ToolCallSupport = 'works' | 'failed' | 'unmeasured';

/** Who asks: the owner in the window, or an agent through the API. */
export type EndpointActor = { window: true } | { agentId: string; agentName?: string };

export interface EndpointView {
  id: string; name: string; baseUrl: string; allowTraces: boolean; keySet: boolean;
  models: string[]; modelsReadAt?: string; modelsError?: string;
  agents: Array<{ id: string; name: string; projectPath: string; provider: string; model?: string }>;
  approved: boolean; approvedBaseUrl?: string; changedBy?: InferenceEndpoint['changedBy'];
  holdMaxSeconds: number; sendSessionHeaders: boolean; health?: InferenceEndpoint['health'];
  /** The traffic is plain http, not encrypted at the HTTP level (a private network, or the owner's allowance). */
  plainHttp: boolean;
  allowPlainHttp: boolean;
  /** Sent with every request; never a credential (every agent reads them). */
  extraHeaders: Record<string, string>;
  /** What the owner approved, to show beside a change an agent made. */
  approvedExtraHeaders?: Record<string, string>;
  /** The model's real context window and output cap, in tokens, as the owner set them: given to the harness at launch. */
  contextWindow?: number;
  maxOutputTokens?: number;
}

type Result = { ok: true; settings: AppSettings; endpoint: InferenceEndpoint } | { ok: false; error: string };

const fromWindow = (actor: EndpointActor): actor is { window: true } => 'window' in actor && actor.window === true;

function endpointsOf(settings: Partial<AppSettings>): InferenceEndpoint[] {
  return Array.isArray(settings.inferenceEndpoints) ? settings.inferenceEndpoints.filter(e => e && ENDPOINT_ID.test(e.id)) : [];
}

/**
 * How a base URL's traffic travels (the Audit's L2 on #596, the orchestrator's rule):
 * - `https`: encrypted, anywhere;
 * - `http-private`: plain http to loopback, a private range (RFC 1918, 100.64.0.0/10 where encrypted overlays such
 *   as WireGuard live, fc00::/7) or IPv6 link-local: taken, and the window says the traffic is not encrypted at the
 *   HTTP level;
 * - `http-public`: plain http to anything else, a host name included (no name is resolved to decide): taken only
 *   when the owner allows plain http for that endpoint, in the window.
 * The cloud metadata range 169.254/16 stays refused whatever the scheme (isValidOpenAIBaseUrl).
 */
export function transportOf(url: string): 'https' | 'http-private' | 'http-public' {
  let u: URL;
  try { u = new URL(url); } catch { return 'http-public'; }
  if (u.protocol === 'https:') return 'https';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return 'http-private';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'http-private';
    return 'http-public';
  }
  if (host.includes(':')) {
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return 'http-private';
  }
  return 'http-public';
}

/** A base URL as stored: valid http(s), no credentials, query or fragment, trailing slashes trimmed. */
export function cleanBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!isValidOpenAIBaseUrl(trimmed)) return null;
  const u = new URL(trimmed);
  if (u.search || u.hash || trimmed.includes('?') || trimmed.includes('#')) return null;
  return trimmed;
}

/** Adds an endpoint, or changes one (`id`), as the owner or an agent may. */
export function saveEndpoint(
  settings: AppSettings,
  input: {
    id?: string; name?: string; baseUrl?: string; allowTraces?: boolean; holdMaxSeconds?: number; sendSessionHeaders?: boolean; allowPlainHttp?: boolean; extraHeaders?: unknown;
    /** The model's real context window and output cap in tokens (the owner's, in the window); null clears one. */
    contextWindow?: number | null; maxOutputTokens?: number | null;
    /** The window's save of an endpoint that exists: the address and extra headers its form showed when opened. */
    shown?: { baseUrl?: unknown; extraHeaders?: unknown };
  },
  actor: EndpointActor,
  now: string = new Date().toISOString(),
): Result {
  const list = endpointsOf(settings);
  const current = input.id !== undefined ? list.find(e => e.id === input.id) : undefined;
  if (input.id !== undefined && !current) return { ok: false, error: 'There is no such endpoint.' };
  const owner = fromWindow(actor);
  // The owner's save of an endpoint that exists names what its form showed (the Audit's M-b at c31811361): what the
  // owner "typed" is what differs from that, so a form opened before an agent's latest change could otherwise send
  // the agent's earlier values back as the owner's own, and approve them. Refused unless it is the endpoint now.
  if (owner && current) {
    const stale = shownDiffers(current, input.shown);
    if (stale) return { ok: false, error: stale };
  }

  const name = input.name !== undefined ? String(input.name).trim().slice(0, MAX_NAME) : current?.name;
  if (!name) return { ok: false, error: 'An endpoint has a name.' };
  let baseUrl = current?.baseUrl;
  if (input.baseUrl !== undefined || !current) {
    const clean = cleanBaseUrl(input.baseUrl);
    if (!clean) return { ok: false, error: 'The base URL must be http(s), up to the routes (for example https://host.example.com/v1), with no credentials, query or fragment, and not link-local.' };
    baseUrl = clean;
  }
  const hold = input.holdMaxSeconds ?? current?.holdMaxSeconds ?? DEFAULT_HOLD_SECONDS;
  if (!Number.isInteger(hold) || hold < 0 || hold > MAX_HOLD_SECONDS) return { ok: false, error: `The hold ceiling is a whole number of seconds from 0 to ${MAX_HOLD_SECONDS}.` };
  let allowTraces = current?.allowTraces ?? false;
  if (input.allowTraces !== undefined) {
    if (input.allowTraces === true && !owner && !allowTraces) return { ok: false, error: 'Only the owner turns traces on for an endpoint, in the window.' };
    allowTraces = input.allowTraces === true;
  }
  if (!current && !owner) allowTraces = false;

  const movedTo = baseUrl !== current?.baseUrl;
  // Plain http to a public address: only by the owner's explicit allowance, given in the window, for this address.
  if (input.allowPlainHttp !== undefined && !owner) return { ok: false, error: 'Only the owner allows plain http for an endpoint, in the window.' };
  const allowPlainHttp = input.allowPlainHttp ?? (movedTo ? false : current?.allowPlainHttp === true);
  if (transportOf(baseUrl!) === 'http-public' && !allowPlainHttp) {
    return { ok: false, error: 'A public address takes https. Plain http goes to loopback and private networks only, unless the owner allows it for this endpoint in the window.' };
  }
  let extraHeaders = current?.extraHeaders ?? {};
  if (input.extraHeaders !== undefined) {
    const clean = cleanExtraHeaders(input.extraHeaders);
    if (!clean.ok) return { ok: false, error: clean.error };
    extraHeaders = clean.headers;
  }
  const headersChanged = !sameExtraHeaders(extraHeaders, current?.extraHeaders);
  // The model's limits: the owner's, set in the window (they decide when a harness compacts and what it is refused).
  if ((input.contextWindow !== undefined || input.maxOutputTokens !== undefined) && !owner) {
    return { ok: false, error: 'Only the owner sets an endpoint\'s context window and output cap, in the window.' };
  }
  const contextWindow = input.contextWindow !== undefined ? input.contextWindow : current?.contextWindow;
  const maxOutputTokens = input.maxOutputTokens !== undefined ? input.maxOutputTokens : current?.maxOutputTokens;
  const badLimits = limitsError(contextWindow, maxOutputTokens);
  if (badLimits) return { ok: false, error: badLimits };
  const next: InferenceEndpoint = {
    ...(current ?? { id: newId(list), models: [], approved: false }),
    name, baseUrl: baseUrl!, allowTraces, holdMaxSeconds: hold,
    sendSessionHeaders: input.sendSessionHeaders ?? current?.sendSessionHeaders ?? false,
    allowPlainHttp, extraHeaders,
  } as InferenceEndpoint;
  if (typeof contextWindow === 'number') next.contextWindow = contextWindow; else delete next.contextWindow;
  if (typeof maxOutputTokens === 'number') next.maxOutputTokens = maxOutputTokens; else delete next.maxOutputTokens;
  if (owner) {
    // Approval stays apart from saving (found in the window's work on #599, 27/11). What the owner typed in the
    // window (a new address, new extra headers, or the approved values put back) is the owner's own, so approved by
    // that act. What an agent changed and the owner's form only sends back as it showed it stays pending: a save of
    // another field (traces, the name, the hold) never approves it. Only approveEndpoint does, for what was shown.
    const approvedHeaders = current ? approvedHeadersOf(current) : extraHeaders;
    const addressOk = !current || movedTo || current.approvedBaseUrl === baseUrl;
    const headersOk = !current || headersChanged || sameExtraHeaders(approvedHeaders, extraHeaders);
    next.approvedBaseUrl = addressOk ? baseUrl : current!.approvedBaseUrl;
    next.approvedExtraHeaders = headersOk ? extraHeaders : approvedHeaders;
    next.approved = addressOk && headersOk;
  } else if (movedTo || headersChanged) {
    // An address or extra headers an agent set wait for the owner (the approval guard, above).
    next.approved = false;
    next.changedBy = { agentId: actor.agentId, agentName: actor.agentName, at: now };
  }
  if (movedTo && current) { next.models = []; delete next.modelsReadAt; delete next.health; }
  const endpoints = current ? list.map(e => (e.id === next.id ? next : e)) : [...list, next];
  // An agent moving an endpoint's address takes its key away (the Audit's H1 on #596): the key was given for the old
  // address, and the owner approving the new one must not hand it over unawares. The owner's own move keeps it.
  let keys = settings.endpointKeys;
  if (current && movedTo && !owner && keys && next.id in keys) {
    keys = { ...keys };
    delete keys[next.id];
  }
  return { ok: true, settings: { ...settings, inferenceEndpoints: endpoints, ...(keys !== settings.endpointKeys ? { endpointKeys: keys } : {}) }, endpoint: next };
}

function newId(list: InferenceEndpoint[]): string {
  let id: string;
  do id = `ep-${randomBytes(3).toString('hex')}`; while (list.some(e => e.id === id));
  return id;
}

/**
 * Why what the window showed of an endpoint (its address and extra headers) is not the endpoint now, or null when it
 * is: an agent changed it while the form or the notice was open, and the owner must see that change first.
 */
function shownDiffers(current: InferenceEndpoint, shown: { baseUrl?: unknown; extraHeaders?: unknown } | undefined, act: 'save' | 'approve' = 'save'): string | null {
  const headers = shown?.extraHeaders;
  if (!shown || typeof shown.baseUrl !== 'string' || !headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return act === 'approve'
      ? 'An approval names the address and the extra headers it approves, as the window showed them.'
      : 'A save names the address and the extra headers the form showed, so a change made meanwhile is not taken for yours.';
  }
  if (shown.baseUrl === current.baseUrl && sameExtraHeaders(headers as Record<string, string>, current.extraHeaders)) return null;
  // The time as the notices say it, UTC then the machine's own with its offset (utils/two-zones.ts): the window shows
  // these words as they come.
  const at = current.changedBy ? Date.parse(current.changedBy.at) : NaN;
  const by = current.changedBy ? ` (${current.changedBy.agentName ?? current.changedBy.agentId}${Number.isNaN(at) ? '' : `, ${twoZones(at)}`})` : '';
  return `The endpoint "${current.name}" changed since it was shown${by}: look at it again before you ${act}.`;
}

/** The extra headers the owner approved; for an endpoint approved before they were recorded, its own. */
function approvedHeadersOf(e: InferenceEndpoint): Record<string, string> {
  return e.approvedExtraHeaders ?? (e.approved ? e.extraHeaders ?? {} : {});
}

/**
 * The owner's approval, from the window only, of exactly what the window showed (`seen`: the address and the extra
 * headers). Refused when they are not the endpoint's now: an agent changed it again while the notice was open, and
 * the owner must see that change before approving it.
 */
export function approveEndpoint(settings: AppSettings, id: string, seen?: { baseUrl?: unknown; extraHeaders?: unknown }): Result {
  const list = endpointsOf(settings);
  const current = list.find(e => e.id === id);
  if (!current) return { ok: false, error: 'There is no such endpoint.' };
  if (!seen) return { ok: false, error: 'An approval names the address and the extra headers it approves, as the window showed them.' };
  const stale = shownDiffers(current, seen, 'approve');
  if (stale) return { ok: false, error: stale };
  const next: InferenceEndpoint = { ...current, approved: true, approvedBaseUrl: current.baseUrl, approvedExtraHeaders: current.extraHeaders ?? {} };
  return { ok: true, settings: { ...settings, inferenceEndpoints: list.map(e => (e.id === id ? next : e)) }, endpoint: next };
}

/** Removed, with its key: refused while an agent runs on it. */
export function removeEndpoint(settings: AppSettings, id: string, agents: AgentStatus[]): { ok: true; settings: AppSettings } | { ok: false; error: string; agents?: string[] } {
  const list = endpointsOf(settings);
  if (!list.some(e => e.id === id)) return { ok: false, error: 'There is no such endpoint.' };
  const users = agents.filter(a => a.endpointId === id);
  if (users.length) return { ok: false, error: 'Agents run on this endpoint: move them first.', agents: users.map(a => a.name || a.id) };
  const keys = { ...(settings.endpointKeys ?? {}) };
  delete keys[id];
  return { ok: true, settings: { ...settings, inferenceEndpoints: list.filter(e => e.id !== id), endpointKeys: keys } };
}

/** The key set, rotated or cleared. Write-only: nothing returns it. No approval is needed or taken. */
export function setEndpointKey(settings: AppSettings, id: string, key: string | null): Result {
  const current = endpointsOf(settings).find(e => e.id === id);
  if (!current) return { ok: false, error: 'There is no such endpoint.' };
  const keys = { ...(settings.endpointKeys ?? {}) };
  if (key === null || key === '') delete keys[id];
  else {
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(key)) return { ok: false, error: 'A key is one line of printable characters, with no spaces.' };
    keys[id] = key;
  }
  return { ok: true, settings: { ...settings, endpointKeys: keys }, endpoint: current };
}

/** What the window and the agents see: everything but the key, and who runs on each. */
export function endpointViews(settings: AppSettings, agents: AgentStatus[]): EndpointView[] {
  const keys = settings.endpointKeys ?? {};
  return endpointsOf(settings).map(e => ({
    id: e.id, name: e.name, baseUrl: e.baseUrl, allowTraces: e.allowTraces === true, keySet: typeof keys[e.id] === 'string' && keys[e.id] !== '',
    models: Array.isArray(e.models) ? e.models : [], modelsReadAt: e.modelsReadAt, modelsError: e.modelsError,
    agents: agents.filter(a => a.endpointId === e.id).map(a => ({ id: a.id, name: a.name ?? a.id, projectPath: a.projectPath, provider: String(a.provider ?? ''), model: a.model })),
    approved: e.approved === true, approvedBaseUrl: e.approvedBaseUrl, changedBy: e.changedBy,
    holdMaxSeconds: typeof e.holdMaxSeconds === 'number' ? e.holdMaxSeconds : DEFAULT_HOLD_SECONDS,
    sendSessionHeaders: e.sendSessionHeaders === true, health: e.health,
    plainHttp: transportOf(e.baseUrl) !== 'https', allowPlainHttp: e.allowPlainHttp === true,
    extraHeaders: { ...(e.extraHeaders ?? {}) }, ...(e.approvedExtraHeaders ? { approvedExtraHeaders: { ...e.approvedExtraHeaders } } : {}),
    ...(typeof e.contextWindow === 'number' ? { contextWindow: e.contextWindow } : {}),
    ...(typeof e.maxOutputTokens === 'number' ? { maxOutputTokens: e.maxOutputTokens } : {}),
  }));
}

/** Where the proxy sends an agent's requests, or why it must not. Only an approved endpoint, at its approved URL. */
export function endpointTarget(settings: AppSettings, id: string): ProxyTarget | { refused: { status: number; type: string; message: string } } {
  const e = endpointsOf(settings).find(x => x.id === id);
  if (!e) return { refused: { status: 404, type: 'endpoint_not_found', message: 'This agent\'s endpoint is no longer in Tars.' } };
  if (!e.approved || !e.approvedBaseUrl || e.approvedBaseUrl !== e.baseUrl) {
    return { refused: { status: 403, type: 'endpoint_not_approved', message: `The owner has not approved the endpoint "${e.name}" at this address yet: Settings, Inference endpoints.` } };
  }
  return {
    baseUrl: e.approvedBaseUrl, key: settings.endpointKeys?.[id] || null,
    holdMaxSeconds: typeof e.holdMaxSeconds === 'number' ? e.holdMaxSeconds : DEFAULT_HOLD_SECONDS, sendSessionHeaders: e.sendSessionHeaders === true,
    extraHeaders: { ...(e.extraHeaders ?? {}) },
  };
}

/** Why an agent may not run on this endpoint and model with this harness, or null when it may (or has none). */
export function validateEndpointChoice(
  settings: AppSettings,
  choice: { endpointId: string | null | undefined; provider: string | undefined; model: string | null | undefined },
  support: Partial<Record<string, ToolCallSupport>> = {},
): string | null {
  if (!choice.endpointId) return null;
  const e = endpointsOf(settings).find(x => x.id === choice.endpointId);
  if (!e) return 'There is no such endpoint.';
  if (!e.approved || e.approvedBaseUrl !== e.baseUrl) return `The owner must approve the endpoint "${e.name}" in the window first.`;
  if (!ENDPOINT_HARNESSES.includes(choice.provider as EndpointHarness)) return 'An endpoint runs codex, pi, qwen-code or opencode.';
  if (support[choice.provider!] === 'failed') return `${choice.provider} was measured failing tool calls on an endpoint, so it is not offered.`;
  if (!choice.model || !(e.models ?? []).includes(choice.model)) return `The endpoint "${e.name}" does not list the model "${choice.model ?? ''}". Refresh its models first.`;
  return null;
}

/**
 * The key an agent dropped for Tars, read and taken away at once. For a caller with nothing to write in between.
 */
export function takeKeyFromDropFile(name: unknown, dir: string = ENDPOINT_KEYS_DIR): { ok: true; key: string } | { ok: false; error: string } {
  const r = readKeyFromDropFile(name, dir);
  if (!r.ok) return r;
  r.consume();
  return { ok: true, key: r.key };
}

/**
 * The key an agent dropped for Tars: `<dir>/<name>`, a plain file of one printable line, 8 KiB at most, with one
 * link, in a drop folder that is a real folder. Read, and left in place: `consume()` takes that very file away (the
 * same inode, never a file put there since), to be called once the settings holding the key are written. The drop
 * file is how the owner hands Tars a production key: a save that fails must leave it exactly as it was. A file that
 * fails a check is left as it is, and nothing of its content is said.
 */
export function readKeyFromDropFile(name: unknown, dir: string = ENDPOINT_KEYS_DIR): { ok: true; key: string; consume(): void } | { ok: false; error: string } {
  if (typeof name !== 'string' || !DROP_NAME.test(name) || name.includes('..') || name === '.key') {
    return { ok: false, error: `A key file is named like <name>.key (letters, digits, . _ -), in ${ENDPOINT_KEYS_DIR}, and nowhere else.` };
  }
  let dirStat: fs.Stats;
  try { dirStat = fs.lstatSync(dir); } catch { return { ok: false, error: `There is no drop folder ${dir}: write the key into ${path.join(dir, name)}.` }; }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return { ok: false, error: 'The drop folder is not a plain folder: nothing is read from it.' };
  const file = path.join(dir, name);
  let before: fs.Stats;
  try { before = fs.lstatSync(file); } catch { return { ok: false, error: `There is no file ${name} in the drop folder.` }; }
  if (before.isSymbolicLink() || !before.isFile()) return { ok: false, error: `${name} is not a plain file: it is left as it is.` };
  if (before.nlink !== 1) return { ok: false, error: `${name} has another link: it is left as it is.` };
  if (before.size > MAX_KEY_BYTES) return { ok: false, error: `${name} is over ${MAX_KEY_BYTES} bytes: it is left as it is.` };
  const noFollow = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow); } catch { return { ok: false, error: `${name} could not be opened: it is left as it is.` }; }
  let raw: Buffer;
  try {
    const after = fs.fstatSync(fd);
    if (after.ino !== before.ino || after.dev !== before.dev || !after.isFile()) return { ok: false, error: `${name} changed while it was read: it is left as it is.` };
    raw = Buffer.alloc(Math.min(after.size, MAX_KEY_BYTES));
    fs.readSync(fd, raw, 0, raw.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const key = raw.toString('utf8').replace(/\r?\n$/, '');
  if (!/^[\x21-\x7e]{1,8192}$/.test(key)) return { ok: false, error: `${name} is not one line of printable characters without spaces: it is left as it is.` };
  const read = before;
  const consume = () => {
    try {
      const now = fs.lstatSync(file);
      if (now.ino !== read.ino || now.dev !== read.dev) return;
      fs.rmSync(file, { force: true });
    } catch (err) {
      // Its name and the error's code only: never the key.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') console.error(`[endpoints] the drop file ${name} could not be removed after its key was saved (${code ?? 'error'})`);
    }
  };
  return { ok: true, key, consume };
}

/** The drop folder, made private (0700) where the system has modes. */
export function ensureDropFolder(dir: string = ENDPOINT_KEYS_DIR): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows: no modes */ }
}

/** What a probe changes on an endpoint, applied to the settings as they are when it is written (the Audit's M1). */
export type EndpointPatch = Partial<Pick<InferenceEndpoint, 'models' | 'modelsReadAt' | 'modelsError' | 'health'>>;

/**
 * A probe's patch onto the settings as they are now. With `probed`, the address the probe went to: when the endpoint
 * has moved since, the patch describes another address and is dropped (the re-audit's I1 on #596).
 */
export function applyEndpointPatch(settings: AppSettings, id: string, patch: EndpointPatch, probed?: string): AppSettings {
  const now = endpointsOf(settings).find(e => e.id === id);
  if (!now || (probed !== undefined && now.baseUrl !== probed)) return settings;
  return { ...settings, inferenceEndpoints: endpointsOf(settings).map(e => (e.id === id ? { ...e, ...patch } : e)) };
}

function withoutKey(text: string, key: string | null): string {
  return key ? text.split(key).join('<key>') : text;
}

/**
 * Where a probe goes, and with which key: the key only to the address the owner approved, as the proxy sends it
 * (the Audit's H1 on #596). An endpoint whose address an agent changed is probed at its new address with no key.
 */
function probeOf(settings: AppSettings, e: InferenceEndpoint): { url: string; key: string | null; headers: Record<string, string> } {
  const approvedNow = e.approved === true && !!e.approvedBaseUrl && e.approvedBaseUrl === e.baseUrl;
  // The extra headers go where the key goes: an endpoint that needs them would refuse the probe without them.
  const extra = approvedNow ? Object.fromEntries(Object.entries(e.extraHeaders ?? {}).filter(([n]) => !isRefusedExtraHeader(n))) : {};
  return { url: `${e.baseUrl}/models`, key: approvedNow ? settings.endpointKeys?.[e.id] || null : null, headers: extra };
}

/** A redirect is never followed: the key, or the probe, would go to an address nobody approved. */
const REDIRECT_REFUSED = 'The endpoint answered with a redirect, which Tars does not follow.';

/**
 * The endpoint's own /v1/models. A bad answer says why, never the key, and leaves the last list. It hands back a
 * patch, never the settings: they are read again when it is written.
 */
export async function readModels(settings: AppSettings, id: string, fetchImpl: typeof fetch = fetch, now: string = new Date().toISOString()):
  Promise<{ ok: true; models: string[]; patch: EndpointPatch; probed: string } | { ok: false; error: string; patch: EndpointPatch; probed?: string }> {
  const e = endpointsOf(settings).find(x => x.id === id);
  if (!e) return { ok: false, error: 'There is no such endpoint.', patch: {} };
  const probed = e.baseUrl;
  const { url, key, headers } = probeOf(settings, e);
  let error: string;
  try {
    const res = await fetchImpl(url, { headers: { ...headers, Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (res.status >= 300 && res.status < 400) error = REDIRECT_REFUSED;
    else if (!res.ok) error = `HTTP ${res.status}: ${text.slice(0, 200)}`;
    else {
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
      const data = (parsed as { data?: unknown })?.data;
      const models = Array.isArray(data) ? data.map(m => (m as { id?: unknown })?.id).filter((m): m is string => typeof m === 'string' && m.length > 0) : null;
      if (models && models.length) return { ok: true, models, patch: { models, modelsReadAt: now, modelsError: undefined }, probed };
      error = 'The endpoint answered, but not with a list of models (/v1/models).';
    }
  } catch (err) {
    error = (err as Error).message;
  }
  const said = withoutKey(error, key).slice(0, 300);
  return { ok: false, error: said, patch: { modelsError: said }, probed };
}

/** A /v1/models probe: its status, latency and time. Never the key, and the key only to the approved address. */
export async function checkHealth(settings: AppSettings, id: string, fetchImpl: typeof fetch = fetch, now: string = new Date().toISOString(), clock: () => number = Date.now):
  Promise<{ health: NonNullable<InferenceEndpoint['health']>; patch: EndpointPatch; probed?: string }> {
  const e = endpointsOf(settings).find(x => x.id === id);
  if (!e) return { health: { ok: false, at: now, error: 'There is no such endpoint.' }, patch: {} };
  const probed = e.baseUrl;
  const { url, key, headers } = probeOf(settings, e);
  const started = clock();
  let health: NonNullable<InferenceEndpoint['health']>;
  try {
    const res = await fetchImpl(url, { headers: { ...headers, ...(key ? { Authorization: `Bearer ${key}` } : {}) }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const latencyMs = clock() - started;
    const text = await res.text().catch(() => '');
    const redirect = res.status >= 300 && res.status < 400;
    health = { ok: res.ok && !redirect, status: res.status, latencyMs, at: now, ...(res.ok && !redirect ? {} : { error: redirect ? REDIRECT_REFUSED : withoutKey(text.slice(0, 200), key) }) };
  } catch (err) {
    health = { ok: false, latencyMs: clock() - started, at: now, error: withoutKey((err as Error).message, key).slice(0, 200) };
  }
  return { health, patch: { health }, probed };
}
