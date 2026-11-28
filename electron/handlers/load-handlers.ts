import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { execFile } from 'child_process';
import * as path from 'path';
import { DATA_DIR, privatePath } from '../constants';
import type { AgentProvider, AgentStatus, AppSettings } from '../types';
import { broadcastToAllWindows } from '../utils/broadcast';
import { createAgent } from '../core/agent-create';
import { launchAgent } from '../core/agent-launch';
import { stopAgent } from '../core/agent-stop';
import { agentStatusEmitter, emitAgentStatus } from '../services/agent-events';
import { createLoadEngine } from '../services/load-engine';
import { endpointsOf } from '../services/inference-endpoints';
import { updateRun } from '../services/load-run-record';
import { safeGit } from '../utils/safe-git';
import { buildFullPath } from '../utils/path-builder';
import { traceSettingsOf } from '../services/traces-runtime';
import { emptyAgentTmp } from '../services/agent-tmp';
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
  /** Writes the fleet to disk (agents.json): a load agent's worktree is set and cleared through it. */
  saveAgents?(): void;
  /** Tests only: where the pools, runs, grants, approvals and the engine's state live, and the clock. */
  dirs?: { pools: string; runs: string; grants: string; approved: string; setAside: string; state?: string };
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
/** The registered engine's recovery, for the watch main.ts starts. */
let recoverLoad: (() => Promise<void>) | undefined;

/**
 * Reads the state every 5 s and tells the window when it changed (a pool written, a window's end), after the engine's
 * recovery of what a quit or a crash left (load-engine.ts recover). Started by main.ts with the app's other watches,
 * never by the registration, so a test that registers the handlers runs no timer and recovers nothing.
 */
