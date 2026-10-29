import type { AgentResources } from './contract';
import { clock } from './format';

/**
 * What outlived an agent's session, said as the frame draws it (`Resources (2.0.5) · agents and projects · states`, its
 * pane `what outlived a session · alert`): a note on the agent's row, a notice under the fleet, and each item when
 * shown. The data is the main process's (#523's records, services/born-watch.ts): pids, commands masked by the window's
 * rule, containers as `<name> (<id>)`; null when nothing outlived. On Windows only the containers can be.
 */

export type Outlived = AgentResources['outlived'];

/** Programs that run another one: a process is named by what they run. */
const RUNNERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby']);
const SCRIPT = /\.(c|m)?(j|t)s$|\.py$|\.rb$/;
const SUBCOMMAND = /^[a-z][\w:-]*$/;

const base = (word: string) => word.split(/[\\/]/).pop() ?? word;

/** A process by its program and its subcommand, from its masked command: "next dev", "node", "npm run". Never a flag. */
export function processName(command: string): string {
  const words = command.trim().split(/\s+/);
  let program = base(words[0] ?? '');
  let next = 1;
  const ran = words[1];
  if (RUNNERS.has(program) && ran && !ran.startsWith('-') && !SCRIPT.test(ran)) {
    program = base(ran);
    next = 2;
  } else if (RUNNERS.has(program) && ran && SCRIPT.test(ran)) {
    return program;
  }
  const sub = words[next];
  return sub && SUBCOMMAND.test(sub) ? `${program} ${sub}` : program;
}

/** A container by its name, without its id. */
const containerName = (container: string) => container.replace(/\s*\([^)]*\)\s*$/, '');

export const outlivedCount = (o: Outlived) => (o ? o.processes.length + o.containers.length : 0);

/** The agent row's note: "3 outlived its session". */
export const outlivedNote = (o: Outlived) => (outlivedCount(o) ? `${outlivedCount(o)} outlived its session` : null);

/** The notice under the fleet, for one agent. */
export function outlivedNotice(agentName: string, o: Outlived): string | null {
  const n = outlivedCount(o);
  if (!o || !n) return null;
  const names = [...o.processes.map((p) => processName(p.command)), ...o.containers.map((c) => `the container ${containerName(c)}`)];
  const them = n === 1 ? 'it' : 'them';
  return `${agentName}'s session ended${o.since !== null ? ` at ${clock(o.since)}` : ''} and ${n} of what it started ${n === 1 ? 'runs' : 'run'} on: ${names.join(', ')}. Tars ends ${them} on a stop of the agent; it does not end ${them} by itself.`;
}
