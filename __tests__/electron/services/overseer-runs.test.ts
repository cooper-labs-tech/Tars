import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * What the fleet has been doing.
 *
 * The overseer got a snapshot each turn and nothing else, so it could say
 * "Frontend is waiting on you" and never "that is the third time it has come
 * back to this task". This is the small ledger that makes the second sentence
 * possible: status transitions, a day of them, summarised into lines worth
 * spending a turn's tokens on.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-runs-'));
vi.mock('../../../electron/constants', () => ({
  DATA_DIR: tmp,
  dataPath: (f: string) => path.join(tmp, f),
  API_PORT: 31415,
}));

let runs: typeof import('../../../electron/services/overseer-runs');
const NOW = Date.parse('2026-08-24T12:00:00Z');
const hoursAgo = (h: number) => NOW - h * 3600_000;

beforeEach(async () => {
  vi.resetModules();
  runs = await import('../../../electron/services/overseer-runs');
  runs.clearRunEvents();
});

const ev = (over: Partial<import('../../../electron/services/overseer-runs').RunEvent> = {}) => ({
  at: NOW, agentId: 'a1', agentName: 'Frontend', project: '/tars',
  from: 'idle', to: 'running', ...over,
});

describe('the ledger', () => {
  it('keeps what it was given', () => {
    runs.recordRunEvents([ev()], NOW);
    expect(runs.readRunEvents(NOW)).toHaveLength(1);
  });

  it('forgets anything older than a day', () => {
    runs.recordRunEvents([ev({ at: hoursAgo(30) }), ev({ at: hoursAgo(2) })], NOW);
    expect(runs.readRunEvents(NOW)).toHaveLength(1);
  });

  it('survives a file that is not readable', () => {
    fs.writeFileSync(path.join(tmp, 'overseer-runs.json'), '{not json');
    expect(runs.readRunEvents(NOW)).toEqual([]);
    // And can still be written to afterwards.
    runs.recordRunEvents([ev()], NOW);
    expect(runs.readRunEvents(NOW)).toHaveLength(1);
  });

  it('does not grow without bound', () => {
    runs.recordRunEvents(Array.from({ length: 1200 }, () => ev()), NOW);
    expect(runs.readRunEvents(NOW).length).toBeLessThanOrEqual(800);
  });

  it('writing nothing is not an error', () => {
    expect(() => runs.recordRunEvents([], NOW)).not.toThrow();
  });
});

describe('the summary', () => {
  it('says nothing when nothing happened', () => {
    expect(runs.summariseRuns(NOW, [])).toBe('');
  });

  it('counts runs and pauses per agent', () => {
    runs.recordRunEvents([
      ev({ to: 'running' }), ev({ to: 'waiting' }), ev({ to: 'running' }), ev({ to: 'waiting' }),
    ], NOW);
    const out = runs.summariseRuns(NOW);
    expect(out).toContain('Frontend');
    expect(out).toContain('2 runs');
    expect(out).toContain('2 pauses for the user');
  });

  it('names a task the agent keeps coming back to', () => {
    // The signal a snapshot cannot carry.
    runs.recordRunEvents([
      ev({ to: 'running', task: 'fix the scroll lock' }),
      ev({ to: 'running', task: 'fix the scroll lock' }),
      ev({ to: 'running', task: 'fix the scroll lock' }),
    ], NOW);
    const out = runs.summariseRuns(NOW);
    expect(out).toContain('fix the scroll lock');
    expect(out).toContain('3 times');
  });

  it('does not cry wolf on a task seen twice', () => {
    runs.recordRunEvents([
      ev({ to: 'running', task: 'build' }), ev({ to: 'running', task: 'build' }),
    ], NOW);
    expect(runs.summariseRuns(NOW)).not.toContain('same task');
  });

  it('keeps agents apart', () => {
    runs.recordRunEvents([
      ev({ agentId: 'a1', agentName: 'Frontend', to: 'running' }),
      ev({ agentId: 'a2', agentName: 'QA', to: 'error' }),
    ], NOW);
    const out = runs.summariseRuns(NOW);
    expect(out).toContain('Frontend');
    expect(out).toContain('QA');
    expect(out).toContain('1 error');
  });

  it('leaves out an agent that only ever went idle', () => {
    // A line saying an agent was quiet is not worth a turn's tokens.
    runs.recordRunEvents([ev({ to: 'idle' })], NOW);
    expect(runs.summariseRuns(NOW)).toBe('');
  });
});
