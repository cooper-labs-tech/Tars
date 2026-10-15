import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTaskLedger, turnUsageOf, type TaskAgentView } from '../../../electron/services/task-ledger';
import { hasPosixModes } from '../../setup/platform-limits';

/**
 * The tasks the Usage page prices (PLAN-1.9.3.md, item 2; DESIGN-COUT-PAR-TACHE.md): one record per piece of work an
 * agent does, from the turn that starts it to the rest that ends it, with who handed it over and the task it was
 * handed for. Tars kept none of this: workHandedAt is overwritten at each hand-off, the end of a turn leaves no time,
 * and requestedBy is consumed once the result is handed back.
 *
 * How it can fail, written before the code:
 * 1. A turn after a hand-off opens a task without what the hand-off said: who handed it (an agent, Tars, a channel),
 *    its text, the requester's own open task as the parent; or with the agent's provider, model, account or project
 *    as they are later, not at the turn.
 * 2. A turn nobody handed (typed in the terminal) opens no task, or opens one under the last hand-off, however old,
 *    or under a hand-off a turn already took (one typed while a task was open, which that task ran).
 * 3. A turn while a task is open opens another one, or is not counted in it; a session is recorded twice, or not at all.
 * 4. The task ends at the wrong moment: at a permission prompt, before its first turn (an agent handed work while
 *    idle), while background work remains; or not at all when the agent rests, stops, completes or fails; or without
 *    saying how it ended.
 * 5. A turn after the end does not open a new task.
 * 6. The parent link goes wrong: an agent that hands itself work becomes its own parent, a requester with no open
 *    task gives one anyway.
 * 7. A delegation over ACP is not a task, or loses its usage and cost.
 * 8. What is kept goes wrong: the tasks do not survive a restart; a task open when Tars stopped stays open for ever;
 *    a damaged line stops the reading; the file grows without bound; more than 200 characters of a task's text are
 *    kept (the file is in ~/.dorothy, which every agent reads).
 * 9. (the Audit's Low 2 on #305) A line forged in the file, which every agent can write, reaches the report with fields
 *    of the wrong type: a text that is an object or a megabyte, turns that are not a number, an agent that is null, a
 *    time that is not one (then written back as the end of a task), a session id that is a path; or a good line is
 *    lost with it.
 * 10. (QA's gate of #305) A worker's report to the agent that leads it is taken for a delegation: the lead's next task,
 *     and all it hands on after, are filed under the worker's task, whose total then holds them (a task that cost 1
 *     showed a total of 21). A worker writing to the agent that handed it its task, or to its project's orchestrator,
 *     reports; as #302 has it for the delegation link.
 * 12. (JeanBrasse's answer of 2026-10-05) A task's text, the first line of what was handed over (JeanBrasse's own prompts, the
 *     chat messages handed to orchestrators), is written to ~/.dorothy, which every agent is handed; or to a file
 *     another account can read. Only the text moves: what a task cost and how long it took stays where it was.
 * 13. Read back, a task loses its text, or a missing or damaged text file loses the tasks.
 * 14. A ledger written before, its texts inline in ~/.dorothy, keeps them there after the first start.
 * 15. Rewritten past its bound, the ledger keeps the texts of the tasks it dropped, or loses those of the tasks it kept.
 * 16. A text line that is not one (no id, a text that is not text, a megabyte) is taken as it is.
 * 17. (mods step 4, JeanBrasse's go) A turn's usage, which the state mod reports from Claude Code's turn.complete, is not
 *     kept, or kept on the wrong task. It arrives after the Stop that ended its task (measured on 2.1.289: 8 to 14 ms
 *     after), so it belongs to the agent's latest task in that session, ended or not; a session none of the agent's
 *     tasks ran in has no task to take it.
 * 18. The usage does not survive a restart; or a usage line that is not one (counts that are not counts, a model that
 *     is not text, a task the ledger does not know) is taken.
 * 19. Several turns of a task, on one model or several, are not summed per model.
 * 26. (the Audit's L1 on #333) A turn's usage loses its session: written without it, read back without it, or lost
 *     when the file is rewritten; or a session id that is not one is taken with it. Without it a task over two
 *     sessions cannot be priced per session.
 * 27. (the Audit's gate of #343) How many of a task's turns named their session is not kept, so a task whose
 *     every turn did cannot be told from one with 1.9.3's turns, which named none; or it is lost in a rewrite.
 * And from the per-task requester link (ORCHESTRATOR-PER-CHAT.md v2.2, PR A, the Audit's R1), written before the code
 * (2026-10-07). The ledger kept one pending hand-off per agent, and the next turn to start took it, whoever started it:
 * 28. Two hand-offs to one worker (the bot's and an orchestrator's): the second replaces the first, and the turn that
 *     runs the first is filed under the second's sender.
 * 29. A turn with no task id in its prompt (JeanBrasse typing into the worker, a scheduled task, a /loop) takes a hand-off
 *     Tars typed, and the turn of that hand-off then opens a task from nobody.
 * 30. A hand-off with no id (a launch's prompt, which carries no sender line) no longer opens the next turn's task.
 * 31. (the Audit's gate of #351, H1) An agent named "x, task t-<another's id>: y" files its turn under that other
 *     hand-off: the id is read from anywhere in the prompt, not from the envelope Tars wrote.
 * And for delegated results that survive a restart (ORCHESTRATOR-PER-CHAT.md v2.2, 4.4 item 3; PR B), written before
 * the code (2026-10-12). A run over ACP was written once, when it ended: a quit mid-run left nothing.
 * 32. A delegated run is not a task until it ends: a quit while it works leaves no task, nothing to read, and nobody
 *     told.
 * 33. Its result (why it stopped, and what it answered) is not kept, or the answer is written to ~/.dorothy, which
 *     every agent is handed, or kept whole however long it is.
 * 34. A run open when Tars stopped is not marked as cut at the next start, or is not listed for its asker to be told,
 *     or is listed again at every start after.
 * 35. A task cannot be found by its id once Tars started again, or comes back without its result.
 * 36. Rewritten past its bound, the ledger keeps the results of the tasks it dropped, or loses those it kept.
 */

