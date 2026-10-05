import * as path from 'path';
import { agents } from '../core/agent-manager';
import { broadcastToAllWindows } from './broadcast';
import { extractStatusLine } from './ansi';
import { ptyProcesses } from '../core/pty-manager';
import { cliRunningIn } from '../core/agent-pty';
import { leftFullscreenIn } from '../core/terminal-mirror';
import { launchesPending, sessionStarting, setLaunchListener } from '../core/agent-launch';
import { publishedWaitingOn } from './waiting-on';
import { publishedWaking } from '../core/agent-asleep';
import type { AgentStatus, AgentWaitingOn, AgentWaking } from '../types';

export type DisplayStatus = 'working' | 'waiting' | 'done' | 'ready' | 'stopped' | 'error' | 'asleep' | 'waking';

export interface AgentTickItem {
  id: string;
  name: string;
  character: string;
  status: AgentStatus['status'];
  displayStatus: DisplayStatus;
  statusLine: string;
  currentTask: string;
  projectName: string;
  lastActivity: string;
  /** When the current status began. See AgentStatus.statusSince. */
  statusSince?: string;
  /** What a waiting agent waits on. See AgentStatus.waitingOn. */
  waitingOn?: AgentWaitingOn;
  provider: string;
  /** A CLI runs in the agent's PTY, whatever its status says. See cliRunningIn. */
  cliRunning: boolean;
  /** The CLI repaints inline on an alternate screen it never left, so the
   *  wheel reaches nothing. See RepaintWatch in core/terminal-mirror.ts. */
  leftFullscreen: boolean;
  /** A launch is on its way and its session is not up yet (sessionStarting). */
  launching: boolean;
  /** Since when it is asleep. See AgentStatus.asleepSince. */
  asleepSince?: string;
  /** Who woke it and how, while its CLI comes back. See AgentStatus.waking. */
  waking?: AgentWaking;
}

let tickTimer: ReturnType<typeof setTimeout> | null = null;

// Callback set by tray-manager for attention badge updates
let trayAttentionCallback: ((hasWaiting: boolean) => void) | null = null;

export function setTrayAttentionCallback(cb: (hasWaiting: boolean) => void): void {
  trayAttentionCallback = cb;
}

export function scheduleTick(): void {
  if (tickTimer) return;
  tickTimer = setTimeout(() => {
    tickTimer = null;
    const payload = buildTickPayload();
    const statuses = payload.map(a => `${a.name}:${a.displayStatus}`).join(', ');
    console.log(`[tick] Broadcasting ${payload.length} agents: ${statuses}`);
    broadcastToAllWindows('agents:tick', payload);

    // Update tray attention badge
    if (trayAttentionCallback) {
      const hasWaiting = payload.some(a => a.displayStatus === 'waiting');
      trayAttentionCallback(hasWaiting);
    }
  }, 500);
}

function deriveDisplayStatus(a: AgentStatus, waking: AgentWaking | undefined): DisplayStatus {
  if (waking) return 'waking';
  if (a.status === 'asleep') return 'asleep';
  if (a.status === 'running') return 'working';
  if (a.status === 'waiting') return 'waiting';
  if (a.status === 'completed') return 'done';
  if (a.status === 'error') return 'error';
  // idle: check if PTY exists
  if (a.ptyId && ptyProcesses.has(a.ptyId)) return 'ready';
  return 'stopped';
}

/** Whether a CLI runs in this agent's PTY, if it has one. */
function agentCliRunning(a: AgentStatus): boolean {
  return cliRunningIn(a.ptyId ? ptyProcesses.get(a.ptyId) : undefined);
}

function buildTickPayload(): AgentTickItem[] {
  return Array.from(agents.values())
    .map(a => {
      const launching = sessionStarting(a);
      const waking = publishedWaking(a, launching);
      return {
        id: a.id,
        name: a.name || `Agent ${a.id.slice(0, 6)}`,
        character: a.character || 'robot',
        status: a.status,
        displayStatus: deriveDisplayStatus(a, waking),
        statusLine: (a as AgentStatus & { statusLine?: string }).statusLine || '',
        currentTask: a.currentTask || '',
        projectName: a.projectPath ? path.basename(a.projectPath) : '',
        lastActivity: a.lastActivity,
        statusSince: a.statusSince,
        waitingOn: publishedWaitingOn(a),
        provider: a.provider || 'claude',
        cliRunning: agentCliRunning(a),
        launching,
        asleepSince: a.asleepSince,
        waking,
        leftFullscreen: leftFullscreenIn(a.ptyId ? ptyProcesses.get(a.ptyId) : undefined),
      };
    })
    .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
}

/**
 * A launch that begins or ends is news for the page (`launching`) even when no
 * status moves with it: a restart keeps `idle`, and a launch given up after
 * CLI_BOOT_MS ends by itself. So a tick goes out when one begins or is
 * abandoned, and the window is looked at every second while any is open, for
 * one that closed by itself (sessionStarting drops it when its session is up
 * or it timed out). Nothing is polled while no launch is under way.
 */
let launchPoll: ReturnType<typeof setInterval> | null = null;

function watchLaunches(): void {
  scheduleTick();
  if (launchPoll) return;
  launchPoll = setInterval(() => {
    let ended = false;
    for (const id of launchesPending()) {
      const agent = agents.get(id);
      if (!agent || !sessionStarting(agent)) ended = true;
    }
    if (ended) scheduleTick();
    if (launchesPending().length === 0 && launchPoll) {
      clearInterval(launchPoll);
      launchPoll = null;
    }
  }, 1000);
}

setLaunchListener(watchLaunches);
