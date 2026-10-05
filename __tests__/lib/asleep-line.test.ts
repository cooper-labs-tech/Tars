import { describe, it, expect } from 'vitest';
import { asleepLine, wakingLine } from '../../src/lib/asleep-line';
import type { AgentStatus } from '../../src/types/electron';

/**
 * The line an asleep agent reads, and the one it reads while it wakes, where
 * an error gives its reason: in place of the task on its card, of the branch
 * in its pane's header, of the path in its window, under its name in an
 * orchestrator's rail. Since #322 an agent with no turn for 30 minutes is put
 * to sleep (`status: 'asleep'`, `asleepSince`), and every way it gets its CLI
 * back reads `waking: { by, via, since }` until its session is up. Frame:
 * `Agent asleep · and how it wakes` in design/tars-redesign.pen. Written
 * before the code. How the lines can fail:
 * 1. an agent that is not asleep says it is: a copy patched out of asleep by
 *    an event keeps the asleepSince it had;
 * 2. the time: one that does not parse prints "Invalid Date" or "NaN:NaN", and
 *    one of another day or year reads as today's;
 * 3. waking said of an agent already up: the copy kept `waking` after its
 *    session came up, or kept it on an agent stopped or asleep again;
 * 4. who woke it: an agent's or a chat's name, free text, turns the line
 *    around with a U+202E, splits it with a line break, or pushes the rest out
 *    by its length;
 * 5. how it was woken: each way has its own words, and a way a newer main
 *    sends that this page does not know still says who.
 */

const NOW = new Date(2026, 9, 5, 14, 30);
const at = (h: number, m: number, day = 5, month = 9, year = 2026) => new Date(year, month, day, h, m).toISOString();

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'a1', name: 'Frontend Engineer', status: 'asleep', projectPath: '/p', skills: [], output: [],
    lastActivity: at(14, 2), provider: 'claude', asleepSince: at(14, 2),
    ...over,
  } as AgentStatus;
}

const waking = (by: string, via: string) => agent({ status: 'idle', asleepSince: undefined, waking: { by, via, since: at(14, 29) } as AgentStatus['waking'] });

describe('asleep', () => {
  it('says since when, and why', () => {
    expect(asleepLine(agent(), NOW)).toBe('Asleep since 14:02: no turn for 30 minutes');
  });

  it('nothing for an agent that is not asleep, whatever its copy kept (1)', () => {
    for (const status of ['idle', 'running', 'waiting', 'completed', 'error', 'stopped'] as const) {
      expect(asleepLine(agent({ status }), NOW), status).toBeNull();
    }
  });

  it('the date before the time on another day, the year in another year, and no time it cannot read (2)', () => {
    expect(asleepLine(agent({ asleepSince: at(23, 58, 4) }), NOW)).toBe('Asleep since 4 Oct at 23:58: no turn for 30 minutes');
    expect(asleepLine(agent({ asleepSince: at(9, 5, 31, 11, 2025) }), NOW)).toBe('Asleep since 31 Dec 2025 at 09:05: no turn for 30 minutes');
    expect(asleepLine(agent({ asleepSince: 'not a date' }), NOW)).toBe('Asleep: no turn for 30 minutes');
    expect(asleepLine(agent({ asleepSince: undefined }), NOW)).toBe('Asleep: no turn for 30 minutes');
  });
});

describe('waking', () => {
  it('says who woke it, and how (5)', () => {
    expect(wakingLine(waking('Orchestrator', 'message'))).toBe('Waking: a message from Orchestrator');
    expect(wakingLine(waking('JeanBrasse', 'chat'))).toBe('Waking: a chat message from JeanBrasse');
    expect(wakingLine(waking('you', 'wake'))).toBe('Waking: woken by you');
    expect(wakingLine(waking('you', 'key'))).toBe('Waking: a key typed by you');
    expect(wakingLine(waking('Tars', 'start'))).toBe('Waking: started by Tars');
    expect(wakingLine(waking('Telegram', 'somehow'))).toBe('Waking: woken by Telegram');
  });

  it('nothing for an agent with no wake on its way, or one already up, stopped or asleep again (3)', () => {
    expect(wakingLine(agent({ status: 'idle', asleepSince: undefined }))).toBeNull();
    const up = waking('you', 'wake');
    for (const status of ['running', 'waiting', 'completed', 'error', 'stopped', 'asleep'] as const) {
      expect(wakingLine({ ...up, status }), status).toBeNull();
    }
  });

  it('a name that hides, turns or breaks the line is flattened, and a long one cut (4)', () => {
    expect(wakingLine(waking('Ev\u202Eil\u2028Lead', 'message'))).toBe('Waking: a message from Ev il Lead');
    const long = 'A'.repeat(60);
    const line = wakingLine(waking(long, 'message'))!;
    expect(line.startsWith('Waking: a message from ')).toBe(true);
    expect([...line.slice('Waking: a message from '.length)].length).toBe(40);
    expect(line.endsWith('…')).toBe(true);
  });
});