const T0 = Date.UTC(2026, 9, 4, 18, 0, 0);
let dir: string;
let file: string;
let textFile: string;
let resultFile: string;
let clock: number;

function agent(over: Partial<TaskAgentView> = {}): TaskAgentView {
  return { id: 'worker-1', projectPath: '/work/tars', provider: 'claude', model: 'claude-opus-5-5', claudeAccountId: null, status: 'running', ...over };
}
const open = (maxLines?: number) => createTaskLedger({ file, textFile, resultFile, now: () => clock, ...(maxLines ? { maxLines } : {}) });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-task-ledger-'));
  file = path.join(dir, 'task-ledger.jsonl');
  textFile = path.join(dir, 'private', 'task-texts.jsonl');
  resultFile = path.join(dir, 'private', 'task-results.jsonl');
  clock = T0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a task opens', () => {
  it('1. at the turn after a hand-off, with what the hand-off said and the agent as it is at that turn', () => {
    const ledger = open();
    const orchestrator = agent({ id: 'orch' });
    ledger.handedOff('orch', { source: 'telegram', text: 'fais le point' });
    ledger.turnStarted(orchestrator, { sessionId: 'sess-orch' });
    ledger.handedOff('worker-1', { source: 'agent', requesterAgentId: 'orch', text: 'run the review of #280' });
    clock += 2_000;
    ledger.turnStarted(agent({ model: 'claude-sonnet-5-5', claudeAccountId: 'acct-2' }), { sessionId: 'sess-1' });

    const [parent, task] = ledger.tasks();
    expect(parent).toMatchObject({ agentId: 'orch', source: 'telegram', requesterAgentId: null, parentTaskId: null, text: 'fais le point' });
    expect(task).toMatchObject({
      agentId: 'worker-1', projectPath: '/work/tars', provider: 'claude', model: 'claude-sonnet-5-5', accountId: 'acct-2',
      source: 'agent', requesterAgentId: 'orch', parentTaskId: parent.id, text: 'run the review of #280',
      startedAt: T0 + 2_000, endedAt: null, outcome: 'running', turns: 1, sessionIds: ['sess-1'],
    });
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('2. at a turn nobody handed, named by its prompt; a hand-off older than 15 minutes is not taken for it', () => {
    const ledger = open();
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'typed by hand' });
    ledger.stateChanged(agent({ status: 'idle' }));
    ledger.handedOff('worker-1', { source: 'tars', text: 'a note from Tars' });
    clock += 16 * 60_000;
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'typed again' });

    expect(ledger.tasks().map((t) => [t.source, t.text])).toEqual([['terminal', 'typed by hand'], ['terminal', 'typed again']]);
  });

  it('2. nor a hand-off the open task already ran', () => {
    const ledger = open();
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'typed by hand' });
    ledger.handedOff('worker-1', { source: 'agent', requesterAgentId: 'orch', text: 'and this too' });
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'and this too' });
    ledger.stateChanged(agent({ status: 'idle' }));
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'next' });

    expect(ledger.tasks().map((t) => [t.source, t.text, t.turns])).toEqual([['terminal', 'typed by hand', 2], ['terminal', 'next', 1]]);
  });

  it('3. one task for its turns: the next turns are counted in it, and each session once', () => {
    const ledger = open();
    ledger.handedOff('worker-1', { source: 'tars', text: 'build it' });
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });
    ledger.stateChanged(agent({ status: 'waiting', waitingReason: 'permission' }));
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });
    ledger.turnStarted(agent(), { sessionId: 'sess-2' });

    expect(ledger.tasks()).toHaveLength(1);
    expect(ledger.tasks()[0]).toMatchObject({ turns: 3, sessionIds: ['sess-1', 'sess-2'], outcome: 'running' });
  });
});

