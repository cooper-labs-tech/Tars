import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { API_TOKEN_FILE, BRIDGE_TOKEN_FILE, DATA_DIR, ENDPOINT_PROXY_PORT, privatePath } from '../constants';
import type { AgentStatus, AppSettings, TraceSettings } from '../types';
import { describeSecretFileError, writeSecretFileSync } from '../utils/secret-file';
import { hasOrchestratorPowers } from '../core/agent-role';
import { safeGit } from '../utils/safe-git';
import { updateSharedJsonSync } from '../utils/shared-file';
import { startEndpointProxy, stopEndpointProxy, type HoldEvent, type ProxySession } from './endpoint-proxy';
import { endpointLaunchFor, piModelsWithEndpoint, type EndpointLaunch } from './endpoint-harness';
import { ENDPOINT_HARNESSES, endpointTarget, ensureDropFolder, transportOf } from './inference-endpoints';
import { TraceStore } from './trace-store';
import { defaultTracePairs, traceDecision } from './trace-gate';
import { projectEnvValues, type ScrubContext } from './trace-scrub';
import { TraceUploader } from './trace-upload';
import { WorkspaceRecorder } from './turn-workspace';
import { ciVerdicts, recordVerdict, type VerdictCaller, type VerdictInput } from './gate-verdicts';
import { SECRET_FIELDS, keysKeptAfter, withKeptKeys } from './settings-secrets';

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
  /** Holds the settings in memory, where the uploader, the proxy and the window read them. */
  setSettings(settings: AppSettings): void;
  /** Writes the settings to disk, or throws saying why (main.ts writeAppSettingsFile). */
  writeSettings(settings: AppSettings): void;
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

/**
 * The consent to upload, in a file of its own beside the install, in the private folder no agent is handed: it holds
 * the time the consent was given, and the consent stands only while this file and the settings say the same time.
 * A withdrawal must hold on a disk main cannot write, and measured on macOS 26 (APFS) a full volume refuses a write, a
 * rename and even a truncate (ENOSPC) but takes an unlink, while a folder that may not be written refuses an unlink
 * and a rename (EACCES) but takes a truncate. So a withdrawal unlinks this file, or else truncates it, and a start
 * whose settings still say consent with no such file, a partial one or another time has none: it fails closed.
 */
export const TRACES_CONSENT_FILE = privatePath('traces-upload-consent');

/**
 * The window's words for settings main could not write: the reason, and what that left (`then`, else that nothing
 * changed). A save whose keys could not be put back as they were says so, since they load at the next start (the
 * Audit's I-2 at 965cfced0).
 */
export function settingsNotWritten(err: unknown, then?: string): string {
  const left = keysKeptAfter(err)
    ? `the keys you set were kept and load at the next start, and the rest was not saved${then ? `; ${then}` : ''}`
    : then ?? 'nothing was changed';
  return `Tars could not save the settings (${describeSecretFileError(err)}): ${left}.`;
}

