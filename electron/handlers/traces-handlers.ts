import * as fs from 'fs';
import { ipcMain, dialog, BrowserWindow } from 'electron';
import type { AppSettings, TraceSettings } from '../types';
import { agents } from '../core/agent-manager';
import {
  applyEndpointPatch, approveEndpoint, checkHealth, endpointViews, readModels, removeEndpoint, sameExtraHeaders, saveEndpoint, setEndpointKey,
  transportOf, type EndpointView, type ToolCallSupport,
} from '../services/inference-endpoints';
import {
  endpointWaits, readerTokenStatus, revokeReaderToken, rotateReaderToken, sweepTraces, traceSettingsOf, traceStore,
  withdrawUploadConsent, holdRevoke,
} from '../services/traces-runtime';
import type { TraceFilter } from '../services/trace-store';
import { traceExportLines } from '../services/trace-export';
import { CLOSED_MODELS_WARNING, traceDecision } from '../services/trace-gate';
import {
  dropConsentFile, previewUpload, recordConsent, settingsNotWritten, traceUploader, uploadPersistence,
} from '../services/traces-runtime';
import { cleanBaseUrl } from '../services/inference-endpoints';
import { SCRUB_VERSION } from '../services/trace-scrub';
import { withKeptKeys } from '../services/settings-secrets';

/**
 * The window's side of inference endpoints and native traces: the IPC contract the back-office page
 * and the Settings section are built on. The window never gets a key back, only `keySet`, and it is the one place
 * an endpoint is approved (endpoints:approve): no API route does it.
 */

export interface TracesHandlerDeps {
  getAppSettings(): AppSettings;
  setAppSettings(settings: AppSettings): void;
  /** The settings written, or a throw saying why (main.ts writeAppSettingsFile). */
  writeAppSettings(settings: AppSettings): void;
}

/** How each harness measured on an endpoint. */
export const HARNESS_SUPPORT: Array<{ harness: string; toolCalls: ToolCallSupport; api: 'chat' | 'responses'; measuredOn: string; note?: string }> = [
  { harness: 'codex', toolCalls: 'works', api: 'responses', measuredOn: '0.163.0', note: 'Responses only: 0.163 refuses wire_api "chat" at load.' },
  { harness: 'qwen-code', toolCalls: 'works', api: 'chat', measuredOn: '0.25.2' },
  { harness: 'pi', toolCalls: 'works', api: 'chat', measuredOn: '1.5.2' },
  { harness: 'opencode', toolCalls: 'works', api: 'chat', measuredOn: '1.19.6' },
];

export const harnessSupportMap = (): Record<string, ToolCallSupport> =>
  Object.fromEntries(HARNESS_SUPPORT.map(h => [h.harness, h.toolCalls]));

function cleanFilter(raw: unknown): TraceFilter {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof f[k] === 'string' && f[k] ? String(f[k]) : undefined);
  const num = (k: string) => (typeof f[k] === 'number' && Number.isFinite(f[k]) ? Number(f[k]) : undefined);
  return { traceId: str('traceId'), project: str('project'), agentId: str('agentId'), harness: str('harness'), model: str('model'), endpointId: str('endpointId'), from: num('from'), to: num('to'), cursor: str('cursor'), limit: num('limit') };
}