describe('a task ends', () => {
  it('4. when the agent rests after its turn, not at a permission prompt, and says how', () => {
    const ledger = open();
    ledger.handedOff('worker-1', { source: 'tars', text: 'build it' });
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });
    clock += 5_000;
    ledger.stateChanged(agent({ status: 'waiting', waitingReason: 'permission' }));
    expect(ledger.tasks()[0].endedAt).toBeNull();

    clock += 5_000;
    ledger.stateChanged(agent({ status: 'idle' }));
    expect(ledger.tasks()[0]).toMatchObject({ endedAt: T0 + 10_000, outcome: 'completed' });
  });

  it('4. not before its first turn: an agent handed work while idle is still idle until its turn starts', () => {
    const ledger = open();
    ledger.handedOff('worker-1', { source: 'tars', text: 'build it' });
    ledger.stateChanged(agent({ status: 'idle' }));
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });

    expect(ledger.tasks()).toEqual([expect.objectContaining({ text: 'build it', outcome: 'running', endedAt: null })]);
  });

  it('4. not while background work remains, and at the rest after it', () => {
    const ledger = open();
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });
    ledger.stateChanged(agent({ status: 'idle' }), { backgroundLeft: true });
    expect(ledger.tasks()[0].outcome).toBe('running');

    clock += 60_000;
    ledger.stateChanged(agent({ status: 'idle' }), { backgroundLeft: false });
    expect(ledger.tasks()[0]).toMatchObject({ outcome: 'completed', endedAt: T0 + 60_000 });
  });

  it.each([
    ['completed', 'completed'], ['error', 'error'], ['stopped', 'stopped'], ['waiting', 'completed'],
  ] as const)('4. at an agent %s, as %s', (status, outcome) => {
    const ledger = open();
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });
    ledger.stateChanged(agent({ status, waitingReason: status === 'waiting' ? 'idle' : undefined }));

    expect(ledger.tasks()[0].outcome).toBe(outcome);
  });

  it('5. and the next turn opens a new task', () => {
    const ledger = open();
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });
    ledger.stateChanged(agent({ status: 'idle' }));
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });

    expect(ledger.tasks().map((t) => t.outcome)).toEqual(['completed', 'running']);
  });
});

describe('the parent', () => {
  it('6. never the task itself, and none when the requester has no open task', () => {
    const ledger = open();
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });
    ledger.handedOff('worker-1', { source: 'agent', requesterAgentId: 'worker-1', text: 'a note to myself' });
    ledger.stateChanged(agent({ status: 'idle' }));
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });
    ledger.handedOff('worker-2', { source: 'agent', requesterAgentId: 'orch-idle', text: 'from an agent with no task' });
    ledger.turnStarted(agent({ id: 'worker-2' }), { sessionId: 'sess-2' });

    const [, second, third] = ledger.tasks();
    expect(second.parentTaskId).toBeNull();
    expect(third).toMatchObject({ requesterAgentId: 'orch-idle', parentTaskId: null });
  });
});

describe('a delegation over ACP', () => {
  it('7. is a task of its own, with its usage and its cost, under the requester\'s task', () => {
    const ledger = open();
    ledger.handedOff('orch', { source: 'tars', text: 'plan the release' });
    ledger.turnStarted(agent({ id: 'orch' }), { sessionId: 'sess-orch' });
    ledger.acpRun({
      agent: agent({ id: 'codex-1', provider: 'codex', model: 'gpt-5.5' }), requesterAgentId: 'orch', text: 'review #285',
      startedAt: T0 + 1_000, endedAt: T0 + 61_000, outcome: 'completed',
      usage: { inputTokens: 1200, outputTokens: 300, cachedReadTokens: 100, cachedWriteTokens: 0 }, costUSD: 0.0123,
    });

    const acp = ledger.tasks().find((t) => t.source === 'acp')!;
    expect(acp).toMatchObject({
      agentId: 'codex-1', provider: 'codex', model: 'gpt-5.5', requesterAgentId: 'orch', parentTaskId: ledger.tasks()[0].id,
      text: 'review #285', startedAt: T0 + 1_000, endedAt: T0 + 61_000, outcome: 'completed', turns: 1,
      acp: { inputTokens: 1200, outputTokens: 300, cachedReadTokens: 100, cachedWriteTokens: 0, costUSD: 0.0123 },
    });
  });
});