/** Writes the consent's file, before the settings say it. Throws when it cannot. */
export function recordConsent(at: string): void {
  fs.mkdirSync(path.dirname(TRACES_CONSENT_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TRACES_CONSENT_FILE, at, { mode: 0o600 });
}

/**
 * A file of the private folder gone, or emptied, which reads as nothing: a full volume takes the unlink, and a folder
 * that may not be written takes the truncate. Null once one holds, else the reason, which the log says too.
 */
function dropPrivateFile(file: string, what: string): string | null {
  try {
    fs.unlinkSync(file);
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
  }
  try {
    fs.truncateSync(file, 0);
    return null;
  } catch (err) {
    const reason = describeSecretFileError(err);
    console.error(`[traces] ${what} could be neither removed nor emptied: ${reason}`);
    return reason;
  }
}

/** The consent's file gone or emptied: true when it no longer says any consent. */
export function dropConsentFile(): boolean {
  return dropPrivateFile(TRACES_CONSENT_FILE, "the consent's file") === null;
}

/** Whether the settings' consent stands: its file holds the very same time. */
export function consentStands(settings: AppSettings | undefined): boolean {
  const at = traceSettingsOf(settings).uploadConsentAt;
  if (!at) return false;
  try {
    return fs.readFileSync(TRACES_CONSENT_FILE, 'utf8') === at;
  } catch {
    return false;
  }
}

/** The consent the uploader acts on: the settings' in memory, and only while it stands. */
export function uploadConsentAt(): string | undefined {
  const settings = deps?.getSettings();
  return consentStands(settings) ? traceSettingsOf(settings).uploadConsentAt : undefined;
}

let unsaved: string | undefined;
let persistRetry: NodeJS.Timeout | null = null;
const PERSIST_RETRY_MS = 60_000;

/** Which note `unsaved` carries, for the window to key on rather than on the words (src/types/electron.d.ts). */
export type UnsavedKind = 'consent-held' | 'revoke-comes-back' | 'owed';
let unsavedKind: UnsavedKind | undefined;

/** What the settings' last write said when it failed, for the window, and which note it is; nothing once one held. */
export function uploadPersistence(): { unsaved?: string; unsavedKind?: UnsavedKind } {
  return unsaved ? { unsaved, unsavedKind } : {};
}

/**
 * The settings in memory written to disk now, and again every minute until it holds, the window told while it does
 * not: for a change that already holds in memory (a withdrawal, a deletion's bookkeeping), which must not wait for
 * the disk. True when written now.
 */
function persistSettings(): boolean {
  if (!deps) return false;
  try {
    deps.writeSettings(deps.getSettings());
  } catch (err) {
    // The window shows these words as they are. The last try is stopTracesRuntime's.
    const then = consentHeldForRevoke ? 'sharing is stopped until they are, and Tars tries again every minute and once more as it quits; if none of these holds, the next start takes your consent as withdrawn, and nothing recorded before it is ever sent'
      : revokeComesBack ? 'what you stopped is stopped for now, but a restart before they are saved would share it again; Tars tries again every minute and once more as it quits'
      : 'Tars tries again every minute and once more as it quits';
    const reason = settingsNotWritten(err, then);
    console.error(`[traces] ${reason}`);
    unsavedKind = consentHeldForRevoke ? 'consent-held' : revokeComesBack ? 'revoke-comes-back' : 'owed';
    if (unsaved !== reason) { unsaved = reason; deps.emit('traces:changed'); }
    if (!persistRetry) {
      persistRetry = setTimeout(() => { persistRetry = null; persistSettings(); }, PERSIST_RETRY_MS);
      persistRetry.unref?.();
    }
    return false;
  }
  if (unsaved) { unsaved = undefined; deps.emit('traces:changed'); }
  unsavedKind = undefined;
  revokeComesBack = false;
  if (consentHeldForRevoke) restoreHeldConsent();
  return true;
}

/**
 * A revoke not yet written whose consent's file could be neither removed nor emptied: a restart before the settings
 * hold reads them as they were, the consent standing, and shares again what the revoke stopped. The window is told.
 */
let revokeComesBack = false;

/**
 * The consent whose file a revoke not yet written dropped (holdRevoke), to be put back once the settings hold: the
 * user's own consent, still in the settings, never a new one.
 */
let consentHeldForRevoke: string | undefined;

function restoreHeldConsent(): void {
  const at = consentHeldForRevoke;
  consentHeldForRevoke = undefined;
  if (!deps || !at || traceSettingsOf(deps.getSettings()).uploadConsentAt !== at) return;
  try {
    recordConsent(at);
  } catch (err) {
    console.error(`[traces] the settings hold now, and the consent's file could not be written back (${describeSecretFileError(err)}): sharing stays off until consent is given again`);
  }
  deps.emit('traces:changed');
}

/**
 * A revoke of sharing (a project opted out, a pair removed, closed models left out, an endpoint's traces turned off
 * or the endpoint removed): held in memory at once, so the uploader holds back what it covers from now, then written,
 * and tried again every minute until it holds, the window told (`unsaved`). While it does not hold, the consent's
 * file is dropped, which needs no free space (dropConsentFile), so that a start before the write holds reads the old
 * settings with no consent and takes it for a deletion: it fails closed. Meanwhile nothing is shared at all; the file
 * is put back once the settings hold. A file that can be neither removed nor emptied cannot fail closed, and the note
 * says a restart would share again (revokeComesBack). Undefined when written, else the window's note.
 */
export function holdRevoke(settings: AppSettings): string | undefined {
  if (!deps) return 'Tars is not ready.';
  deps.setSettings(settings);
  if (persistSettings()) return undefined;
  const at = traceSettingsOf(settings).uploadConsentAt;
  if (at && !consentHeldForRevoke && consentStands(settings)) {
    if (dropConsentFile()) consentHeldForRevoke = at;
    else revokeComesBack = true;
    // Once more, so the note says what a restart would do.
    persistSettings();
  }
  return unsaved;
}

/**
 * The consent taken back (after "delete everything", or a back-office that forgot this install): at once in memory,
 * so nothing uploads from now, then off the disk, its file first, which needs no free space, then the settings.
 * `persisted` when a restart cannot bring it back: the file is gone or empty, or the settings say no consent.
 */
export function withdrawUploadConsent(deletion?: { owed: boolean; since?: number; by?: 'you' | 'start' }): { persisted: boolean } {
  if (!deps) return { persisted: false };
  const t = traceSettingsOf(deps.getSettings());
  const { uploadConsentAt: _gone, ...kept } = t;
  // A deletion's moment, owed mark and origin go in with the withdrawal, in the same write (the Audit's I-1 at
  // 965cfced0, and its I-3 on #599 for the origin).
  const { uploadDeletedAt: _at, uploadDeletionOwed: _owed, uploadDeletionBy: _by, ...unmarked } = kept;
  const rest = deletion
    ? {
      ...unmarked,
      ...(deletion.since !== undefined ? { uploadDeletedAt: deletion.since } : {}),
      ...(deletion.owed ? { uploadDeletionOwed: true } : {}),
      ...(deletion.by ? { uploadDeletionBy: deletion.by } : {}),
    }
    : kept;
  deps.setSettings({ ...deps.getSettings(), traces: rest });
  const dropped = dropConsentFile();
  // A file that stays gives the consent back to a restart before the settings hold, and the note that stays says so
  // (persistSettings clears it once a write holds).
  if (!dropped && t.uploadConsentAt) revokeComesBack = true;
  const written = persistSettings();
  // Still to try again while the file holds the consent: a later write of the settings is what removes it then.
  if (!dropped && !written) console.error('[traces] the withdrawal of the consent is in memory only until a write holds; nothing uploads meanwhile');
  deps.emit('traces:changed');
  return { persisted: dropped || written };
}

/** Whether this install's file still names an install a DELETE could be asked with. */
function installHeld(): boolean {
  try {
    return typeof (JSON.parse(fs.readFileSync(TRACES_INSTALL_FILE, 'utf8')) as { token?: unknown })?.token === 'string';
  } catch {
    return false;
  }
}

/**
 * At start: a consent the settings say and its file does not is a withdrawal Tars could not write down, and it may
 * have come with "delete everything", whose moment and owed DELETE live in the settings alone (the Audit's M1 at
 * a3c07fbfa). Which it was is not known now, so it is taken for a deletion (it fails closed): its moment is the
 * latest of the one kept, now and the newest session's start, as deleteEverywhere sets it, and the DELETE is owed
 * while the install is still here. The only other withdrawal, a 401's, drops the install with it: taken for a
 * deletion, it owes nothing and holds back only the sessions recorded before it, which a new consent then never sends.
 */
export function reconcileConsent(): void {
  if (!deps) return;
  const settings = deps.getSettings();
  const t = traceSettingsOf(settings);
  if (!t.uploadConsentAt || consentStands(settings)) return;
  console.error('[traces] the settings say consent and its file does not: no consent, and taken for a deletion');
  // A store that cannot be opened must not stop the start (the Audit's I-3 at 965cfced0): the consent still goes,
  // with this start as the moment.
  let newest: number | undefined;
  try {
    newest = store || fs.existsSync(TRACES_DB_FILE) ? traceStore().newestStartedAt() : undefined;
  } catch (err) {
    console.error(`[traces] the trace store could not be read at start (${describeSecretFileError(err)}): the deletion's moment is this start`);
  }
  const since = Math.max(t.uploadDeletedAt ?? 0, Date.now(), newest ?? 0);
  withdrawUploadConsent({ owed: t.uploadDeletionOwed === true || installHeld(), since, by: 'start' });
}

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
    ...(t?.uploadDeletionBy === 'you' || t?.uploadDeletionBy === 'start' ? { uploadDeletionBy: t.uploadDeletionBy } : {}),
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

/**
 * One session exactly as its upload would send it now: the batches and blobs the uploader builds for it, through the
 * same function, and what was masked, by kind. The window shows this document as the one Tars would send.
 */
export function previewUpload(traceId: string): ReturnType<TraceUploader['preview']> {
  return traceUploader().preview(traceId);
}

export function traceStore(): TraceStore {
  if (!store) store = new TraceStore(TRACES_DB_FILE);
  return store;
}

let workspace: WorkspaceRecorder | null = null;
/** What each traced turn changed in the agent's checkout, and how much lasted (turn-workspace.ts). */
export function turnWorkspace(): WorkspaceRecorder {
  if (!workspace) workspace = new WorkspaceRecorder({ store: traceStore() });
  return workspace;
}

/**
 * A gate's verdict, recorded by the agent that gates (api-routes/verdict-routes.ts): linked to the traced turns that
 * made the judged head, then CI's own verdict on the same pull request read from its checks, off the call's path.
 */
export async function recordGateVerdict(caller: VerdictCaller, v: VerdictInput): Promise<Awaited<ReturnType<typeof recordVerdict>>> {
  const r = await recordVerdict({ store: traceStore() }, caller, v);
  if (r.changed) changed();
  if (v.gate !== 'ci') {
    void ciVerdicts({ store: traceStore() }, caller, v.pr).then((ci) => { if (ci) changed(); }, () => undefined);
  }
  return r;
}

/** The folder an agent works in: its worktree, else its project. */
function folderOf(agentId: string): string | undefined {
  const agent = agentOf(agentId);
  return agent?.worktreePath || agent?.projectPath;
}

/**
 * The ended sessions whose branch may since have merged into the default branch, or been deleted: their survival is
 * measured again on the default branch (a few per sweep, each git call bounded).
 */
export async function finalizeWorkspaces(limit = 10): Promise<void> {
  const checked = await turnWorkspace().finalizeDue((s) => folderOf(s.agentId), limit);
  if (checked.some(c => c.result === 'merged' || c.result === 'deleted')) changed();
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
        // The consent only while it stands (its file says it too): one the settings kept after a withdrawal is none.
        return { url: allowed ? t.uploadUrl : '', consentAt: uploadConsentAt(), since: t.uploadDeletedAt, deletionOwed: t.uploadDeletionOwed === true, deletionBy: t.uploadDeletionBy };
      },
      // In memory at once, then written, and tried again until it holds (persistSettings).
      setDeletion: (d) => {
        if (!deps) return;
        const t = traceSettingsOf(deps.getSettings());
        const { uploadDeletedAt: _at, uploadDeletionOwed: _owed, ...rest } = t;
        deps.setSettings({ ...deps.getSettings(), traces: { ...rest, ...(d.since !== undefined ? { uploadDeletedAt: d.since } : {}), ...(d.owed ? { uploadDeletionOwed: true } : {}) } });
        persistSettings();
        deps.emit('traces:changed');
      },
      // Opted in now, not only when the session was recorded: a project or an agent switched off since is not sent.
      // The trace gate as it is now, so a revoke made since the session was recorded holds it back too.
      eligible: (q) => {
        const settings = deps?.getSettings();
        const t = traceSettingsOf(settings);
        const endpoint = (settings?.inferenceEndpoints ?? []).find(e => e.id === q.endpointId);
        return traceDecision({
          provider: q.harness, model: q.model,
          endpoint: endpoint ? { allowTraces: endpoint.allowTraces === true, approved: endpoint.approved === true && endpoint.approvedBaseUrl === endpoint.baseUrl } : undefined,
          projectOptedIn: t.projects.includes(q.projectPath), agentOptedIn: agentOf(q.agentId)?.traces === true, pairs: t.pairs,
          excludeClosedModels: t.excludeClosedModels,
        }).traced;
      },
      scrubContext: (projectPath) => scrubContextFor(projectPath),
      client: { name: 'tars', version: deps?.clientVersion ?? 'unknown', platform: process.platform },
      // After "delete everything sent": no upload again until the user consents again, a restart included.
      withdrawConsent: (deletion) => { withdrawUploadConsent(deletion); },
    });
  }
  return uploader;
}