export function registerTracesHandlers(deps: TracesHandlerDeps): void {
  // Written first, then held in memory, where the uploader and the proxy read them: a setting main could not write
  // was answered ok and held for the rest of the run (a consent to upload on a full disk, the Audit's L2 on #599).
  // The reason when it could not, for the window to show; null when it was written and applied.
  const samePair = (a: { harness: string; models: string }, b: { harness: string; models: string }) => a.harness === b.harness && a.models === b.models;
  // `then`: what the failure left, when something already held before the write (a withdrawal).
  const apply = (settings: AppSettings, then?: string): string | null => {
    try {
      deps.writeAppSettings(settings);
    } catch (err) {
      console.error('[traces] settings not written:', err);
      // A key the failed save left on disk is held in memory too, or the next save would write the old one back.
      const kept = withKeptKeys(deps.getAppSettings(), err);
      if (kept) deps.setAppSettings(kept);
      return settingsNotWritten(err, then);
    }
    deps.setAppSettings(settings);
    return null;
  };
  const views = (): EndpointView[] => endpointViews(deps.getAppSettings(), [...agents.values()]);
  const view = (id: string) => views().find(v => v.id === id);
  const tell = (channel: string, payload?: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
  };

  ipcMain.handle('endpoints:list', () => views());

  ipcMain.handle('endpoints:save', (_e, input: unknown) => {
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const r = saveEndpoint(deps.getAppSettings(), {
      id: typeof i.id === 'string' ? i.id : undefined, name: typeof i.name === 'string' ? i.name : undefined,
      baseUrl: typeof i.baseUrl === 'string' ? i.baseUrl : undefined, allowTraces: typeof i.allowTraces === 'boolean' ? i.allowTraces : undefined,
      holdMaxSeconds: typeof i.holdMaxSeconds === 'number' ? i.holdMaxSeconds : undefined,
      sendSessionHeaders: typeof i.sendSessionHeaders === 'boolean' ? i.sendSessionHeaders : undefined,
      allowPlainHttp: typeof i.allowPlainHttp === 'boolean' ? i.allowPlainHttp : undefined,
      // Checked by saveEndpoint (cleanExtraHeaders): anything but a map of header names to values is refused there.
      extraHeaders: i.extraHeaders,
      // What the form showed when it opened: a save of an endpoint that exists is refused without it, or when an
      // agent changed the endpoint since (saveEndpoint), before anything is written, the grant-first path included.
      shown: i.shown && typeof i.shown === 'object' ? i.shown as { baseUrl?: unknown; extraHeaders?: unknown } : undefined,
    }, { window: true });
    if (!r.ok) return r;
    // Traces turned off for an endpoint is a revoke of sharing: it applies first, then is written (holdRevoke), with
    // the rest of the save when that grants nothing (names, the hold, the defaults the save fills in). A save that
    // also grants (session headers or plain http turned on, the address moved, which the save approves with the key,
    // or extra headers changed, which go out with it) has that part written first.
    const before = (deps.getAppSettings().inferenceEndpoints ?? []).find(e => e.id === r.endpoint.id);
    let held: string | undefined;
    if (before?.allowTraces === true && r.endpoint.allowTraces === false) {
      const grants = (before.sendSessionHeaders !== true && r.endpoint.sendSessionHeaders === true)
        || (before.allowPlainHttp !== true && r.endpoint.allowPlainHttp === true)
        || before.baseUrl !== r.endpoint.baseUrl
        || !sameExtraHeaders(before.extraHeaders, r.endpoint.extraHeaders);
      if (!grants) {
        held = holdRevoke(r.settings);
      } else {
        const now = deps.getAppSettings();
        held = holdRevoke({ ...now, inferenceEndpoints: (now.inferenceEndpoints ?? []).map(e => (e.id === r.endpoint.id ? { ...e, allowTraces: false } : e)) });
        const unsaved = apply(r.settings, 'traces stay off for it, and the rest was not saved');
        if (unsaved) return { ok: false, error: unsaved };
      }
    } else {
      const unsaved = apply(r.settings);
      if (unsaved) return { ok: false, error: unsaved };
    }
    // An agent's change the save left pending still needs the owner's approval.
    tell('endpoints:changed', { id: r.endpoint.id, needsApproval: !r.endpoint.approved });
    return { ok: true, endpoint: view(r.endpoint.id), ...(held ? { unsaved: held } : {}) };
  });

  ipcMain.handle('endpoints:approve', (_e, id: unknown, seen: unknown) => {
    // What the window showed: approved only if it is still what the endpoint holds (approveEndpoint).
    const r = approveEndpoint(deps.getAppSettings(), String(id), seen && typeof seen === 'object' ? seen as { baseUrl?: unknown; extraHeaders?: unknown } : undefined);
    if (!r.ok) return r;
    const unsaved = apply(r.settings);
    if (unsaved) return { ok: false, error: unsaved };
    tell('endpoints:changed', { id: r.endpoint.id, needsApproval: false });
    return { ok: true, endpoint: view(r.endpoint.id) };
  });

  ipcMain.handle('endpoints:setKey', (_e, id: unknown, key: unknown) => {
    const r = setEndpointKey(deps.getAppSettings(), String(id), key === null ? null : typeof key === 'string' ? key : '');
    if (!r.ok) return r;
    const unsaved = apply(r.settings);
    if (unsaved) return { ok: false, error: unsaved };
    return { ok: true };
  });

  ipcMain.handle('endpoints:remove', (_e, id: unknown) => {
    const r = removeEndpoint(deps.getAppSettings(), String(id), [...agents.values()]);
    if (!r.ok) return r;
    // A revoke of sharing: it applies first, then is written (holdRevoke).
    const held = holdRevoke(r.settings);
    tell('endpoints:changed', { id: String(id), needsApproval: false });
    return { ok: true, ...(held ? { unsaved: held } : {}) };
  });

  ipcMain.handle('endpoints:refreshModels', async (_e, id: unknown) => {
    const r = await readModels(deps.getAppSettings(), String(id));
    // Only what the probe owns, onto the settings as they are now (the Audit's M1 on #596).
    const unsaved = apply(applyEndpointPatch(deps.getAppSettings(), String(id), r.patch, r.probed));
    if (unsaved) return { ok: false, error: unsaved };
    return r.ok ? { ok: true, models: r.models } : { ok: false, error: r.error };
  });

  ipcMain.handle('endpoints:check', async (_e, id: unknown) => {
    const r = await checkHealth(deps.getAppSettings(), String(id));
    // The health is what the probe read, said whether or not its patch could be kept.
    apply(applyEndpointPatch(deps.getAppSettings(), String(id), r.patch, r.probed));
    return r.health;
  });

  ipcMain.handle('endpoints:harnesses', () => HARNESS_SUPPORT.map(h => ({ ...h })));
  ipcMain.handle('endpoints:waits', () => endpointWaits());

  ipcMain.handle('traces:settings', () => traceSettingsOf(deps.getAppSettings()));

  ipcMain.handle('traces:setSettings', (_e, patch: unknown) => {
    const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<TraceSettings>;
    const current = traceSettingsOf(deps.getAppSettings());
    const next: TraceSettings = { ...current };
    if (p.projects !== undefined) {
      if (!Array.isArray(p.projects) || !p.projects.every(x => typeof x === 'string')) return { ok: false, error: 'Projects are named by their paths.' };
      next.projects = [...new Set(p.projects)];
    }
    if (p.capBytes !== undefined) {
      if (typeof p.capBytes !== 'number' || p.capBytes < 64 * 1024 * 1024) return { ok: false, error: 'The cap is 64 MiB at least.' };
      next.capBytes = Math.floor(p.capBytes);
    }
    if (p.retentionDays !== undefined) {
      if (!Number.isInteger(p.retentionDays) || p.retentionDays < 1 || p.retentionDays > 3650) return { ok: false, error: 'Retention is 1 to 3650 days.' };
      next.retentionDays = p.retentionDays;
    }
    if (p.pairs !== undefined) {
      if (!Array.isArray(p.pairs) || !p.pairs.every(x => x && typeof x.harness === 'string' && typeof x.models === 'string')) return { ok: false, error: 'A pair is a harness and a model glob.' };
      next.pairs = p.pairs.map(x => ({ harness: x.harness, models: x.models, ...(typeof x.note === 'string' ? { note: x.note } : {}) }));
    }
    if (p.excludeClosedModels !== undefined) {
      if (typeof p.excludeClosedModels !== 'boolean') return { ok: false, error: 'Leaving closed models out is on or off.' };
      next.excludeClosedModels = p.excludeClosedModels;
    }
    if (p.uploadAllowPlainHttp !== undefined) {
      if (typeof p.uploadAllowPlainHttp !== 'boolean') return { ok: false, error: 'Allowing plain http is on or off.' };
      next.uploadAllowPlainHttp = p.uploadAllowPlainHttp;
    }
    if (p.uploadUrl !== undefined) {
      if (typeof p.uploadUrl !== 'string') return { ok: false, error: 'The back-office address is a URL, or empty.' };
      const url = p.uploadUrl.trim() === '' ? '' : cleanBaseUrl(p.uploadUrl);
      if (url === null) return { ok: false, error: 'The back-office address must be http(s), with no credentials, query or fragment.' };
      if (url !== next.uploadUrl) {
        delete next.uploadConsentAt;
        if (p.uploadAllowPlainHttp === undefined) next.uploadAllowPlainHttp = false;
      }
      next.uploadUrl = url;
    }
    // The endpoints' rule (the Audit's L2 on #596): https for a public address, plain http to loopback and private
    // networks, and elsewhere only with the owner's allowance, given here, in the window.
    if (next.uploadUrl && transportOf(next.uploadUrl) === 'http-public' && !next.uploadAllowPlainHttp) {
      return { ok: false, error: 'A public back-office address takes https. Plain http goes to loopback and private networks only, unless you allow it.' };
    }
    // A consent is given for one address: emptying or changing it takes the consent back at once, in memory and off
    // the disk, before the rest is written, so a write that fails never leaves sharing on (the Audit's L2 at
    // 1e9571eab). Settings that never hold then: the next start takes it for a deletion, which fails closed.
    const dropsConsent = !!current.uploadConsentAt && !next.uploadConsentAt;
    // `persisted` false: neither the consent's file nor the settings hold the withdrawal, so a restart before a write
    // holds would share again with the old address (the Audit's L1 at c447c1ceb). Said, not hidden.
    const withdrawn = dropsConsent ? withdrawUploadConsent() : undefined;
    // What the patch takes away from sharing (projects opted out, pairs removed, closed models left out) applies
    // first, then is written (holdRevoke); what it grants, or anything else it changes, is written first.
    const base = traceSettingsOf(deps.getAppSettings());
    const narrowed: TraceSettings = {
      ...base,
      projects: base.projects.filter(x => next.projects.includes(x)),
      pairs: base.pairs.filter(x => next.pairs.some(y => samePair(x, y))),
      excludeClosedModels: base.excludeClosedModels || next.excludeClosedModels,
    };
    const revoked = JSON.stringify(narrowed) !== JSON.stringify(base);
    const held = revoked ? holdRevoke({ ...deps.getAppSettings(), traces: narrowed }) : undefined;
    if (JSON.stringify(next) !== JSON.stringify({ ...narrowed, ...(next.uploadConsentAt ? { uploadConsentAt: next.uploadConsentAt } : {}) })) {
      const then = withdrawn && !withdrawn.persisted
        ? 'sharing stopped for now, but a restart before the settings are saved would share again with the old address; Tars tries again every minute'
        : dropsConsent ? 'sharing stopped at once, and the address was not saved'
        : revoked ? 'what it took away from sharing holds, and the rest was not saved' : undefined;
      const unsaved = apply({ ...deps.getAppSettings(), traces: next }, then);
      if (unsaved) return { ok: false, error: unsaved };
    }
    sweepTraces();
    return { ok: true, settings: traceSettingsOf(deps.getAppSettings()), ...(held ? { unsaved: held } : {}) };
  });

  // The harness and model pairs that may be traced: the owner's list, empty as Tars ships, and the closed-model
  // default beside it (trace-gate.ts).
  const pairsView = () => {
    const t = traceSettingsOf(deps.getAppSettings());
    return { pairs: t.pairs, excludeClosedModels: t.excludeClosedModels, closedModelsWarning: CLOSED_MODELS_WARNING };
  };
  const setPairs = (pairs: TraceSettings['pairs']) => {
    const unsaved = apply({ ...deps.getAppSettings(), traces: { ...traceSettingsOf(deps.getAppSettings()), pairs } });
    if (unsaved) return { ok: false as const, error: unsaved };
    return { ok: true as const, ...pairsView() };
  };
  const pairOf = (raw: unknown): TraceSettings['pairs'][number] | null => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (typeof o.harness !== 'string' || !o.harness.trim() || typeof o.models !== 'string' || !o.models.trim()) return null;
    return { harness: o.harness.trim().slice(0, 80), models: o.models.trim().slice(0, 200), ...(typeof o.note === 'string' && o.note ? { note: o.note.slice(0, 200) } : {}) };
  };
  const same = samePair;
  ipcMain.handle('traces:pairs', () => pairsView());
  ipcMain.handle('traces:addPair', (_e, raw: unknown) => {
    const pair = pairOf(raw);
    if (!pair) return { ok: false, error: 'A pair is a harness (or *) and a model glob (or *).' };
    const pairs = traceSettingsOf(deps.getAppSettings()).pairs;
    if (pairs.some(p => same(p, pair))) return { ok: true, ...pairsView() };
    return setPairs([...pairs, pair]);
  });
  ipcMain.handle('traces:removePair', (_e, raw: unknown) => {
    const pair = pairOf(raw);
    if (!pair) return { ok: false, error: 'A pair is a harness and a model glob.' };
    // A revoke of sharing: it applies first, then is written (holdRevoke).
    const held = holdRevoke({ ...deps.getAppSettings(), traces: { ...traceSettingsOf(deps.getAppSettings()), pairs: traceSettingsOf(deps.getAppSettings()).pairs.filter(p => !same(p, pair)) } });
    return { ok: true as const, ...pairsView(), ...(held ? { unsaved: held } : {}) };
  });
  // A list of pairs from a JSON file the owner picks (an array of { harness, models, note? }), added to the list.
  ipcMain.handle('traces:importPairs', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = { properties: ['openFile' as const], filters: [{ name: 'JSON', extensions: ['json'] }] };
    const chosen = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
    if (chosen.canceled || !chosen.filePaths[0]) return { ok: false, error: 'Cancelled.', cancelled: true };
    let raw: unknown;
    try {
      if (fs.statSync(chosen.filePaths[0]).size > 1024 * 1024) return { ok: false, error: 'The file is over 1 MiB.' };
      raw = JSON.parse(fs.readFileSync(chosen.filePaths[0], 'utf8'));
    } catch (err) {
      return { ok: false, error: `Not a JSON file: ${(err as Error).message}` };
    }
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as { pairs?: unknown })?.pairs) ? (raw as { pairs: unknown[] }).pairs : null;
    if (!list || list.length > 500) return { ok: false, error: 'The file holds a list of up to 500 { harness, models } pairs.' };
    const incoming = list.map(pairOf);
    if (incoming.some(p => p === null)) return { ok: false, error: 'Every entry is { harness, models, note? }.' };
    const pairs = [...traceSettingsOf(deps.getAppSettings()).pairs];
    let added = 0;
    for (const p of incoming as TraceSettings['pairs']) if (!pairs.some(x => same(x, p))) { pairs.push(p); added++; }
    return { ...setPairs(pairs), added };
  });

  // The upload to a back-office (its address a setting, empty until the user sets one): what leaves the machine,
  // shown before the first upload, and a session as it would be sent.
  ipcMain.handle('traces:uploadNotice', () => ({
    // After a deletion, only what was recorded after it goes: the deleted sessions are never sent again.
    ...(traceSettingsOf(deps.getAppSettings()).uploadDeletedAt !== undefined
      ? { onlyAfter: new Date(traceSettingsOf(deps.getAppSettings()).uploadDeletedAt!).toISOString() } : {}),
    leaves: [
      'the sessions of the projects and agents you opted in, in full: system prompts, tool definitions, your messages and the agents\', tool calls and their results, thinking the model returned',
      'their timing, token counts, the harness and its version, the model and the endpoint\'s name',
      'how many secrets, e-mail addresses, IP addresses, names, home folders and phone numbers were masked in each session, and the version of the masking',
      'who wrote each turn (you, an orchestrator, an agent, a channel) and how the session ended (branch, commit)',
      'an install id, to delete everything this install sent',
    ],
    stays: ['your keys and Tars\'s tokens (masked before upload)', 'sessions of projects and agents not opted in', 'the endpoints\' keys and addresses', 'anything outside traced sessions'],
    scrubbing: {
      version: SCRUB_VERSION,
      catches: ['every secret Tars holds (settings keys, endpoint keys, its own tokens)', 'the values of the project\'s .env files', 'keys by shape (OpenAI, Anthropic, GitHub, Slack, AWS, Google, Stripe, npm, Hugging Face, JWT, private keys)', 'secrets after a telling name (password=, api_key:, "token":)', 'passwords in URLs, Bearer and Basic credentials',
        'home folders, yours and anyone else\'s, with the name in them', 'e-mail addresses', 'IP addresses (not 127.0.0.1, 0.0.0.0 or ::1)', 'phone numbers written as people write them (+33 6 12 34 56 78, (555) 201-4567, 06 12 34 56 78)',
        'the names Tars knows: the authors and committers of the project\'s git history, written whole (First Last, or Last, First), and your own name as git and your system have it, whole or by its parts',
        'each as a placeholder numbered within its session (<SECRET_1>, <EMAIL_2>, <HOME_1>...): the same value, the same number, and numbers start again in each session'],
      cannot: ['a secret with no known shape and no telling name that Tars does not hold', 'a secret or personal data cut in two, encoded, or in an image', 'a name Tars does not know: someone outside the project\'s git history and you',
        'another person\'s first or last name written alone, or a one-word name that is not yours: only their whole names are masked',
        'a phone number written some other way', 'what the endpoint itself already received'],
    },
  }));
  ipcMain.handle('traces:preview', (_e, traceId: unknown) => previewUpload(String(traceId)));
  // With `unsaved` while a change that already holds in memory (a withdrawal) waits for a write that holds: every
  // answer that carries the upload state takes it from here (the Audit's I-2 on #599).
  const uploadState = () => ({ ...traceUploader().state(), ...uploadPersistence() });
  ipcMain.handle('traces:uploadState', () => uploadState());
  // The user gives up a deletion an old back-office never confirmed: its install is forgotten, and what was recorded
  // before the deletion is still never sent.
  ipcMain.handle('traces:ackDeletionCleared', () => { traceUploader().ackDeletionCleared(); return { ok: true }; });
  ipcMain.handle('traces:abandonDeletion', () => {
    const r = traceUploader().abandonDeletion();
    if (!r.ok) return r;
    tell('traces:changed');
    return { ok: true, state: uploadState() };
  });
  ipcMain.handle('traces:deleteEverywhere', async () => {
    const r = await traceUploader().deleteEverywhere();
    tell('traces:changed');
    return r;
  });
  ipcMain.handle('traces:giveUploadConsent', () => {
    const t = traceSettingsOf(deps.getAppSettings());
    if (!t.uploadUrl) return { ok: false, error: 'Set the back-office address first.' };
    if (traceUploader().isDeletionOwed()) return { ok: false, error: 'The deletion of what was shared is not confirmed yet: delete again, or give it up.' };
    const at = new Date().toISOString();
    // Given once written, never only in memory, where the uploader reads it (the Audit's L2 on #599): its own file
    // first, then the settings, and the file taken back when the settings cannot be written.
    try {
      recordConsent(at);
    } catch (err) {
      console.error('[traces] consent not written:', err);
      return { ok: false, error: settingsNotWritten(err) };
    }
    const unsaved = apply({ ...deps.getAppSettings(), traces: { ...t, uploadConsentAt: at } });
    if (unsaved) {
      dropConsentFile();
      return { ok: false, error: unsaved };
    }
    return { ok: true, at };
  });

  // Whether "Record traces" can be offered for this harness, model, endpoint and project, and why not: the window
  // asks rather than copy the rule (trace-gate.ts). The agent's own switch is what is offered, so it counts as on;
  // the project's is said apart.
  ipcMain.handle('traces:offer', (_e, raw: unknown) => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const settings = deps.getAppSettings();
    const t = traceSettingsOf(settings);
    const endpoint = (settings.inferenceEndpoints ?? []).find(e => e.id === o.endpointId);
    const projectOptedIn = typeof o.projectPath === 'string' && t.projects.includes(o.projectPath);
    const d = traceDecision({
      provider: typeof o.provider === 'string' ? o.provider : undefined, model: typeof o.model === 'string' ? o.model : undefined,
      endpoint: endpoint ? { allowTraces: endpoint.allowTraces === true, approved: endpoint.approved === true && endpoint.approvedBaseUrl === endpoint.baseUrl } : undefined,
      projectOptedIn: true, agentOptedIn: true, pairs: t.pairs, excludeClosedModels: t.excludeClosedModels,
    });
    const projectMissing = d.traced && !projectOptedIn;
    return {
      offered: d.traced, code: projectMissing ? 'project-off' as const : d.code,
      reason: projectMissing ? 'the project is not opted in' : d.reason, projectOptedIn,
    };
  });

  ipcMain.handle('traces:stats', () => {
    const s = traceStore().stats();
    const t = traceSettingsOf(deps.getAppSettings());
    return { bytes: s.bytes, capBytes: t.capBytes, retentionDays: t.retentionDays, sessions: s.sessions, requests: s.requests, oldest: s.oldest, bodiesDropped: s.bodiesDropped, byProject: s.byProject };
  });

  ipcMain.handle('traces:list', (_e, filter: unknown) => traceStore().list(cleanFilter(filter)));
  ipcMain.handle('traces:session', (_e, traceId: unknown) => traceStore().session(String(traceId)));
  ipcMain.handle('traces:requestMessages', (_e, requestId: unknown) => {
    const r = traceStore().requestMessages(String(requestId));
    if (!r) return null;
    return { system: r.system, tools: r.tools, input: r.input, output: r.output };
  });

  ipcMain.handle('traces:exportTo', async (_e, filter: unknown) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const chosen = await (win ? dialog.showSaveDialog(win, { defaultPath: `tars-traces-${new Date().toISOString().slice(0, 10)}.jsonl` }) : dialog.showSaveDialog({ defaultPath: 'tars-traces.jsonl' }));
    if (chosen.canceled || !chosen.filePath) return { ok: false, error: 'Cancelled.', cancelled: true };
    try {
      const out = fs.openSync(chosen.filePath, 'w', 0o600);
      let sessions = 0;
      try {
        for (const line of traceExportLines(traceStore(), cleanFilter(filter))) {
          if (line.startsWith('{"table":"traces"')) sessions++;
          fs.writeSync(out, `${line}\n`);
        }
      } finally {
        fs.closeSync(out);
      }
      return { ok: true, path: chosen.filePath, sessions };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('traces:remove', (_e, sel: unknown) => {
    const s = (sel && typeof sel === 'object' ? sel : {}) as { traceIds?: unknown; filter?: unknown };
    const r = Array.isArray(s.traceIds)
      ? traceStore().remove({ traceIds: s.traceIds.filter((x): x is string => typeof x === 'string') })
      : traceStore().remove({ filter: cleanFilter(s.filter) });
    tell('traces:changed');
    return r;
  });

  ipcMain.handle('traces:readerToken', () => readerTokenStatus());
  // Ok only once the old token opens nothing and its file says no token (the Audit's L1 at 1e9571eab).
  ipcMain.handle('traces:rotateReaderToken', () => {
    try {
      return { token: rotateReaderToken() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('traces:revokeReaderToken', () => {
    try {
      revokeReaderToken();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}
