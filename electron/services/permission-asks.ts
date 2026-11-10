import type { AgentStatus, AgentWaitingOn, AppSettings } from '../types';
import { createHash } from 'crypto';
import * as path from 'path';
import { agents } from '../core/agent-manager';
import { DATA_DIR } from '../constants';
import { retentionLog } from './agent-tmp';
import { redactSecrets } from '../utils/redact-secrets';

/**
 * Permissions decided by Tars (mods step 2, ETUDE-MODS-CLAUDE-CODE.md §2).
 *
 * When Claude Code would put a tool call to its permission dialog, the state
 * mod's `classic.PermissionRequest` hook asks Tars instead (POST
 * /api/hooks/permission; until 2.0.7 its `tool.check`, which also caught calls
 * the auto mode classifier was about to allow), and
 * the request is held here until the window answers (agent:answerPermission):
 * allow or deny is then Claude Code's decision, with no dialog and nothing
 * typed into the terminal. A question handed back (`ask`) and one whose
 * session ends go back to the engine, whose own decision then stands: the
 * dialog, as before the mod. One nobody answers within the owner's delay
 * (`permissionAskMinutes`, 10 by default) is refused with a reason the model
 * reads, so the agent takes another way instead of freezing at a dialog all
 * night (2.0.5, fix-permission-dialogs-2810.md; until then it went back to
 * the dialog, and three projects' agents waited there until morning). Tars
 * allows nothing by itself, but for what the owner turned on in the settings
 * (chromeActsWithoutAsking, services/chrome-without-asking.ts); a file tool's question, its content withheld, is
 * held for an agent in bypass only, and the window may refuse it, never allow
 * it (hooks-routes.ts). Every decision is written to
 * ~/.tars/logs/permissions.log with who or what decided. Measured on 2.1.289:
 * a hook may await Tars past its 10 s budget, since a `$` call in flight is not
 * counted, and the model reads a deny's reason.
 *
 * Only the window answers. No API route takes an answer: an agent that could
 * answer could allow its own calls, or a teammate's.
 */

export type PermissionDecision = 'allow' | 'deny' | 'ask';
export type PermissionAnswer = { decision: PermissionDecision; reason?: string; fingerprint?: string };
/** Not decided yet: the mod asks again for the same call. */
export type PermissionPending = { decision: 'pending' };

/** How long a question is held for the window before Tars refuses it, from its first ask, by default. */
export const PERMISSION_HOLD_MS = 10 * 60_000;
/** The owner's setting's range, in minutes: past 60 the state mod stops asking first (its MAX_ASKS) and the dialog shows. */
const HOLD_MINUTES_MAX = 60;

/** The hold the owner set (`permissionAskMinutes`), or the default when it is not a whole number of minutes in range. */
export function permissionHoldMs(settings: Pick<AppSettings, 'permissionAskMinutes'> | undefined): number {
  const m = settings?.permissionAskMinutes;
  return typeof m === 'number' && Number.isInteger(m) && m >= 1 && m <= HOLD_MINUTES_MAX ? m * 60_000 : PERMISSION_HOLD_MS;
}

/** Where every decision is written, with who or what decided: ~/.tars/logs/permissions.log, moved to .1 past 256 KB. */
export const PERMISSION_LOG = path.join(DATA_DIR, 'logs', 'permissions.log');

/** One line per decision: the agent, the tool, the decision, who decided, and what was asked (masked, one line, cut at 300). */
export function logPermission(agent: { id: string; name?: string } | undefined, agentId: string, tool: string, decision: string, by: string, subject: string): void {
  // Masked: every agent can read the log (the Audit's L3 on #538). A subject can hold a file of 3 MiB since 2.0.7:
  // masked on its first 2,000 characters only, which hold the 300 written and any secret that reaches into them.
  const what = redactSecrets(subject.slice(0, 2000)).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, 300);
  retentionLog(`[permission] ${agent?.name || agentId} (${agentId}) ${tool} ${decision} by ${by}: ${what}`, PERMISSION_LOG);
}
/**
 * How long one ask is held before Tars answers `pending`. Measured on 2.1.289
 * (e2e/mod-permissions.live.spec.ts): a request held about 30 s ended under
 * the mod, and Claude Code showed its dialog while Tars still held the
 * question. Well under that, the mod asks again for the same call.
 */
