import * as fs from 'fs';
import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { API_TOKEN_FILE, BRIDGE_TOKEN_FILE, DATA_DIR, ENDPOINT_PROXY_PORT, privatePath } from '../constants';
import type { AgentStatus, AppSettings, TraceSettings } from '../types';
import { writeSecretFileSync } from '../utils/secret-file';
import { hasOrchestratorPowers } from '../core/agent-role';
import { updateSharedJsonSync } from '../utils/shared-file';
import { startEndpointProxy, stopEndpointProxy, type HoldEvent, type ProxySession } from './endpoint-proxy';
import { endpointLaunchFor, piModelsWithEndpoint, type EndpointLaunch } from './endpoint-harness';
import { ENDPOINT_HARNESSES, endpointTarget, ensureDropFolder, transportOf } from './inference-endpoints';
import { TraceStore } from './trace-store';
import { defaultTracePairs, traceDecision } from './trace-gate';
import { projectEnvValues, scrubValue, SCRUB_VERSION, type ScrubContext } from './trace-scrub';
import { sessionDocument } from './trace-export';
import { TraceUploader } from './trace-upload';
import { SECRET_FIELDS } from './settings-secrets';

/**
 * The running side of inference endpoints and native traces: wires the proxy, the per-terminal
 * sessions, the trace store, the holds the window shows, authorship and the reader token to the rest of Tars.
 *
 * - **A session per terminal.** When an agent on an endpoint gets a terminal (core/agent-pty.ts), a token and a
 *   trace id are minted for it, in memory only, and the token goes into the variables its harness reads it from
 *   (endpoint-harness.ts). The token dies with the terminal. Whether the session is traced is decided then
 *   (trace-gate.ts), from the settings as they are at that spawn.
 * - **Authorship.** What Tars types into an agent's terminal (core/pty-manager.ts writeProgrammaticInput), and from
 *   whom, is noted in the store for a traced agent: an agent's words, a channel's, the user's, Tars's own. An agent
 *   that is not an open harness on an endpoint is a closed model: its words make the session `mixed`.
 * - **The reader token** (`~/.tars-private/traces-reader-token`, 0600) opens `GET /api/traces/*` and nothing else,
 *   like a Hermes gateway's secret opens its own route (services/hermes-gateways.ts).
 */

export const TRACES_DB_FILE = path.join(DATA_DIR, 'traces', 'traces.db');
export const TRACES_READER_TOKEN_FILE = privatePath('traces-reader-token');
export const PROXY_BASE = `http://127.0.0.1:${ENDPOINT_PROXY_PORT}/v1`;
const GIB = 1024 ** 3;

export interface TracesDeps {
  getSettings(): AppSettings;
  /** Holds and writes the settings, as the window's saves do: the API's endpoint routes change them. */
  saveSettings(settings: AppSettings): void;
  getAgent(id: string): AgentStatus | undefined;
  /** Tells the window: 'traces:changed', 'endpoints:waiting', 'endpoints:changed'. */
  emit(channel: string, payload?: unknown): void;
  /** Tars's version, sent when the install registers with a back-office. */
  clientVersion?: string;
}

let deps: TracesDeps | null = null;
let store: TraceStore | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let changedTimer: NodeJS.Timeout | null = null;
let readerLastUsedAt: string | undefined;
let uploader: TraceUploader | null = null;
let uploadTimer: NodeJS.Timeout | null = null;
let uploadSoon: NodeJS.Timeout | null = null;
export const TRACES_INSTALL_FILE = privatePath('traces-install.json');

/** An agent being created, whose terminal is spawned before its record is in the fleet (agent:create). */
const preRegistered = new Map<string, AgentStatus>();
export function preRegisterAgent(agent: Partial<AgentStatus> & { id: string }): void {
  preRegistered.set(agent.id, agent as AgentStatus);
}
export function clearPreRegistered(id: string): void {
  preRegistered.delete(id);
}
const agentOf = (id: string): AgentStatus | undefined => deps?.getAgent(id) ?? preRegistered.get(id);

interface LiveSession extends ProxySession { harness: string; model: string; startedAt: number }
const sessions = new Map<string, LiveSession>();
const waits = new Map<string, Extract<HoldEvent, { since: number }>>();

/**
 * The trace settings with their defaults: no project opted in, 5 GiB, 30 days, no pair (the owner names them), closed
 * models left out, no upload address.
 */