describe('what is kept', () => {
  it('8. the tasks survive a restart; one open when Tars stopped is ended as stopped, at its last known moment', () => {
    const ledger = open();
    ledger.handedOff('worker-1', { source: 'tars', text: 'build it' });
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });
    clock += 30_000;
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });

    clock += 3_600_000;
    const again = open();

    expect(again.tasks()).toEqual([expect.objectContaining({ text: 'build it', turns: 2, outcome: 'stopped', endedAt: T0 + 30_000 })]);
    expect(again.openTaskOf('worker-1')).toBeUndefined();
  });

  it('8. a damaged line is skipped, the others read', () => {
    const ledger = open();
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });
    ledger.stateChanged(agent({ status: 'idle' }));
    fs.appendFileSync(file, '{"t":"open","id":\n');
    fs.appendFileSync(file, 'not json at all\n');
    clock += 1_000;
    const after = open();
    after.turnStarted(agent(), { sessionId: 'sess-1' });
    after.stateChanged(agent({ status: 'idle' }));

    // The one written after the damage too, not only the one before it.
    expect(open().tasks()).toHaveLength(2);
  });

  it('8. the file keeps its last lines only', () => {
    const ledger = createTaskLedger({ file, textFile, now: () => clock, maxLines: 50 });
    for (let i = 0; i < 40; i++) {
      ledger.turnStarted(agent(), { sessionId: 'sess-1' });
      ledger.stateChanged(agent({ status: 'idle' }));
      clock += 1_000;
    }

    expect(fs.readFileSync(file, 'utf-8').trim().split('\n').length).toBeLessThanOrEqual(50 + 2);
    const kept = createTaskLedger({ file, textFile, now: () => clock, maxLines: 50 }).tasks();
    expect(kept.length).toBeGreaterThan(10);
    // The newest, without a gap: the tasks kept are the last ones started.
    expect(kept.map((t) => t.startedAt)).toEqual(kept.map((_, i) => clock - (kept.length - i) * 1_000));
  });

  it('8. 200 characters of a task\'s text at most, a character never cut in two', () => {
    const ledger = open();
    const long = 'x'.repeat(199) + String.fromCodePoint(0x1F600) + 'tail';
    ledger.handedOff('worker-1', { source: 'tars', text: long });
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });

    expect(Array.from(ledger.tasks()[0].text)).toHaveLength(200);
    expect(ledger.tasks()[0].text.endsWith(String.fromCodePoint(0x1F600))).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('tail');
  });
});

describe('what is read back, from a file any agent can write', () => {
  const good = (id: string, over: Record<string, unknown> = {}) => JSON.stringify({ t: 'task', task: {
    id, agentId: 'ag', projectPath: '/p', worktreePath: null, provider: 'claude', model: 'opus', accountId: null,
    source: 'terminal', requesterAgentId: null, parentTaskId: null, text: 'fine', startedAt: T0 - 1000, endedAt: T0,
    lastAt: T0, outcome: 'completed', turns: 1, sessionIds: ['0941a7e6-7262-4068-ba83-68b7e0de1773'], ...over,
  } });
  const read = (lines: string[]) => {
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return open().tasks();
  };

  it.each([
    ['a text that is an object', { text: { toString: 1 } }],
    ['turns that are not a number', { turns: 'many' }],
    ['an agent that is null', { agentId: null }],
    ['a start that is not a time', { startedAt: 'yesterday' }],
    ['an end that is not a time', { endedAt: 'soon' }],
    ['a source that is not one', { source: 'everyone' }],
    ['an outcome that is not one', { outcome: 'merged' }],
    ['a session id that is a number', { sessionIds: [42] }],
    ['a session id that is a path', { sessionIds: ['../../../../etc/hosts-not-jsonl'] }],
    ['a parent that is an object', { parentTaskId: { id: 'x' } }],
    ['an ACP cost that is not a number', { source: 'acp', acp: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0, costUSD: 'free' } }],
  ])('9. a task with %s is dropped, and the good one beside it kept', (_name, over) => {
    expect(read([good('kept'), good('forged', over)]).map((t) => t.id)).toEqual(['kept']);
  });

  it('9. a line with only an id is dropped', () => {
    expect(read([good('kept'), JSON.stringify({ t: 'task', task: { id: 'bare', sessionIds: [] } })]).map((t) => t.id)).toEqual(['kept']);
  });

  it('9. a text of a megabyte is cut to 200 characters on reading too', () => {
    const [task] = read([good('big', { text: 'x'.repeat(1_000_000) })]);
    expect(task.text).toHaveLength(200);
  });

  it('9. an open task whose last moment is not a time is dropped, not ended at "x"', () => {
    expect(read([good('kept'), good('open', { endedAt: null, lastAt: 'x', outcome: 'running' })]).map((t) => t.id)).toEqual(['kept']);
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/"at":"x"/);
  });

  it('9. a turn or an end line whose fields are not what they say is skipped', () => {
    const tasks = read([
      good('t1', { endedAt: null, outcome: 'running', lastAt: T0 }),
      JSON.stringify({ t: 'turn', id: 't1', at: 'later', sessionId: 's' }),
      JSON.stringify({ t: 'turn', id: 't1', at: T0 + 1, sessionId: '../x' }),
      JSON.stringify({ t: 'end', id: 't1', at: 'x', outcome: 'stopped' }),
      JSON.stringify({ t: 'end', id: 't1', at: T0 + 5, outcome: 'merged' }),
    ]);
    // Read back as a quit cut it short: ended at its last good moment, its turns as they were.
    expect(tasks).toEqual([expect.objectContaining({ id: 't1', turns: 1, endedAt: T0, outcome: 'stopped' })]);
  });
});

