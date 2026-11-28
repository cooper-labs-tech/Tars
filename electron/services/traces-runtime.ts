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
import {
  CORRECTION_WINDOW_MS, TraceStore, boundOutcomeTasks, type InterventionDuring, type InterventionEvent, type RequestCancel, type TraceEvent,
  type TraceStart, type TraceTask, type TurnAuthor,
} from './trace-store';
import { InterruptKeys, interruptKeyOf, type InterruptKey } from '../core/interrupt-keys';
import { takeSessionStart } from '../core/session-start';
import type { OneTaskQueue, QueueEvent } from '../core/one-task';
import { liveTaskLedger } from './task-ledger';
import { chooseGh, prStatesOfProjects, type PrState } from './github-watch';
import { defaultTracePairs, traceDecision } from './trace-gate';
import { machineFacts, nodeEnvironmentIo, sessionEnvironment, type MachineFacts } from './session-environment';
import { harnessVersions } from './harness-version';
import { readHarnessCompactions } from './harness-compactions';
import { codexHome } from '../providers/codex-cli';
import { probeVersion } from '../core/version-probe';
import { buildFullPath } from '../utils/path-builder';
import { cliPathDirs } from '../utils/cli-path-dirs';
import { projectEnvValues, type ScrubContext } from './trace-scrub';
import { cachedPersonNames, preparePersonNames } from './trace-person-names';
import { TraceUploader } from './trace-upload';
import type { ToolCallPart } from './tool-calls';
import { ENDED_GRACE_MS, HarnessToolLogs, type FollowedSession } from './harness-tool-logs';
import { WorkspaceRecorder } from './turn-workspace';
import { ciVerdicts, recordVerdict, relinkSession, type VerdictCaller, type VerdictInput } from './gate-verdicts';
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
 * - **A session's environment.** A traced session keeps the harness's exact version (read from the binary Tars
 *   launched, harness-version.ts), the machine and the system it ran on with Tars's version, the locale and the time
 *   zone (session-environment.ts), the sleeps, wakes and changes of power during it, and on each request the traced
 *   sessions live on this computer when it was sent.
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
  /** Tars's version, sent when the install registers with a back-office, and kept with each traced session. */
  clientVersion?: string;
  /**
   * The binary an agent's terminal starts (its own CLI path, else its provider's): the harness whose exact version a
   * traced session keeps (harness-version.ts). From main.ts, since the providers import this module.
   */
  launchedBinary?(agent: AgentStatus): string;
  /** Electron's powerMonitor: sleep, wake, battery and mains power, stamped on every traced session open then. */
  power?: PowerSource;
  /** The system's own version (Electron's process.getSystemVersion: macOS 15.7.2, not Darwin's 24.6.0). */
  systemVersion?(): string;
  /** The system's language and region (Electron's app.getSystemLocale). */
  locale?(): string;
  /** A packaged build (app.isPackaged): an E2E's stand-in gh is never taken there (github-watch.ts testGhOf). */
  packaged?: boolean;
  /**
   * The agents' queue (core/one-task.ts oneTaskQueue): a task's queue times, and what the queue tells a traced
   * session. Handed in rather than imported, so this module stays clear of the provider registry the queue's module
   * loads: a require cycle (a provider loads this module) that types cannot see and that fails at runtime.
   */
  queue?: Pick<OneTaskQueue, 'lookup' | 'busyRun' | 'onEvent'>;
}

