/**
 * The Traces page's and the inference endpoints' words for figures and states, as the frames write them
 * (design/tars-redesign.pen: Settings · Inference endpoints, Traces · sessions, Traces · a session's turns).
 * Sizes in Tars's own unit (a GB is 1024³ bytes, components/Resources/format.ts), tokens as the Usage page writes
 * them (lib/usage-format.ts). A figure the main process did not give is never said as zero.
 */
import type { EndpointView, TraceOutcome, TraceSessionSummary } from '@/types/electron';
import type { StatusTone } from '@/components/ui';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * What a delete does to a copy on the back-office (`Traces · states`, the delete dialogs). A session the user deletes
 * that had been sent is owed a per-session delete, sent with sharing on or off, to the install it went to, while the
 * back-office address is still that install's (a new install forgets it; trace-upload.ts). The window does not know
 * whether a session was sent: the sentences hold that condition, and the address's.
 */
export const BACK_OFFICE_COPY_ONE = 'If it was sent to the back-office, Tars asks that back-office to delete its copy too, as long as the back-office address stays the same.';
export const BACK_OFFICE_COPY_MANY = 'For those sent to the back-office, Tars asks that back-office to delete its copies too, as long as the back-office address stays the same.';

/** 14:02 */
export function clockOf(ms: number | string | undefined): string {
  if (ms === undefined) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 14:02:11 */
export function clockSecondsOf(ms: number | undefined): string {
  if (ms === undefined) return '';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 19/11 14:02 */
export function dayClockOf(ms: number | undefined): string {
  if (ms === undefined) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${clockOf(ms)}`;
}

/** 20/10 */
export function dayOf(ms: number | undefined): string {
  if (ms === undefined) return '';
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

/** 2.4 s, 1 m 12 s, 41 min */
export function durationOf(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 600) return `${Math.floor(s / 60)} m ${s % 60} s`;
  return `${Math.round(s / 60)} min`;
}

/** The session's end as the frames say it, in its tone. */
export function outcomeOf(status: TraceSessionSummary['finalStatus']): { word: string; tone: StatusTone } {
  switch (status) {
    case 'done': return { word: 'done', tone: 'running' };
    case 'open': return { word: 'open', tone: 'waiting' };
    case 'failed': return { word: 'failed', tone: 'error' };
    default: return { word: 'abandoned', tone: 'idle' };
  }
}

/** The muted words after a session's outcome: still recording, its unknown turns, mixed. */
export function marksOf(s: Pick<TraceSessionSummary, 'finalStatus' | 'unknownTurns' | 'mixed'>): string {
  const marks: string[] = [];
  if (s.finalStatus === 'open') marks.push('recording');
  if (s.unknownTurns > 0) marks.push(`${s.unknownTurns} turn${s.unknownTurns === 1 ? '' : 's'} of unknown author`);
  if (s.mixed) marks.push('mixed');
  return marks.join(' · ');
}

/** "reachable · 182 ms · checked 14:02", "the key was refused (401) · checked 14:31", "not checked yet". */
export function healthOf(h: EndpointView['health'], checking = false): { word: string; tone: StatusTone } {
  if (checking) return { word: 'checking', tone: 'waiting' };
  if (!h) return { word: 'not checked yet', tone: 'idle' };
  const at = clockOf(h.at);
  const when = at ? ` · checked ${at}` : '';
  if (h.ok) return { word: `reachable${h.latencyMs !== undefined ? ` · ${h.latencyMs} ms` : ''}${when}`, tone: 'running' };
  if (h.status === 401 || h.status === 403) return { word: `the key was refused (${h.status})${when}`, tone: 'error' };
  if (h.status) return { word: `answered ${h.status}${h.error ? `: ${h.error}` : ''}${when}`, tone: 'error' };
  return { word: `not reached${h.error ? `: ${h.error}` : ''}${when}`, tone: 'error' };
}

/** "used by Harbor-Codex and Atlas-Qwen", "used by no agent". */
export function usedByOf(agents: EndpointView['agents']): string {
  const names = agents.map(a => a.name);
  if (names.length === 0) return 'used by no agent';
  if (names.length === 1) return `used by ${names[0]}`;
  return `used by ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Main's reason as a clause, its closing stop taken off, so the window's own sentence follows it with one stop:
 * "Tars could not save the settings (ENOSPC): nothing was changed." + ". The last list is kept." ended twice.
 */
export function clauseOf(reason: string): string {
  return reason.trim().replace(/[.\s]+$/, '');
}

/** "qwen3-coder-480b · glm-4.6 · kimi-k2 · deepseek-v3.1 · and 8 more" */
export function modelsLineOf(models: string[], shown = 4): string {
  if (models.length === 0) return 'no model read';
  const head = models.slice(0, shown).join(' · ');
  return models.length > shown ? `${head} · and ${models.length - shown} more` : head;
}

/** The last path segment of a project, as the sessions table shows it. */
export function projectNameOf(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 1.4 KB, 3.1 MB, 2.1 GB: one decimal, in Tars's 1024 units, down to a message part's bytes. */
export function sizeOf(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * A session's outcome in words: "task done · fe/settle at 3f2a91c · tests 12 passed". What Tars does not know of it
 * is absent from TraceOutcome, and left out here, never guessed.
 */
export function outcomeWordsOf(o: TraceOutcome | undefined): string {
  if (!o) return '';
  const words: string[] = [];
  if (o.task) words.push(`task ${o.task.status}`);
  if (o.branch) words.push(o.head ? `${o.branch} at ${o.head.slice(0, 9)}` : o.branch);
  if (o.tests && (o.tests.passed !== undefined || o.tests.failed !== undefined)) {
    words.push(o.tests.failed ? `tests ${o.tests.failed} failed` : `tests ${o.tests.passed ?? 0} passed`);
  }
  for (const g of o.gates ?? []) words.push(`${g.kind} ${g.verdict}`);
  if (o.heldRequests) words.push(`${o.heldRequests} request${o.heldRequests === 1 ? '' : 's'} held`);
  return words.join(' · ');
}

/**
 * Main's own reason for a failure, in words a line of the view can carry: without Electron's "Error invoking remote
 * method '<channel>': Error: " in front, without a system error's code and the call it failed in ("ENOSPC: no space
 * left on device, write" says "no space left on device"), and without the final period, which the line's own sentence
 * puts (QA's re-check of #599: "404 not_found.. Nothing was forgotten", and the channel's name shown to the user).
 * Shared by the upload view and the three places a removal of sessions is asked.
 */
export function reasonOf(e: unknown): string {
  let s = (e instanceof Error ? e.message : String(e)).trim();
  s = s.replace(/^Error invoking remote method '[^']*':\s*/, '');
  while (/^[A-Za-z]*Error:\s*/.test(s)) s = s.replace(/^[A-Za-z]*Error:\s*/, '');
  // A system error's code (ENOSPC, EACCES...), not a message that happens to start with ERROR.
  const system = s.match(/^(?!ERROR:)E[A-Z]+:\s*([^,]+)(?:,.*)?$/);
  if (system) s = system[1];
  return s.replace(/[.\s]+$/, '');
}