describe("a worker's report to the agent that leads it", () => {
  it('10. is no delegation: the lead\'s next task has no parent, and what it hands on after is under that task', () => {
    const ledger = open();
    // JeanBrasse gives the lead a task; the lead hands a gate to the worker, then rests.
    ledger.turnStarted(agent({ id: 'lead' }), { sessionId: 'sess-lead', text: 'gate #305' });
    ledger.handedOff('worker', { source: 'agent', requesterAgentId: 'lead', text: 'gate #305' });
    ledger.turnStarted(agent({ id: 'worker' }), { sessionId: 'sess-worker' });
    ledger.stateChanged(agent({ id: 'lead', status: 'idle' }));
    // The worker reports with send_message, its task still open.
    clock += 1_000;
    ledger.handedOff('lead', { source: 'agent', requesterAgentId: 'worker', text: 'gate done, MERGE' });
    ledger.turnStarted(agent({ id: 'lead' }), { sessionId: 'sess-lead' });
    // The lead hands the merge to a third agent.
    ledger.handedOff('third', { source: 'agent', requesterAgentId: 'lead', text: 'merge #305' });
    ledger.turnStarted(agent({ id: 'third' }), { sessionId: 'sess-third' });

    const [usersTask, gate, report, merge] = ledger.tasks();
    expect(gate).toMatchObject({ agentId: 'worker', parentTaskId: usersTask.id });
    expect(report).toMatchObject({ agentId: 'lead', requesterAgentId: 'worker', parentTaskId: null, text: 'gate done, MERGE' });
    expect(merge).toMatchObject({ agentId: 'third', parentTaskId: report.id });
  });

  it("10. nor to its project's orchestrator, whoever handed it its task", () => {
    const ledger = createTaskLedger({ file, textFile, now: () => clock, leads: (receiverId, senderId) => receiverId === 'orch' && senderId === 'worker' });
    ledger.handedOff('worker', { source: 'tars', text: 'build it' });
    ledger.turnStarted(agent({ id: 'worker' }), { sessionId: 'sess-worker' });
    ledger.handedOff('orch', { source: 'agent', requesterAgentId: 'worker', text: 'built' });
    ledger.turnStarted(agent({ id: 'orch' }), { sessionId: 'sess-orch' });
    // An agent the worker does not report to, handed work by it, is a delegation as before.
    ledger.handedOff('helper', { source: 'agent', requesterAgentId: 'worker', text: 'lint it' });
    ledger.turnStarted(agent({ id: 'helper' }), { sessionId: 'sess-helper' });

    const byAgent = Object.fromEntries(ledger.tasks().map((t) => [t.agentId, t]));
    expect(byAgent.orch.parentTaskId).toBeNull();
    expect(byAgent.helper.parentTaskId).toBe(byAgent.worker.id);
  });
});

describe('an agent put to sleep (#322)', () => {
  // 11. The sleep is taken for an end: a task closed at the rest before it gets a second end, or one the rest kept
  //     open for its background work is closed. Red as QA found it: TaskAgentView did not know `asleep` (tsc).
  it('11. ends no task: the rest before it already did, and its outcome stays as that rest left it', () => {
    const ledger = open();
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'typed by hand' });
    ledger.stateChanged(agent({ status: 'idle' }));
    clock += 31 * 60_000;
    ledger.stateChanged(agent({ status: 'asleep' }));
    expect(ledger.tasks()).toMatchObject([{ outcome: 'completed', endedAt: T0 }]);
  });

  it('11. nor one its rest kept open for work still in the background', () => {
    const ledger = open();
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'typed by hand' });
    ledger.stateChanged(agent({ status: 'idle' }), { backgroundLeft: true });
    ledger.stateChanged(agent({ status: 'asleep' }));
    expect(ledger.tasks()).toMatchObject([{ outcome: 'running', endedAt: null }]);
  });
});

