import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { execFile } from 'child_process';
import * as path from 'path';
import { DATA_DIR, privatePath } from '../constants';
import type { AgentStatus, AppSettings } from '../types';
import { safeGit } from '../utils/safe-git';
import { buildFullPath } from '../utils/path-builder';
import { traceSettingsOf } from '../services/traces-runtime';
import { createLoadWindow, type LoadWindow, type LoadWindowDeps } from '../services/load-window';
import { checkGrant, readGrants, writeGrant, LOAD_GRANTS_FILE } from '../services/load-grants';

/**
 * The load window's IPC (trace feature C3, 27/11), and the only way into its approval and the owner's grants.
 *
 * `load:approve`, `load:grant`, `load:notNow` and `load:stop` are handled here alone, and each is refused unless it
 * comes from Tars's main window: the owner's click. No API route, MCP tool, agent token or message reaches them, and
 * nothing else in the main process holds the window's runtime (load-approval-boundary.test.ts proves both). The
 * window reads the state with `load:state` and is told of a change on `load:changed`.
 */

export interface LoadHandlerDeps {
  getAppSettings(): AppSettings;
  agents: Map<string, AgentStatus>;
  getMainWindow(): BrowserWindow | null;
  /** Tars's projects (review-handlers.ts knownProjects). */
  projects(): string[];
  /** Tests only: where the pools, runs, grants and approvals live, and the clock. */
  dirs?: { pools: string; runs: string; grants: string; approved: string };
  now?: () => number;
}

/** gh, read-only: an E2E's stand-in under DOROTHY_E2E in a build that is not packaged, else gh where a shell finds it. */
function ghCommand(): string {
  const asked = process.env.DOROTHY_E2E_GH;
  return process.env.DOROTHY_E2E === '1' && !app.isPackaged && asked && path.isAbsolute(asked) ? asked : 'gh';
}

function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ghCommand(), args, { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, PATH: buildFullPath() } },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

const POLL_MS = 5000;

/** The registered window's way to tell it the state, for the watch main.ts starts. */
let tellWindow: (() => void) | undefined;

/**
 * Reads the state every 5 s and tells the window when it changed (a pool written, a window's end). Started by main.ts
 * with the app's other watches, never by the registration, so a test that registers the handlers runs no timer.
 */
export function startLoadWatch(): () => void {
  const timer = setInterval(() => tellWindow?.(), POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function registerLoadHandlers(deps: LoadHandlerDeps): { window: LoadWindow; dispose(): void } {
  const dirs = deps.dirs ?? {
    pools: path.join(DATA_DIR, 'load-pools'), runs: path.join(DATA_DIR, 'load-runs'), grants: LOAD_GRANTS_FILE, approved: privatePath('load-approved.json'),
  };
  let lastSent = '';
  const send = (state: unknown) => {
    const text = JSON.stringify(state);
    if (text === lastSent) return;
    lastSent = text;
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('load:changed', state);
  };
  const tell = () => { void window.refresh().then(send, err => console.error(`[load] the state not read: ${(err as Error).message}`)); };
  const windowDeps: LoadWindowDeps = {
    poolsDir: dirs.pools, runsDir: dirs.runs, approvedFile: dirs.approved,
    grants: () => readGrants(dirs.grants),
    tracedProjects: () => traceSettingsOf(deps.getAppSettings()).projects,
    endpoints: () => (deps.getAppSettings().inferenceEndpoints ?? []).map(e => ({ id: e.id, name: e.name, baseUrl: e.baseUrl, ...(e.approvedBaseUrl ? { approvedBaseUrl: e.approvedBaseUrl } : {}) })),
    loadAgents: () => [...deps.agents.values()].filter(a => a.load === true).map(a => ({ id: a.id, name: a.name ?? '', projectPath: a.projectPath, provider: String(a.provider ?? '') })),
    git: (cwd, args) => safeGit(cwd, args, { timeout: 10_000 }).then(r => r.stdout),
    gh,
    now: deps.now ?? Date.now,
    emit: tell,
  };
  const window = createLoadWindow(windowDeps);

  /** The owner's click: the main window's own frame, nothing else. */
  const fromWindow = (e: IpcMainInvokeEvent): boolean => {
    const win = deps.getMainWindow();
    return !!win && !win.isDestroyed() && e.sender === win.webContents;
  };
  const refused = { ok: false as const, error: 'only your click in Tars\'s window does this' };

  ipcMain.handle('load:state', () => window.refresh());
  ipcMain.handle('load:approve', (e, input: unknown) => (fromWindow(e) ? window.approve((input ?? {}) as Record<string, unknown>) : refused));
  ipcMain.handle('load:notNow', (e, input: unknown) => (fromWindow(e) ? window.notNow((input ?? {}) as Record<string, unknown>) : refused));
  ipcMain.handle('load:stop', (e, runId: unknown) => (fromWindow(e) ? window.stop(runId) : refused));
  ipcMain.handle('load:grants', () => readGrants(dirs.grants));
  ipcMain.handle('load:grant', (e, input: unknown) => {
    if (!fromWindow(e)) return refused;
    const asked = (input ?? {}) as { path?: unknown; remove?: unknown };
    try {
      if (asked.remove === true && typeof asked.path === 'string') {
        writeGrant({ path: asked.path, remove: true }, dirs.grants);
      } else {
        const grant = checkGrant(input, { projects: deps.projects(), endpoints: deps.getAppSettings().inferenceEndpoints ?? [] });
        if (typeof grant === 'string') return { ok: false, error: grant };
        writeGrant(grant, dirs.grants);
      }
    } catch (err) {
      return { ok: false, error: `Tars could not save the grant: ${(err as Error).message}` };
    }
    tell();
    return { ok: true, grants: readGrants(dirs.grants) };
  });

  tellWindow = tell;
  return {
    window,
    dispose: () => {
      if (tellWindow === tell) tellWindow = undefined;
      for (const channel of ['load:state', 'load:approve', 'load:notNow', 'load:stop', 'load:grants', 'load:grant']) ipcMain.removeHandler(channel);
    },
  };
}