export function traceSettingsOf(settings: Partial<AppSettings> | undefined): TraceSettings {
  const t = settings?.traces;
  return {
    projects: Array.isArray(t?.projects) ? t!.projects.filter(p => typeof p === 'string' && path.isAbsolute(p)) : [],
    capBytes: typeof t?.capBytes === 'number' && t.capBytes > 0 ? t.capBytes : 5 * GIB,
    retentionDays: typeof t?.retentionDays === 'number' && t.retentionDays > 0 ? t.retentionDays : 30,
    pairs: Array.isArray(t?.pairs) ? t!.pairs : defaultTracePairs(),
    excludeClosedModels: t?.excludeClosedModels !== false,
    uploadUrl: typeof t?.uploadUrl === 'string' ? t.uploadUrl : '',
    ...(typeof t?.uploadConsentAt === 'string' ? { uploadConsentAt: t.uploadConsentAt } : {}),
    ...(t?.uploadAllowPlainHttp === true ? { uploadAllowPlainHttp: true } : {}),
    ...(typeof t?.uploadDeletedAt === 'number' ? { uploadDeletedAt: t.uploadDeletedAt } : {}),
    ...(t?.uploadDeletionOwed === true ? { uploadDeletionOwed: true } : {}),
  };
}

/**
 * What the scrubber masks for a project's sessions (trace-scrub.ts): every secret Tars holds (the settings' keys,
 * the endpoints' keys, its API and reader tokens), the project's .env values, and the home folder in each spelling.
 */
export function scrubContextFor(projectPath: string | undefined): ScrubContext {
  const settings = deps?.getSettings() ?? ({} as AppSettings);
  const known: string[] = [];
  const collect = (v: unknown) => {
    if (typeof v === 'string') known.push(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) collect(x);
  };
  for (const f of SECRET_FIELDS) collect((settings as unknown as Record<string, unknown>)[f]);
  for (const file of [API_TOKEN_FILE, BRIDGE_TOKEN_FILE, TRACES_READER_TOKEN_FILE]) {
    try { known.push(fs.readFileSync(file, 'utf8').trim()); } catch { /* none */ }
  }
  const home = os.homedir();
  return {
    homeDirs: [...new Set([home, home.replace(/\\/g, '/')])],
    knownSecrets: [...new Set(known.filter(k => k.length >= 8))],
    envValues: projectPath ? projectEnvValues(projectPath) : [],
  };
}

/** One session as it would be uploaded: its document, scrubbed, and what was masked, by kind. */
export function previewUpload(traceId: string): { document: unknown; counts: Record<string, number>; scrubVersion: string } | null {
  const doc = sessionDocument(traceStore(), traceId);
  if (!doc) return null;
  const counts: Record<string, number> = {};
  const document = scrubValue(doc, scrubContextFor(String(doc.trace.project_path ?? '')), counts);
  return { document, counts, scrubVersion: SCRUB_VERSION };
}

export function traceStore(): TraceStore {
  if (!store) store = new TraceStore(TRACES_DB_FILE);
  return store;
}

/** The uploader to the user's back-office (trace-upload.ts): idle while no address or no consent. */
export function traceUploader(): TraceUploader {
  if (!uploader) {
    uploader = new TraceUploader({
      store: traceStore(),
      installFile: TRACES_INSTALL_FILE,
      // An address that breaks the plain-http rule (a file edited by hand) is no address: nothing goes.
      settings: () => {
        const t = traceSettingsOf(deps?.getSettings());
        const allowed = !t.uploadUrl || transportOf(t.uploadUrl) !== 'http-public' || t.uploadAllowPlainHttp === true;
        return { url: allowed ? t.uploadUrl : '', consentAt: t.uploadConsentAt, since: t.uploadDeletedAt, deletionOwed: t.uploadDeletionOwed === true };
      },
      setDeletion: (d) => {
        if (!deps) return;
        const t = traceSettingsOf(deps.getSettings());
        const { uploadDeletedAt: _at, uploadDeletionOwed: _owed, ...rest } = t;
        deps.saveSettings({ ...deps.getSettings(), traces: { ...rest, ...(d.since !== undefined ? { uploadDeletedAt: d.since } : {}), ...(d.owed ? { uploadDeletionOwed: true } : {}) } });
        deps.emit('traces:changed');
      },
      // Opted in now, not only when the session was recorded: a project or an agent switched off since is not sent.
      eligible: (q) => traceSettingsOf(deps?.getSettings()).projects.includes(q.projectPath) && agentOf(q.agentId)?.traces === true,
      scrubContext: (projectPath) => scrubContextFor(projectPath),
      client: { name: 'tars', version: deps?.clientVersion ?? 'unknown', platform: process.platform },
      // After "delete everything sent": no upload again until the user consents again.
      withdrawConsent: () => {
        if (!deps) return;
        const t = traceSettingsOf(deps.getSettings());
        const { uploadConsentAt: _gone, ...rest } = t;
        deps.saveSettings({ ...deps.getSettings(), traces: rest });
        deps.emit('traces:changed');
      },
    });
  }
  return uploader;
}

