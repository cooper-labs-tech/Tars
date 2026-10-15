import * as fs from 'fs';
import { agents } from '../core/agent-manager';
import { ptyProcesses, writeProgrammaticInput } from '../core/pty-manager';
import { cliRunningIn } from '../core/agent-pty';
import { launchAgent, sessionStarted } from '../core/agent-launch';
import { transcriptPath, transcriptRoots } from '../utils/resume-session';
import { agentStatusEmitter } from './agent-events';
import { carryNews, owedNews, setQueuesChangedHook } from './agent-watch';
import { carryKanban, owedKanban, setKanbanQueuesChangedHook } from './api-routes/kanban-routes';
import { loadBus } from './bus-store';
import { carryWaitingDeliveries } from './bus-delivery';
import { readCarryOver, startCarryOver } from './carry-over';
import { resumeInterrupted, type ResumeAgent, type ResumeOutcome } from './crash-resume';
import { agentTmpEnvOrNone } from './agent-tmp';
import { endRun, recordResumed, recordRun, type PreviousRun } from './run-state';
import { leaveRunnersAsleep } from './chat-runners';

/**
 * What a run of Tars does so that the next one can recover from it, and what
 * a run does to recover from the last (RD-REDEMARRAGE.md, 2.2 and 2.3; JeanBrasse's
 * yes of 2026-10-05):
 * - the run record follows the working agents, at each change of the fleet and
 *   once a minute, so an abrupt stop is dated within a minute (run-state.ts);
 * - what is owed to agents is kept on disk as it changes, and what the last run
 *   left owed is taken back (carry-over.ts, and the bus journal's waiting rows);
 * - after an abrupt stop, the agents that were working are resumed with a note,
 *   a few at a time, and the agents at rest stay asleep (crash-resume.ts).
 */

const RECORD_EVERY_MS = 60_000;
const RECORD_AFTER_CHANGE_MS = 250;

function transcriptOf(agent: ResumeAgent & { worktreePath?: string; resumableSessionId?: string }, sessionId?: string): string | undefined {
  const id = sessionId ?? agent.resumableSessionId;
  if (!id) return undefined;
  for (const root of transcriptRoots(agent.worktreePath, agent.projectPath)) {
    const file = transcriptPath(root, id);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

/** Types Tars's note into a session already up, and says whether it went in. */
function typeNote(agentId: string, note: string): Promise<boolean> {
  const agent = agents.get(agentId);
  const pty = agent?.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  if (!pty) return Promise.resolve(false);
  return new Promise((resolve) => {
    const outcome = writeProgrammaticInput(pty, note, true, {
      agentId, from: 'Tars', sender: { kind: 'tars' },
      onWritten: () => resolve(true),
      onDropped: () => resolve(false),
    });
    if (outcome === 'refused') resolve(false);
  });
}

export function startRestartRecovery(previous: PreviousRun | null): { flush: () => void; resumed: Promise<ResumeOutcome[]> } {
  // What the last run owed, taken back before anything new is owed.
  const carried = readCarryOver();
  carryNews(carried.notes);
  carryKanban(carried.kanban);
  const writer = startCarryOver({ notes: owedNews, kanban: owedKanban });
  setQueuesChangedHook(writer.changed);
  setKanbanQueuesChangedHook(writer.changed);
  writer.flush();
  loadBus();
  carryWaitingDeliveries();

  // The run record, in step with the fleet.
  const record = () => recordRun(agents.values());
  let soon: ReturnType<typeof setTimeout> | null = null;
  agentStatusEmitter.on('fleet-change', () => {
    if (soon) return;
    soon = setTimeout(() => { soon = null; record(); }, RECORD_AFTER_CHANGE_MS);
    soon.unref?.();
  });
  setInterval(record, RECORD_EVERY_MS).unref?.();
  record();

  let resumed: Promise<ResumeOutcome[]> = Promise.resolve([]);
  if (previous) {
    const stoppedAt = new Date(previous.lastWriteAt).toISOString();
    console.log(`[resume] the last run of Tars stopped abruptly (last heard of at ${stoppedAt}); ${previous.working.length} agent(s) were working`);
    // Chats' runners beyond the RAM's limit stay asleep, their next send
    // resuming them with why (services/chat-runners.ts; the Audit's M5).
    const leftAsleep = leaveRunnersAsleep(previous.working);
    const interrupted = leftAsleep.size ? { ...previous, working: previous.working.filter((w) => !leftAsleep.has(w.agentId)) } : previous;
    if (interrupted.working.length > 0) {
      // Before any launch: if this run stops too while resuming, the next one does not loop.
      if (!interrupted.resumedAndCrashedAgain) recordResumed(interrupted.working.map((w) => w.agentId));
      resumed = resumeInterrupted(interrupted, {
        agent: (id) => agents.get(id),
        fleet: () => agents.values(),
        cliRunning: (a) => cliRunningIn(a.ptyId ? ptyProcesses.get(a.ptyId) : undefined),
        launch: (id, note) => launchAgent(id, note),
        typeNote,
        sessionUp: (id, ms) => {
          const agent = agents.get(id);
          return agent ? sessionStarted(agent, ms) : Promise.resolve(false);
        },
        transcriptOf,
        tmpDirOf: (id) => agentTmpEnvOrNone(id).TMPDIR,
      }).catch((err) => {
        console.error('[resume] the resume failed:', err);
        // Nobody known to be resumed: each one's work in hand is ended.
        return interrupted.working.map((w) => ({ agentId: w.agentId, how: 'failed' as const, why: 'the resume failed' }));
      });
    }
  }

  return { flush: () => { writer.flush(); record(); }, resumed };
}

/** At a quit: what is owed written now, and the run marked as ended cleanly. */
export function endRestartRecovery(handle: { flush: () => void } | null): void {
  handle?.flush();
  endRun();
}