export interface PowerSource {
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  isOnBatteryPower(): boolean;
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

/**
 * The training switch's default, "May be used to train models", when the owner never chose: on (the owner's ruling
 * of 11/11). The one place it is set (trace feature A5).
 */
export const TRAINING_DEFAULT = true;

/**
 * The owner's training switch, in a file of its own in the private folder (0600), beside the consent's: no agent is
 * handed it, and no save of the settings (the window's generic one, or an agent writing app-settings.json) reaches
 * it. Only the window's `traces:setTraining` writes it. `owed`: a change the back-office has not taken yet, which a
 * restart finds and sends. No file: nothing chosen, the default. A file that cannot be read as one: off (fails closed).
 */
export const TRACES_TRAINING_FILE = privatePath('traces-training.json');

/**
 * The sessions that may be used to train models, in the private folder (`{ ids }`, 0600): those Tars opened while
 * training was on, each taken off when the switch goes off while it runs. Trainable is a positive, private fact (the
 * Audit's M1 on #690, the orchestrator's ruling): a session is trainable only when it is on this list and its stamp
 * says yes (trace-store.ts summaryOf), so an agent, which is handed the store under ~/.tars, can neither turn a "no"
 * back into a yes nor copy a session under a new id. Read once per run, then held in memory, which is the truth for
 * the run; a change is written at once, and again every minute until a write holds. A list that cannot be read is set
 * aside and a new one started: none of the sessions before it is trainable, and the window is told. Pruned on the
 * sweep, with the sessions it names.
 */
export const TRACES_TRAINING_ALLOWED_FILE = privatePath('traces-training-allowed.json');

let allowed: Set<string> | undefined;
let allowedDirty = false;
let allowedRetry: NodeJS.Timeout | null = null;
let allowedNote: string | undefined;
let unreadableNote: string | undefined;
/** Sessions running at an off that the store could not mark: said to the window (they left the list all the same). */
let markNote: string | undefined;

function loadAllowed(): Set<string> {
  if (allowed) return allowed;
  let raw: string;
  try {
    raw = fs.readFileSync(TRACES_TRAINING_ALLOWED_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return (allowed = new Set());
    return restartAllowed(describeSecretFileError(err));
  }
  try {
    const j = JSON.parse(raw) as { ids?: unknown };
    if (Array.isArray(j.ids) && j.ids.every(x => typeof x === 'string')) return (allowed = new Set(j.ids as string[]));
  } catch { /* below */ }
  return restartAllowed('it is not a list of ids');
}

/** An unreadable list set aside, and a new one started: no session from before counts as trainable. */
function restartAllowed(reason: string): Set<string> {
  const aside = `${TRACES_TRAINING_ALLOWED_FILE}.unreadable-${Date.now()}`;
  let where = `set aside as ${path.basename(aside)}`;
  try {
    fs.renameSync(TRACES_TRAINING_ALLOWED_FILE, aside);
  } catch (err) {
    where = `left where it is (it could not be moved: ${describeSecretFileError(err)})`;
  }
  unreadableNote = `The list of sessions that may be used to train models could not be read (${reason}): it was ${where}, a new one was started, and no session recorded before now counts as trainable.`;
  console.error(`[traces] ${unreadableNote}`);
  allowed = new Set();
  allowedDirty = true;
  persistAllowed();
  return allowed;
}

/** Whether a session is on the private list of trainable sessions: the store's rule beside its stamp. */
export function sessionTrainable(traceId: string): boolean {
  return loadAllowed().has(traceId);
}

function persistAllowed(): boolean {
  if (!allowedDirty || !allowed) return true;
  try {
    fs.mkdirSync(path.dirname(TRACES_TRAINING_ALLOWED_FILE), { recursive: true, mode: 0o700 });
    writeSecretFileSync(TRACES_TRAINING_ALLOWED_FILE, `${JSON.stringify({ ids: [...allowed] })}\n`);
    allowedDirty = false;
    allowedNote = undefined;
    if (allowedRetry) { clearTimeout(allowedRetry); allowedRetry = null; }
    return true;
  } catch (err) {
    allowedNote = `The list of sessions that may be used to train models holds for this run, but Tars could not save it (${describeSecretFileError(err)}): it tries again every minute.`;
    console.error(`[traces] ${allowedNote}`);
    if (!allowedRetry) {
      allowedRetry = setTimeout(() => { allowedRetry = null; persistAllowed(); }, 60_000);
      allowedRetry.unref?.();
    }
    return false;
  }
}

function allowSession(traceId: string): void {
  const a = loadAllowed();
  if (a.has(traceId)) return;
  a.add(traceId);
  allowedDirty = true;
  persistAllowed();
}

function disallowSessions(ids: string[]): void {
  const a = loadAllowed();
  let changed = false;
  for (const id of ids) if (a.delete(id)) changed = true;
  if (!changed) return;
  allowedDirty = true;
  persistAllowed();
}

/** The list keeps only the sessions the store still holds. */
function pruneAllowed(): void {
  const a = loadAllowed();
  if (a.size === 0) return;
  const gone = [...a].filter(id => !traceStore().hasTrace(id));
  if (gone.length) disallowSessions(gone);
}

/** An off the disk did not take yet: it holds in memory (a revoke applies at once), and is written again every minute. */
let heldTraining: { value: boolean; owed: boolean } | undefined;
let trainingRetry: NodeJS.Timeout | null = null;
let trainingUnsaved: string | undefined;
let trainingSoon: NodeJS.Timeout | null = null;

/** The switch as it stands, and whether its value is owed to the back-office. */
export function readTraining(): { value: boolean; owed: boolean } {
  if (heldTraining) return { ...heldTraining };
  let raw: string;
  try {
    raw = fs.readFileSync(TRACES_TRAINING_FILE, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { value: TRAINING_DEFAULT, owed: false } : { value: false, owed: false };
  }
  try {
    const t = JSON.parse(raw) as { training?: unknown; owed?: unknown };
    if (typeof t.training === 'boolean') return { value: t.training, owed: t.owed === true };
  } catch { /* below */ }
  return { value: false, owed: false };
}

function writeTraining(t: { value: boolean; owed: boolean }): void {
  fs.mkdirSync(path.dirname(TRACES_TRAINING_FILE), { recursive: true, mode: 0o700 });
  writeSecretFileSync(TRACES_TRAINING_FILE, `${JSON.stringify({ training: t.value, owed: t.owed, at: new Date().toISOString() })}\n`);
}

/** A held off written, or tried again in a minute; the window told while it does not hold. True once written. */
function persistHeldTraining(): boolean {
  if (!heldTraining) return true;
  try {
    writeTraining(heldTraining);
    heldTraining = undefined;
    trainingUnsaved = undefined;
    if (trainingRetry) { clearTimeout(trainingRetry); trainingRetry = null; }
    deps?.emit('traces:changed');
    return true;
  } catch (err) {
    trainingUnsaved = `Training is off for this run, but Tars could not save it (${describeSecretFileError(err)}): it tries again every minute, and a restart before it holds would read the switch as it was.`;
    console.error(`[traces] ${trainingUnsaved}`);
    if (!trainingRetry) {
      trainingRetry = setTimeout(() => { trainingRetry = null; persistHeldTraining(); }, 60_000);
      trainingRetry.unref?.();
    }
    return false;
  }
}

/** A pass soon after a change, sharing on or off: the back-office learns it in seconds, not at the 5-minute pass. */
function trainingPassSoon(): void {
  if (trainingSoon) clearTimeout(trainingSoon);
  trainingSoon = setTimeout(() => { trainingSoon = null; trainingPass(); }, 2_000);
  trainingSoon.unref?.();
}

/** That pass: one running already (busy) is waited out, and this one runs 2 s after, not at the 5-minute pass. */
function trainingPass(): void {
  const t = traceSettingsOf(deps?.getSettings());
  if (!t.uploadUrl || (!uploadConsentAt() && !readTraining().owed)) return;
  traceUploader().runOnce()
    .then((r) => {
      if (r.skipped === 'busy') trainingPassSoon();
      else if (r.sent || r.failed) deps?.emit('traces:changed');
    })
    .catch((err) => { console.error(`[traces] an upload pass failed: ${describeSecretFileError(err)}`); });
}

/**
 * The owner's switch set, from the window only. Off is a revoke: it applies at once (every session running now is
 * false for good, and so is any opened from now), then is written, held in memory until a write holds. On is a grant:
 * written first, and nothing changes when it cannot be. Either way the new value is owed to the back-office.
 */
export function setTraining(value: boolean): { ok: true; unsaved?: string } | { ok: false; error: string } {
  const now = readTraining();
  if (now.value === value) return { ok: true, ...trainingNotes() };
  const next = { value, owed: true };
  if (!value) {
    heldTraining = next;
    const running = [...sessions.values()].filter(s => s.traced).map(s => s.traceId);
    // Off the private list of trainable sessions first, which no agent reaches, then stamped no in the store.
    disallowSessions(running);
    markNote = undefined;
    try {
      if (running.length) traceStore().denyTraining(running);
    } catch (err) {
      markNote = `The sessions running now could not be marked off in the trace store (${describeSecretFileError(err)}): their "no" is kept in the private folder, so none leaves as trainable.`;
      console.error(`[traces] ${markNote}`);
    }
    persistHeldTraining();
  } else {
    try {
      writeTraining(next);
    } catch (err) {
      return { ok: false, error: `Tars could not save the switch (${describeSecretFileError(err)}): training stays off.` };
    }
    heldTraining = undefined;
    trainingUnsaved = undefined;
    if (trainingRetry) { clearTimeout(trainingRetry); trainingRetry = null; }
  }
  deps?.emit('traces:changed');
  trainingPassSoon();
  return { ok: true, ...trainingNotes() };
}

/** The back-office took this value: owed no more, if it still stands. A write that fails leaves it owed (resent). */
function trainingSent(value: boolean): void {
  const now = readTraining();
  if (!now.owed || now.value !== value) return;
  if (heldTraining) {
    heldTraining = { value, owed: false };
    // Written, persistHeldTraining tells the window; held still, the owed mark changed all the same: told here.
    if (!persistHeldTraining()) deps?.emit('traces:changed');
    return;
  }
  try {
    writeTraining({ value, owed: false });
  } catch (err) {
    console.error(`[traces] the back-office took the training value, and the file still says it is owed (${describeSecretFileError(err)}): it is sent again, which is harmless`);
    return;
  }
  // The window drops its "not yet sent" line now, not at its next read (the held path is told by persistHeldTraining).
  deps?.emit('traces:changed');
}

/** What the window is told is not saved or not marked, in one `unsaved`, or nothing. */
function trainingNotes(): { unsaved?: string } {
  const notes = [trainingUnsaved, allowedNote, unreadableNote, markNote].filter(Boolean).join(' ');
  return notes ? { unsaved: notes } : {};
}

/** What the window shows of the switch. */
export function trainingView(): { training: boolean; owed: boolean; unsaved?: string } {
  const t = readTraining();
  return { training: t.value, owed: t.owed, ...trainingNotes() };
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

interface LiveSession extends ProxySession {
  harness: string;
  model: string;
  startedAt: number;
  /** The ref of the task it started for, if any. */
  startRef?: string;
  /** The queued tasks the ledger named while it ran: their ref, when they entered the line and when their turn came. */
  named: Map<string, { ref: string; queuedAt: number; handedAt: number }>;
}
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
 * the endpoints' keys, its API and reader tokens), the project's .env values, the home folder in each spelling, and
 * the names Tars knows for the project (trace-person-names.ts), as last read: an upload and a preview read them first.
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
  const names = projectPath ? cachedPersonNames(projectPath) : { own: [], others: [] };
  return {
    homeDirs: [...new Set([home, home.replace(/\\/g, '/')])],
    knownSecrets: [...new Set(known.filter(k => k.length >= 8))],
    envValues: projectPath ? projectEnvValues(projectPath) : [],
    personNames: names.others,
    ownNames: names.own,
  };
}

/**
 * One session exactly as its upload would send it now: the batches and blobs the uploader builds for it, through the
 * same function, its project's names read first as an upload reads them, and what was masked, by kind. The window
 * shows this document as the one Tars would send.
 */
export function previewUpload(traceId: string): Promise<ReturnType<TraceUploader['preview']>> {
  return traceUploader().previewPrepared(traceId);
}

export function traceStore(): TraceStore {
  // The store reads a session as trainable only when the private list names it too (sessionTrainable).
  if (!store) store = new TraceStore(TRACES_DB_FILE, { trainable: sessionTrainable });
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
  const r = await recordVerdict({ store: traceStore(), branchOf: runningBranchOf }, caller, v);
  if (r.changed) changed();
  if (v.gate !== 'ci') {
    void ciVerdicts({ store: traceStore() }, caller, v.pr).then((ci) => { if (ci) changed(); }, () => undefined);
  }
  return r;
}

/**
 * The branch of a traced session still running: the one the folder its workspace is recorded in is on now (the read
 * the session's end makes for its outcome, gitOutcome). Null for a session that is not running, or a detached head.
 */
async function runningBranchOf(traceId: string): Promise<string | null> {
  for (const s of sessions.values()) {
    if (!s.traced || s.traceId !== traceId) continue;
    const agent = agentOf(s.agentId);
    const { branch } = await gitOutcome(agent?.worktreePath || agent?.projectPath);
    return branch && branch !== 'HEAD' ? branch : null;
  }
  return null;
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
      prepareScrub: (projectPath) => preparePersonNames(projectPath),
      client: { name: 'tars', version: deps?.clientVersion ?? 'unknown', platform: process.platform },
      // After "delete everything sent": no upload again until the user consents again, a restart included.
      withdrawConsent: (deletion) => { withdrawUploadConsent(deletion); },
      training: readTraining,
      trainingSent,
    });
  }
  return uploader;
}

