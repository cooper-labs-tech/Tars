import type { AgentStatus } from '../types';
import { labelledContainers, readBornProcesses, type BornProcess } from '../core/born-processes';
import { redactCommandLine } from '../utils/redact-command-line';
import type { NoteDelivery } from './error-triage';

/**
 * What an agent started that outlives its session: recorded on its record, and said once to its project's
 * orchestrator an hour on; never ended by Tars (2.0.5, the owner's lot 2 of 28/10). kotsna's 5 dev servers (14
 * processes) ran 10 days with no session, and nobody knew. The owner's limits: an ansible run, a `fly ssh` or a
 * build talking to the Sparks may be among them, so nothing here signals anything; a stop, which someone asks
 * for, ends what its agent started (core/born-processes.ts, agent-stop.ts).
 *
 * An agent with no live session: stopped, asleep, or whose CLI is gone from its terminal. With one, what it runs
 * is its work. Read every WATCH_EVERY_MS: one read of the birth tags (about 0.2 s on macOS, a walk of /proc on
 * Linux, nothing on Windows) and one `docker ps` when docker answers.
 */

export const REPORT_AFTER_MS = 60 * 60_000;
export const WATCH_EVERY_MS = 10 * 60_000;
const COMMAND_CHARS = 120;

export interface BornWatchDeps {
  fleet: () => Iterable<AgentStatus>;
  read: () => Promise<BornProcess[] | undefined>;
  containers: () => Promise<Array<{ id: string; agentId: string; name: string }> | undefined>;
  hasSession: (agent: AgentStatus) => boolean;
  tell: (projectPath: string, message: string) => Promise<NoteDelivery>;
  save: () => void;
}

function noteOf(agent: AgentStatus, left: NonNullable<AgentStatus['leftRunning']>): string {
  const what = [...left.commands, ...left.containers.map(c => `container ${c}`)].join('; ');
  return `${agent.name || agent.id} has no live session, and what it started has been running without one since ${left.since}: ${what}. `
    + 'Tars ends none of it by itself. Stop each by its PID (or the container by its id) if it is no longer needed, or start the agent again to look after it.';
}

/** One pass over the fleet. Exported for its tests; startBornWatch runs it. */
export async function bornWatchPass(now: number, deps: BornWatchDeps): Promise<void> {
  const [born, containers] = await Promise.all([deps.read(), deps.containers()]);
  let changed = false;
  for (const agent of deps.fleet()) {
    const mine = deps.hasSession(agent) ? [] : (born ?? []).filter(p => p.agentId === agent.id);
    const boxes = deps.hasSession(agent) ? [] : (containers ?? []).filter(c => c.agentId === agent.id);
    if (mine.length === 0 && boxes.length === 0) {
      if (agent.leftRunning) { agent.leftRunning = undefined; changed = true; }
      continue;
    }
    const before = agent.leftRunning;
    const left: NonNullable<AgentStatus['leftRunning']> = {
      pids: mine.map(p => p.pid),
      // The window's rule, as a stop's lines (core/born-processes.ts's describeBorn): the record and the note follow it.
      commands: mine.map(p => `pid ${p.pid}: ${redactCommandLine(p.command).replace(/\s+/g, ' ').slice(0, COMMAND_CHARS)}`),
      containers: boxes.map(c => `${c.name} (${c.id})`),
      since: before?.since ?? new Date(now).toISOString(),
      ...(before?.reportedAt ? { reportedAt: before.reportedAt } : {}),
    };
    if (JSON.stringify(left) !== JSON.stringify(before)) { agent.leftRunning = left; changed = true; }
    if (!left.reportedAt && now - Date.parse(left.since) >= REPORT_AFTER_MS && agent.projectPath) {
      const delivery = await deps.tell(agent.projectPath, noteOf(agent, left));
      if (delivery === 'typed') { left.reportedAt = new Date(now).toISOString(); agent.leftRunning = left; changed = true; }
    }
  }
  if (changed) deps.save();
}

let timer: ReturnType<typeof setInterval> | undefined;

export function startBornWatch(deps: Omit<BornWatchDeps, 'read' | 'containers'>): void {
  if (timer) return;
  const full: BornWatchDeps = { ...deps, read: () => readBornProcesses(), containers: () => labelledContainers() };
  timer = setInterval(() => {
    bornWatchPass(Date.now(), full).catch((err) => console.warn('[born-watch] pass failed:', err));
  }, WATCH_EVERY_MS);
  timer.unref?.();
}

export function stopBornWatch(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