export function startLoadWatch(): () => void {
  void recoverLoad?.().catch(err => console.error(`[load] the recovery at start failed: ${(err as Error).message}`));
  const timer = setInterval(() => tellWindow?.(), POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function registerLoadHandlers(deps: LoadHandlerDeps): { window: LoadWindow; dispose(): void } {
  const dirs = deps.dirs ?? {
    pools: path.join(DATA_DIR, 'load-pools'), runs: path.join(DATA_DIR, 'load-runs'), grants: LOAD_GRANTS_FILE, approved: privatePath('load-approved.json'),
    setAside: privatePath('load-set-aside.json'),
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
    poolsDir: dirs.pools, runsDir: dirs.runs, approvedFile: dirs.approved, setAsideFile: dirs.setAside,
    projects: deps.projects,
    grants: () => readGrants(dirs.grants),
    tracedProjects: () => traceSettingsOf(deps.getAppSettings()).projects,
    // The endpoints Tars knows, as the rest of Tars reads them (an id of their shape): a grant names one an agent can run on.
    endpoints: () => endpointsOf(deps.getAppSettings()).map(e => ({
      id: e.id, name: e.name, baseUrl: e.baseUrl, approved: e.approved === true, models: e.models ?? [], ...(e.approvedBaseUrl ? { approvedBaseUrl: e.approvedBaseUrl } : {}),
    })),
    loadAgents: () => [...deps.agents.values()].filter(a => a.load === true).map(a => ({
      id: a.id, name: a.name ?? '', projectPath: a.projectPath, provider: String(a.provider ?? ''),
      ...(a.endpointId ? { endpointId: a.endpointId } : {}), ...(a.model ? { model: a.model } : {}),
    })),
    git: (cwd, args) => safeGit(cwd, args, { timeout: 10_000 }).then(r => r.stdout),
    gh,
    now: deps.now ?? Date.now,
    emit: tell,
    startRun: (run, planned) => { startEngine(run.runId, planned).catch(err => console.error(`[load] ${run.runId} not started: ${(err as Error).message}`)); },
    // The card's live progress: the engine's own, never the log (the Audit's Infos on #685).
    progress: runId => engine.progress(runId),
    stopRun: (runId) => { void engine.stop(runId); },
  };
  const window = createLoadWindow(windowDeps);

  const save = () => deps.saveAgents?.();
  const announce = (a: AgentStatus) => {
    broadcastToAllWindows('agent:status', { type: 'status', agentId: a.id, status: a.status, timestamp: new Date().toISOString() });
    emitAgentStatus(a.id);
  };
  const engine = createLoadEngine({
    now: deps.now ?? Date.now,
    setTimer: (fn, ms) => setTimeout(fn, Math.max(0, ms)),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    stateFile: dirs.state ?? privatePath('load-run-state.json'),
    plan: runId => window.runPlan(runId),
    isRunning: runId => window.isRunning(runId),
    endRun: (runId, stopped) => window.endRun(runId, stopped),
    grantHarnesses: project => readGrants(dirs.grants).find(g => g.path === project)?.harnesses ?? [],
    // Where the owner's grant runs the project's load agents, from the private file at each read (the Audit's M1 on #691).
    grantTarget: (project) => {
      const g = readGrants(dirs.grants).find(x => x.path === project);
      return g ? { endpointId: g.endpointId ?? null, model: g.model ?? null } : undefined;
    },
    loadAgents: () => [...deps.agents.values()].filter(a => a.load === true)
      .map(a => ({ id: a.id, name: a.name ?? a.id, projectPath: a.projectPath, provider: String(a.provider ?? ''), status: a.status, endpointId: a.endpointId ?? null, model: a.model ?? null })),
    // The busy cap's seam, shaped like #593's capVerdict (core/project-cap.ts): every arrival allowed until it lands.
    busyCap: () => ({ ok: true }),
    git: (cwd, args) => safeGit(cwd, args, { timeout: 60_000 }).then(r => r.stdout),
    // Its worktree, and an emptied TMPDIR: nothing an earlier session left there (services/load-session.ts). A TMPDIR
    // that cannot be emptied throws, and the engine starts no session (load-engine.ts).
    prepare: (agentId, worktreePath) => {
      const a = deps.agents.get(agentId);
      if (!a) throw new Error('the load agent is gone');
      a.worktreePath = worktreePath;
      save();
      emptyAgentTmp(agentId);
    },
    release: (agentId) => { const a = deps.agents.get(agentId); if (a && a.worktreePath) { delete a.worktreePath; save(); } },
    launch: async (agentId, prompt) => {
      const r = await launchAgent(agentId, prompt, { resumeSessionId: null });
      return r.success ? { ok: true } : { ok: false, error: r.error };
    },
    stopSession: async (agentId) => {
      const a = deps.agents.get(agentId);
      if (a) await stopAgent(a, { by: 'Tars', reason: 'its load task ended' }, { save, announce });
    },
    statusOf: agentId => deps.agents.get(agentId)?.status,
    onStatus: (fn) => { agentStatusEmitter.on('fleet-change', fn); return () => { agentStatusEmitter.off('fleet-change', fn); }; },
    logArrival: (runId, arrival) => {
      try {
        updateRun(dirs.runs, runId, r => ({ ...r, arrivals: [...r.arrivals.filter(x => x.n !== arrival.n), arrival].sort((x, y) => x.n - y.n) }));
      } catch (err) {
        console.error(`[load] the log of ${runId} not written: ${(err as Error).message}`);
      }
      tell();
    },
  });

  /** An approved run: the load agents its proposal planned made where missing, through the one creation, then armed. */
  async function startEngine(runId: string, planned: Array<{ name: string; project: string; harness: string; existing: boolean }>): Promise<void> {
    for (const p of planned.filter(x => !x.existing)) {
      const grant = readGrants(dirs.grants).find(g => g.path === p.project);
      if (!grant?.endpointId || !grant.model) continue;
      try {
        await createAgent({
          projectPath: p.project, skills: [], name: p.name, provider: p.harness as AgentProvider, model: grant.model, endpointId: grant.endpointId,
          traces: true, load: true, permissionMode: 'bypass', character: 'robot',
        });
      } catch (err) {
        console.error(`[load] ${p.name} of ${p.project} not made: ${(err as Error).message}`);
      }
    }
    engine.start(runId);
  }
  recoverLoad = () => engine.recover(window.unstoppedRunIds());

  /** The owner's click: the main window's own frame, nothing else. */
  const fromWindow = (e: IpcMainInvokeEvent): boolean => {
    const win = deps.getMainWindow();
    // Its top frame too: a subframe shares the window's web contents (the Audit's I-1 at fdd82ca3d).
    return !!win && !win.isDestroyed() && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame;
  };
  const refused = { ok: false as const, error: 'only your click in Tars\'s window does this' };

  ipcMain.handle('load:state', () => window.refresh());
  ipcMain.handle('load:approve', (e, input: unknown) => (fromWindow(e) ? window.approve((input ?? {}) as Record<string, unknown>) : refused));
  ipcMain.handle('load:notNow', (e, input: unknown) => (fromWindow(e) ? window.notNow((input ?? {}) as Record<string, unknown>) : refused));
  ipcMain.handle('load:stop', (e, runId: unknown) => (fromWindow(e) ? window.stop(runId) : refused));
  ipcMain.handle('load:projects', () => window.projects());
  // A project's settings as the Projects view sets them, kept whether its switch is on or off; the switch kept on only
  // when the project can then run. Answered with the project as the view now shows it.
  ipcMain.handle('load:grant', async (e, input: unknown) => {
    if (!fromWindow(e)) return refused;
    const asked = (input ?? {}) as { path?: unknown; remove?: unknown };
    try {
      if (asked.remove === true && typeof asked.path === 'string') {
        writeGrant({ path: asked.path, remove: true }, dirs.grants);
      } else {
        const grant = checkGrant(input, { projects: deps.projects(), endpoints: windowDeps.endpoints() });
        if (typeof grant === 'string') return { ok: false, error: grant };
        writeGrant(await window.settle(grant), dirs.grants);
      }
    } catch (err) {
      return { ok: false, error: `Tars could not save the grant: ${(err as Error).message}` };
    }
    tell();
    return { ok: true, project: await window.project(asked.path as string) };
  });

  tellWindow = tell;
  return {
    window,
    dispose: () => {
      if (tellWindow === tell) tellWindow = undefined;
      for (const channel of ['load:state', 'load:approve', 'load:notNow', 'load:stop', 'load:projects', 'load:grant']) ipcMain.removeHandler(channel);
    },
  };
}
