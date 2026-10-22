import { describe, it, expect } from 'vitest';
import { checkpointProblem, writeCheckpoint, checkpointOfTask, CHECKPOINT_MAX } from '../../../electron/core/agent-checkpoint';
import type { AgentStatus } from '../../../electron/types';

/**
 * The checkpoint line an agent writes about itself (2.0.5, taken from Orca): one line, 120 characters at most,
 * kept with the agent and given to the window, to task_status and to what list_agents and get_agent answer.
 *
 * How it fails, written before the code:
 * 1. A line that is not one is taken: not a string, empty or only spaces, longer than 120 characters, holding a
 *    newline or another control character (an escape sequence would reach the window and the reports raw).
 * 2. A line of 120 characters made of emoji or accents is refused: the limit counts characters, not UTF-16 units.
 * 3. The line is kept untrimmed, or without the time it was written, or the previous one survives.
 * 4. task_status shows a running task a line written before that task started (it is a previous task's), or shows
 *    a line for a task that has ended (its answer says the rest).
 */

const agent = () => ({ id: 'w', status: 'running' }) as AgentStatus;

describe('a checkpoint line', () => {
  it('1. refuses what is not one line of 1 to 120 characters', () => {
    for (const bad of [undefined, 42, '', '   ', 'x'.repeat(CHECKPOINT_MAX + 1), 'two\nlines', 'a\rb', 'tab\there', 'esc\x1b[31mred', 'nul\0']) {
      expect(checkpointProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    expect(CHECKPOINT_MAX).toBe(120);
  });

  it('2. counts characters, not UTF-16 units', () => {
    expect(checkpointProblem('🙂'.repeat(120))).toBeNull();
    expect(checkpointProblem('é'.repeat(120))).toBeNull();
    expect(checkpointProblem('🙂'.repeat(121))).not.toBeNull();
  });

  it('3. keeps the trimmed line with its time, replacing the previous one', () => {
    const a = agent();
    writeCheckpoint(a, '  tests written, 3 of 5 green  ', new Date('2026-10-22T10:00:00Z'));
    expect(a.checkpoint).toEqual({ line: 'tests written, 3 of 5 green', at: '2026-10-22T10:00:00.000Z' });
    writeCheckpoint(a, 'all 5 green, opening the PR', new Date('2026-10-22T10:05:00Z'));
    expect(a.checkpoint).toEqual({ line: 'all 5 green, opening the PR', at: '2026-10-22T10:05:00.000Z' });
  });

  it('4. belongs to a running task only when written after it started', () => {
    const a = agent();
    writeCheckpoint(a, 'halfway', new Date('2026-10-22T10:00:00Z'));
    const started = Date.parse('2026-10-22T09:59:00Z');
    expect(checkpointOfTask(a, { outcome: 'running', startedAt: started })).toEqual({ line: 'halfway', at: '2026-10-22T10:00:00.000Z' });
    expect(checkpointOfTask(a, { outcome: 'running', startedAt: Date.parse('2026-10-22T10:01:00Z') })).toBeUndefined();
    expect(checkpointOfTask(a, { outcome: 'completed', startedAt: started })).toBeUndefined();
    expect(checkpointOfTask(undefined, { outcome: 'running', startedAt: started })).toBeUndefined();
  });
});