function uploadPass(): void {
  const t = traceSettingsOf(deps?.getSettings());
  if (!t.uploadUrl || !t.uploadConsentAt) return;
  void traceUploader().runOnce().then((r) => { if (r.sent || r.failed) deps?.emit('traces:changed'); });
}

function changed(): void {
  // A pass 30 s after the last change, besides the one every 5 minutes.
  if (uploadSoon) clearTimeout(uploadSoon);
  uploadSoon = setTimeout(() => { uploadSoon = null; uploadPass(); }, 30_000);
  uploadSoon.unref?.();
  if (changedTimer) return;
  changedTimer = setTimeout(() => { changedTimer = null; deps?.emit('traces:changed'); }, 1000);
  changedTimer.unref?.();
}

export function sweepTraces(): void {
  // Nothing to sweep for a user who has never traced a session: the store is not created for that (the Audit's I2).
  if (!deps || (!store && !fs.existsSync(TRACES_DB_FILE))) return;
  const t = traceSettingsOf(deps.getSettings());
  try {
    const r = traceStore().sweep({ capBytes: t.capBytes, retentionDays: t.retentionDays, now: Date.now() });
    if (r.deleted) changed();
  } catch (err) {
    console.error(`[traces] sweep failed: ${(err as Error).message}`);
  }
}

/** The proxy on its port, and the hourly sweep. Called once at startup. */
/** What the runtime reads and writes through (the settings, the fleet, the window), without starting anything. */
export function configureTraces(d: TracesDeps): void {
  deps = d;
}

export function startTracesRuntime(d: TracesDeps): void {
  configureTraces(d);
  sweepTimer = setInterval(sweepTraces, 3600_000);
  sweepTimer.unref?.();
  sweepTraces();
  uploadTimer = setInterval(uploadPass, 5 * 60_000);
  uploadTimer.unref?.();
  uploadPass();
}

/**
 * The proxy on its port, started with the first terminal of an agent on an endpoint, not at boot: an install with no
 * endpoint binds no port of it (the Audit's I2 on #596).
 */
let proxyStarted = false;
function ensureProxy(): void {
  const d = deps;
  if (proxyStarted || !d) return;
  proxyStarted = true;
  try { ensureDropFolder(); } catch { /* made again when an agent drops a key */ }
  startEndpointProxy(ENDPOINT_PROXY_PORT, {
    sessionOf: (token) => sessions.get(token),
    targetOf: (endpointId) => endpointTarget(d.getSettings(), endpointId),
    record: (rec) => {
      if (traceStore().ingest(rec)) {
        changed();
        const t = traceSettingsOf(d.getSettings());
        if (traceStore().stats().bytes > t.capBytes) sweepTraces();
      }
    },
    onHold: (e) => {
      if ('cleared' in e) waits.delete(e.agentId); else waits.set(e.agentId, e);
      d.emit('endpoints:waiting', endpointWaits());
    },
  });
}

export function stopTracesRuntime(): void {
  proxyStarted = false;
  stopEndpointProxy();
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  if (uploadTimer) clearInterval(uploadTimer);
  if (uploadSoon) clearTimeout(uploadSoon);
  uploadTimer = null;
  uploadSoon = null;
  uploader = null;
  store?.close();
  store = null;
}

export function endpointWaits(): Array<Extract<HoldEvent, { since: number }>> {
  return [...waits.values()];
}

export function endpointWaitOf(agentId: string): Extract<HoldEvent, { since: number }> | undefined {
  return waits.get(agentId);
}

/** Whether this agent runs its harness on an endpoint: one of the four, with an endpoint chosen. */
function onEndpoint(agent: AgentStatus | undefined): agent is AgentStatus & { endpointId: string } {
  return !!agent?.endpointId && ENDPOINT_HARNESSES.includes(agent.provider as typeof ENDPOINT_HARNESSES[number]);
}

