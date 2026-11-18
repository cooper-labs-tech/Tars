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
import { defaultTracePairs } from '../services/trace-gate';

/** Said with the list, so the window can show it: the rule no pair can open. */
export const HARD_RULE = 'A Claude, GPT, o-series or Gemini model is never traced, whatever the list says.';

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
  return { project: str('project'), agentId: str('agentId'), harness: str('harness'), model: str('model'), endpointId: str('endpointId'), from: num('from'), to: num('to'), cursor: str('cursor'), limit: num('limit') };
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
    apply({ ...deps.getAppSettings(), traces: next });
    sweepTraces();
    return { ok: true, settings: next };
  });

  // The harness and model pairs that may be traced: the owner's list, behind the hard rule in code (trace-gate.ts).
  const pairsView = () => ({ pairs: traceSettingsOf(deps.getAppSettings()).pairs, hardRule: HARD_RULE });
  const setPairs = (pairs: TraceSettings['pairs']) => {
    apply({ ...deps.getAppSettings(), traces: { ...traceSettingsOf(deps.getAppSettings()), pairs } });
    return { ok: true as const, ...pairsView() };
  };
  const pairOf = (raw: unknown): TraceSettings['pairs'][number] | null => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (typeof o.harness !== 'string' || !o.harness.trim() || typeof o.models !== 'string' || !o.models.trim()) return null;
    return { harness: o.harness.trim(), models: o.models.trim(), ...(typeof o.note === 'string' && o.note ? { note: o.note } : {}) };
  };
  ipcMain.handle('traces:pairs', () => pairsView());
  ipcMain.handle('traces:addPair', (_e, raw: unknown) => {
    const pair = pairOf(raw);
    if (!pair) return { ok: false, error: 'A pair is a harness (or *) and a model glob (or *).' };
    const pairs = traceSettingsOf(deps.getAppSettings()).pairs;
    if (pairs.some(p => p.harness === pair.harness && p.models === pair.models)) return { ok: true, ...pairsView() };
    return setPairs([...pairs, pair]);
  });
  ipcMain.handle('traces:removePair', (_e, raw: unknown) => {
    const pair = pairOf(raw);
    if (!pair) return { ok: false, error: 'A pair is a harness and a model glob.' };
    return setPairs(traceSettingsOf(deps.getAppSettings()).pairs.filter(p => !(p.harness === pair.harness && p.models === pair.models)));
  });
  // A vetted list from outside Tars is not there yet: the seed is the four open harnesses until it is.
  ipcMain.handle('traces:reseedPairs', () => setPairs(defaultTracePairs()));

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
    const { raw: _raw, ...shown } = r;
    return shown;
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
