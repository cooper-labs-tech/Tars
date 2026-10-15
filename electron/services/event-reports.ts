import * as fs from 'fs';
import * as path from 'path';
import { privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';
import { redactSecrets } from '../utils/redact-secrets';

/**
 * Reports to the user's Telegram as things happen (the design's part A2; JeanBrasse:
 * "en fonction de ce qui se passe"), through the relay to their Hermes
 * (hermes-relay.ts, which hands this module its channel while it is on).
 *
 * An event (an agent gone to error, a PR merged, changes requested on a PR)
 * waits up to GROUP_MS for others, and those of one project leave together in
 * one message of that project: the user's reply to it reaches that project's
 * orchestrator. At most REPORTS_PER_DAY messages a (local) day, counted across
 * restarts in ~/.tars-private; past that, events are counted, and the next
 * day's first message opens with one line saying how many were held. No quiet
 * hours. While the relay is off, an event is dropped, not kept: news sent late
 * is stale news.
 *
 * The same event is said once: an agent in error is reported when it enters
 * error, and again only once it has left it (agentRecovered); a merged PR
 * once per run (the GitHub watch also remembers what it has seen). Changes
 * requested may come back after an approval, so only a window's repeats are
 * dropped.
 *
 * Plain text, as the relay carries it: every name, title and error text is
 * kept to its own line, so that none can pass for another event of the
 * report, and has its secrets masked.
 */

export const GROUP_MS = 2 * 60_000;
export const REPORTS_PER_DAY = 40;

export type ReportEvent =
  | { kind: 'agent-error'; agentId: string; agentName: string; projectPath: string; reason?: string }
  | { kind: 'pr-merged'; repo: string; number: number; title: string; url: string; projectPath: string }
  | { kind: 'changes-requested'; repo: string; number: number; title: string; url: string; projectPath: string };

/** The relay, as it hands itself over while it is on, and takes itself back when it is off. */
export interface ReportChannel {
  /** Sends one report of a project; whether it went, or waits to go. */
  send(text: string, projectPath: string): Promise<boolean>;
}

let channel: ReportChannel | null = null;
let pending: ReportEvent[] = [];
let timer: NodeJS.Timeout | undefined;
const inError = new Set<string>();
const mergedSeen = new Set<string>();

export function setReportChannel(next: ReportChannel | null): void {
  channel = next;
  if (!next) {
    pending = [];
    if (timer) { clearTimeout(timer); timer = undefined; }
  }
}

/** Whether reports go out now: what the GitHub watch asks before it polls. */
export function reportsOn(): boolean {
  return channel !== null;
}

/** The agent has left error: its next error is a new event. */
export function agentRecovered(agentId: string): void {
  inError.delete(agentId);
}

const keyOf = (e: ReportEvent) => (e.kind === 'agent-error' ? `error:${e.agentId}` : `${e.kind}:${e.repo}#${e.number}`);

export function reportEvent(event: ReportEvent): void {
  if (!channel) return;
  if (event.kind === 'agent-error') {
    if (inError.has(event.agentId)) return;
    inError.add(event.agentId);
  }
  if (event.kind === 'pr-merged') {
    if (mergedSeen.has(keyOf(event))) return;
    mergedSeen.add(keyOf(event));
  }
  if (pending.some(p => keyOf(p) === keyOf(event))) return;
  pending.push(event);
  if (!timer) {
    timer = setTimeout(() => { timer = undefined; void flush(); }, GROUP_MS);
    timer.unref?.();
  }
}

interface DayCount { day: string; sent: number; held: number; heldBefore: number }
const FILE = () => privatePath('event-reports.json');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

function readCount(): DayCount {
  let stored: Partial<DayCount> = {};
  try { stored = JSON.parse(fs.readFileSync(FILE(), 'utf-8')); } catch { /* none yet */ }
  const day = today();
  if (stored.day === day) {
    return { day, sent: stored.sent ?? 0, held: stored.held ?? 0, heldBefore: stored.heldBefore ?? 0 };
  }
  // A new day: what was held on the last one is said in its first message.
  return { day, sent: 0, held: 0, heldBefore: (stored.held ?? 0) + (stored.heldBefore ?? 0) };
}

function writeCount(count: DayCount): void {
  try {
    writeSecretFileSync(FILE(), JSON.stringify(count));
  } catch (err) {
    console.error('[reports] could not record the day\'s count:', err instanceof Error ? err.message : err);
  }
}

/** One line, masked: a newline in a name or a title would start a line of its own. */
const oneLine = (s: string) => redactSecrets(s).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

function line(e: ReportEvent): string {
  if (e.kind === 'agent-error') {
    // Masked, then cut: cut first, a key that starts near the end kept its
    // first characters in clear (the Audit's gate of #234).
    const reason = e.reason ? oneLine(e.reason).slice(0, 300) : '';
    return `- ${oneLine(e.agentName)} stopped on an error${reason ? `: ${reason}` : ''}`;
  }
  if (e.kind === 'pr-merged') return `- PR #${e.number} merged in ${oneLine(e.repo)}: ${oneLine(e.title)} ${oneLine(e.url)}`;
  return `- Changes requested on PR #${e.number} in ${oneLine(e.repo)}: ${oneLine(e.title)} ${oneLine(e.url)}`;
}

async function flush(): Promise<void> {
  const events = pending;
  pending = [];
  if (!channel || events.length === 0) return;
  // One message per project, in the order its first event came: the user's
  // reply to it reaches that project's orchestrator.
  const byProject = new Map<string, ReportEvent[]>();
  for (const e of events) byProject.set(e.projectPath, [...(byProject.get(e.projectPath) ?? []), e]);
  for (const [projectPath, ofProject] of byProject) {
    const count = readCount();
    if (count.sent >= REPORTS_PER_DAY) {
      count.held += ofProject.length;
      writeCount(count);
      continue;
    }
    const lines = [`Report, project ${oneLine(path.basename(projectPath) || projectPath || 'unknown')}:`];
    if (count.heldBefore > 0) {
      lines.push(`${count.heldBefore} ${count.heldBefore === 1 ? 'event' : 'events'} after yesterday's limit ${count.heldBefore === 1 ? 'was' : 'were'} not sent.`);
    }
    lines.push(...ofProject.map(line));
    count.sent += 1;
    count.heldBefore = 0;
    if (count.sent === REPORTS_PER_DAY) {
      lines.push('', `That is ${REPORTS_PER_DAY} reports today, the most Tars sends: later events are counted and said tomorrow.`);
    }
    writeCount(count);
    try {
      await channel.send(lines.join('\n'), projectPath);
    } catch (err) {
      console.error('[reports] the relay refused the report:', err instanceof Error ? err.message : err);
    }
  }
}
