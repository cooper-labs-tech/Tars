import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTaskLedger, type TaskAgentView, type TaskRecord } from '../../../electron/services/task-ledger';
import { createOneTaskQueue } from '../../../electron/core/one-task';

/**
 * Every task keeps its answer under its id, a delegation's or not, and a queued message's id follows the turn it
 * opened (2.0.7; an orchestrator's reports of 19/11: get_agent_output kept an older task's text after the agent
 * had finished newer ones, and a message sent with mode 'queue' got a task id that task_status called "that agent's
 * work now", its answer never kept). Until 2.0.7 only a delegation's own run (agent-routes.ts runInTerminal) kept an
 * answer: a turn the owner typed, a message, a queued message ended with none, and the agent's last answer was its
 * last delegation's, however old.
 *
 * How it can fail, written before the code:
 * E1. A task that ends is not told to whoever reads its answer (the ledger's `onEnded`): a turn the owner typed, a
 *     message, a task a delegation's rest ends, or one `endedForDelegation` ends before the next delegation.
 * E2. A task told ended twice, or told for an ACP run, a task still running, or one a quit cut at the last start.
 * E3. `keepAnswer` keeps an answer for a task that is not there, still runs, or ran over ACP; or replaces an answer
 *     already kept (the delegation's own, read the same way); or does not survive a restart.
 * E4. The agent's last answer is an older task's while a newer one has its own.
 * E5. A queued message delivered into the agent's terminal can never be followed to the turn it opened: its id reads
 *     `delivered` for ever (one-task.ts `named`); or `named` moves a task that started already, one that failed, one
 *     never taken, or names it twice.
 */

const T0 = Date.UTC(2026, 10, 19, 9, 0, 0);
let dir: string;
let file: string;
let textFile: string;
let resultFile: string;
let clock: number;
let ended: TaskRecord[];
const agent = (status: TaskAgentView['status'], id = 'arch'): TaskAgentView => ({ id, status, projectPath: '/p', provider: 'claude' });
const open = () => createTaskLedger({ file, textFile, resultFile, now: () => clock, onEnded: (task) => ended.push(task) });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-every-answer-'));
  file = path.join(dir, 'task-ledger.jsonl');
  textFile = path.join(dir, 'private', 'task-texts.jsonl');
  resultFile = path.join(dir, 'private', 'task-results.jsonl');
  clock = T0;
  ended = [];
});

describe('every task that ends is told, once', () => {
  it('E1, E2: a turn the owner typed, a message, a delegation\'s, and one ended before the next delegation', () => {
    const ledger = open();
    const typed = ledger.turnStarted(agent('running'), { sessionId: 's1', text: 'OWNER>> one more check' })!;
    clock += 1_000;
    ledger.stateChanged(agent('idle'));
    ledger.stateChanged(agent('idle'));
    expect(ended.map((t) => t.id)).toEqual([typed]);
    expect(ended[0]).toMatchObject({ id: typed, agentId: 'arch', outcome: 'completed', endedAt: T0 + 1_000, sessionIds: ['s1'] });

    clock += 1_000;
    const kept = ledger.turnStarted(agent('running'), { sessionId: 's1', text: 'a turn its background work keeps open' })!;
    ledger.stateChanged(agent('idle'), { backgroundLeft: true });
    expect(ended).toHaveLength(1);
    expect(ledger.endedForDelegation('arch')).toBe(kept);
    expect(ended.map((t) => t.id)).toEqual([typed, kept]);

    const acp = ledger.acpStarted({ agent: agent('running', 'acp-agent'), text: 'over ACP', startedAt: clock });
    ledger.acpEnded(acp, { outcome: 'completed', stopReason: 'end_turn', usage: null, costUSD: null });
    expect(ended.map((t) => t.id)).toEqual([typed, kept]);
  });

  it('E2: a task a quit cut, ended at the next start, is not told', () => {
    const first = open();
    first.turnStarted(agent('running'), { sessionId: 's1', text: 'cut by a quit' });
    open();
    expect(ended).toEqual([]);
  });
});

describe('the answer of any task', () => {
  it('E3: kept for an ended terminal task, once, and read back after a restart', () => {
    const ledger = open();
    const id = ledger.turnStarted(agent('running'), { sessionId: 's1', text: 'typed' })!;
    ledger.keepAnswer(id, 'too early');
    expect(ledger.task(id)?.result).toBeUndefined();
    clock += 500;
    ledger.stateChanged(agent('idle'));
    ledger.keepAnswer(id, 'The owner answer.');
    ledger.keepAnswer(id, 'a second read');
    ledger.keepAnswer('no-such-task', 'nothing');
    expect(ledger.task(id)?.result).toBe('The owner answer.');
    expect(open().task(id)?.result).toBe('The owner answer.');
    // The delegation's own answer, the same text, is not written again; another is kept as the delegation's.
    ledger.terminalEnded(id, { result: 'The owner answer.', stopReason: 'end_turn' });
    expect(fs.readFileSync(resultFile, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('E3: an ACP run keeps its own answer only', () => {
    const ledger = open();
    const acp = ledger.acpStarted({ agent: agent('running'), text: 'over ACP', startedAt: clock });
    ledger.acpEnded(acp, { outcome: 'completed', stopReason: 'end_turn', result: 'acp says', usage: null, costUSD: null });
    ledger.keepAnswer(acp, 'another');
    expect(ledger.task(acp)?.result).toBe('acp says');
  });

  it('E4: the agent\'s last answer is its latest task\'s, a delegation or not', () => {
    const ledger = open();
    const delegated = ledger.turnStarted(agent('running'), { sessionId: 's1', text: 'LATE>>' })!;
    clock += 1_000;
    ledger.stateChanged(agent('idle'));
    ledger.terminalEnded(delegated, { result: 'the report', stopReason: 'end_turn' });
    clock += 1_000;
    const typed = ledger.turnStarted(agent('running'), { sessionId: 's1', text: 'OWNER>>' })!;
    clock += 1_000;
    ledger.stateChanged(agent('idle'));
    ledger.keepAnswer(typed, 'The owner answer.');
    expect(ledger.lastAnswerOf('arch')).toMatchObject({ taskId: typed, result: 'The owner answer.' });
  });
});

describe('a queued message delivered into the terminal', () => {
  it('E5: its id follows the turn it opened, and only that', () => {
    const q = createOneTaskQueue(T0);
    const item = q.enqueue('arch', { requesterId: 'lead', title: 'QUEUED>>', how: 'message' }, T0, 't-0000aaaa');
    expect(q.takeTurn('arch', item.ref, undefined, T0)).toBe(true);
    q.delivered(item.ref, 'typed', undefined, T0 + 10);
    q.runEnded('arch');
    expect(q.lookup(item.ref)?.state).toBe('delivered');
    q.named(item.ref, 'ledger-task-1');
    q.named(item.ref, 'ledger-task-2');
    expect(q.lookup(item.ref)).toMatchObject({ state: 'started', taskId: 'ledger-task-1' });

    const failed = q.enqueue('arch', { title: 'never went in' }, T0, 't-0000bbbb');
    q.takeTurn('arch', failed.ref, undefined, T0);
    q.notStarted(failed.ref, 'its terminal gave it up');
    q.named(failed.ref, 'ledger-task-3');
    expect(q.lookup(failed.ref)?.state).toBe('failed');
    q.runEnded('arch');

    const waiting = q.enqueue('arch', { title: 'still queued' }, T0, 't-0000cccc');
    q.named(waiting.ref, 'ledger-task-4');
    expect(q.lookup(waiting.ref)?.state).toBe('queued');
  });
});
