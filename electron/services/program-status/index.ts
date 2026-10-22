import type { AgentStatus } from '../../types';
import { hasEndOfTurn } from '../../core/end-of-turn';
import { createProgramStatusOscScanner } from './osc-scanner';
import { PROGRAM_STATUS_QUERY_REPLY, type ProgramStatusReport } from './protocol';

/**
 * The Program Status Protocol (OSC 7501, revision 0.4) in an agent's terminal, read in the main process as the
 * bytes arrive, before the window's xterm sees them.
 *
 * Measured on 22/10: claude 2.1.308 sends `OSC 7501 ; ?` then a DA1 query when it starts, and reports only if the
 * probe is answered before the DA1 answer (the window's xterm gives that one, later): it then says
 * `state=idle:app=claude-code`. codex 0.163 reports without asking. The reply goes from here, into the PTY, as soon
 * as the chunk holding the probe is read.
 *
 * Precedence (the brief of 22/10): the hooks win, and OSC 7501 fills the gaps.
 * - Only the agent's current terminal counts (the session-ownership rule): a report from a terminal that is no
 *   longer the agent's, after a restart, moves nothing and is not kept.
 * - Only the root record is the agent's; a report addressed to an id is a sub-task's.
 * - A CLI Tars follows otherwise (claude's hooks, codex's and pi's session logs) keeps its status from them: the
 *   report is only kept, for the window, with the reason of a blocked state.
 * - A CLI Tars cannot follow otherwise (amp, grok, opencode) gets its status from the reports. A blocked report is
 *   `waiting` with the reason `permission`, which keeps anything from being typed into it, whatever its kind.
 * - A stopped or an asleep agent is never moved: its terminal speaking is not a start.
 */

const scanners = new Map<string, ReturnType<typeof createProgramStatusOscScanner>>();

/** Reads one chunk of an agent terminal's output. True when it moved the agent's status. */
export function readProgramStatus(agent: AgentStatus | undefined, ptyId: string, terminal: { write(data: string): void }, data: string): boolean {
  let scan = scanners.get(ptyId);
  if (!scan) {
    // The fast path costs one check for ESC per chunk, so a terminal that never speaks 7501 costs nothing more.
    if (!data.includes('\x1b')) return false;
    scan = createProgramStatusOscScanner();
    scanners.set(ptyId, scan);
  }
  let moved = false;
  for (const event of scan(data)) {
    if (event.type === 'query') {
      // Answered whoever the terminal belongs to: the CLI waits on it, and a late answer is no answer.
      terminal.write(PROGRAM_STATUS_QUERY_REPLY);
      continue;
    }
    if (!agent || agent.ptyId !== ptyId) continue;
    if (event.type === 'prompt-start' || event.type === 'full-reset') {
      agent.programStatus = undefined;
      continue;
    }
    if (event.report.id !== null) continue;
    moved = apply(agent, event.report) || moved;
  }
  return moved;
}

/** A terminal that ended: its half-read frame goes with it. */
export function forgetProgramStatus(ptyId: string): void {
  scanners.delete(ptyId);
}

function apply(agent: AgentStatus, report: ProgramStatusReport): boolean {
  if (report.state === 'clear') {
    agent.programStatus = undefined;
    return false;
  }
  agent.programStatus = {
    state: report.state,
    ...(report.kind ? { kind: report.kind } : {}),
    ...(report.msg ? { msg: report.msg } : {}),
    ...(report.app ? { app: report.app } : {}),
    at: new Date().toISOString(),
  };
  if (agent.status === 'stopped' || agent.status === 'asleep') return false;
  if (hasEndOfTurn(agent)) return false;
  const before = `${agent.status}/${agent.waitingReason ?? ''}`;
  switch (report.state) {
    case 'working':
      agent.status = 'running';
      agent.waitingReason = undefined;
      break;
    case 'blocked':
      agent.status = 'waiting';
      agent.waitingReason = 'permission';
      break;
    case 'idle':
    case 'done':
      agent.status = 'idle';
      agent.waitingReason = undefined;
      break;
    case 'error':
      agent.status = 'error';
      agent.waitingReason = undefined;
      agent.error = report.msg ? `The CLI reported an error: ${report.msg}` : 'The CLI reported an error.';
      break;
  }
  return `${agent.status}/${agent.waitingReason ?? ''}` !== before;
}
