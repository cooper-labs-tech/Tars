/**
 * The owner's words Tars holds, and who may relay them (2.0.6, option e; SECURITY.md §8).
 *
 * What the window sends to a chat, and what the Hermes relay brings from the owner's private Telegram chat, are
 * recorded here as Tars receives them: a random id, the text as received, when, how, the project they were addressed
 * to, the chat when a chat received them, what they were (an answer, a reply, a message to the project) and, for an
 * answer, the question. In memory only: a restart forgets them, and nothing is ever written where an agent can write.
 * Those who could have received them may have Tars relay them, by id, to an orchestrator, once per receiver, within
 * OWNER_WORDS_TTL_MS: the project's orchestrator, and the runner of the chat they went to (every chat's runner when
 * the chats read each other). Tars types the record itself, under a sender line only it writes (core/pty-manager.ts,
 * the `owner-relay` sender), and a receiver can read back what was relayed to it (`relayedTo`).
 */
import { randomBytes } from 'crypto';
import { envelopeValue } from '../utils/envelope-value';
import { twoZones } from '../utils/two-zones';

/** Words older than this are not relayed: a receiver would take old words for fresh ones. */
export const OWNER_WORDS_TTL_MS = 24 * 3_600_000;
/** The most words held; the oldest go first. */
export const OWNER_WORDS_MAX = 200;
/**
 * How long a line typed into an orchestrator's terminal waits for its CLI to say it took it as a prompt (2.0.7): the
 * hook comes some 40 ms after an Enter at rest (input-draft.ts), and only a line typed at rest waits (typedAtRest).
 * It was 10 minutes, all the time a forged hook needed (the Audit's L1 on #594).
 */
export const OWNER_TYPED_PENDING_MS = 60_000;

/**
 * Whether a line the owner just submitted into that agent's terminal may wait for its confirmation (the Audit's L1 on
 * #594): only with the CLI at rest at its prompt (idle, completed, failed, or waiting at its idle prompt), never in a
 * turn (the line is queued, or answers what the turn shows), with a dialog or a question open, or a permission
 * question held by Tars. The hook that confirms it carries the agent's own token: a prompt-injected agent could
 * otherwise confirm a "yes" its owner typed to a dialog Tars did not see.
 */
export function typedAtRest(
  agent: { status?: string; waitingReason?: string; permissionAsk?: unknown; currentSessionId?: string },
  dialogShown: boolean,
  /**
   * The agent's rest as Tars itself read it (restFromReadings), in its current session. The status alone is what
   * the agent posts, and it can post "idle" mid-turn (the Audit's re-read at f211ff380); so can its Stop, with its own
   * token (the re-read at 82f13ebd2): neither is a reading of Tars's.
   */
  rest: { session: string } | undefined,
): boolean {
  if (dialogShown || agent.permissionAsk) return false;
  if (!rest || !agent.currentSessionId || rest.session !== agent.currentSessionId) return false;
  if (agent.status === 'waiting') return agent.waitingReason === 'idle';
  return agent.status === 'idle' || agent.status === 'completed' || agent.status === 'error';
}
/** The most lines that wait, per agent; the oldest go first. */
export const OWNER_TYPED_PENDING_MAX = 20;
/**
 * The shortest prompt that may stand for a longer typed line: the hooks carry the first 200 characters (the state
 * mod) or 200 bytes (the shell hook), never fewer than this many bytes once the cut character is dropped.
 */
const HOOK_CUT_MIN_BYTES = 150;

export type OwnerWordsVia = 'window' | 'terminal' | 'Telegram';

export interface OwnerWords {
  id: string;
  text: string;
  /** When Tars received them, in ms. */
  at: number;
  via: OwnerWordsVia;
  /** The project the owner addressed them to. */
  projectPath: string;
  /** The chat that received them, when one did: only its runner, and the project's orchestrator, may relay them. */
  chatId?: string;
  /** What they were, in Tars's words, as the mark says it: "an answer to a question", "a reply to ...". */
  about?: string;
  /** The question they answer, as its asker wrote it, who asked it and when. */
  question?: { text: string; by: string; at: number };
}

