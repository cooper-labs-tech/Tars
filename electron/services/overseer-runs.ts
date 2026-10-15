import * as fs from 'fs';
import { dataPath } from '../constants';
import { writeAtomicSync } from '../utils/secret-file';

/**
 * What the fleet has been doing, not just what it is doing.
 *
 * The overseer was given a snapshot each turn and nothing else, so it could
 * say "Frontend is waiting on you" and never "that is the third time it has
 * come back to this task". Judgement about whether work is going well needs
 * the shape of the last few hours, and a snapshot has none.
 *
 * This is deliberately small. It is not a metrics store: it records status
 * transitions, keeps a day of them, and turns them into a handful of English
 * lines the model can act on. Anything longer belongs in the usage ledger,
 * which already exists and answers a different question.
 */

const LEDGER_FILE = 'overseer-runs.json';
/** A day is what makes "again today" answerable without carrying a month. */
const RETAIN_MS = 24 * 60 * 60 * 1000;
/** A hard cap as well as a time window: a thrashing fleet must not grow this
 *  file without bound between two prunes. */
const MAX_EVENTS = 800;

export interface RunEvent {
  at: number;
  agentId: string;
  agentName: string;
  project: string;
  from: string;
  to: string;
  /** The task in flight when the transition happened, trimmed. */
  task?: string;
}

function ledgerPath(): string {
  return dataPath(LEDGER_FILE);
}

export function readRunEvents(now = Date.now()): RunEvent[] {
  try {
    const raw = fs.readFileSync(ledgerPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is RunEvent => !!e && typeof e === 'object' && typeof (e as RunEvent).at === 'number')
      .filter(e => now - e.at <= RETAIN_MS);
  } catch {
    // No ledger yet, or an unreadable one. Neither is worth failing a turn for.
    return [];
  }
}

export function recordRunEvents(events: RunEvent[], now = Date.now()): void {
  if (events.length === 0) return;
  try {
    const kept = [...readRunEvents(now), ...events].slice(-MAX_EVENTS);
    writeAtomicSync(ledgerPath(), JSON.stringify(kept));
  } catch (err) {
    console.error('[overseer] could not write the run ledger:', err);
  }
}

/** Test seam and a way out if the file ever goes bad. */
export function clearRunEvents(): void {
  try {
    fs.rmSync(ledgerPath(), { force: true });
  } catch { /* nothing to clear */ }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The last day, in the few sentences that are worth a turn's tokens.
 *
 * Only agents that did something appear, and only the facts that change what
 * a reader would say next: how often it ran, how often it stopped to ask, and
 * whether it keeps coming back to the same task. A quiet agent produces no
 * line at all rather than a line saying it was quiet.
 */
export function summariseRuns(now = Date.now(), events = readRunEvents(now)): string {
  if (events.length === 0) return '';

  const byAgent = new Map<string, RunEvent[]>();
  for (const e of events) {
    const list = byAgent.get(e.agentId);
    if (list) list.push(e);
    else byAgent.set(e.agentId, [e]);
  }

  const lines: string[] = [];
  for (const [, list] of byAgent) {
    const latest = list[list.length - 1];
    const starts = list.filter(e => e.to === 'running').length;
    const pauses = list.filter(e => e.to === 'waiting').length;
    const errors = list.filter(e => e.to === 'error').length;

    // The signal that a snapshot cannot carry: the same task started again
    // and again is an agent going in circles, not an agent working.
    const taskCounts = new Map<string, number>();
    for (const e of list) {
      if (e.to !== 'running' || !e.task) continue;
      taskCounts.set(e.task, (taskCounts.get(e.task) ?? 0) + 1);
    }
    let repeated: string | null = null;
    for (const [task, count] of taskCounts) {
      if (count >= 3) { repeated = `${task}" started ${count} times`; break; }
    }

    const parts: string[] = [];
    if (starts > 0) parts.push(plural(starts, 'run', 'runs'));
    if (pauses > 0) parts.push(`${plural(pauses, 'pause', 'pauses')} for the user`);
    if (errors > 0) parts.push(plural(errors, 'error', 'errors'));
    if (parts.length === 0) continue;

    const tail = repeated ? `, same task "${repeated}` : '';
    lines.push(`- "${latest.agentName}" (${latest.project}): ${parts.join(', ')}${tail}`);
  }

  if (lines.length === 0) return '';
  return `THE LAST DAY (what these agents have been doing, not just where they are now)\n${lines.join('\n')}`;
}