describe('where a task\'s text is kept (JeanBrasse, 05/10)', () => {
  const handAndRun = (ledger: ReturnType<typeof open>, text: string) => {
    ledger.handedOff('worker-1', { source: 'telegram', text });
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });
    ledger.stateChanged(agent({ status: 'idle' }));
  };

  it('12. is never written to the ledger every agent is handed, but to a file only its owner reads', () => {
    const ledger = open();
    handAndRun(ledger, 'merge the release branch, the Hermes key is in the vault');
    const pub = fs.readFileSync(file, 'utf-8');
    expect(pub).not.toContain('merge the release branch');
    expect(pub).not.toContain('"text"');
    // What it cost and how long it took stays there.
    expect(pub).toContain('"startedAt"');
    expect(pub).toContain('"sess-1"');
    expect(fs.readFileSync(textFile, 'utf-8')).toContain('merge the release branch');
    if (hasPosixModes()) {
      expect(fs.statSync(textFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(textFile)).mode & 0o777).toBe(0o700);
    }
    expect(ledger.tasks()[0].text).toBe('merge the release branch, the Hermes key is in the vault');
  });

  it('13. comes back with its task at the next start, and a missing or damaged text file loses no task', () => {
    handAndRun(open(), 'first');
    expect(open().tasks().map((t) => t.text)).toEqual(['first']);
    fs.writeFileSync(textFile, '{"id":');
    expect(open().tasks().map((t) => [t.text, t.outcome])).toEqual([['', 'completed']]);
    fs.rmSync(textFile);
    expect(open().tasks()).toHaveLength(1);
  });

  it('14. written inline by an earlier build, it moves out of ~/.dorothy at the first start', () => {
    const task = {
      id: 't-old', agentId: 'worker-1', projectPath: '/work/tars', worktreePath: null, provider: 'claude', model: null, accountId: null,
      source: 'telegram', requesterAgentId: null, parentTaskId: null, text: 'the old prompt', startedAt: T0, endedAt: T0 + 1, lastAt: T0 + 1,
      outcome: 'completed', turns: 1, sessionIds: ['sess-0'],
    };
    fs.writeFileSync(file, JSON.stringify({ t: 'task', task }) + '\n');
    const ledger = open();
    expect(ledger.tasks().map((t) => t.text)).toEqual(['the old prompt']);
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('the old prompt');
    expect(fs.readFileSync(file, 'utf-8')).toContain('t-old');
    expect(fs.readFileSync(textFile, 'utf-8')).toContain('the old prompt');
  });

  it('15. rewritten past its bound, it keeps the texts of the tasks kept, and no other', () => {
    const ledger = createTaskLedger({ file, textFile, now: () => clock, maxLines: 50 });
    for (let i = 0; i < 40; i++) {
      handAndRun(ledger, `task number ${i}`);
      clock += 1_000;
    }
    const kept = createTaskLedger({ file, textFile, now: () => clock, maxLines: 50 }).tasks();
    expect(kept.length).toBeGreaterThan(10);
    expect(kept.every((t) => /^task number \d+$/.test(t.text))).toBe(true);
    expect(fs.readFileSync(textFile, 'utf-8')).not.toContain('"task number 0"');
    if (hasPosixModes()) expect(fs.statSync(textFile).mode & 0o777).toBe(0o600);
  });

  it('16. a text line that is not one is skipped, and a long one cut to 200 characters', () => {
    handAndRun(open(), 'kept');
    const id = open().tasks()[0].id;
    fs.appendFileSync(textFile, [JSON.stringify({ text: 'no id' }), JSON.stringify({ id, text: { evil: 1 } }), 'not json', ''].join('\n'));
    expect(open().tasks()[0].text).toBe('kept');
    fs.appendFileSync(textFile, JSON.stringify({ id, text: 'y'.repeat(1_000_000) }) + '\n');
    expect(Array.from(open().tasks()[0].text)).toHaveLength(200);
  });
});