/**
 * What the agent's harness is given to reach its endpoint (endpoint-harness.ts), or null when it runs on none.
 * For pi, Tars's provider in its models.json is brought up to date here, before the launch reads it.
 */
export function endpointLaunchForAgent(agentId: string | undefined, harness: string): EndpointLaunch | null {
  if (!agentId || !deps) return null;
  const agent = agentOf(agentId);
  if (!onEndpoint(agent) || agent.provider !== harness || !agent.model) return null;
  const launch = endpointLaunchFor(harness, { proxyBase: PROXY_BASE, model: agent.model });
  if (launch && harness === 'pi') {
    const file = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'models.json');
    const models = (deps.getSettings().inferenceEndpoints ?? []).filter(e => e.approved).flatMap(e => e.models ?? []);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      updateSharedJsonSync<Record<string, unknown>>(file, current => piModelsWithEndpoint(current, PROXY_BASE, models), { createMode: 0o600 });
    } catch (err) {
      console.error(`[endpoints] pi's models.json not updated: ${(err as Error).message}`);
    }
  }
  return launch;
}

/**
 * At an agent terminal's spawn: its endpoint session, minted, and the variables that carry its token. Empty for an
 * agent on no endpoint. The token is revoked by closeEndpointSession when the terminal exits.
 */
export function openEndpointSession(agentId: string): { env: Record<string, string>; token?: string } {
  if (!deps) return { env: {} };
  const agent = agentOf(agentId);
  if (!onEndpoint(agent) || !agent.model) return { env: {} };
  const harness = String(agent.provider);
  const launch = endpointLaunchFor(harness, { proxyBase: PROXY_BASE, model: agent.model });
  if (!launch) return { env: {} };
  ensureProxy();
  const settings = deps.getSettings();
  const endpoint = (settings.inferenceEndpoints ?? []).find(e => e.id === agent.endpointId);
  const t = traceSettingsOf(settings);
  const decision = traceDecision({
    provider: harness, model: agent.model,
    endpoint: endpoint ? { allowTraces: endpoint.allowTraces === true, approved: endpoint.approved === true && endpoint.approvedBaseUrl === endpoint.baseUrl } : undefined,
    projectOptedIn: t.projects.includes(agent.projectPath), agentOptedIn: agent.traces === true, pairs: t.pairs,
    excludeClosedModels: t.excludeClosedModels,
  });
  const token = `tep_${randomBytes(24).toString('hex')}`;
  const traceId = `tr_${Date.now().toString(36)}${randomBytes(8).toString('hex')}`;
  const live: LiveSession = { token, traceId, agentId, endpointId: agent.endpointId, traced: decision.traced, harness, model: agent.model, startedAt: Date.now() };
  sessions.set(token, live);
  if (decision.traced) {
    try {
      traceStore().openTrace({
        traceId, projectPath: agent.projectPath, agentId, agentName: agent.name, harness,
        endpointId: agent.endpointId, endpointName: endpoint?.name, endpointBaseUrl: endpoint?.approvedBaseUrl, model: agent.model, startedAt: live.startedAt,
      });
      changed();
    } catch (err) {
      console.error(`[traces] session not opened: ${(err as Error).message}`);
      live.traced = false;
    }
  }
  const env: Record<string, string> = {};
  for (const name of launch.tokenVars) env[name] = token;
  return { env, token };
}

/** At the terminal's exit: the token opens nothing any more, and its trace is ended. */
export function closeEndpointSession(token: string | undefined): void {
  if (!token) return;
  const live = sessions.get(token);
  sessions.delete(token);
  if (!live) return;
  waits.delete(live.agentId);
  if (!live.traced) return;
  const endedAt = Date.now();
  const agent = agentOf(live.agentId);
  const folder = agent?.worktreePath || agent?.projectPath;
  void gitOutcome(folder).then((git) => {
    try {
      const counts = traceStore().requestCounts(live.traceId);
      traceStore().endTrace(live.traceId, endedAt, { ...git, heldRequests: counts.held, requestErrors: counts.errors });
      changed();
    } catch (err) {
      console.error(`[traces] session not ended: ${(err as Error).message}`);
    }
  });
}

