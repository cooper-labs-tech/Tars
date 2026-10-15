import type { AgentStatus, AgentWaitingOn } from '../types';
import { createHash } from 'crypto';
import { agents } from '../core/agent-manager';

/**
 * Permissions decided by Tars (mods step 2, ETUDE-MODS-CLAUDE-CODE.md §2).
 *
 * When Claude Code would put a tool call to its permission dialog, the state
 * mod's `tool.check` hook asks Tars instead (POST /api/hooks/permission), and
 * the request is held here until the window answers (agent:answerPermission):
 * allow or deny is then Claude Code's decision, with no dialog and nothing
 * typed into the terminal. A question handed back (`ask`), one nobody answers
 * within the bound, and one whose session ends go back to the engine, whose
 * own decision then stands: the dialog, as before the mod. Measured on 2.1.289:
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

/** How long a question is held for the window before it goes back to the dialog, from its first ask. */
export const PERMISSION_HOLD_MS = 10 * 60_000;
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
};

/**
 * What a question is about, as the mod computes it for the call it holds:
 * sha256 of the tool and the asked fields, sorted by name. A question and any
 * answer kept for it are bound to it, not to the call's id alone, and every
 * decision names it: the agent's own shell holds the hook token and can read
 * its next call's id from its transcript, so a post for that id with `ls`
 * made JeanBrasse allow a `curl ... | sh` (the gate of #318, Medium 1).
 */
export function questionFingerprint(tool: string, fields: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify([tool, Object.keys(fields).sort().map(k => [k, fields[k]])])).digest('hex');
}

/** What the window names as asked: the command, the path or the address, whole; the tool when there is none. */
function subjectOf(tool: string, fields: Record<string, string>): string {
  const path = fields.file_path || fields.notebook_path;
  return fields.command || (path ? `${tool} ${path}` : '') || fields.url || fields.query || fields.pattern || fields.path || tool;
}

type Held = {
  agentId: string;
  toolUseId: string;
  fingerprint: string;
  /** The asks waiting on it now: one, or none between two asks. */
  waiters: Set<(answer: PermissionAnswer) => void>;
  timer: ReturnType<typeof setTimeout>;
  /** Tells the window and the watchers, at the question and at its end. */
  changed: (agent: AgentStatus) => void;
};

/** One question per agent: a turn makes one tool call at a time ask. */
const held = new Map<string, Held>();
/** A decision no ask was waiting for, kept for the next ask of that very call. */
const kept = new Map<string, { toolUseId: string; fingerprint: string; answer: PermissionAnswer; timer: ReturnType<typeof setTimeout> }>();

function close(agent: AgentStatus | undefined, entry: Held, answer: PermissionAnswer): void {
  clearTimeout(entry.timer);
  console.log(`[permission] ${agent?.name || entry.agentId}: ${answer.decision}${answer.reason ? ` (${answer.reason})` : ', back to its dialog'}`);
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
  const fingerprint = questionFingerprint(question.tool, question.fields);
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
  if (current) close(agent, current, { decision: 'ask' });

  const entry: Held = {
    agentId: agent.id,
    toolUseId: question.toolUseId,
    fingerprint,
    waiters: new Set(),
    // Unanswered: the dialog shows, and the agent stays waiting on it.
    timer: setTimeout(() => close(agent, entry, { decision: 'ask' }), holdMs),
    changed,
  };
  held.set(agent.id, entry);
  const askedAt = new Date();
  agent.status = 'waiting';
  agent.waitingReason = 'permission';
  agent.dialogSince = askedAt.toISOString();
  agent.waitingOn = question.waitingOn;
  agent.permissionAsk = {
    tool: question.tool,
    askedAt: askedAt.toISOString(),
    until: new Date(askedAt.getTime() + holdMs).toISOString(),
    subject: subjectOf(question.tool, question.fields),
    fields: { ...question.fields },
    ...(question.reason ? { reason: question.reason } : {}),
    ...(question.rule ? { rule: question.rule } : {}),
  };
  agent.lastActivity = askedAt.toISOString();
  console.log(`[permission] ${agent.name || agent.id} asks Tars: ${question.tool}${question.waitingOn ? ` ${question.waitingOn.text}` : ''}`);
  const wait = waitOn(entry, pollMs);
  changed(agent);
  return wait;
}

function reasonFor(decision: PermissionDecision, by: string, reason?: string): string | undefined {
  const why = typeof reason === 'string' ? reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 200) : '';
  if (decision === 'allow') return `${by} allowed it in Tars`;
  if (decision === 'deny') return `${by} refused it in Tars${why ? `: ${why}` : ''}`;
  return undefined;
}

/**
 * The window's answer to the agent's held question: allow or deny decide the
 * call and the agent runs on; ask hands it back to the terminal's dialog.
 * False, and nothing changed, when the agent has no question or the decision
 * is none of the three. The window is told through the question's own
 * `changed`.
 */
export function answerPermission(agentId: string, decision: PermissionDecision, by: string, reason?: string): boolean {
  if (decision !== 'allow' && decision !== 'deny' && decision !== 'ask') return false;
  const entry = held.get(agentId);
  if (!entry) return false;
  const agent = agents.get(agentId);
  if (agent && decision !== 'ask') {
    agent.status = 'running';
    agent.waitingReason = undefined;
    agent.waitingOn = undefined;
    agent.dialogSince = undefined;
    agent.lastActivity = new Date().toISOString();
  }
  const text = reasonFor(decision, by, reason);
  close(agent, entry, text ? { decision, reason: text } : { decision });
  return true;
}

/** The question held for this agent ends: its session or its turn did, it was stopped or deleted. */
export function dropPermissionAsks(agentId: string): void {
  const decided = kept.get(agentId);
  if (decided) { clearTimeout(decided.timer); kept.delete(agentId); }
  const entry = held.get(agentId);
  if (entry) close(agents.get(agentId), entry, { decision: 'ask' });
}

/** The quit: every question goes back to its engine. */
export function endPermissionAsks(): void {
  for (const entry of [...held.values()]) close(agents.get(entry.agentId), entry, { decision: 'ask' });
}

/** Test seam. */
export function resetPermissionAsks(): void {
  for (const entry of held.values()) clearTimeout(entry.timer);
  for (const entry of kept.values()) clearTimeout(entry.timer);
  held.clear();
  kept.clear();
}