describe('the usage of each turn (mods step 4)', () => {
  const usage = (input: number, output: number, model = 'claude-opus-5-5', cacheRead = 0, cacheWrite = 0) => ({ model, input, output, cacheRead, cacheWrite });

  it('17. goes to the agent\'s latest task in its session, even once that task ended at the Stop before it', () => {
    const ledger = open();
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'first' });
    ledger.stateChanged(agent({ status: 'idle' }));
    clock += 1_000;
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'second' });
    ledger.stateChanged(agent({ status: 'idle' }));
    const second = ledger.tasks()[1];
    expect(ledger.turnUsage('worker-1', 'sess-1', usage(10, 5))).toBe(second.id);
    expect(ledger.tasks()[1].usageByModel).toEqual({ 'claude-opus-5-5': { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } });
    expect(ledger.tasks()[0].usageByModel).toBeUndefined();
    // No task of this agent ran in that session, or no such agent: nothing to take it.
    expect(ledger.turnUsage('worker-1', 'sess-9', usage(1, 1))).toBeNull();
    expect(ledger.turnUsage('nobody', 'sess-1', usage(1, 1))).toBeNull();
  });

  it('19. sums the turns of a task, per model', () => {
    const ledger = open();
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'work' });
    ledger.turnUsage('worker-1', 'sess-1', usage(10, 5, 'claude-opus-5-5', 100, 50));
    ledger.turnStarted(agent(), { sessionId: 'sess-1' });
    ledger.turnUsage('worker-1', 'sess-1', usage(20, 10, 'claude-opus-5-5', 200, 100));
    ledger.turnUsage('worker-1', 'sess-1', usage(3, 1, 'claude-haiku-4-5'));
    expect(ledger.tasks()[0].usageByModel).toEqual({
      'claude-opus-5-5': { input: 30, output: 15, cacheRead: 300, cacheWrite: 150 },
      'claude-haiku-4-5': { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    expect(ledger.tasks()[0].usageTurns).toBe(3);
  });

  it('18. survives a restart, and a usage line that is not one is skipped', () => {
    const ledger = open();
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'work' });
    ledger.turnUsage('worker-1', 'sess-1', usage(10, 5));
    const id = ledger.tasks()[0].id;
    fs.appendFileSync(file, [
      { t: 'usage', id, at: clock, model: 'm', input: -1, output: 0, cacheRead: 0, cacheWrite: 0 },
      { t: 'usage', id, at: clock, model: 'm', input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0 },
      { t: 'usage', id, at: clock, model: { x: 1 }, input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      { t: 'usage', id: 'unknown-task', at: clock, model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      { t: 'usage', id, at: 'x', model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const again = open().tasks();
    expect(again[0].usageByModel).toEqual({ 'claude-opus-5-5': { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } });
    expect(again[0].usageTurns).toBe(1);
  });

  it('18. reads what the mod sends only when it is a usage', () => {
    expect(turnUsageOf({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, model: 'claude-opus-5-5' }))
      .toEqual({ model: 'claude-opus-5-5', input: 10, output: 5, cacheRead: 100, cacheWrite: 50 });
    // Claude Code leaves a count out when it is nought.
    expect(turnUsageOf({ input_tokens: 10, output_tokens: 5, model: 'm' })).toEqual({ model: 'm', input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
    for (const bad of [null, 'x', {}, { input_tokens: 1, output_tokens: 1 }, { input_tokens: -1, output_tokens: 1, model: 'm' },
      { input_tokens: '1', output_tokens: 1, model: 'm' }, { input_tokens: 1, output_tokens: 1, model: 'm'.repeat(201) }]) {
      expect(turnUsageOf(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the session of each turn\'s usage (the Audit\'s L1 on #333)', () => {
  const usage = (input: number, output: number, model = 'claude-opus-5-5') => ({ model, input, output, cacheRead: 0, cacheWrite: 0 });

  it('26. is kept with it, per session and per model, and read back so', () => {
    const ledger = open();
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'work' });
    ledger.turnUsage('worker-1', 'sess-1', usage(10, 5));
    ledger.turnStarted(agent(), { sessionId: 'sess-2' });
    ledger.turnUsage('worker-1', 'sess-2', usage(20, 10));
    ledger.turnUsage('worker-1', 'sess-2', usage(1, 1, 'claude-haiku-4-5'));
    const want = {
      'sess-1': { 'claude-opus-5-5': { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
      'sess-2': { 'claude-opus-5-5': { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 }, 'claude-haiku-4-5': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    };
    expect(ledger.tasks()[0].usageBySession).toEqual(want);
    expect(fs.readFileSync(file, 'utf-8')).toContain('"sessionId":"sess-2"');
    expect(open().tasks()[0].usageBySession).toEqual(want);
    expect(ledger.tasks()[0]).toMatchObject({ usageTurns: 3, sessionedTurns: 3 });
    expect(open().tasks()[0]).toMatchObject({ usageTurns: 3, sessionedTurns: 3 });
  });

  it('26. survives a rewrite of the file past its bound', () => {
    const ledger = createTaskLedger({ file, textFile, now: () => clock, maxLines: 50 });
    for (let i = 0; i < 40; i++) {
      ledger.turnStarted(agent(), { sessionId: `sess-${i}` });
      ledger.turnUsage('worker-1', `sess-${i}`, usage(i + 1, 1));
      ledger.stateChanged(agent({ status: 'idle' }));
      clock += 1_000;
    }
    const kept = createTaskLedger({ file, textFile, now: () => clock, maxLines: 50 }).tasks();
    // The oldest kept were carried by the rewrite's task lines alone; the newest by lines written after it.
    expect(kept.length).toBeGreaterThan(10);
    for (const t of kept) {
      const i = Number(t.sessionIds[0].slice('sess-'.length));
      expect(t.usageBySession, t.sessionIds[0]).toEqual({ [`sess-${i}`]: { 'claude-opus-5-5': { input: i + 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
      expect(t.sessionedTurns, `27. ${t.sessionIds[0]}`).toBe(1);
    }
  });

  it('26. a usage line whose session is not one is skipped; one written by 1.9.3, with none, is kept as a session not known', () => {
    const ledger = open();
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'work' });
    const id = ledger.tasks()[0].id;
    fs.appendFileSync(file, [
      { t: 'usage', id, at: clock, sessionId: '../../etc/passwd', model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      { t: 'usage', id, at: clock, sessionId: 42, model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      { t: 'usage', id, at: clock, model: 'm', input: 7, output: 0, cacheRead: 0, cacheWrite: 0 },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const read = open().tasks()[0];
    expect(read.usageByModel).toEqual({ m: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(read.usageBySession ?? {}).toEqual({});
    expect(read.usageTurns).toBe(1);
    expect(read.sessionedTurns ?? 0, '27. a 1.9.3 turn names no session').toBe(0);
  });
});

describe('hand-offs in order, each to the turn that runs it (R1)', () => {
  const said = (ref: string, text: string, from = 'orch') => `Message from agent "X" ("${from}"), task ${ref}: ${text}`;

  it("28. two hand-offs to one worker: each turn takes the one whose id it carries, the first's sender kept", () => {
    const ledger = open();
    ledger.handedOff('worker-1', { source: 'agent', requesterAgentId: 'orch', text: 'review #280', ref: 't-aaaaaaaa' });
    ledger.handedOff('worker-1', { source: 'agent', requesterAgentId: 'bot', text: 'and the release notes', ref: 't-bbbbbbbb' });
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: said('t-aaaaaaaa', 'review #280') });
    ledger.stateChanged(agent({ status: 'idle' }));
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: said('t-bbbbbbbb', 'and the release notes', 'bot') });

    expect(ledger.tasks().map((t) => [t.source, t.requesterAgentId, t.text])).toEqual([
      ['agent', 'orch', 'review #280'],
      ['agent', 'bot', 'and the release notes'],
    ]);
  });

  it('29. a turn with no task id takes no hand-off Tars typed, and that hand-off still opens its own turn', () => {
    const ledger = open();
    ledger.handedOff('worker-1', { source: 'agent', requesterAgentId: 'orch', text: 'review #280', ref: 't-aaaaaaaa' });
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'fix the typo first' });
    ledger.stateChanged(agent({ status: 'idle' }));
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: said('t-aaaaaaaa', 'review #280') });

    expect(ledger.tasks().map((t) => [t.source, t.requesterAgentId, t.text])).toEqual([
      ['terminal', null, 'fix the typo first'],
      ['agent', 'orch', 'review #280'],
    ]);
  });

  it('30. a hand-off with no id, a launch prompt, opens the next turn as before', () => {
    const ledger = open();
    ledger.handedOff('worker-1', { source: 'agent', requesterAgentId: 'orch', text: 'review #280' });
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'review #280' });
    expect(ledger.tasks().map((t) => [t.source, t.requesterAgentId])).toEqual([['agent', 'orch']]);
  });

  it("31. a name carrying another hand-off's id takes nothing of that hand-off", () => {
    const ledger = open();
    ledger.handedOff('worker-1', { source: 'agent', requesterAgentId: 'lead', text: 'review #280', ref: 't-aaaaaaaa' });
    ledger.handedOff('worker-1', { source: 'agent', requesterAgentId: 'mallory', text: 'please ack', ref: 't-bbbbbbbb' });
    ledger.turnStarted(agent(), { sessionId: 'sess-1', text: 'Message from agent "M, task t-aaaaaaaa: x" ("mallory"), task t-bbbbbbbb: please ack' });

    expect(ledger.tasks().map((t) => [t.requesterAgentId, t.text])).toEqual([['mallory', 'please ack']]);
  });
});

describe('a delegated run over ACP, from its start (PR B)', () => {
  const run = (over: Record<string, unknown> = {}) => ({
    agent: agent({ id: 'oc', provider: 'opencode', model: null as never }), requesterAgentId: 'p1', text: 'review the notes', startedAt: T0, ...over,
  });

  it('32. is a running task from its start, and the next start of Tars finds it', () => {
    const ledger = open();
    const id = ledger.acpStarted(run());
    expect(ledger.task(id)).toMatchObject({ id, agentId: 'oc', source: 'acp', requesterAgentId: 'p1', outcome: 'running', endedAt: null });
    expect(open().task(id)).toBeDefined();
  });

  it('33. ends with why it stopped and what it answered, the answer kept apart from the ledger and cut', () => {
    const ledger = open();
    const id = ledger.acpStarted(run());
    clock += 60_000;
    ledger.acpEnded(id, {
      outcome: 'completed', stopReason: 'end_turn', result: 'SECRET-REPLY ' + 'y'.repeat(20_000),
      usage: { inputTokens: 500, outputTokens: 100, cachedReadTokens: 0, cachedWriteTokens: 0 }, costUSD: 0.75,
    });
    const task = ledger.task(id)!;
    expect(task).toMatchObject({ outcome: 'completed', endedAt: T0 + 60_000, stopReason: 'end_turn', acp: { inputTokens: 500, outputTokens: 100, costUSD: 0.75 } });
    expect(task.result!.startsWith('SECRET-REPLY')).toBe(true);
    expect(task.result!.length).toBeLessThanOrEqual(8_000);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('SECRET-REPLY');
    expect(fs.readFileSync(resultFile, 'utf8')).toContain('SECRET-REPLY');
    expect(fs.statSync(resultFile).mode & 0o777).toBe(0o600);
  });

  it('34. one open when Tars stopped is marked cut at the next start, listed once for its asker to be told', () => {
    const first = open();
    const id = first.acpStarted(run());
    clock += 10_000;
    const second = open();
    expect(second.task(id)).toMatchObject({ outcome: 'stopped', stopReason: 'interrupted' });
    expect(second.interruptedAtStart().map((t) => [t.id, t.requesterAgentId, t.text])).toEqual([[id, 'p1', 'review the notes']]);
    expect(second.interruptedAtStart()).toEqual([]);
    expect(open().interruptedAtStart()).toEqual([]);
  });

  it('35. is found by its id after a restart, with its result', () => {
    const ledger = open();
    const id = ledger.acpStarted(run());
    ledger.acpEnded(id, { outcome: 'completed', stopReason: 'end_turn', result: 'reviewed', usage: null, costUSD: null });
    expect(open().task(id)).toMatchObject({ id, outcome: 'completed', stopReason: 'end_turn', result: 'reviewed' });
    expect(open().task('00000000-0000-4000-8000-000000000000')).toBeUndefined();
  });

  it('36. rewritten past its bound, keeps the results of the tasks it keeps, and only those', () => {
    const ledger = open(4);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      clock += 1_000;
      const id = ledger.acpStarted(run({ startedAt: clock, text: `run ${i}` }));
      ledger.acpEnded(id, { outcome: 'completed', stopReason: 'end_turn', result: `RESULT-${i}`, usage: null, costUSD: null });
      ids.push(id);
    }
    const again = open(4);
    const kept = ids.filter((id) => again.task(id));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(4);
    for (const id of kept) expect(again.task(id)!.result).toMatch(/^RESULT-/);
    const results = fs.readFileSync(resultFile, 'utf8');
    for (const id of ids.filter((id) => !kept.includes(id))) expect(results).not.toContain(id);
  });
});