/** Who relays, or receives: an agent of the fleet, as the route reads it. */
export interface OwnerWordsParty {
  id: string;
  name?: string;
  projectPath?: string;
  /** Whether the agent has an orchestrator's powers (core/agent-role.ts): every chat's runner has them. */
  orchestrator: boolean;
  /** Whether it is the project's orchestrator itself, its role (Main's runner). */
  projectOrchestrator?: boolean;
  /** The chat it runs, for a chat's runner. */
  chatId?: string;
  /** The owner lets the project's chats read each other (chatsReadEachOther). */
  readsAllChats?: boolean;
}

/** Words relayed to an agent, as it can read them back: by whom, and when. */
export type RelayedWords = OwnerWords & { by: { id: string; name?: string }; relayedAt: number };

export type RelayRefusal = { status: number; code: string; error: string };

/** What Tars types under the mark: the words, after the question they answer when they answer one. */
export function relayedBody(words: OwnerWords): string {
  if (!words.question) return words.text;
  const q = words.question;
  return `In answer to the question ${envelopeValue(q.text)} that ${envelopeValue(q.by)} asked at ${twoZones(q.at)}:\n${words.text}`;
}

/**
 * Could `party` have received these words? The project's orchestrator, the runner of the chat they went to, or, with
 * the chats reading each other, every chat's runner of the project. Never a worker, never another project
 * (the Audit's M2 on #569: every chat's runner has an orchestrator's powers).
 */
function mayHold(party: OwnerWordsParty, words: OwnerWords): boolean {
  if (!party.orchestrator || party.projectPath !== words.projectPath) return false;
  if (party.projectOrchestrator || party.readsAllChats) return true;
  return !!words.chatId && party.chatId === words.chatId;
}

/**
 * An agent's rest from what Tars reads itself, never from what the agent posts (the Audit's re-read of #594 at
 * 82f13ebd2): for the claude binary, its transcript's tail in the current session with no turn on record (Claude Code's
 * turn_duration, or the interrupt marker, after the last prompt) and nothing queued (status-truth.ts turnRecordOf);
 * for codex and pi, the turn's end their watcher read in the current session's log (cli-rest.ts); for every other CLI
 * (Qwen Code, whose transcript writes no turn end, gemini, opencode, amp, grok), none. No reading is no rest.
 */
export function restFromReadings(r: {
  cli: 'transcript' | 'session-log' | 'none';
  session?: string;
  record?: { inTurn: boolean; queued?: boolean };
  logRestSession?: string;
}): { session: string } | undefined {
  if (!r.session) return undefined;
  if (r.cli === 'transcript') return r.record && !r.record.inTurn && !r.record.queued ? { session: r.session } : undefined;
  if (r.cli === 'session-log') return r.logRestSession === r.session ? { session: r.session } : undefined;
  return undefined;
}

/** A typed line or a prompt, as compared: CR line breaks as LF, the spaces at its ends and a character the hook cut dropped. */
function typedForm(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\uFFFD+$/, '').trim();
}

/** Where a typed line belongs: the agent's project, and its chat for a chat's runner. */
export interface TypedScope { projectPath: string; chatId?: string }