function uploadPass(): void {
  const t = traceSettingsOf(deps?.getSettings());
  if (!t.uploadUrl || !uploadConsentAt()) return;
  traceUploader().runOnce()
    .then((r) => { if (r.sent || r.failed) deps?.emit('traces:changed'); })
    .catch((err) => { console.error(`[traces] an upload pass failed: ${describeSecretFileError(err)}`); });
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
  finalizeWorkspaces().catch((err) => console.error(`[traces] a session's survival was not measured again: ${(err as Error).message}`));
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
  // A consent its file does not hold is none, before anything is sent (it fails closed).
  reconcileConsent();
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
    // A request that opens a turn: the agent's checkout is snapshot as the request is forwarded (its edits come with
    // the answer's tools, after), the turn's start and the previous turn's end. Off the request's path: next tick.
    onRequest: (r) => {
      setImmediate(() => {
        if (traceStore().opensTurnAt(r.traceId, r.surface, r.body)) void turnWorkspace().turnStarted(r.traceId, r.startedAt, folderOf(r.agentId));
      });
    },
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
  // A write still owed is tried once more before Tars stops: another save may have written the settings since (the
  // window's own, an agent's), and only this one puts a consent dropped for a revoke back.
  if (persistRetry) {
    clearTimeout(persistRetry);
    persistRetry = null;
    persistSettings();
    // Failed again: no retry outlives the runtime.
    if (persistRetry) clearTimeout(persistRetry);
    persistRetry = null;
  }
  // A consent dropped for a revoke that is still not written stays dropped: the next start reads closed.
  consentHeldForRevoke = undefined;
  revokeComesBack = false;
  uploader = null;
  workspace = null;
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
  // The last turn's end, then each turn's survival (turn-workspace.ts).
  void turnWorkspace().sessionEnded(live.traceId, endedAt, folder);
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

/**
 * The branch and head of the folder the agent worked in, when it is a git checkout: through safe-git, like every git
 * call of the main process (its environment, its git command, its guards).
 */
function gitOutcome(folder: string | undefined): Promise<{ branch?: string; head?: string }> {
  if (!folder) return Promise.resolve({});
  const git = (args: string[]) => safeGit(folder, args, { timeout: 5000 })
    .then(r => r.stdout.trim() || undefined, () => undefined);
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
  const held = readReaderToken();
  return { exists: !!held && !revokedReaderTokens.has(held), createdAt, lastUsedAt: readerLastUsedAt, route: '/api/traces/', listen: 'loopback' };
}

/**
 * Reader tokens revoked in this run: refused at once, whatever their file still says (the Audit's L1 at 1e9571eab).
 * A revoke applies first, then the file goes, unlinked or else emptied, which reads as no token at the next start.
 */
const revokedReaderTokens = new Set<string>();

/** The reader token refused now and off the disk: null once the file says no token, else the reason. */
function dropReaderToken(): string | null {
  const held = readReaderToken();
  if (held) revokedReaderTokens.add(held);
  readerLastUsedAt = undefined;
  return dropPrivateFile(TRACES_READER_TOKEN_FILE, 'the reader token');
}

/**
 * A new reader token, shown once: the one before opens nothing from now on. The old one goes first, so a new write
 * that fails (a full disk) leaves no token rather than the old one. Throws the reason when either step fails.
 */
export function rotateReaderToken(): string {
  const kept = dropReaderToken();
  if (kept) throw new Error(`Tars could not remove the reader token (${kept}): it opens nothing until Tars quits, but would again after a restart, and no new one was made.`);
  const token = `trd_${randomBytes(32).toString('hex')}`;
  try {
    writeSecretFileSync(TRACES_READER_TOKEN_FILE, token);
  } catch (err) {
    throw new Error(`Tars could not save a new reader token (${describeSecretFileError(err)}): the old one opens nothing, and there is none now.`);
  }
  return token;
}

/** The reader token revoked: refused at once, and off the disk. Throws the reason when its file stays. */
export function revokeReaderToken(): void {
  const kept = dropReaderToken();
  if (kept) throw new Error(`Tars could not remove the reader token (${kept}): it opens nothing until Tars quits, but would again after a restart.`);
}

/** Whether this is the reader token, compared whole and in constant time. */
export function isReaderToken(presented: string): boolean {
  const held = readReaderToken();
  if (!presented || !held || revokedReaderTokens.has(held)) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(held);
  const same = a.length === b.length && timingSafeEqual(a, b);
  if (same) readerLastUsedAt = new Date().toISOString();
  return same;
}

/**
 * The settings changed by an API route (an agent's endpoint tools): written first, then held in memory, as the
 * window's saves are (traces-handlers.ts). Throws the reason when they cannot be written, and nothing changes.
 */
export function saveSettingsFromApi(settings: AppSettings): void {
  if (!deps) throw new Error('Tars is not ready.');
  try {
    deps.writeSettings(settings);
  } catch (err) {
    console.error('[traces] settings not written:', err);
    // A key the failed save left on disk is held in memory too, or the next save would write the old one back.
    const kept = withKeptKeys(deps.getSettings(), err);
    if (kept) deps.setSettings(kept);
    throw new Error(settingsNotWritten(err));
  }
  deps.setSettings(settings);
}

/** Tells the window an endpoint changed, and whether it now waits for the owner's approval. */
export function tellEndpointChanged(e: { id: string; by?: { agentId: string; agentName?: string }; needsApproval: boolean }): void {
  deps?.emit('endpoints:changed', e);
}
