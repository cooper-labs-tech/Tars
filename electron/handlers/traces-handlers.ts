import * as fs from 'fs';
import { ipcMain, dialog, BrowserWindow } from 'electron';
import type { AppSettings, TraceSettings } from '../types';
import { agents } from '../core/agent-manager';
import {
  approveEndpoint, checkHealth, endpointViews, readModels, removeEndpoint, saveEndpoint, setEndpointKey,
  type EndpointView, type ToolCallSupport,
} from '../services/inference-endpoints';
import {
  endpointWaits, readerTokenStatus, revokeReaderToken, rotateReaderToken, sweepTraces, traceSettingsOf, traceStore,
} from '../services/traces-runtime';
import type { TraceFilter } from '../services/trace-store';
import { traceExportLines } from '../services/trace-export';
import { CLOSED_MODELS_WARNING, traceDecision } from '../services/trace-gate';
import { previewUpload } from '../services/traces-runtime';
import { cleanBaseUrl } from '../services/inference-endpoints';
import { SCRUB_VERSION } from '../services/trace-scrub';

/**
 * The window's side of inference endpoints and native traces: the IPC contract the back-office page
 * and the Settings section are built on. The window never gets a key back, only `keySet`, and it is the one place
 * an endpoint is approved (endpoints:approve): no API route does it.
 */

export interface TracesHandlerDeps {
  getAppSettings(): AppSettings;
  setAppSettings(settings: AppSettings): void;
  saveAppSettings(settings: AppSettings): void;
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
  const apply = (settings: AppSettings) => { deps.setAppSettings(settings); deps.saveAppSettings(settings); };
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
    }, { window: true });
    if (!r.ok) return r;
    apply(r.settings);
    tell('endpoints:changed', { id: r.endpoint.id, needsApproval: false });
    return { ok: true, endpoint: view(r.endpoint.id) };
  });

  ipcMain.handle('endpoints:approve', (_e, id: unknown) => {
    const r = approveEndpoint(deps.getAppSettings(), String(id));
    if (!r.ok) return r;
    apply(r.settings);
    tell('endpoints:changed', { id: r.endpoint.id, needsApproval: false });
    return { ok: true, endpoint: view(r.endpoint.id) };
  });

  ipcMain.handle('endpoints:setKey', (_e, id: unknown, key: unknown) => {
    const r = setEndpointKey(deps.getAppSettings(), String(id), key === null ? null : typeof key === 'string' ? key : '');
    if (!r.ok) return r;
    apply(r.settings);
    return { ok: true };
  });

  ipcMain.handle('endpoints:remove', (_e, id: unknown) => {
    const r = removeEndpoint(deps.getAppSettings(), String(id), [...agents.values()]);
    if (!r.ok) return r;
    apply(r.settings);
    tell('endpoints:changed', { id: String(id), needsApproval: false });
    return { ok: true };
  });

  ipcMain.handle('endpoints:refreshModels', async (_e, id: unknown) => {
    const r = await readModels(deps.getAppSettings(), String(id));
    if (r.settings) apply(r.settings);
    return r.ok ? { ok: true, models: r.models } : { ok: false, error: r.error };
  });

  ipcMain.handle('endpoints:check', async (_e, id: unknown) => {
    const r = await checkHealth(deps.getAppSettings(), String(id));
    apply(r.settings);
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
    if (p.uploadUrl !== undefined) {
      if (typeof p.uploadUrl !== 'string') return { ok: false, error: 'The back-office address is a URL, or empty.' };
      const url = p.uploadUrl.trim() === '' ? '' : cleanBaseUrl(p.uploadUrl);
      if (url === null) return { ok: false, error: 'The back-office address must be http(s), with no credentials, query or fragment.' };
      if (url !== next.uploadUrl) delete next.uploadConsentAt;
      next.uploadUrl = url;
    }
    apply({ ...deps.getAppSettings(), traces: next });
    sweepTraces();
    return { ok: true, settings: next };
  });

  // The harness and model pairs that may be traced: the owner's list, empty as Tars ships, and the closed-model
  // default beside it (trace-gate.ts).
  const pairsView = () => {
    const t = traceSettingsOf(deps.getAppSettings());
    return { pairs: t.pairs, excludeClosedModels: t.excludeClosedModels, closedModelsWarning: CLOSED_MODELS_WARNING };
  };
  const setPairs = (pairs: TraceSettings['pairs']) => {
    apply({ ...deps.getAppSettings(), traces: { ...traceSettingsOf(deps.getAppSettings()), pairs } });
    return { ok: true as const, ...pairsView() };
  };
  const pairOf = (raw: unknown): TraceSettings['pairs'][number] | null => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (typeof o.harness !== 'string' || !o.harness.trim() || typeof o.models !== 'string' || !o.models.trim()) return null;
    return { harness: o.harness.trim().slice(0, 80), models: o.models.trim().slice(0, 200), ...(typeof o.note === 'string' && o.note ? { note: o.note.slice(0, 200) } : {}) };
  };
  const same = (a: { harness: string; models: string }, b: { harness: string; models: string }) => a.harness === b.harness && a.models === b.models;
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
    return setPairs(traceSettingsOf(deps.getAppSettings()).pairs.filter(p => !same(p, pair)));
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
    leaves: [
      'the sessions of the projects and agents you opted in, in full: system prompts, tool definitions, your messages and the agents\', tool calls and their results, thinking the model returned',
      'their timing, token counts, the harness and its version, the model and the endpoint\'s name',
      'who wrote each turn (you, an orchestrator, an agent, a channel) and how the session ended (branch, commit)',
      'an install id, to delete everything this install sent',
    ],
    stays: ['your keys and Tars\'s tokens (masked before upload)', 'sessions of projects and agents not opted in', 'the endpoints\' keys and addresses', 'anything outside traced sessions'],
    scrubbing: {
      version: SCRUB_VERSION,
      catches: ['every secret Tars holds (settings keys, endpoint keys, its own tokens)', 'the values of the project\'s .env files', 'keys by shape (OpenAI, Anthropic, GitHub, Slack, AWS, Google, Stripe, npm, Hugging Face, JWT, private keys)', 'secrets after a telling name (password=, api_key:, "token":)', 'passwords in URLs, Bearer and Basic credentials', 'your home folder, as ~'],
      cannot: ['a secret with no known shape and no telling name that Tars does not hold', 'a secret split in two, encoded, or in an image', 'personal data: names, e-mail addresses, IP addresses', 'what the endpoint itself already received'],
    },
  }));
  ipcMain.handle('traces:preview', (_e, traceId: unknown) => previewUpload(String(traceId)));
  ipcMain.handle('traces:giveUploadConsent', () => {
    const t = traceSettingsOf(deps.getAppSettings());
    if (!t.uploadUrl) return { ok: false, error: 'Set the back-office address first.' };
    const at = new Date().toISOString();
    apply({ ...deps.getAppSettings(), traces: { ...t, uploadConsentAt: at } });
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
    return { offered: d.traced, reason: d.traced ? (projectOptedIn ? 'traced' : 'the project is not opted in') : d.reason, projectOptedIn };
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
  ipcMain.handle('traces:rotateReaderToken', () => ({ token: rotateReaderToken() }));
  ipcMain.handle('traces:revokeReaderToken', () => { revokeReaderToken(); return { ok: true }; });
}