export const PERMISSION_POLL_MS = 20_000;
/** How long a decision made between two asks waits for the next one. */
const ANSWER_KEPT_MS = 60_000;

/** What the call is asked about: its tool and the fields a person decides on, whole. */
export type PermissionQuestion = {
  tool: string;
  toolUseId: string;
  fields: Record<string, string>;
  waitingOn: AgentWaitingOn | undefined;
  reason?: string;
  rule?: string;
  /**
   * A question Tars cannot show whole (the state mod): a file tool asked without its content, or a call with a field
   * the mod could not send (one with no JSON, or past what a request to Tars carries, 3 MiB). The window may refuse
   * it, never allow it, since it would approve what it never showed.
   */
  withheld?: boolean;
  /** What was withheld and why, as the mod says it: `<field>: <why>`, joined by `; `. */
  withheldWhy?: string;
  /** Why Tars could not allow it itself: said with the refusal at the delay. */
  notAllowedBecause?: string;
  /** The fields the mod sent as their JSON (a number, a boolean, null, an array, an object), not as text (2.0.7). */
  jsonFields?: string[];
};

/**
 * What a question is about, as the mod computes it for the call it holds:
 * sha256 of the tool and the asked fields, sorted by name, and of the fields
 * sent as JSON when there are any (2.0.7: an answer about `"true"` never allows
 * `true`; a question with none binds as 2.0.6's did). A question and any
 * answer kept for it are bound to it, not to the call's id alone, and every
 * decision names it: the agent's own shell holds the hook token and can read
 * its next call's id from its transcript, so a post for that id with `ls`
 * made JeanBrasse allow a `curl ... | sh` (the gate of #318, Medium 1).
 */
