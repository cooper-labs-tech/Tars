import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';
import { redactSecrets } from '../utils/redact-secrets';
import { isSuperAgent } from '../utils';
import { agents } from '../core/agent-manager';
import { ptyProcesses, writeProgrammaticInput } from '../core/pty-manager';
import { cliRunningIn } from '../core/agent-pty';
import { onRelayReply, receiptFor, relaySend, relayWasSent, tellUser, type RelayReply } from './hermes-relay';
import { dialogShown } from '../core/agent-launch';

/**
 * ask_user: a project's orchestrator asks the user a question on their Telegram, through their Hermes (the relay,
 * DESIGN-RELAIS-HERMES-V2.md), and their answer is typed into that orchestrator's terminal.
 *
 * - Only an orchestrator asks (JeanBrasse's rule of 2026-10-01): a worker asks its orchestrator, which decides whether to
 *   ask the user, and passes the answer on.
 * - A question is recorded (id, agent, time, expiry) and sent through the relay as plain text under the agent's and
 *   the project's names, every line of the agent's words quoted, so none can pass for Tars's own, and every secret
 *   masked. Hermes down: it waits, the agent is told it has not gone, and it goes when Hermes takes it.
 * - The user answers with Telegram's "reply" on that very message. The tars-relay plugin keeps it from Hermes's model,
 *   and Tars takes it only as a reply to a message on its own list of what it sent (hermes-relay.ts).
 * - The answer is typed into the asking agent's terminal through the writer every message takes (its dialog guard
 *   included), after a line only Tars writes, "Message from the user via Telegram: " (senderLine): the answer alone,
 *   never the question, named by the time it was asked. Into a CLI only: an agent with no CLI running is not typed
 *   into, and the user is told.
 * - One open question per agent, 20 a day for the whole fleet, and 4 hours to answer: then the agent is told there was
 *   no answer, by the time it asked, never by its words, and a later reply is refused.
 * - Kept in ~/.tars-private (0600), not in ~/.dorothy, which every agent can write: a record rewritten there would
 *   send their answer to another agent.
 */

export const QUESTION_LIFETIME_MS = 4 * 3_600_000;
export const QUESTIONS_PER_DAY = 20;
export const MAX_QUESTION = 2_000;
export const MAX_CONTEXT = 4_000;
const DAY_MS = 24 * 3_600_000;
const TELEGRAM_MAX_UNITS = 4096;
const FILE = () => privatePath('user-questions.json');

interface Question {
  id: string;
  agentId: string;
  agentName: string;
  projectPath: string;
  question: string;
  context?: string;
  askedAt: number;
  expiresAt: number;
  state: 'open' | 'answered' | 'expired';
}

function load(): Question[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE(), 'utf-8'));
    return Array.isArray(parsed) ? parsed as Question[] : [];
  } catch {
    return [];
  }
}

function save(list: Question[], now: number): void {
  // What is still open, and what counts towards the day's limit.
  const kept = list.filter(q => q.state === 'open' || q.askedAt > now - DAY_MS);
  try {
    writeSecretFileSync(FILE(), JSON.stringify(kept));
  } catch (err) {
    console.error('[ask_user] could not record the questions:', err instanceof Error ? err.message : err);
  }
}

