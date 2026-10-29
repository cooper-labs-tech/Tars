/**
 * What still waits, told its sender in one digest (2.0.6, option b).
 *
 * A message held in a terminal (its field in use, a dialog open) or sent to wait behind an agent's work used to tell
 * its sender on its own, a few minutes on ("still not in its terminal", "still waits for its work to end"): an
 * orchestrator that sent ten messages to busy workers was woken ten times. Each such message is tracked here instead,
 * and its sender is told at most once per DIGEST_EVERY_MS, one line per message still waiting: to whom, since when,
 * why. A notice goes only when one of its lines is new, so a sender is never woken with nothing new. The window reads
 * the same list (`waits:list`) and is told when it changes (`waits:changed`), which wakes nobody.
 */
import { envelopeValue } from '../utils/envelope-value';

/** A sender hears of what it sent that still waits at most this often. */
export const DIGEST_EVERY_MS = 30 * 60_000;

export type WaitWhy = 'held' | 'behind-work';

export interface WaitInput {
  /** The agent that sent the message, and is told. */
  senderId: string;
  targetId: string;
  targetName: string;
  /** When it was sent, in ms. */
  sentAt: number;
  why: WaitWhy;
  /** Held: why the terminal holds it, read when it is told (a dialog may have opened since). */
  reason?: string | (() => string);
  /** How long it waits before it is worth a line. */
  dueAfterMs: number;
  /** False while the line may not be told yet: a held message whose target is in a turn, where somebody may be typing. */
  ready?: () => boolean;
}

/** One waiting message, as the window reads it. */
export interface WaitView {
  id: string;
  senderId: string;
  targetId: string;
  targetName: string;
  sentAt: string;
  why: WaitWhy;
  reason?: string;
  /** Whether a digest has told its sender of it yet. */
  told: boolean;
}

interface Wait extends WaitInput {
  id: string;
  told: boolean;
}

export interface WaitsDigestDeps {
  /** Types the digest into the sender's terminal. */
  tell: (senderId: string, text: string) => void;
  /** The list changed: the window is told. */
  changed?: () => void;
}

const clockOf = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const reasonOf = (wait: WaitInput) => (typeof wait.reason === 'function' ? wait.reason() : wait.reason);

function lineOf(wait: Wait, now: number): string {
  const name = envelopeValue(wait.targetName || wait.targetId);
  const minutes = Math.max(1, Math.round((now - wait.sentAt) / 60_000));
  if (wait.why === 'behind-work') {
    return `- your message to ${name} of ${clockOf(wait.sentAt)} still waits for ${name}'s work to end, ${minutes} minutes on: `
      + 'it goes in at its next rest. Nothing needs resending.';
  }
  return `- your message to ${name} of ${clockOf(wait.sentAt)} is still not in its terminal, ${minutes} minutes on. `
    + `${reasonOf(wait) ?? ''} Only a person at that terminal can end this wait: if nobody is there, tell the user, `
    + `or stop ${name} and start it again, which drops the message, and send it again then.`;
}

export function createWaitsDigest(deps: WaitsDigestDeps) {
  const waits = new Map<string, Wait>();
  /** When each sender was last told. */
  const toldAt = new Map<string, number>();
  let nextId = 0;

  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, Math.max(0, ms));
    timer.unref?.();
  };
  const isDue = (wait: Wait, now: number) => now - wait.sentAt >= wait.dueAfterMs && (wait.ready?.() ?? true);

  /** Tells the sender, if a line is new and its window is open; else looks again when it may. */
  function review(senderId: string): void {
    const now = Date.now();
    const mine = [...waits.values()].filter((w) => w.senderId === senderId);
    // Not yet tellable (a target in a turn): looked at again after the same wait.
    for (const w of mine) if (!w.told && now - w.sentAt >= w.dueAfterMs && !(w.ready?.() ?? true)) later(() => review(senderId), w.dueAfterMs);
    const due = mine.filter((w) => isDue(w, now));
    if (!due.some((w) => !w.told)) return;
    const last = toldAt.get(senderId);
    if (last !== undefined && now - last < DIGEST_EVERY_MS) {
      later(() => review(senderId), last + DIGEST_EVERY_MS - now);
      return;
    }
    for (const w of due) w.told = true;
    toldAt.set(senderId, now);
    deps.tell(senderId, [
      `[Tars] Your messages not yet in their terminal, as of ${clockOf(now)} (Tars tells you at most every ${DIGEST_EVERY_MS / 60_000} minutes):`,
      ...due.map((w) => lineOf(w, now)),
    ].join('\n'));
    deps.changed?.();
  }

  return {
    /** Tracks a waiting message; returns what ends it, once it went in or was dropped. */
    track(input: WaitInput): () => void {
      const wait: Wait = { ...input, id: `w${++nextId}`, told: false };
      waits.set(wait.id, wait);
      deps.changed?.();
      later(() => review(wait.senderId), wait.sentAt + wait.dueAfterMs - Date.now());
      return () => {
        if (waits.delete(wait.id)) deps.changed?.();
      };
    },
    /** Test seam: the digest is process memory, and a test that drives several fleets through one module needs it empty. */
    reset(): void {
      waits.clear();
      toldAt.clear();
    },
    list(): WaitView[] {
      return [...waits.values()].map((w) => {
        const reason = reasonOf(w);
        return {
          id: w.id, senderId: w.senderId, targetId: w.targetId, targetName: w.targetName, sentAt: new Date(w.sentAt).toISOString(),
          why: w.why, ...(reason ? { reason } : {}), told: w.told,
        };
      });
    },
  };
}
