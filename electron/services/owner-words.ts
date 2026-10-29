/**
 * The owner's words Tars holds, and who may relay them (2.0.6, option e; SECURITY.md §8).
 *
 * What the window sends to a chat, and what the Hermes relay brings from the owner's private Telegram chat, are
 * recorded here as Tars receives them: a random id, the text as received, when, how, and the project they were
 * addressed to. In memory only: a restart forgets them, and nothing is ever written where an agent can write. An agent
 * with an orchestrator's powers in that project may have Tars relay them, by id, to an orchestrator, once per receiver,
 * within OWNER_WORDS_TTL_MS; Tars types the record itself, under a sender line only it writes (core/pty-manager.ts,
 * the `owner-relay` sender).
 */
import { randomBytes } from 'crypto';

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
}

/** Who relays, or receives: an agent of the fleet, as the route reads it. */
export interface OwnerWordsParty {
  id: string;
  projectPath?: string;
  /** Whether the agent has an orchestrator's powers (core/agent-role.ts). */
  orchestrator: boolean;
}

export type RelayRefusal = { status: number; code: string; error: string };

export function createOwnerWords(deps: { now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  const held: Array<OwnerWords & { relayedTo: Set<string> }> = [];
  const copy = (w: OwnerWords): OwnerWords => ({ id: w.id, text: w.text, at: w.at, via: w.via, projectPath: w.projectPath });
  const refused = (status: number, code: string, error: string): RelayRefusal => ({ status, code, error });

  return {
    /** Records words the owner sent, as Tars received them. */
    record(input: { text: string; via: OwnerWordsVia; projectPath: string }): OwnerWords {
      const words = { ...input, id: `ow-${randomBytes(6).toString('hex')}`, at: now(), relayedTo: new Set<string>() };
      held.push(words);
      if (held.length > OWNER_WORDS_MAX) held.splice(0, held.length - OWNER_WORDS_MAX);
      return copy(words);
    },
    /** The words addressed to a project, newest first, as copies. */
    listFor(projectPath: string): OwnerWords[] {
      return held.filter((w) => w.projectPath === projectPath).reverse().map(copy);
    },
    /** May `by` relay these words to `to`? The record, as a copy, when it may; once per receiver. */
    relay(id: string, parties: { by: OwnerWordsParty; to: OwnerWordsParty }): { ok: true; words: OwnerWords } | RelayRefusal {
      const words = held.find((w) => w.id === id);
      if (!words) return refused(404, 'owner_words_unknown', 'Tars holds no owner words of that id: it gives the ids itself (owner_words), and forgets them when it restarts.');
      const { by, to } = parties;
      if (!by.orchestrator || by.projectPath !== words.projectPath) {
        return refused(403, 'owner_words_not_yours', "Only an orchestrator of the project the owner wrote to relays the owner's words.");
      }
      if (!to.orchestrator) return refused(400, 'owner_words_to_orchestrators', "The owner's words are relayed to an orchestrator only.");
      if (now() - words.at > OWNER_WORDS_TTL_MS) {
        return refused(410, 'owner_words_stale', `These words are more than ${OWNER_WORDS_TTL_MS / 3_600_000} hours old: ask the owner again.`);
      }
      if (words.relayedTo.has(to.id)) return refused(409, 'owner_words_already_relayed', 'These words were relayed to that agent already.');
      words.relayedTo.add(to.id);
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