export function questionFingerprint(tool: string, fields: Record<string, string>, jsonFields: string[] = []): string {
  const entries = Object.keys(fields).sort().map(k => [k, fields[k]]);
  const canonical = jsonFields.length ? [tool, entries, [...jsonFields].sort()] : [tool, entries];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** The field the window's line opens on, in this order: what runs, the file, the address, the search, the folder. */
const MAIN_FIELDS = ['command', 'file_path', 'notebook_path', 'url', 'query', 'pattern', 'path'];
/** Bash's fields the mod shows as words (the Audit's M1 on #538), said after the command when not their default. */
const BASH_WORDS = ['timeout', 'run_in_background', 'dangerouslyDisableSandbox'];

/**
 * What the window names as asked: every field an allow covers, whole (the Audit's fifth gate of #538, M1: a Grep of
 * `~/.ssh` read as a search for a string). The main field first (the tool's name when there is none, a file as
 * `<tool> <path>`), a search's folder as `in <path>`, then each other field as `<field> <value>`, by name. A Bash's
 * `description` is the model's own words, not what runs, and is left out.
 */
export function subjectOf(tool: string, fields: Record<string, string>): string {
  const main = MAIN_FIELDS.find(k => fields[k]);
  const head = !main ? tool : main === 'file_path' || main === 'notebook_path' ? `${tool} ${fields[main]}` : fields[main];
  const searchIn = (main === 'pattern' || main === 'query') && fields.path ? ` in ${fields.path}` : '';
  const words = Object.keys(fields).sort()
    .filter(k => k !== main && fields[k] && !(searchIn && k === 'path') && !(tool === 'Bash' && (k === 'description' || BASH_WORDS.includes(k))))
    .map(k => `${k} ${fields[k]}`);
  if (tool === 'Bash') {
    if (fields.timeout) words.push(`timeout ${fields.timeout} ms`);
    if (fields.run_in_background === 'true') words.push('in the background');
    if (fields.dangerouslyDisableSandbox === 'true') words.push('outside the sandbox');
  }
  return `${head}${searchIn}${words.length ? ` (${words.join(', ')})` : ''}`;
}

/**
 * What Tars publishes of a question (approve-everywhere, 2.0.7): the window's line, every agents:tick and status
 * event, list_agents and get_agent. Since the mod sends every field whole, a file's content and a field of 3 MiB
 * included, a question rode whole on each tick, twice (its fields and its line). The view holds each field's first
 * 2,000 characters and the first 32 fields, `cut` naming every field it does not hold whole with its length; the
 * window asks for the question whole (permissionQuestionOf, agent:permissionQuestion) to show it before an allow.
 */
export const VIEW_FIELD_CAP = 2000;
export const VIEW_FIELDS_CAP = 32;

/** The question whole, as the window shows it before an allow: every field, its line, and the fingerprint an allow names. */
export type PermissionQuestionWhole = {
  tool: string;
  askedAt: string;
  until: string;
  subject: string;
  fields: Record<string, string>;
  /** The fields sent as their JSON (a number, a boolean, null, an array, an object); [] when none. */
  jsonFields: string[];
  fingerprint: string;
  reason?: string;
  rule?: string;
  withheld?: true;
  withheldWhy?: string;
};

/** The view of a question's fields: each at most VIEW_FIELD_CAP, VIEW_FIELDS_CAP of them, and what it cut. */
function viewOf(fields: Record<string, string>): { fields: Record<string, string>; cut: Array<{ field: string; length: number }> } {
  const shown: Record<string, string> = {};
  const cut: Array<{ field: string; length: number }> = [];
  for (const [field, text] of Object.entries(fields)) {
    if (Object.keys(shown).length >= VIEW_FIELDS_CAP) { cut.push({ field, length: text.length }); continue; }
    shown[field] = text.length > VIEW_FIELD_CAP ? text.slice(0, VIEW_FIELD_CAP) : text;
    if (text.length > VIEW_FIELD_CAP) cut.push({ field, length: text.length });
  }
  return { fields: shown, cut };
}

type Held = {
  agentId: string;
  toolUseId: string;
  fingerprint: string;
  /** For the log: the tool and what it asked, as the view says it. */
  tool: string;
  subject: string;
  /** The question whole, for the window (permissionQuestionOf). */
  whole: PermissionQuestionWhole;
  /** The view does not hold it whole: an allow must name its fingerprint, which only its whole form gives. */
  cut: boolean;
  /** The asks waiting on it now: one, or none between two asks. */
  waiters: Set<(answer: PermissionAnswer) => void>;
  timer: ReturnType<typeof setTimeout>;
  /** Tells the window and the watchers, at the question and at its end. */
  changed: (agent: AgentStatus) => void;
  /** Its content withheld: the window cannot allow it. */
  withheld: boolean;
};

/**
 * The question as another agent reads it (list_agents, get_agent): a token or a URL's password in the command masked
 * (the Audit's L3 on #538). The window, where the owner decides, keeps it whole.
 */
export function maskedAsk(ask: NonNullable<AgentStatus['permissionAsk']>): NonNullable<AgentStatus['permissionAsk']> {
  return {
    ...ask,
    subject: redactSecrets(ask.subject),
    fields: Object.fromEntries(Object.entries(ask.fields).map(([k, v]) => [k, redactSecrets(v)])),
  };
}

/** One question per agent: a turn makes one tool call at a time ask. */
const held = new Map<string, Held>();
/** A decision no ask was waiting for, kept for the next ask of that very call. */
const kept = new Map<string, { toolUseId: string; fingerprint: string; answer: PermissionAnswer; timer: ReturnType<typeof setTimeout> }>();

function close(agent: AgentStatus | undefined, entry: Held, answer: PermissionAnswer, by: string): void {
  clearTimeout(entry.timer);
  logPermission(agent, entry.agentId, entry.tool, answer.decision === 'ask' ? 'back to its dialog' : answer.decision, by, entry.subject);
  if (held.get(entry.agentId) === entry) held.delete(entry.agentId);
  const decided: PermissionAnswer = answer.decision === 'ask' ? answer : { ...answer, fingerprint: entry.fingerprint };
  if (entry.waiters.size === 0) {
    const timer = setTimeout(() => kept.delete(entry.agentId), ANSWER_KEPT_MS);
    kept.set(entry.agentId, { toolUseId: entry.toolUseId, fingerprint: entry.fingerprint, answer: decided, timer });
  }
  for (const waiter of entry.waiters) waiter(decided);
  entry.waiters.clear();
  // Every end is the window's news, the ones that come by themselves too:
  // the bound, a new session, the turn's end, a dialog shown anyway, the quit.
  if (agent) {
    agent.permissionAsk = undefined;
    entry.changed(agent);
  }
}

/** One ask's wait: the decision, or `pending` after the poll. */
function waitOn(entry: Held, pollMs: number): Promise<PermissionAnswer | PermissionPending> {
  return new Promise(resolve => {
    const waiter = (answer: PermissionAnswer) => { clearTimeout(poll); resolve(answer); };
    const poll = setTimeout(() => { entry.waiters.delete(waiter); resolve({ decision: 'pending' }); }, pollMs);
    entry.waiters.add(waiter);
  });
}

/**
 * The mod's question about one call. The first ask holds the agent `waiting`
 * on that permission and tells the window (`changed`, as a hook's status post
 * does); an ask again for the same call, the same id and the same fields,
 * joins it. Each ask gets the decision, or `pending` after `pollMs`, and the
 * question goes back to the dialog (`ask`) once `holdMs` has passed since its
 * first ask.
 */
export function holdPermissionAsk(
  agent: AgentStatus,
  question: PermissionQuestion,
  changed: (agent: AgentStatus) => void,
  holdMs: number = PERMISSION_HOLD_MS,
  pollMs: number = PERMISSION_POLL_MS,
): Promise<PermissionAnswer | PermissionPending> {
  const fingerprint = questionFingerprint(question.tool, question.fields, question.jsonFields);
  const decided = kept.get(agent.id);
  if (decided) {
    kept.delete(agent.id);
    clearTimeout(decided.timer);
    if (decided.toolUseId === question.toolUseId && decided.fingerprint === fingerprint) return Promise.resolve(decided.answer);
  }
  const current = held.get(agent.id);
  if (current && current.toolUseId === question.toolUseId && current.fingerprint === fingerprint) return waitOn(current, pollMs);
  // A question still held is about another call, or about this call's id
  // with other fields: one its engine gave up on, or a post that was not the
  // mod's. It goes back to its dialog, and this one is shown afresh.
  if (current) close(agent, current, { decision: 'ask' }, 'its engine, which asked about another call');

  const minutes = Math.round(holdMs / 60_000);
  const askedAt = new Date();
  const until = new Date(askedAt.getTime() + holdMs).toISOString();
  const view = viewOf(question.fields);
  const viewSubject = subjectOf(question.tool, view.fields);
  const jsonFields = [...(question.jsonFields ?? [])].sort();
  const entry: Held = {
    agentId: agent.id,
    toolUseId: question.toolUseId,
    fingerprint,
    tool: question.tool,
    subject: viewSubject,
    whole: {
      tool: question.tool, askedAt: askedAt.toISOString(), until,
      subject: subjectOf(question.tool, question.fields), fields: { ...question.fields }, jsonFields, fingerprint,
      ...(question.reason ? { reason: question.reason } : {}),
      ...(question.rule ? { rule: question.rule } : {}),
      ...(question.withheld ? { withheld: true as const } : {}),
      ...(question.withheld && question.withheldWhy ? { withheldWhy: question.withheldWhy } : {}),
    },
    cut: view.cut.length > 0,
    waiters: new Set(),
    // Unanswered: refused, with what the agent can do instead, and it runs on.
    // Never back to the dialog, where nobody may answer until morning.
    timer: setTimeout(() => {
      running(agent);
      const why = question.notAllowedBecause ? ` Tars could not allow it itself: ${question.notAllowedBecause}.` : '';
      close(agent, entry, { decision: 'deny', reason: expiredReason(minutes) + why }, `the delay (${minutes} minute${minutes === 1 ? '' : 's'})`);
    }, holdMs),
    changed,
    withheld: question.withheld === true,
  };
  held.set(agent.id, entry);
  agent.status = 'waiting';
  agent.waitingReason = 'permission';
  agent.dialogSince = askedAt.toISOString();
  agent.waitingOn = question.waitingOn;
  const viewJson = jsonFields.filter(k => Object.hasOwn(view.fields, k));
  agent.permissionAsk = {
    tool: question.tool,
    askedAt: askedAt.toISOString(),
    until,
    subject: viewSubject,
    fields: view.fields,
    ...(viewJson.length ? { jsonFields: viewJson } : {}),
    // Shown whole, its fingerprint is the window's to name; cut, only the whole question gives it.
    ...(view.cut.length ? { cut: view.cut } : { fingerprint }),
    ...(question.reason ? { reason: question.reason } : {}),
    ...(question.rule ? { rule: question.rule } : {}),
    ...(question.withheld ? { withheld: true as const } : {}),
    ...(question.withheld && question.withheldWhy ? { withheldWhy: question.withheldWhy } : {}),
  };
  agent.lastActivity = askedAt.toISOString();
  console.log(`[permission] ${agent.name || agent.id} asks Tars: ${question.tool}${question.waitingOn ? ` ${question.waitingOn.text}` : ''}`);
  const wait = waitOn(entry, pollMs);
  changed(agent);
  return wait;
}

/** What the model reads when nobody answered in time: why, and what to do instead of waiting. */
function expiredReason(minutes: number): string {
  return `Nobody answered this permission question in Tars within ${minutes} minute${minutes === 1 ? '' : 's'}, so Tars refused it. Do not wait `
    + 'for it and do not ask again for the same call: take another way. Write a file with the Write tool, not a '
    + 'heredoc or a redirection in a shell command; split a compound command into simple ones; work inside your own '
    + 'worktree or temporary folders. Or go on with the rest and say in your report what you needed and why.';
}

/** The agent runs again: its question was decided. */
function running(agent: AgentStatus): void {
  agent.status = 'running';
  agent.waitingReason = undefined;
  agent.waitingOn = undefined;
  agent.dialogSince = undefined;
  agent.lastActivity = new Date().toISOString();
}

function reasonFor(decision: PermissionDecision, by: string, reason?: string): string | undefined {
  const why = typeof reason === 'string' ? reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 200) : '';
  if (decision === 'allow') return `${by} allowed it in Tars`;
  if (decision === 'deny') return `${by} refused it in Tars${why ? `: ${why}` : ''}`;
  return undefined;
}