function uploadPass(): void {
  const t = traceSettingsOf(deps?.getSettings());
  // Without consent a pass still sends the per-session deletes owed to the install, and the training value owed
  // (trace-upload.ts runOnce decides: deletesDue, trainingDue).
  if (!t.uploadUrl) return;
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
    // The private list of sessions whose training is off keeps only the sessions the store still holds.
    pruneAllowed();
  } catch (err) {
    console.error(`[traces] sweep failed: ${(err as Error).message}`);
  }
  finalizeWorkspaces().catch((err) => console.error(`[traces] a session's survival was not measured again: ${(err as Error).message}`));
}

/** The proxy on its port, and the hourly sweep. Called once at startup. */
/** What the runtime reads and writes through (the settings, the fleet, the window), without starting anything. */
export function configureTraces(d: TracesDeps): void {
  deps = d;
  // What the agents' queues tell a traced session: a task named once its turn came, a task dropped never to start.
  queueEvents?.();
  queueEvents = d.queue?.onEvent(onQueueEvent) ?? null;
}

let queueEvents: (() => void) | null = null;
let prTimer: NodeJS.Timeout | null = null;

/** How often Qwen Code's and opencode's logs are read for the tool calls of their traced sessions. */
const HARNESS_LOGS_EVERY_MS = 2000;
let harnessLogsTimer: NodeJS.Timeout | null = null;
/** The harnesses whose logs no watcher of their own follows: read here (codex's and pi's watchers already do). */
const LOGGED_HERE = new Set(['qwen-code', 'opencode']);
/** Their traced sessions that ended lately: still read for a while, for what the harness writes as it exits. */
const endedFollowed: FollowedSession[] = [];

