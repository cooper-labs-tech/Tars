import * as fs from 'fs';
import { app, powerMonitor, screen } from 'electron';
import { agents, saveAgents } from '../core/agent-manager';
import { ptyProcesses } from '../core/pty-manager';
import { cliRunningIn } from '../core/agent-pty';
import { hasClaudeHooks, hasEndOfTurn } from '../core/end-of-turn';
import { oneTaskQueue } from '../core/one-task';
import { stopAgent } from '../core/agent-stop';
import { launchAgent } from '../core/agent-launch';
import { pendingBackgroundWork } from './agent-truth';
import { agentStatusEmitter } from './agent-events';
import { announceTask } from './task-banner';
import { broadcastToAllWindows } from '../utils/broadcast';
import { scheduleTick } from '../utils/agents-tick';
import { createFleetOperations, setFleetOperations, FLEET_FILE, type FleetAgent, type FleetOperations } from './fleet-operations';
import { ioregClamshell, readPower, systemFiles } from './power-state';
import type { AgentStatus, KeepAwakeMode } from '../types';
import type { KeepAwakeState } from './keep-awake';

/**
 * A project's hours and its cap (services/fleet-operations.ts) on the live app: the fleet, its queues, the stop and the
 * launch the window uses, and the computer's power. One look every 30 s and at every change of the fleet (a turn that
 * ends is what a waiting stop waits for); the window is told `fleet:changed` with every project's hours, cap and window.
 *
 * Two clocks for the e2e only, never in a packaged build, in the style of CLAUDE.md's others:
 * - DOROTHY_SCHEDULE_EVERY_MS, under DOROTHY_E2E: how often the hours are looked at (200 ms at least; else 30 s).
 * - DOROTHY_E2E_CLOCK_FILE, under DOROTHY_E2E: a file holding an ISO instant, read as now by the hours alone, so a spec
 *   moves a night forward in a second; missing or unreadable, the real clock.
 */

const e2e = () => process.env.DOROTHY_E2E === '1' && !app.isPackaged;

function everyMs(): number {
  const asked = Number(process.env.DOROTHY_SCHEDULE_EVERY_MS);
  return e2e() && process.env.DOROTHY_SCHEDULE_EVERY_MS?.trim() && Number.isFinite(asked) && asked >= 200 ? asked : 30_000;
}

function clock(): () => number {
  const file = e2e() ? process.env.DOROTHY_E2E_CLOCK_FILE?.trim() : undefined;
  if (!file) return Date.now;
  return () => {
    try {
      const t = Date.parse(fs.readFileSync(file, 'utf8').trim());
      return Number.isFinite(t) ? t : Date.now();
    } catch {
      return Date.now();
    }
  };
}

/**
 * At work, for a stop: a task Tars is handing it, a turn or a dialog in its terminal (the stall watch's word ignored: a
 * frozen turn is still one a stop would cut), or, for claude, background work it left that has not reported back.
 */
function atWork(a: AgentStatus, cliUp: boolean): boolean {
  if (oneTaskQueue.busyRun(a.id)) return true;
  if (!cliUp) return false;
  if (a.status === 'running' || (a.status === 'waiting' && a.waitingReason !== 'idle')) return true;
  if (!hasClaudeHooks(a)) return false;
  try {
    const since = a.sessionRegisteredAt ? Date.parse(a.sessionRegisteredAt) : 0;
    return pendingBackgroundWork(a, Number.isFinite(since) ? since : 0).length > 0;
  } catch {
    return false;
  }
}

function fleetAgentOf(a: AgentStatus): FleetAgent {
  const cliUp = cliRunningIn(a.ptyId ? ptyProcesses.get(a.ptyId) : undefined);
  return {
    id: a.id, name: a.name || a.id, projectPath: a.projectPath, status: a.status,
    atWork: atWork(a, cliUp), endOfTurn: hasEndOfTurn(a), cliUp, queued: oneTaskQueue.queued(a.id).length,
    ...(a.stoppedBy ? { stoppedBy: a.stoppedBy } : {}), ...(a.stoppedAt ? { stoppedAt: a.stoppedAt } : {}),
  };
}

function announce(agent: AgentStatus): void {
  broadcastToAllWindows('agent:status', { type: 'status', agentId: agent.id, status: agent.status, timestamp: agent.lastActivity });
  scheduleTick();
}

export function startFleetOperations(keepAwake: { sync(): KeepAwakeState; state(): KeepAwakeState }): FleetOperations {
  // `changed` reads `ops`: it is never called while the engine is being made.
  const ops: FleetOperations = createFleetOperations({
    file: FLEET_FILE(),
    now: clock(),
    agents: () => [...agents.values()].map(fleetAgentOf),
    queue: {
      pausedOf: (id) => oneTaskQueue.pausedOf(id),
      pause: (id, why) => { oneTaskQueue.pause(id, why); announceTask(id); },
      resume: (id) => { oneTaskQueue.resume(id); announceTask(id); },
    },
    stop: async (id, reason) => {
      const agent = agents.get(id);
      if (!agent) return undefined;
      return (await stopAgent(agent, { by: 'Tars', reason }, { save: saveAgents, announce })) ? agent.stoppedAt : undefined;
    },
    start: async (id) => {
      const r = await launchAgent(id, '', {});
      return r.success ? { ok: true } : { ok: false, error: r.error };
    },
    power: () => readPower({
      platform: process.platform,
      onBattery: () => powerMonitor.isOnBatteryPower(),
      displays: () => screen.getAllDisplays(),
      ioreg: ioregClamshell,
      ...systemFiles,
    }),
    keepAwake: () => {
      const s = keepAwake.state();
      return { mode: s.mode as KeepAwakeMode, ...(s.refused ? { refused: true as const } : {}) };
    },
    changed: () => {
      keepAwake.sync();
      broadcastToAllWindows('fleet:changed', { projects: ops.views() });
    },
  });
  setFleetOperations(ops);

  let soon: ReturnType<typeof setTimeout> | undefined;
  agentStatusEmitter.on('fleet-change', () => {
    soon ??= setTimeout(() => { soon = undefined; void ops.tick(); }, 250);
    soon.unref?.();
  });
  setInterval(() => void ops.tick(), everyMs()).unref?.();
  powerMonitor.on('suspend', () => ops.noteSuspend());
  powerMonitor.on('resume', () => { ops.noteResume(); void ops.tick(); });
  void ops.tick().then(() => keepAwake.sync());
  return ops;
}