/** The question held for this agent, whole, for the window to show before an allow; undefined when none is held. */
export function permissionQuestionOf(agentId: string): PermissionQuestionWhole | undefined {
  const whole = held.get(agentId)?.whole;
  return whole ? { ...whole, fields: { ...whole.fields }, jsonFields: [...whole.jsonFields] } : undefined;
}

/**
 * The window's answer to the agent's held question: allow or deny decide the
 * call and the agent runs on; ask hands it back to the terminal's dialog.
 * False, and nothing changed, when the agent has no question or the decision
 * is none of the three. The window is told through the question's own
 * `changed`. `fingerprint`, the one the window read (approve-everywhere): an
 * answer naming another question's changes nothing, so an allow never lands on
 * a question asked after the one read; and a question whose view is cut is
 * allowed only by naming it, which only its whole form gives.
 */
export function answerPermission(agentId: string, decision: PermissionDecision, by: string, reason?: string, fingerprint?: string): boolean {
  if (decision !== 'allow' && decision !== 'deny' && decision !== 'ask') return false;
  const entry = held.get(agentId);
  if (!entry) return false;
  const named = typeof fingerprint === 'string' ? fingerprint : undefined;
  if (named !== undefined && named !== entry.fingerprint) return false;
  // Content the window never showed is never allowed from it: refused, or handed back to the dialog.
  if (decision === 'allow' && entry.withheld) return false;
  if (decision === 'allow' && entry.cut && named === undefined) return false;
  const agent = agents.get(agentId);
  if (agent && decision !== 'ask') running(agent);
  const text = reasonFor(decision, by, reason);
  close(agent, entry, text ? { decision, reason: text } : { decision }, by);
  return true;
}

/** The question held for this agent ends: its session or its turn did, it was stopped or deleted. */
export function dropPermissionAsks(agentId: string): void {
  const decided = kept.get(agentId);
  if (decided) { clearTimeout(decided.timer); kept.delete(agentId); }
  const entry = held.get(agentId);
  if (entry) close(agents.get(agentId), entry, { decision: 'ask' }, 'the end of its session or turn, its own dialog, a stop or a removal');
}

/** The quit: every question goes back to its engine. */
export function endPermissionAsks(): void {
  for (const entry of [...held.values()]) close(agents.get(entry.agentId), entry, { decision: 'ask' }, 'the quit');
}

/** Test seam. */
export function resetPermissionAsks(): void {
  for (const entry of held.values()) clearTimeout(entry.timer);
  for (const entry of kept.values()) clearTimeout(entry.timer);
  held.clear();
  kept.clear();
}
