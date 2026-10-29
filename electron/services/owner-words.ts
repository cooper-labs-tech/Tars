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

export type OwnerWordsVia = 'window' | 'Telegram';

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

export function createOwnerWords(deps: { now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  const held: Array<OwnerWords & { relayedTo: Map<string, { by: { id: string; name?: string }; at: number }> }> = [];
  const copy = (w: OwnerWords): OwnerWords => ({
    id: w.id, text: w.text, at: w.at, via: w.via, projectPath: w.projectPath,
    ...(w.chatId ? { chatId: w.chatId } : {}), ...(w.about ? { about: w.about } : {}),
    ...(w.question ? { question: { ...w.question } } : {}),
  });
  const refused = (status: number, code: string, error: string): RelayRefusal => ({ status, code, error });

  return {
    /** Records words the owner sent, as Tars received them. */
    record(input: Omit<OwnerWords, 'id' | 'at'>): OwnerWords {
      const words = { ...input, id: `ow-${randomBytes(6).toString('hex')}`, at: now(), relayedTo: new Map() };
      held.push(words);
      if (held.length > OWNER_WORDS_MAX) held.splice(0, held.length - OWNER_WORDS_MAX);
      return copy(words);
    },
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