function followedOf(live: LiveSession, endedAt?: number): FollowedSession | null {
  const agent = agentOf(live.agentId);
  const folder = agent?.worktreePath || agent?.projectPath;
  if (!live.traced || !LOGGED_HERE.has(live.harness) || !folder) return null;
  return { traceId: live.traceId, agentId: live.agentId, harness: live.harness, folder, startedAt: live.startedAt, ...(endedAt !== undefined ? { endedAt } : {}) };
}

const harnessLogs = new HarnessToolLogs({
  sessions: () => {
    const now = Date.now();
    for (let i = endedFollowed.length - 1; i >= 0; i--) if (now - endedFollowed[i].endedAt! > ENDED_GRACE_MS) endedFollowed.splice(i, 1);
    return [...[...sessions.values()].map(s => followedOf(s)).filter((s): s is FollowedSession => !!s), ...endedFollowed];
  },
  sessionIdOf: (agentId) => agentOf(agentId)?.currentSessionId ?? undefined,
  note: (agentId, part) => noteToolCall(agentId, part),
});

/** How often the pull requests of ended sessions are read: every 5 minutes, or an E2E's own pace (200 ms at least). */
function prEveryMs(): number {
  const asked = Number(process.env.DOROTHY_PR_EVERY_MS);
  return process.env.DOROTHY_E2E === '1' && deps?.packaged !== true && Number.isFinite(asked) && asked >= 200 ? asked : 5 * 60_000;
}

