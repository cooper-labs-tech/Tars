import '../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { onAgentMoveLine } from '../../src/hooks/useClaudeAccounts';
import { moveLine } from '../../src/lib/claude-accounts';
import type { ClaudeAccountMove, ClaudeAccountState, ClaudeAccountsView } from '../../src/types/electron';

/**
 * The grey line a move by Tars writes in the agent's terminal (#269's
 * claude-accounts:agent-moved; frame `Agent · Claude account`, "When an agent
 * moves"). The Dashboard's panels and the agent's window each hand their own
 * writer to onAgentMoveLine; what the line says is pinned in
 * __tests__/lib/claude-accounts.test.ts. Written before the code, as the ways
 * it can fail:
 * 1. a move main tells the window writes nothing, or writes it for another
 *    agent than the one it names;
 * 2. it names the accounts from something else than the view the window
 *    holds, or is written with no view to name them from;
 * 3. one move writes twice in a terminal, or a terminal that has one listener
 *    per view misses its line;
 * 4. a terminal that closed keeps writing.
 */

const g = globalThis as unknown as { window?: unknown };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function account(id: string, label: string): ClaudeAccountState {
  return {
    id, label, configDir: id === 'default' ? null : `/Users/someone/.claude-accounts/${id}`, enabled: true, signedIn: true,
    email: `${id}@example.com`, subscriptionType: 'max', fiveHour: null, sevenDay: null, updatedAt: 0, blockedUntil: null,
    agentIds: [], error: null,
  };
}

const VIEW: ClaudeAccountsView = {
  settings: {
    enabled: true,
    accounts: [{ id: 'default', label: 'Main', configDir: null, enabled: true }, { id: 'acct-000002', label: 'Second', configDir: '/Users/someone/.claude-accounts/acct-000002', enabled: true }],
    fiveHourThreshold: 90,
    weeklyThreshold: 95,
  },
  accounts: [account('default', 'Main'), account('acct-000002', 'Second')],
  registryError: null,
};

const MOVE: ClaudeAccountMove = { agentId: 'a1', from: 'default', to: 'acct-000002', reason: 'limit', window: 'fiveHour', usedPercentage: 100, at: new Date(2026, 8, 28, 14, 2, 0).getTime() };

let heard: Set<(move: ClaudeAccountMove) => void>;
let answerList: (view: ClaudeAccountsView) => void;
const pushMove = (move: ClaudeAccountMove) => { for (const listener of heard) listener(move); };

beforeEach(() => {
  heard = new Set();
  // A new bridge each time: the store starts over on it.
  g.window = {
    electronAPI: {
      claudeAccounts: {
        list: () => new Promise(resolve => { answerList = view => resolve({ success: true, ...view }); }),
        onChanged: () => () => {},
        onAgentMoved: (listener: (move: ClaudeAccountMove) => void) => { heard.add(listener); return () => { heard.delete(listener); }; },
      },
    },
  };
});

afterEach(() => {
  delete g.window;
});

describe('the grey line of a move by Tars', () => {
  it('is written for the agent the move names, in the words of the view the window holds (1, 2)', async () => {
    const written: Array<[string, string]> = [];
    const stop = onAgentMoveLine((agentId, line) => written.push([agentId, line]));
    answerList(VIEW);
    await settle();
    pushMove(MOVE);
    expect(written).toEqual([['a1', moveLine(VIEW, MOVE)]]);
    pushMove({ ...MOVE, agentId: 'a2' });
    expect(written[1]).toEqual(['a2', moveLine(VIEW, { ...MOVE, agentId: 'a2' })]);
    stop();
  });

  it('is not written while the window holds no view to name the accounts from (2)', async () => {
    const written: string[] = [];
    const stop = onAgentMoveLine((_, line) => written.push(line));
    pushMove(MOVE);
    answerList(VIEW);
    await settle();
    expect(written).toEqual([]);
    stop();
  });

  it('is written once in each terminal that listens, the Dashboard panel and the window alike (3)', async () => {
    const panel: string[] = [];
    const window: string[] = [];
    const stopPanel = onAgentMoveLine((_, line) => panel.push(line));
    const stopWindow = onAgentMoveLine((_, line) => window.push(line));
    answerList(VIEW);
    await settle();
    pushMove(MOVE);
    expect(panel).toEqual([moveLine(VIEW, MOVE)]);
    expect(window).toEqual([moveLine(VIEW, MOVE)]);
    stopPanel();
    stopWindow();
  });

  it('stops once its terminal closes (4)', async () => {
    const written: string[] = [];
    const stop = onAgentMoveLine((_, line) => written.push(line));
    answerList(VIEW);
    await settle();
    stop();
    expect(heard.size).toBe(0);
    pushMove(MOVE);
    expect(written).toEqual([]);
  });
});
