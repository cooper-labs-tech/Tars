import '../../setup/home-guard';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * What the overseer may send without asking.
 *
 * The write gate does not move: nothing reaches a CLI except through
 * `confirmPendingAction`. A rule here says a particular proposal counts as
 * already approved, so what has to be right is the refusal. Two states must
 * never be written to automatically, and neither is a matter of taste:
 *
 * - a running agent, because typing into a session mid-task interleaves with
 *   what it is doing;
 * - one blocked on a permission dialog, because that dialog wants arrow keys
 *   and the delayed carriage return Tars sends could accept the very
 *   permission being asked about.
 *
 * The rules resolve against the live agent map, never the snapshot the model
 * was shown, so an agent that has moved on since the proposal was written is
 * judged on where it is now.
 */

const agents = new Map<string, Record<string, unknown>>();
vi.mock('../../../electron/core/agent-manager', () => ({ agents }));

let auto: typeof import('../../../electron/services/overseer-auto');

const NOW = Date.parse('2026-08-24T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

beforeEach(async () => {
  agents.clear();
  auto = await import('../../../electron/services/overseer-auto');
});

const put = (over: Record<string, unknown> = {}) => {
  agents.set('a1', { id: 'a1', status: 'waiting', lastActivity: minutesAgo(10), ...over });
};

describe('nothing is authorised by default', () => {
  it('returns no rule when the list is empty', () => {
    put();
    expect(auto.findAutoRule([], { agentId: 'a1' }, NOW)).toBeNull();
  });

  it('ignores a rule id it does not know', () => {
    put();
    expect(auto.findAutoRule(['nudge-everything'], { agentId: 'a1' }, NOW)).toBeNull();
  });
});

describe('nudging an agent that is waiting', () => {
  const on = ['nudge-waiting'];

  it('authorises one that has been waiting long enough', () => {
    put({ status: 'waiting', lastActivity: minutesAgo(10) });
    expect(auto.findAutoRule(on, { agentId: 'a1' }, NOW)?.id).toBe('nudge-waiting');
  });

  it('refuses one that has only just asked', () => {
    // Answering within seconds is not unsticking it, it is interrupting.
    put({ status: 'waiting', lastActivity: minutesAgo(1) });
    expect(auto.findAutoRule(on, { agentId: 'a1' }, NOW)).toBeNull();
  });

  it('refuses one blocked on a permission dialog, however long it has been', () => {
    // Typed text cannot answer it, and the carriage return could accept it.
    put({ status: 'waiting', waitingReason: 'permission', lastActivity: minutesAgo(120) });
    expect(auto.findAutoRule(on, { agentId: 'a1' }, NOW)).toBeNull();
  });

  it('refuses one that is running', () => {
    put({ status: 'running', lastActivity: minutesAgo(120) });
    expect(auto.findAutoRule(on, { agentId: 'a1' }, NOW)).toBeNull();
  });

  it('refuses idle, completed and errored agents', () => {
    for (const status of ['idle', 'completed', 'error']) {
      put({ status, lastActivity: minutesAgo(120) });
      expect(auto.findAutoRule(on, { agentId: 'a1' }, NOW), status).toBeNull();
    }
  });

  it('refuses an agent that no longer exists', () => {
    // Proposed a minute ago, deleted since.
    expect(auto.findAutoRule(on, { agentId: 'gone' }, NOW)).toBeNull();
  });

  it('refuses one whose last activity cannot be read', () => {
    put({ status: 'waiting', lastActivity: 'not a date' });
    expect(auto.findAutoRule(on, { agentId: 'a1' }, NOW)).toBeNull();
    put({ status: 'waiting', lastActivity: undefined });
    expect(auto.findAutoRule(on, { agentId: 'a1' }, NOW)).toBeNull();
  });
});

describe('restarting an agent that has errored', () => {
  const on = ['restart-errored'];

  it('authorises one that errored a minute ago', () => {
    put({ status: 'error', lastActivity: minutesAgo(5) });
    expect(auto.findAutoRule(on, { agentId: 'a1' }, NOW)?.id).toBe('restart-errored');
  });

  it('refuses one that just errored, so it does not race the status write', () => {
    put({ status: 'error', lastActivity: new Date(NOW - 5_000).toISOString() });
    expect(auto.findAutoRule(on, { agentId: 'a1' }, NOW)).toBeNull();
  });

  it('refuses every state that is not an error', () => {
    for (const status of ['running', 'waiting', 'idle', 'completed']) {
      put({ status, lastActivity: minutesAgo(120) });
      expect(auto.findAutoRule(on, { agentId: 'a1' }, NOW), status).toBeNull();
    }
  });

  it('does not authorise a waiting agent just because the other rule is off', () => {
    // The two rules are independent: enabling one must not widen the other.
    put({ status: 'waiting', lastActivity: minutesAgo(60) });
    expect(auto.findAutoRule(['restart-errored'], { agentId: 'a1' }, NOW)).toBeNull();
    put({ status: 'error', lastActivity: minutesAgo(60) });
    expect(auto.findAutoRule(['nudge-waiting'], { agentId: 'a1' }, NOW)).toBeNull();
  });
});

describe('the rules on offer', () => {
  it('each has an id, a label and a description a person can decide from', () => {
    for (const rule of auto.AUTO_ACTION_RULES) {
      expect(rule.id).toMatch(/^[a-z-]+$/);
      expect(rule.label.length).toBeGreaterThan(10);
      expect(rule.description.length).toBeGreaterThan(40);
    }
  });

  it('has no duplicate ids', () => {
    const ids = auto.AUTO_ACTION_RULES.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