export function startTracesRuntime(d: TracesDeps): void {
  configureTraces(d);
  watchPower(d.power);
  chooseGh(d.packaged === true);
  prTimer = setInterval(prWatchPass, prEveryMs());
  prTimer.unref?.();
  sweepTimer = setInterval(sweepTraces, 3600_000);
  sweepTimer.unref?.();
  sweepTraces();
  uploadTimer = setInterval(uploadPass, 5 * 60_000);
  uploadTimer.unref?.();
  // The tool calls of Qwen Code's and opencode's traced sessions, from their own logs (harness-tool-logs.ts).
  harnessLogsTimer = setInterval(() => harnessLogs.tick(), HARNESS_LOGS_EVERY_MS);
  harnessLogsTimer.unref?.();
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
    // The install's back-office id, read at each request: an endpoint whose owner turned its install header on is told
    // it while the install is registered, and never once it is deleted (trace-upload.ts currentInstallId).
    targetOf: (endpointId) => endpointTarget(d.getSettings(), endpointId, traceUploader().currentInstallId()),
    liveSessions: liveTracedSessions,
    cutOf: (agentId, startedAt, at) => cutOf(agentId, startedAt, at),
    inFlight: (agentId, delta) => requestInFlight(agentId, delta),
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
  unwatchPower?.();
  unwatchPower = null;
  queueEvents?.();
  queueEvents = null;
  if (prTimer) clearInterval(prTimer);
  prTimer = null;
  if (harnessLogsTimer) clearInterval(harnessLogsTimer);
  harnessLogsTimer = null;
  endedFollowed.length = 0;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  if (uploadTimer) clearInterval(uploadTimer);
  if (uploadSoon) clearTimeout(uploadSoon);
  uploadTimer = null;
  uploadSoon = null;
  if (trainingSoon) clearTimeout(trainingSoon);
  trainingSoon = null;
  // An off still held in memory is tried once more before Tars stops; what does not hold is said in the log.
  if (heldTraining && !persistHeldTraining()) console.error('[traces] training off was not saved before Tars stopped: the next start reads the switch as it was');
  if (trainingRetry) clearTimeout(trainingRetry);
  trainingRetry = null;
  heldTraining = undefined;
  trainingUnsaved = undefined;
  if (allowedDirty && !persistAllowed()) console.error('[traces] the list of trainable sessions was not saved before Tars stopped');
  if (allowedRetry) clearTimeout(allowedRetry);
  allowedRetry = null;
  allowed = undefined;
  allowedDirty = false;
  allowedNote = undefined;
  unreadableNote = undefined;
  markNote = undefined;
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
  // The interventions' state is this run's.
  windowKeys.dispose();
  lastKeys.clear();
  tarsEndings.clear();
  inFlight.clear();
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
/** The model's real limits the owner set on the agent's endpoint, given to its harness at launch (trace feature C2). */
function endpointLimitsOf(endpointId: string | undefined): { contextWindow?: number; maxOutputTokens?: number } {
  const e = (deps?.getSettings().inferenceEndpoints ?? []).find(x => x.id === endpointId);
  return { contextWindow: e?.contextWindow, maxOutputTokens: e?.maxOutputTokens };
}

export function endpointLaunchForAgent(agentId: string | undefined, harness: string): EndpointLaunch | null {
  if (!agentId || !deps) return null;
  const agent = agentOf(agentId);
  if (!onEndpoint(agent) || agent.provider !== harness || !agent.model) return null;
  const launch = endpointLaunchFor(harness, { proxyBase: PROXY_BASE, model: agent.model, ...endpointLimitsOf(agent.endpointId) });
  if (launch && harness === 'pi') {
    const file = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'models.json');
    const models = (deps.getSettings().inferenceEndpoints ?? []).filter(e => e.approved).flatMap(e => e.models ?? []);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      updateSharedJsonSync<Record<string, unknown>>(file, current => piModelsWithEndpoint(current, PROXY_BASE, models, { model: agent.model!, contextWindow: launch.given.contextWindow, outputCap: launch.given.outputCap }), { createMode: 0o600 });
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
  // Why this terminal opens, said by its start: read once, whether or not the session is traced.
  const note = takeSessionStart(agentId);
  const agent = agentOf(agentId);
  if (!onEndpoint(agent) || !agent.model) return { env: {} };
  const harness = String(agent.provider);
  const launch = endpointLaunchFor(harness, { proxyBase: PROXY_BASE, model: agent.model, ...endpointLimitsOf(agent.endpointId) });
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
  const live: LiveSession = {
    token, traceId, agentId, endpointId: agent.endpointId, traced: decision.traced, harness, model: agent.model, startedAt: Date.now(),
    ...(note?.taskRef ? { startRef: note.taskRef } : {}), named: new Map(),
  };
  sessions.set(token, live);
  if (decision.traced) {
    // Opened while training is on: on the private list of trainable sessions, which no agent reaches. Opened while
    // off, it is on no list, and never trainable.
    if (readTraining().value) allowSession(traceId);
    try {
      traceStore().openTrace({
        traceId, projectPath: agent.projectPath, agentId, agentName: agent.name, harness,
        endpointId: agent.endpointId, endpointName: endpoint?.name, endpointBaseUrl: endpoint?.approvedBaseUrl, model: agent.model, startedAt: live.startedAt,
        // The training switch as it stands now; turned off while the session runs, it is false for good (setTraining).
        training: readTraining().value,
      });
      const start = startOf(agent, traceId, note);
      traceStore().setStart(traceId, start);
      // The session that had this task before reads the link on its last turn (trace feature B3): sent again with it.
      if (start.redelegatedFrom) traceStore().touch(start.redelegatedFrom);
      // What the harness was given at this launch: the endpoint's window and cap, whether it compacts on its own.
      traceStore().setContextGiven(traceId, launch.given);
      changed();
      describeSession(traceId, agent, live.startedAt);
    } catch (err) {
      console.error(`[traces] session not opened: ${(err as Error).message}`);
      live.traced = false;
    }
    // The commit and branch it starts from, in the folder it works in: git through safe-git (execFile, an argv array).
    if (live.traced) {
      void gitOutcome(agent.worktreePath || agent.projectPath).then(({ branch, head }) => {
        try {
          if (traceStore().setStart(traceId, { commit: head, branch })) changed();
        } catch (err) {
          console.error(`[traces] start commit not recorded: ${(err as Error).message}`);
        }
      });
    }
  }
  const env: Record<string, string> = {};
  for (const name of launch.tokenVars) env[name] = token;
  return { env, token };
}

/** The machine's facts, read once per run (session-environment.ts). */
let machine: Promise<MachineFacts> | null = null;
let versionReader: ReturnType<typeof harnessVersions> | null = null;

function harnessVersionReader(): ReturnType<typeof harnessVersions> {
  versionReader ??= harnessVersions({
    probe: probeVersion,
    // The PATH the agents' terminals get, the configured CLI folders first.
    path: () => buildFullPath(cliPathDirs(deps?.getSettings().cliPaths as Record<string, unknown> | undefined)),
  });
  return versionReader;
}

/**
 * A traced session just opened: what is its own read now (Tars's version, the locale, the time zone, the power), the
 * machine's facts and the harness's exact version as soon as they are read, each kept with it as a change.
 */
function describeSession(traceId: string, agent: AgentStatus, startedAt: number): void {
  const d = deps;
  if (!d) return;
  const intl = Intl.DateTimeFormat().resolvedOptions();
  const read = <T>(f: (() => T) | undefined): T | undefined => { try { return f?.(); } catch { return undefined; } };
  const own = {
    at: startedAt, tarsArch: process.arch, tarsVersion: d.clientVersion,
    locale: read(() => d.locale?.()) || intl.locale, timeZone: intl.timeZone, onBattery: read(() => d.power?.isOnBatteryPower()),
  };
  machine ??= machineFacts(nodeEnvironmentIo(d.systemVersion));
  void machine.then((m) => {
    traceStore().setEnvironment(traceId, sessionEnvironment(m, own));
    changed();
  }).catch(err => console.error(`[traces] the environment of ${traceId} was not kept: ${(err as Error).message}`));
  const binary = read(() => d.launchedBinary?.(agent));
  if (!binary) return;
  void harnessVersionReader().of(binary).then((version) => {
    if (!version) return;
    traceStore().setHarnessVersion(traceId, version);
    changed();
  }).catch(err => console.error(`[traces] the harness version of ${traceId} was not kept: ${(err as Error).message}`));
}

/** The traced sessions open now, on this computer: what each request records it was sent among. */
function liveTracedSessions(): number {
  let n = 0;
  for (const s of sessions.values()) if (s.traced) n++;
  return n;
}

/** Electron's power events, and the kind each is kept as. */
const POWER_EVENTS: Array<[event: string, kind: TraceEvent['kind']]> = [
  ['suspend', 'sleep'], ['resume', 'wake'], ['on-battery', 'battery'], ['on-ac', 'ac'],
];
let unwatchPower: (() => void) | null = null;

/** A power event, stamped on every traced session open now: a session cut by sleep is not a session abandoned. */
export function notePowerEvent(kind: TraceEvent['kind'], at = Date.now()): void {
  let stamped = 0;
  for (const s of sessions.values()) {
    if (!s.traced) continue;
    try {
      traceStore().addEvent(s.traceId, { at, kind });
      stamped++;
    } catch (err) {
      console.error(`[traces] the ${kind} event was not kept on ${s.traceId}: ${(err as Error).message}`);
    }
  }
  if (stamped) changed();
}

function watchPower(power: PowerSource | undefined): void {
  if (!power || unwatchPower) return;
  const offs = POWER_EVENTS.map(([event, kind]) => {
    const listener = () => notePowerEvent(kind);
    power.on(event, listener);
    return () => { power.removeListener(event, listener); };
  });
  unwatchPower = () => { for (const off of offs) off(); };
}

/** At the terminal's exit: the token opens nothing any more, and its trace is ended. */
export function closeEndpointSession(token: string | undefined): void {
  if (!token) return;
  const live = sessions.get(token);
  sessions.delete(token);
  if (!live) return;
  waits.delete(live.agentId);
  windowKeys.forget(live.agentId);
  if (!live.traced) return;
  const endedAt = Date.now();
  // Its harness's log, if read here, is still read a while for what it writes as it exits.
  const followed = followedOf(live, endedAt);
  if (followed) endedFollowed.push(followed);
  const agent = agentOf(live.agentId);
  const folder = agent?.worktreePath || agent?.projectPath;
  // The last turn's end, then each turn's survival (turn-workspace.ts).
  const lastTurn = turnWorkspace().sessionEnded(live.traceId, endedAt, folder).catch(() => undefined);
  const ended = gitOutcome(folder).then((git) => {
    let ok = false;
    try {
      const counts = traceStore().requestCounts(live.traceId);
      const tasks = tasksOf(live, endedAt);
      const ownId = [...live.named].find(([, n]) => n.ref === live.startRef)?.[0];
      const task = tasks.find(t => t.id === ownId) ?? tasks[0];
      // endTrace puts the gates already linked back into the outcome it writes, within what the tasks leave of 12 KiB
      // (trace-store.ts refreshGates): the tasks first, then the gates.
      traceStore().endTrace(live.traceId, endedAt, boundOutcomeTasks({
        ...git, heldRequests: counts.held, requestErrors: counts.errors, abandonedWhileHeld: counts.abandoned,
        ...(task ? { task } : {}), ...(tasks.length ? { tasks } : {}),
      }));
      changed();
      ok = true;
    } catch (err) {
      console.error(`[traces] session not ended: ${(err as Error).message}`);
    }
    // The harness's own log names its compactions, read once the end is written (trace feature C2).
    readCompactionsOf(live, folder, endedAt);
    return ok;
  });
  // Once the last turn's head and the branch are known: the project's verdicts linked again for this session.
  void Promise.all([lastTurn, ended]).then(async ([, ok]) => {
    if (!ok || !folder) return;
    if (await relinkSession({ store: traceStore() }, live.traceId, folder)) changed();
  }).catch((err) => console.error(`[traces] verdicts not linked again at the session's end: ${(err as Error).message}`));
}

/**
 * What started a traced session, at its spawn: an agent asleep wakes, whatever started it; else what its start said
 * (core/session-start.ts), else `unknown`, never a guess. A task that came with a ref carries its queue times from the
 * agent's queue, and reads `redelegation` when another session had that ref before.
 */
function startOf(agent: AgentStatus, traceId: string, note: ReturnType<typeof takeSessionStart>): TraceStart {
  const start: TraceStart = {
    trigger: agent.status === 'asleep' ? 'wake' : note?.trigger ?? 'unknown',
    ...(note?.via ? { via: note.via } : {}), ...(note?.requesterAgentId ? { requesterAgentId: note.requesterAgentId } : {}),
  };
  if (!note?.taskRef) return start;
  start.taskRef = note.taskRef;
  const queued = deps?.queue?.lookup(note.taskRef);
  if (queued) start.queuedAt = queued.task.queuedAt;
  const run = deps?.queue?.busyRun(agent.id);
  if (run?.taskRef === note.taskRef) start.handedAt = run.since;
  const before = traceStore().sessionsWithRef(note.taskRef, traceId);
  if (before.length) {
    start.redelegatedFrom = before[before.length - 1];
    if (start.trigger !== 'wake') start.trigger = 'redelegation';
  }
  return start;
}

/** The newest traced session of an agent's terminal. */
function liveSessionOf(agentId: string): LiveSession | undefined {
  let found: LiveSession | undefined;
  for (const s of sessions.values()) if (s.agentId === agentId && s.traced) found = s;
  return found;
}

/**
 * The agents' queues, told to their traced session: a queued task's run named by the ledger (its queue times, and the
 * session's own task when it started for it), and a task that left the line never to start, the demand the endpoint
 * never saw. An agent with no traced session has nowhere to keep either.
 */
function onQueueEvent(e: QueueEvent): void {
  const live = liveSessionOf(e.agentId);
  if (!live) return;
  try {
    if (e.kind === 'named') {
      live.named.set(e.taskId, { ref: e.ref, queuedAt: e.queuedAt, handedAt: e.handedAt });
      if (e.ref === live.startRef && traceStore().setStart(live.traceId, { taskId: e.taskId })) changed();
    } else if (traceStore().addLostDemand(live.traceId, { kind: 'queue_drop', ref: e.ref, queuedAt: e.queuedAt, at: e.at, reason: e.reason })) {
      changed();
    }
  } catch (err) {
    console.error(`[traces] a queue event not recorded: ${(err as Error).message}`);
  }
}

/**
 * Every task of the ledger this session ran: the agent's tasks whose time meets the session's, in order, each with
 * its queue times. A queued task's come from the queue; one handed over without it takes the hand-off's time; one the
 * owner typed, which nobody handed over, was queued and handed at its turn. Its first request is the session's first
 * after it was handed. The same task in another session is linked both ways (`alsoIn`), the other session's change
 * sequence moved with it.
 */
function tasksOf(live: LiveSession, endedAt: number): TraceTask[] {
  const ledger = liveTaskLedger();
  if (!ledger) return [];
  const ran = ledger.tasks()
    .filter(t => t.agentId === live.agentId && t.startedAt <= endedAt && (t.endedAt ?? endedAt) >= live.startedAt)
    .sort((a, b) => a.startedAt - b.startedAt);
  return ran.map((t) => {
    const queued = live.named.get(t.id);
    const handedAt = queued?.handedAt ?? t.handedAt ?? (t.source === 'terminal' ? t.startedAt : undefined);
    const queuedAt = queued?.queuedAt ?? handedAt;
    const firstRequestAt = traceStore().firstRequestAt(live.traceId, handedAt ?? t.startedAt);
    const task: TraceTask = {
      id: t.id, ...(queued ? { ref: queued.ref } : {}), source: t.source,
      ...(t.parentTaskId ? { parentTaskId: t.parentTaskId } : {}), ...(t.requesterAgentId ? { requesterAgentId: t.requesterAgentId } : {}),
      status: t.outcome, ...(queuedAt !== undefined ? { queuedAt } : {}), ...(handedAt !== undefined ? { handedAt } : {}),
      startedAt: t.startedAt, ...(firstRequestAt !== undefined ? { firstRequestAt } : {}), ...(t.endedAt !== null ? { endedAt: t.endedAt } : {}),
    };
    const others = traceStore().sessionsWithTask(t.id, live.traceId);
    if (others.length) {
      task.alsoIn = others;
      for (const other of others) linkTask(other, t.id, live.traceId);
    }
    return task;
  });
}

/** In `traceId`'s outcome, `taskId` also ran in `alsoIn`. */
function linkTask(traceId: string, taskId: string, alsoIn: string): void {
  const outcome = traceStore().session(traceId)?.outcome;
  if (!outcome?.tasks) return;
  const link = (t: TraceTask): TraceTask => (t.id === taskId ? { ...t, alsoIn: [...new Set([...(t.alsoIn ?? []), alsoIn])] } : t);
  // Bounded again: a link adds weight to an outcome already at its cap.
  const bounded = boundOutcomeTasks({ ...outcome, tasks: outcome.tasks.map(link), ...(outcome.task ? { task: link(outcome.task) } : {}) });
  traceStore().mergeOutcome(traceId, { ...bounded, tasks: bounded.tasks ?? [] });
}

/**
 * The end of a pull request, into the ended sessions whose branch it was: in a project of its repository, on its
 * branch, started before it was merged or closed. Once per session: one that has it is never asked again. Returns
 * how many sessions took it.
 */
export function applyPrStates(states: Array<PrState & { projects: string[] }>, now: number = Date.now()): number {
  let written = 0;
  for (const s of traceStore().awaitingPullRequest(now - PR_WAIT_DAYS * 86_400_000)) {
    const pr = states
      .filter(p => p.projects.includes(s.projectPath) && p.branch === s.branch && p.at >= s.startedAt)
      .sort((a, b) => b.at - a.at)[0];
    if (pr && traceStore().mergeOutcome(s.traceId, { pr: { number: pr.number, state: pr.state, at: pr.at } })) written++;
  }
  if (written) changed();
  return written;
}

/**
 * How long an ended session waits for its branch's pull request: past it, gh is no longer asked for it. A branch never
 * opened as one would keep gh asked every 5 minutes for the life of the install.
 */
export const PR_WAIT_DAYS = 14;

/** The repository's default branch, by origin's HEAD; main and master when origin names none. */
async function defaultBranchesOf(folder: string): Promise<string[]> {
  const head = await safeGit(folder, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { timeout: 5000 })
    .then(r => r.stdout.trim(), () => '');
  return head.startsWith('origin/') ? [head.slice('origin/'.length)] : ['main', 'master'];
}

/**
 * The ended sessions gh is asked about: ended within PR_WAIT_DAYS, on a branch other than their repository's default,
 * which never gets a pull request of its own.
 *
 * A pull request is read among the 50 its repository closed last (prStatesOf). One that closed while 50 others closed
 * after it, before a read found it (Tars off for days in a busy repository), is not found: its sessions wait out
 * PR_WAIT_DAYS and keep no `pr`.
 */
export async function sessionsToAskForPr(now: number = Date.now()): Promise<Array<{ traceId: string; projectPath: string; branch: string; startedAt: number }>> {
  const awaiting = traceStore().awaitingPullRequest(now - PR_WAIT_DAYS * 86_400_000);
  const defaults = new Map<string, string[]>();
  const asked: typeof awaiting = [];
  for (const s of awaiting) {
    if (!defaults.has(s.projectPath)) defaults.set(s.projectPath, await defaultBranchesOf(s.projectPath));
    if (!defaults.get(s.projectPath)!.includes(s.branch)) asked.push(s);
  }
  return asked;
}

/** One read of the pull requests of the projects whose ended sessions wait for one (none: no gh is run). */
function prWatchPass(): void {
  if (!deps || (!store && !fs.existsSync(TRACES_DB_FILE))) return;
  sessionsToAskForPr()
    .then((sessions) => {
      const projects = [...new Set(sessions.map(s => s.projectPath))];
      return projects.length ? prStatesOfProjects(projects).then((states) => { applyPrStates(states); }) : undefined;
    })
    .catch((err) => { console.error(`[traces] pull requests not read: ${(err as Error).message}`); });
}

/**
 * At a session's end, the compactions its harness logged (trace feature C2): codex's rollout of this session (by its
 * own session id), Qwen Code's transcript of the agent's folder that alone overlaps the session. Read only, from the
 * agent's own folders, bounded (harness-compactions.ts). What the wire saw meanwhile stays; the log names it.
 */
function readCompactionsOf(live: LiveSession, folder: string | undefined, endedAt: number): void {
  if (live.harness !== 'codex' && live.harness !== 'qwen-code') return;
  const failed = (err: unknown) => console.error(`[traces] the compactions of ${live.traceId} were not read: ${(err as Error).message}`);
  try {
    const nativeSessionId = traceStore().list({ traceId: live.traceId, limit: 1 }).sessions[0]?.nativeSessionId;
    // Read asynchronously (fs.promises, bounded): a session's end never holds the main process on the files.
    void readHarnessCompactions({
      harness: live.harness, codexHome: codexHome(), qwenHome: path.join(os.homedir(), '.qwen'), cwd: folder,
      nativeSessionId, startedAt: live.startedAt, endedAt,
    }).then((events) => {
      // The runtime stopped meanwhile (Tars quitting): nothing is written, and the store the stop closed stays closed
      // (traceStore() would open it again). As noteToolCall checks.
      if (!deps || !store) return;
      store.applyHarnessCompactions(live.traceId, events);
      changed();
    }).catch(failed);
  } catch (err) {
    failed(err);
  }
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

/** The trace an agent's current terminal records, if any: its newest. */
export function liveTraceOf(agentId: string): string | undefined {
  return liveSessionOf(agentId)?.traceId;
}

type Sender =
  | { kind: 'agent'; id: string; name?: string }
  | { kind: 'tars' }
  | { kind: 'channel'; channel: string }
  | { kind: 'user'; via: string }
  | { kind: 'owner-relay'; by: { id: string; name?: string } };

/** What Tars typed into a traced agent's terminal, and from whom: the turn it opens is attributed to them. */
export function noteTypedForTraces(origin: { agentId: string; from?: string; sender?: Sender; taskRef?: string } | undefined, text: string): void {
  if (!origin || !deps || !liveTraceOf(origin.agentId)) return;
  const s = origin.sender;
  let author: Exclude<TurnAuthor, 'unknown'> = 'user';
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
    // With the ref of the task these words hand over, if they do: the turn they open carries it (#675).
    traceStore().noteTypedInput({ agentId: origin.agentId, at: Date.now(), author, authorDetail: detail, text, closed, ...(origin.taskRef ? { taskRef: origin.taskRef } : {}) });
  } catch (err) {
    console.error(`[traces] typed input not noted: ${(err as Error).message}`);
  }
}

// ── Interventions and the cause of a cut (trace feature B3, 27/11) ────────

export { CORRECTION_WINDOW_MS };

/** A key is the cause of a harness's hang-up that comes within this of it, during the request. */
const KEY_CUT_MS = 10_000;
/** Tars ending a terminal is the cause of a hang-up that comes within this of it, of a request begun before. */
const TARS_CUT_MS = 30_000;
/** A CLI's log of an interrupted turn ties to a cut its watcher read within this. */
const CLI_TIE_MS = 60_000;
/** A generic ending (a terminal replaced) keeps the cause a caller named this shortly before (a restart). */
const NAMED_ENDING_MS = 2000;

/** Where Tars ends an agent's terminal: what a cut by Tars and an interruption say. */
export type TarsEnding = 'stop' | 'restart' | 'sleep' | 'remove' | 'quit' | 'replace';
type During = InterventionDuring;

/** Each agent's requests in flight at the endpoint proxy. */
const inFlight = new Map<string, number>();
/** The last Esc or Ctrl-C from the window, per agent. */
const lastKeys = new Map<string, { key: InterruptKey; at: number }>();
/** The last time Tars ended an agent's terminal, and why. */
const tarsEndings = new Map<string, { cause: TarsEnding; at: number }>();

/** A request of the agent's in flight (+1) or over (-1): the proxy's count (endpoint-proxy.ts inFlight). */
export function requestInFlight(agentId: string, delta: number): void {
  const n = Math.max(0, (inFlight.get(agentId) ?? 0) + delta);
  if (n) inFlight.set(agentId, n); else inFlight.delete(agentId);
}

/** What the agent was doing when a key came: answering (a request in flight), running tools (its turn open), or neither. */
function duringOf(agentId: string): During | undefined {
  if ((inFlight.get(agentId) ?? 0) > 0) return 'answer';
  const live = liveSessionOf(agentId);
  try {
    if (live && traceStore().lastTurnOpen(live.traceId)) return 'tools';
  } catch (err) {
    console.error(`[traces] the turn's state not read: ${(err as Error).message}`);
  }
  return undefined;
}

function addIntervention(agentId: string, e: InterventionEvent): void {
  const live = liveSessionOf(agentId);
  if (!live) return;
  try {
    if (traceStore().addIntervention(live.traceId, e)) changed();
  } catch (err) {
    console.error(`[traces] an intervention not recorded: ${(err as Error).message}`);
  }
}

const windowKeys = new InterruptKeys<During | undefined>((agentId, key, at, during) => {
  lastKeys.set(agentId, { key, at });
  // Into a turn only: an Esc at an idle prompt cuts nothing.
  if (during) addIntervention(agentId, { kind: 'interrupted', at, by: key, during });
});

/**
 * Keys a person typed from the window into an agent's terminal (core/pty-manager.ts writeHumanInput), read for a lone
 * Esc or Ctrl-C (core/interrupt-keys.ts): what the agent was doing is read as the key comes. A traced session only.
 */
export function noteWindowKeys(agentId: string, chunk: string, at: number = Date.now()): void {
  if (!liveSessionOf(agentId)) return;
  windowKeys.feed(agentId, chunk, at, interruptKeyOf(chunk) ? duringOf(agentId) : undefined);
}

/**
 * Tars ends an agent's terminal, said just before it does: the cause of the cut of a request then in flight, and an
 * intervention on the session's turn (a restart, or an interruption when a turn was open). A generic ending (`ifNone`,
 * a terminal replaced, core/pty-kill.ts) keeps a cause a caller named just before.
 */
export function noteTarsEnding(agentId: string, cause: TarsEnding, at: number = Date.now(), opts: { ifNone?: boolean } = {}): void {
  const named = tarsEndings.get(agentId);
  if (opts.ifNone && named && at - named.at < NAMED_ENDING_MS) return;
  tarsEndings.set(agentId, { cause, at });
  windowKeys.forget(agentId);
  if (cause === 'restart' || cause === 'replace') { addIntervention(agentId, { kind: 'restarted', at, by: cause }); return; }
  const during = duringOf(agentId);
  if (during) addIntervention(agentId, { kind: 'interrupted', at, by: cause, during });
}

/**
 * Why an agent's harness hung up on a request begun at `startedAt`, cut at `at` (the proxy's cutOf): Tars ending its
 * terminal, else an Esc or a Ctrl-C from the window during the request, an Esc still in its wait included (the harness
 * hangs up before the wait is over). Undefined when Tars knows of none: never a guess.
 */
export function cutOf(agentId: string, startedAt: number, at: number): Pick<RequestCancel, 'by' | 'cause'> | undefined {
  const ending = tarsEndings.get(agentId);
  if (ending && startedAt <= ending.at && ending.at <= at && at - ending.at <= TARS_CUT_MS) return { by: 'tars', cause: ending.cause };
  const waiting = windowKeys.pending(agentId);
  const keys = [lastKeys.get(agentId), waiting ? { key: 'esc' as const, at: waiting.at } : undefined]
    .filter((k): k is { key: InterruptKey; at: number } => !!k && startedAt <= k.at && k.at <= at && at - k.at <= KEY_CUT_MS)
    .sort((a, b) => b.at - a.at);
  return keys.length ? { by: 'harness', cause: keys[0].key } : undefined;
}

/**
 * The CLI's own log says the agent's turn was interrupted (codex's turn_aborted, pi's; services/task-watch.ts): the
 * latest cut of its live session with no cause Tars knew, within the minute, takes it, and the turn reads interrupted,
 * unless a key or Tars's own ending already said so.
 */
export function noteCliInterrupt(agentId: string, at: number = Date.now()): void {
  const live = liveSessionOf(agentId);
  if (!live) return;
  try {
    const cutAt = traceStore().reviseUnknownCut(live.traceId, at - CLI_TIE_MS, 'cli_interrupt');
    if (cutAt !== undefined) changed();
    const key = lastKeys.get(agentId);
    const ending = tarsEndings.get(agentId);
    if ((key && at - key.at <= CLI_TIE_MS) || (ending && at - ending.at <= CLI_TIE_MS)) return;
    if (traceStore().addIntervention(live.traceId, { kind: 'interrupted', at: cutAt ?? at, by: 'cli', during: cutAt !== undefined ? 'answer' : 'tools' })) changed();
  } catch (err) {
    console.error(`[traces] the CLI's interruption not recorded: ${(err as Error).message}`);
  }
}

/**
 * A tool call the agent's harness wrote in its own log (trace feature C1, services/tool-calls.ts), onto the traced
 * session it happened in: read late, after its request or its session's end, it still lands there; a line of another
 * session finds none. Nothing for an agent never traced (no session opened the store in this run).
 */
export function noteToolCall(agentId: string, part: ToolCallPart): void {
  if (!deps || !store) return;
  try {
    const traceId = store.traceForToolCall(agentId, part);
    if (traceId && store.addToolCall(traceId, part)) changed();
  } catch (err) {
    console.error(`[traces] a tool call not recorded: ${(err as Error).message}`);
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
