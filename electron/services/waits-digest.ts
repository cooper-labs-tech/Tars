/**
 * What still waits, told its sender in one digest (2.0.6, option b).
 *
 * A message held in a terminal (its field in use, a dialog open) or sent to wait behind an agent's work used to tell
 * its sender on its own, a few minutes on ("still not in its terminal", "still waits for its work to end"): an
 * orchestrator that sent ten messages to busy workers was woken ten times. Each such message is tracked here instead,
 * and its sender is told at most once per DIGEST_EVERY_MS, one line per message still waiting: to whom, since when,
 * why. A notice goes only when one of its lines is new, so a sender is never woken with nothing new. The window reads
 * none of it: it shows held messages per agent, and queued tasks in the agent's queue, already.
 */
import { envelopeValue } from '../utils/envelope-value';
import { twoZones } from '../utils/two-zones';

const askedMinute = Number(process.env.DOROTHY_WAITS_MINUTE_MS);
/**
 * A minute of the waits' clock: 60 s; a test run may ask for a shorter one (DOROTHY_WAITS_MINUTE_MS, under DOROTHY_E2E
 * only, 200 ms at least). The wait of a held message (3), of one behind work (10) and the digest's period (30) are
 * counted in it.
 */
export const WAITS_MINUTE_MS = process.env.DOROTHY_E2E === '1' && Number.isFinite(askedMinute) && askedMinute >= 200 ? askedMinute : 60_000;

/** A sender hears of what it sent that still waits at most this often. */
export const DIGEST_EVERY_MS = 30 * WAITS_MINUTE_MS;

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

/** UTC first, then the machine's own, as every notice Tars types into an agent (utils/two-zones.ts, 2.0.6). */
const clockOf = (ms: number) => twoZones(ms);
const reasonOf = (wait: WaitInput) => (typeof wait.reason === 'function' ? wait.reason() : wait.reason);

function lineOf(wait: Wait, now: number): string {
  const name = envelopeValue(wait.targetName || wait.targetId);
  const minutes = Math.max(1, Math.round((now - wait.sentAt) / WAITS_MINUTE_MS));
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

  /**
   * One pending review per sender, at the earliest moment any of its messages needs looking at: each review asked for
   * one more per held message whose target was in a turn, and they multiplied every 3 minutes (the Audit's H1 on #562).
   */
  const pending = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  const reviewAt = (senderId: string, at: number) => {
    const held = pending.get(senderId);
    if (held && held.at <= at) return;
    if (held) clearTimeout(held.timer);
    const timer = setTimeout(() => {
      pending.delete(senderId);
      review(senderId);
    }, Math.max(0, at - Date.now()));
    timer.unref?.();
    pending.set(senderId, { at, timer });
  };
  const isDue = (wait: Wait, now: number) => now - wait.sentAt >= wait.dueAfterMs && (wait.ready?.() ?? true);

  /** Tells the sender, if a line is new and its window is open; else looks again when it may. */
  function review(senderId: string): void {
    const now = Date.now();
    const mine = [...waits.values()].filter((w) => w.senderId === senderId);
    for (const w of mine) {
      if (w.told) continue;
      // Not due yet: looked at when it is (its own time may have been taken by an earlier one's).
      if (now - w.sentAt < w.dueAfterMs) reviewAt(senderId, w.sentAt + w.dueAfterMs);
      // Not yet tellable (a target in a turn): looked at again after the same wait.
      else if (!(w.ready?.() ?? true)) reviewAt(senderId, now + w.dueAfterMs);
    }
    const due = mine.filter((w) => isDue(w, now));
    if (!due.some((w) => !w.told)) return;
    const last = toldAt.get(senderId);
    if (last !== undefined && now - last < DIGEST_EVERY_MS) {
      reviewAt(senderId, last + DIGEST_EVERY_MS);
      return;
    }
    for (const w of due) w.told = true;
    toldAt.set(senderId, now);
    deps.tell(senderId, [
      `[Tars] Your messages not yet in their terminal, as of ${clockOf(now)} (Tars tells you at most every ${DIGEST_EVERY_MS / WAITS_MINUTE_MS} minutes):`,
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
      reviewAt(wait.senderId, wait.sentAt + wait.dueAfterMs);
      return () => {
        if (waits.delete(wait.id)) deps.changed?.();
      };
    },
    /** Test seam: the digest is process memory, and a test that drives several fleets through one module needs it empty. */
    reset(): void {
      waits.clear();
      toldAt.clear();
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
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