export function openQuestionOf(agentId: string): Question | undefined {
  return load().find(q => q.agentId === agentId && q.state === 'open');
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const units = (s: string) => Buffer.byteLength(s, 'utf16le') / 2;
const oneLine = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
/** Every line quoted: no line of the agent's can pass for one of Tars's. */
const quoted = (s: string) => redactSecrets(s).split(/\r?\n/).map(line => `> ${line}`).join('\n');

/** The question as the user reads it, within what Telegram takes: the context is cut first. */
function compose(q: Question): string {
  const head = `Question from ${oneLine(q.agentName)}, project ${oneLine(path.basename(q.projectPath) || q.projectPath)}:`;
  const tail = `Reply to this message to answer: your reply is typed into ${oneLine(q.agentName)}'s terminal. Open until ${clock(q.expiresAt)}.`;
  const body = quoted(q.question);
  if (!q.context) return [head, body, '', tail].join('\n');
  const without = [head, body, 'Context:', '', tail].join('\n');
  let context = quoted(q.context);
  const room = TELEGRAM_MAX_UNITS - units(without) - 1;
  if (units(context) > room) {
    const cut = '\n> ...(cut)';
    while (context && units(context) + units(cut) > room) context = context.slice(0, Math.max(0, context.length - 64));
    context += cut;
  }
  return [head, body, 'Context:', context, '', tail].join('\n');
}

export type AskResult =
  | { ok: true; id: string; expiresAt: string; queued?: true; reason?: string }
  | { ok: false; status: number; error: string };

export async function askUser(
  input: { agentId: string; question: string; context?: string },
  now: number = Date.now(),
): Promise<AskResult> {
  const agent = agents.get(input.agentId);
  if (!agent) return { ok: false, status: 404, error: 'The asking agent is not one Tars knows about.' };
  if (!isSuperAgent(agent)) {
    return { ok: false, status: 403, error: 'Only a project\'s orchestrator asks the user. Ask your orchestrator: it decides whether to ask them, and passes their answer on.' };
  }
  const question = input.question.trim();
  const context = input.context?.trim() || undefined;
  if (!question || question.length > MAX_QUESTION) return { ok: false, status: 400, error: `A question is 1 to ${MAX_QUESTION} characters.` };
  if (context && context.length > MAX_CONTEXT) return { ok: false, status: 400, error: `The context is at most ${MAX_CONTEXT} characters.` };

  expireUserQuestions(now);
  const list = load();
  const open = list.find(q => q.agentId === agent.id && q.state === 'open');
  if (open) {
    return {
      ok: false, status: 409,
      error: `You already have a question open for the user, until ${new Date(open.expiresAt).toISOString()}. Their answer will be typed into your terminal; ask again once it is answered or has expired.`,
    };
  }
  if (list.filter(q => q.askedAt > now - DAY_MS).length >= QUESTIONS_PER_DAY) {
    return { ok: false, status: 429, error: `The user has been asked ${QUESTIONS_PER_DAY} questions in the last 24 hours, the most Tars sends. Decide without them, or ask later.` };
  }

  const record: Question = {
    id: randomUUID(),
    agentId: agent.id,
    agentName: agent.name || agent.id,
    projectPath: agent.projectPath,
    question,
    context,
    askedAt: now,
    expiresAt: now + QUESTION_LIFETIME_MS,
    state: 'open',
  };
  // Recorded before it is sent, so a second call from the same agent while
  // this one waits on Hermes is refused rather than sent too.
  save([...list, record], now);
  const sent = await relaySend({ text: compose(record), kind: 'question', ref: `question:${record.id}`, projectPath: record.projectPath, expiresAt: record.expiresAt }, now);
  if (sent.state === 'refused') {
    save(load().filter(q => q.id !== record.id), now);
    return { ok: false, status: 503, error: `The user cannot be asked: ${sent.reason}` };
  }
  const expiresAt = new Date(record.expiresAt).toISOString();
  return sent.state === 'queued'
    ? { ok: true, id: record.id, expiresAt, queued: true, reason: sent.reason }
    : { ok: true, id: record.id, expiresAt };
}

/** The user's reply to a question, from the relay, which has checked it answers a message Tars sent. */
async function answerQuestion(reply: RelayReply, now: number): Promise<void> {
  expireUserQuestions(now);
  const list = load();
  const q = list.find(x => x.id === reply.refId);
  const tell = (text: string) => tellUser(text, q?.projectPath ?? reply.projectPath, now);
  if (!q) {
    await tell('That question is no longer one Tars keeps, so your reply reached nobody.');
    return;
  }
  if (q.state !== 'open') {
    await tell(q.state === 'answered'
      ? `That question from ${q.agentName} is closed: it was already answered.`
      : `That question from ${q.agentName} is closed: it expired at ${clock(q.expiresAt)}, and ${q.agentName} was told there was no answer.`);
    return;
  }
  const answer = reply.text.trim();
  if (!answer) {
    await tell('Only a text reply is typed into the agent\'s terminal.');
    return;
  }
  const agent = agents.get(q.agentId);
  const terminal = agent?.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  if (!agent || !cliRunningIn(terminal)) {
    await tell(`Not delivered: ${q.agentName} has no session running. The question stays open until ${clock(q.expiresAt)}; reply again once it runs.`);
    return;
  }
  // Their answer alone, never the question: the agent wrote the question, and
  // typed back under the user's sender line it would be the user's words, newlines and a
  // look-alike sender line included (the Audit's gate of #231). The question
  // is named by the time it was asked.
  let heldForPerson = false;
  const outcome = writeProgrammaticInput(terminal!, `Answer to the question you asked at ${clock(q.askedAt)}:\n${answer}`, true, {
    agentId: agent.id,
    onHeld: () => { heldForPerson = true; },
    from: 'the user via Telegram',
    sender: { kind: 'user', via: 'Telegram' },
    // Held, then dropped because the CLI stopped meanwhile: the question is
    // open again, and the user is told.
    onDropped: () => {
      save(load().map(x => (x.id === q.id && x.state === 'answered' ? { ...x, state: 'open' as const } : x)), Date.now());
      void tellUser(`Not delivered: ${q.agentName}'s session stopped before your answer could go in. The question stays open until ${clock(q.expiresAt)}; reply again once it runs.`, q.projectPath);
    },
  });
  if (outcome === 'refused') {
    await tell(`Not delivered: ${q.agentName}'s terminal is not taking messages. The question stays open until ${clock(q.expiresAt)}.`);
    return;
  }
  save(list.map(x => (x.id === q.id ? { ...x, state: 'answered' as const } : x)), now);
  const heldBy = outcome !== 'held' ? undefined
    : dialogShown(agent, terminal) ? 'dialog' as const : heldForPerson ? 'draft' as const : undefined;
  await tell(receiptFor(q.agentName, heldBy));
}

/**
 * Ends the questions whose time is up, and tells each agent: there was no answer, or the question never reached the
 * user. By the time it was asked, never by its words, which the agent wrote: typed back under Tars's line, they
 * would be Tars's (the gate of #231).
 */
export function expireUserQuestions(now: number = Date.now()): void {
  const list = load();
  const due = list.filter(q => q.state === 'open' && q.expiresAt <= now);
  if (due.length === 0) return;
  for (const q of due) {
    const agent = agents.get(q.agentId);
    const terminal = agent?.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
    if (agent && cliRunningIn(terminal)) {
      const words = relayWasSent(`question:${q.id}`)
        ? `The user did not answer your question asked at ${clock(q.askedAt)} within 4 hours. Carry on without their answer, or ask again.`
        : `Your question asked at ${clock(q.askedAt)} could not reach the user: Hermes did not take it within 4 hours. Carry on without their answer, or ask again.`;
      writeProgrammaticInput(terminal!, words, true, { agentId: agent.id, from: 'Tars', sender: { kind: 'tars' } });
    }
  }
  const ids = new Set(due.map(q => q.id));
  save(list.map(q => (ids.has(q.id) ? { ...q, state: 'expired' as const } : q)), now);
}

let sweep: NodeJS.Timeout | undefined;

/**
 * Takes the user's replies to questions from the relay, and checks for expired questions every minute, for as long as
 * Tars runs. `sweep: false` leaves the check to the caller (tests).
 */
export function startUserQuestions(opts: { sweep?: boolean } = {}): void {
  onRelayReply('question', answerQuestion);
  if (opts.sweep === false || sweep) return;
  sweep = setInterval(() => expireUserQuestions(), 60_000);
  sweep.unref?.();
}