export function createOwnerWords(deps: { now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  const held: Array<OwnerWords & { relayedTo: Map<string, { by: { id: string; name?: string }; at: number }> }> = [];
  /** Lines typed into an orchestrator's terminal, by agent, waiting for its CLI to take them as a prompt. */
  const typedLines = new Map<string, Array<{ text: string; scope: TypedScope; at: number }>>();

  const copy = (w: OwnerWords): OwnerWords => ({
    id: w.id, text: w.text, at: w.at, via: w.via, projectPath: w.projectPath,
    ...(w.chatId ? { chatId: w.chatId } : {}), ...(w.about ? { about: w.about } : {}),
    ...(w.question ? { question: { ...w.question } } : {}),
  });
  const refused = (status: number, code: string, error: string): RelayRefusal => ({ status, code, error });
  const record = (input: Omit<OwnerWords, 'id' | 'at'>): OwnerWords => {
    const words = { ...input, id: `ow-${randomBytes(6).toString('hex')}`, at: now(), relayedTo: new Map() };
    held.push(words);
    if (held.length > OWNER_WORDS_MAX) held.splice(0, held.length - OWNER_WORDS_MAX);
    return copy(words);
  };

  return {
    /**
     * A line the owner typed by hand into that agent's terminal (core/input-draft.ts typedLines): held, not recorded,
     * until its CLI says it took it as a prompt (confirmTyped). The caller has checked the agent is an orchestrator.
     */
    typed(agentId: string, text: string, scope: TypedScope): void {
      const line = typedForm(text);
      if (!line) return;
      const fresh = (typedLines.get(agentId) ?? []).filter((p) => now() - p.at <= OWNER_TYPED_PENDING_MS);
      fresh.push({ text: line, scope: { ...scope }, at: now() });
      typedLines.set(agentId, fresh.slice(-OWNER_TYPED_PENDING_MAX));
    },
    /**
     * That agent's CLI took a prompt (its UserPromptSubmit): the oldest line waiting that is this prompt, or whose start
     * it is when the hook cut it, is recorded, from the keys, whole, and no longer waits. Nothing waiting, nothing
     * recorded: a hook confirms a line, it never supplies one.
     */
    confirmTyped(agentId: string, prompt: string | undefined): OwnerWords | undefined {
      const waiting = (typedLines.get(agentId) ?? []).filter((p) => now() - p.at <= OWNER_TYPED_PENDING_MS);
      const said = typedForm(prompt ?? '');
      const at = !said ? -1 : waiting.findIndex((p) => p.text === said
        || (Buffer.byteLength(said, 'utf8') >= HOOK_CUT_MIN_BYTES && p.text.startsWith(said)));
      if (at < 0) {
        if (waiting.length) typedLines.set(agentId, waiting); else typedLines.delete(agentId);
        return undefined;
      }
      const [line] = waiting.splice(at, 1);
      if (waiting.length) typedLines.set(agentId, waiting); else typedLines.delete(agentId);
      return record({ text: line.text, via: 'terminal', projectPath: line.scope.projectPath, ...(line.scope.chatId ? { chatId: line.scope.chatId } : {}) });
    },
    /** Records words the owner sent, as Tars received them. */
    record,
    /** The words `party` could have received, newest first, as copies. */
    listFor(party: OwnerWordsParty): OwnerWords[] {
      return held.filter((w) => mayHold(party, w)).reverse().map(copy);
    },
    /** The words relayed to that agent, newest first: what it can check a mark against (the Audit's M1 on #569). */
    relayedTo(agentId: string): RelayedWords[] {
      return held.flatMap((w) => {
        const relay = w.relayedTo.get(agentId);
        return relay ? [{ ...copy(w), by: { ...relay.by }, relayedAt: relay.at }] : [];
      }).reverse();
    },
    /** May `by` relay these words to `to`? The record, as a copy, when it may; once per receiver. */
    relay(id: string, parties: { by: OwnerWordsParty; to: OwnerWordsParty }): { ok: true; words: OwnerWords } | RelayRefusal {
      const words = held.find((w) => w.id === id);
      if (!words) return refused(404, 'owner_words_unknown', 'Tars holds no owner words of that id: it gives the ids itself (owner_words), and forgets them when it restarts.');
      const { by, to } = parties;
      if (!mayHold(by, words)) {
        return refused(403, 'owner_words_not_yours', "Only the project's orchestrator, or the runner of the chat the owner wrote in, relays the owner's words.");
      }
      if (!to.orchestrator) return refused(400, 'owner_words_to_orchestrators', "The owner's words are relayed to an orchestrator only.");
      if (now() - words.at > OWNER_WORDS_TTL_MS) {
        return refused(410, 'owner_words_stale', `These words are more than ${OWNER_WORDS_TTL_MS / 3_600_000} hours old: ask the owner again.`);
      }
      if (words.relayedTo.has(to.id)) return refused(409, 'owner_words_already_relayed', 'These words were relayed to that agent already.');
      words.relayedTo.set(to.id, { by: { id: by.id, ...(by.name ? { name: by.name } : {}) }, at: now() });
      return { ok: true, words: copy(words) };
    },
    /** The relay to `toId` was not delivered (its terminal refused it): it may be made again. */
    undelivered(id: string, toId: string): void {
      held.find((w) => w.id === id)?.relayedTo.delete(toId);
    },
  };
}

/** The process's own: what the window and the relay record, and the relay route reads. */
export const ownerWords = createOwnerWords();
