import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { panelAgentsKey } from '../../src/components/TerminalsView/utils/panelAgentsKey';
import type { AgentStatus, ClaudeAccountMove } from '../../src/types/electron';

/**
 * The Dashboard hands its panels a new list of agents only when this key
 * changes (TerminalsView/index.tsx), so a field a panel's header draws and the
 * key leaves out never reaches the panel after its first render. Written
 * before the fix, as the ways it can fail:
 * 1. a field the header shows changes and the key does not: the status and
 *    task, the error, the CLI running or not, the terminal, the name and role
 *    the mark is drawn from;
 * 2. the account an agent runs on, the one it is pinned to, or the last move
 *    by Tars (#266, #269) change and the key does not: the panel's account
 *    control keeps its old name and title (seen in the e2e: a move by Tars
 *    wrote its line in the panel, and the control still named the account the
 *    agent had left);
 * 3. a permission question Tars holds (#318) comes or goes while nothing else
 *    the key reads moves: ask in terminal leaves the agent waiting with its
 *    lastActivity, and only permissionAsk goes; the next call's question
 *    changes only its askedAt and what it asks (waitingOn). The panel kept
 *    offering allow and deny for a question gone, or named the call before.
 */

const MOVE: ClaudeAccountMove = { agentId: 'a1', from: 'default', to: 'acct-000002', reason: 'limit', window: 'fiveHour', usedPercentage: 100, at: 1_790_000_000_000 };

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'a1', name: 'Planner', status: 'idle', projectPath: '/tmp/project', skills: [], output: [],
    lastActivity: '2026-09-17T10:00:00.000Z', currentTask: 'Plan the lot', provider: 'claude', cliRunning: false,
    ...over,
  } as AgentStatus;
}

const changes = (over: Partial<AgentStatus>, base: Partial<AgentStatus> = {}) =>
  panelAgentsKey([agent(base), agent({ id: 'a2' })]) !== panelAgentsKey([agent({ ...base, ...over }), agent({ id: 'a2' })]);

describe("the Dashboard's panel key", () => {
  it('changes with each field the header shows (1)', () => {
    expect(changes({ status: 'running' })).toBe(true);
    expect(changes({ currentTask: 'Ship it' })).toBe(true);
    expect(changes({ lastActivity: '2026-09-17T10:01:00.000Z' })).toBe(true);
    expect(changes({ error: 'Turn failed' })).toBe(true);
    expect(changes({ cliRunning: true })).toBe(true);
    expect(changes({ leftFullscreen: true })).toBe(true);
    expect(changes({ ptyId: 'pty-2' })).toBe(true);
    expect(changes({ name: 'Builder' })).toBe(true);
    expect(changes({ role: 'orchestrator' })).toBe(true);
  });

  it('changes with the account the agent runs on, its pin, and the last move by Tars (2)', () => {
    expect(changes({ claudeAccountId: 'acct-000002' })).toBe(true);
    expect(changes({ claudeAccountPin: 'acct-000002' })).toBe(true);
    expect(changes({ claudeAccountMove: MOVE })).toBe(true);
    expect(changes({ claudeAccountMove: { ...MOVE, at: MOVE.at + 60_000 } }, { claudeAccountMove: MOVE })).toBe(true);
  });

  it('changes when a permission question Tars holds comes, goes, or is for another call (3)', () => {
    const ask = { tool: 'Bash', askedAt: '2026-10-05T12:02:00.000Z' };
    const on = (text: string) => ({ kind: 'permission' as const, text });
    expect(changes({ permissionAsk: ask })).toBe(true);
    expect(changes({ permissionAsk: undefined }, { status: 'waiting', permissionAsk: ask })).toBe(true);
    expect(changes({ permissionAsk: { ...ask, askedAt: '2026-10-05T12:03:00.000Z' } }, { permissionAsk: ask })).toBe(true);
    expect(changes({ waitingOn: on('npm test') }, { waitingOn: on('npm run build') })).toBe(true);
  });

  it('stays the same when nothing the header shows changed', () => {
    expect(changes({})).toBe(false);
    expect(changes({ output: ['more'] })).toBe(false);
  });
});