/** The branch and head of the folder the agent worked in, when it is a git checkout (argv, never a shell). */
function gitOutcome(folder: string | undefined): Promise<{ branch?: string; head?: string }> {
  if (!folder) return Promise.resolve({});
  const git = (args: string[]) => new Promise<string | undefined>((resolve) => {
    execFile('git', ['-C', folder, ...args], { timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? undefined : String(out).trim() || undefined));
  });
  return Promise.all([git(['rev-parse', '--abbrev-ref', 'HEAD']), git(['rev-parse', 'HEAD'])]).then(([branch, head]) => ({
    ...(branch ? { branch } : {}), ...(head ? { head } : {}),
  }));
}

/** The trace an agent's current terminal records, if any. */
export function liveTraceOf(agentId: string): string | undefined {
  for (const s of sessions.values()) if (s.agentId === agentId && s.traced) return s.traceId;
  return undefined;
}

type Sender =
  | { kind: 'agent'; id: string; name?: string }
  | { kind: 'tars' }
  | { kind: 'channel'; channel: string }
  | { kind: 'user'; via: string }
  | { kind: 'owner-relay'; by: { id: string; name?: string } };

/** What Tars typed into a traced agent's terminal, and from whom: the turn it opens is attributed to them. */
export function noteTypedForTraces(origin: { agentId: string; from?: string; sender?: Sender } | undefined, text: string): void {
  if (!origin || !deps || !liveTraceOf(origin.agentId)) return;
  const s = origin.sender;
  let author = 'user';
  let detail: string | undefined;
  let closed = false;
  if (s?.kind === 'agent') {
    const sender = deps.getAgent(s.id);
    // Anyone with the orchestrator's powers, a chat's runner included, writes as an orchestrator (core/agent-role.ts).
    author = sender && hasOrchestratorPowers(sender) ? 'orchestrator' : 'agent';
    detail = `${s.name ?? sender?.name ?? s.id} (${sender?.provider ?? 'unknown'}${sender?.model ? ` ${sender.model}` : ''})`;
    closed = !onEndpoint(sender);
  } else if (s?.kind === 'tars') {
    author = 'tars';
  } else if (s?.kind === 'channel') {
    author = 'relay';
    detail = s.channel;
  } else if (s?.kind === 'user') {
    author = 'user';
    detail = s.via;
  } else if (s?.kind === 'owner-relay') {
    author = 'user';
    detail = `relayed by ${s.by.name ?? s.by.id}`;
  } else if (origin.from) {
    detail = origin.from;
  }
  try {
    traceStore().noteTypedInput({ agentId: origin.agentId, at: Date.now(), author, authorDetail: detail, text, closed });
  } catch (err) {
    console.error(`[traces] typed input not noted: ${(err as Error).message}`);
  }
}

// ── The reader token ─────────────────────────────────────────────────

function readReaderToken(): string {
  try { return fs.readFileSync(TRACES_READER_TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

export function readerTokenStatus(): { exists: boolean; createdAt?: string; lastUsedAt?: string; route: string; listen: 'loopback' } {
  let createdAt: string | undefined;
  try { createdAt = fs.statSync(TRACES_READER_TOKEN_FILE).mtime.toISOString(); } catch { /* none */ }
  return { exists: !!readReaderToken(), createdAt, lastUsedAt: readerLastUsedAt, route: '/api/traces/', listen: 'loopback' };
}

/** A new reader token, shown once: the one before opens nothing from now on. */
export function rotateReaderToken(): string {
  const token = `trd_${randomBytes(32).toString('hex')}`;
  writeSecretFileSync(TRACES_READER_TOKEN_FILE, token);
  readerLastUsedAt = undefined;
  return token;
}

export function revokeReaderToken(): void {
  fs.rmSync(TRACES_READER_TOKEN_FILE, { force: true });
  readerLastUsedAt = undefined;
}

/** Whether this is the reader token, compared whole and in constant time. */
export function isReaderToken(presented: string): boolean {
  const held = readReaderToken();
  if (!presented || !held) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(held);
  const same = a.length === b.length && timingSafeEqual(a, b);
  if (same) readerLastUsedAt = new Date().toISOString();
  return same;
}

/** The settings changed by an API route (an agent's endpoint tools), held and saved as the window's saves are. */
export function saveSettingsFromApi(settings: AppSettings): void {
  if (!deps) throw new Error('Tars is not ready.');
  deps.saveSettings(settings);
}

/** Tells the window an endpoint changed, and whether it now waits for the owner's approval. */
export function tellEndpointChanged(e: { id: string; by?: { agentId: string; agentName?: string }; needsApproval: boolean }): void {
  deps?.emit('endpoints:changed', e);
}
