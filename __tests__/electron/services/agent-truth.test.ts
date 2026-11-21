import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';

/** Bytes read from files while `on`, through either way of reading one. */
const counted = vi.hoisted(() => ({ on: false, bytes: 0 }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const readSync = ((...args: Parameters<typeof actual.readSync>) => {
    const n = (actual.readSync as (...a: Parameters<typeof actual.readSync>) => number)(...args);
    if (counted.on) counted.bytes += n;
    return n;
  }) as typeof actual.readSync;
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const out = (actual.readFileSync as (...a: Parameters<typeof actual.readFileSync>) => string | Buffer)(...args);
    if (counted.on) counted.bytes += typeof out === 'string' ? Buffer.byteLength(out) : out.length;
    return out;
  }) as typeof actual.readFileSync;
  return { ...actual, readSync, readFileSync, default: { ...actual, readSync, readFileSync } };
});
import * as os from 'os';
import * as path from 'path';
import { encodeProjectDirName } from '../../../electron/utils/resume-session';
import { sessionModel, withSessionTruth, clearAgentTruthCache, pendingBackgroundWork } from '../../../electron/services/agent-truth';

/**
 * What an agent is actually on.
 *
 * `agent.model` was only ever written by Tars, from the edit screen or the
 * create call. So typing `/model opus` into the terminal changed the session
 * and not the record, the card kept saying the old model, and the next respawn
 * rebuilt the command from that record and quietly put it back.
 *
 * The session is read back, and reported beside the record as `sessionModel`:
 * it used to replace the record, launches included, which put agents moved to
 * a new model back on the one their previous session had used. What has to be
 * right is the "only ever fills in" part: a reading that fails must leave the
 * record alone rather than blanking a model the user did choose.
 *
 * And what reading it costs (the crash of 2026-10-13 00:26: Tars's main process
 * died at its heap's limit, its live heap measured at 2.8 to 3.2 GB). The
 * agent list is built about twice a second, and the model is read for every
 * agent once the 5 s cache runs out: the whole transcript, read and split into
 * lines, to find its last assistant line. The fleet's live transcripts were
 * 136 MB, 114 MB, 104 MB... 830 MB together. How it fails, written before the
 * code:
 * 1. The read follows the file's size: megabytes of strings made, every 5 s,
 *    for each agent, where the last assistant line is a few kilobytes from
 *    the end.
 * 2. Reading only the end misses a last assistant line further back (a long
 *    tool output after it): the model reads as none.
 * 3. A line cut at the start of what is read is taken for a whole one.
 * 4. A file that has not changed is read again when the 5 s run out.
 * And the background work a session left running (the Low logged after the
 * 2.0.0 chain, 13/10: Tars told requesters, at every end of an agent's turn,
 * that tasks finished hours before were still running), written before the
 * code:
 * 6. A task that ends while a turn runs has its note recorded, by claude
 *    2.1.296, as an attachment of type queued_command (its prompt the
 *    <task-notification>), with a queue-operation enqueue beside it: never as
 *    a user line. Read only from user lines, it stays running for ever.
 * 7. Either of the two alone (an enqueue whose attachment never came, the
 *    note removed from the queue before the next turn) is not taken as the
 *    task's end.
 * 8. A note quoted in a tool's output (a transcript read, a file shown) ends
 *    the task it names.
 * 9. (GATE-PR389, L1) A message typed in during the turn (an attachment of
 *    commandMode 'prompt', an enqueue that reads "Message from ...") that
 *    quotes a completed note for this agent's running task ends it: only a
 *    note Claude Code queued itself (commandMode 'task-notification', a
 *    content that is the note) does.
 *
 * 5. A character of several bytes cut at the start of what is read garbles
 *    the model's name.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-truth-'));
const PROJECT = '/Users/you/tars';
const SESSION = '4ab31f00-ce51-4676-ab80-4023cf6e3f4e';

function writeTranscript(projectPath: string, sessionId: string, lines: string[]) {
  const dir = path.join(home, '.claude', 'projects', encodeProjectDirName(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

const assistant = (model: string) =>
  JSON.stringify({ type: 'assistant', message: { model, usage: { input_tokens: 1 } } });

beforeEach(() => {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  clearAgentTruthCache();
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('reading the model back from the session', () => {
  it('reports the model the session last answered on', () => {
    writeTranscript(PROJECT, SESSION, [assistant('claude-sonnet-5'), assistant('claude-opus-5')]);
    expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe('claude-opus-5');
  });

  it('ignores messages Claude Code generated itself', () => {
    // `<synthetic>` is not a model anyone chose.
    writeTranscript(PROJECT, SESSION, [assistant('claude-opus-5'), assistant('<synthetic>')]);
    expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe('claude-opus-5');
  });

  it('skips lines that are not assistant turns', () => {
    writeTranscript(PROJECT, SESSION, [
      assistant('claude-opus-5'),
      JSON.stringify({ type: 'user', message: { model: 'not-a-model' } }),
    ]);
    expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe('claude-opus-5');
  });

  it('survives a corrupt line', () => {
    const dir = path.join(home, '.claude', 'projects', encodeProjectDirName(PROJECT));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), `{not json\n${assistant('claude-opus-5')}\n`);
    expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe('claude-opus-5');
  });

  it('looks in the worktree, which is where an agent with one ran', () => {
    const worktree = '/Users/you/tars/.worktrees/feat-x';
    writeTranscript(worktree, SESSION, [assistant('claude-haiku-4-5')]);
    expect(
      sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT, worktreePath: worktree }, home),
    ).toBe('claude-haiku-4-5');
  });

  it('reports nothing when there is no session or no transcript', () => {
    expect(sessionModel({ projectPath: PROJECT }, home)).toBeNull();
    expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBeNull();
  });

  it('reports nothing for a transcript with no assistant turn yet', () => {
    writeTranscript(PROJECT, SESSION, [JSON.stringify({ type: 'user', message: {} })]);
    expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBeNull();
  });
});

describe('what the agent list serves', () => {
  it('leaves a record alone when there is nothing to read', () => {
    // The case that matters: a failed reading must not blank a model the user
    // did choose.
    const agent = { id: 'a1', model: 'claude-sonnet-5', branchName: 'feat/x', projectPath: PROJECT };
    const out = withSessionTruth(agent);
    expect(out.model).toBe('claude-sonnet-5');
    expect(out.branchName).toBe('feat/x');
  });

  it('keeps every other field untouched', () => {
    const agent = { id: 'a1', name: 'Frontend', model: 'm', projectPath: PROJECT, status: 'idle' };
    expect(withSessionTruth(agent)).toMatchObject({ id: 'a1', name: 'Frontend', status: 'idle' });
  });

  it("serves the model the agent is set to, and the session's beside it", () => {
    // Moved to Opus 5.5 in the Agents page, its last session on Opus 5: the
    // list used to serve Opus 5 as the model, the edit screen showed it, and
    // the next save of anything wrote it back into the record.
    const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectDirName(PROJECT));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), `${assistant('claude-opus-5')}\n`);
    try {
      const out = withSessionTruth({ id: 'a1', model: 'claude-opus-5-5', projectPath: PROJECT, resumableSessionId: SESSION });
      expect(out.model).toBe('claude-opus-5-5');
      expect(out.sessionModel).toBe('claude-opus-5');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('work a session left running in the background', () => {
  const SINCE = Date.parse('2026-09-22T20:41:30.000Z');
  const at = (seconds: number) => new Date(SINCE + seconds * 1000).toISOString();
  const agent = { currentSessionId: SESSION, projectPath: PROJECT };
  /** The records Claude Code 2.1.280 writes, trimmed to the fields read. */
  const call = (id: string, name: string, s: number, input: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (toolUseId: string, s: number, toolUseResult: Record<string, unknown>) =>
    JSON.stringify({ type: 'user', timestamp: at(s), toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'running' }] } });
  const note = (taskId: string, s: number, status?: string) =>
    JSON.stringify({ type: 'user', timestamp: at(s), message: { content:
      `<task-notification>\n<task-id>${taskId}</task-id>\n${status ? `<status>${status}</status>\n` : ''}<summary>x</summary>\n</task-notification>` } });

  it('names a background command until its note says how it ended', () => {
    writeTranscript(PROJECT, SESSION, [call('t1', 'Bash', 5), result('t1', 6, { backgroundTaskId: 'bgncs8rbv' })]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual(['bgncs8rbv']);

    writeTranscript(PROJECT, SESSION, [call('t1', 'Bash', 5), result('t1', 6, { backgroundTaskId: 'bgncs8rbv' }), note('bgncs8rbv', 44, 'completed')]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
  });

  it.each(['failed', 'killed', 'stopped'])('takes a note that says %s as an end', (status) => {
    writeTranscript(PROJECT, SESSION, [call('t1', 'Bash', 5), result('t1', 6, { backgroundTaskId: 'b1' }), note('b1', 9, status)]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
  });

  it('keeps a Monitor running through its events, which carry no status', () => {
    const lines = [call('m1', 'Monitor', 5), result('m1', 6, { taskId: 'biuw2fli9' }), note('biuw2fli9', 20), note('biuw2fli9', 30)];
    writeTranscript(PROJECT, SESSION, lines);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual(['biuw2fli9']);

    writeTranscript(PROJECT, SESSION, [...lines, note('biuw2fli9', 40, 'stopped')]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
  });

  it('counts an Agent launched asynchronously', () => {
    writeTranscript(PROJECT, SESSION, [call('a1', 'Agent', 5), result('a1', 6, { isAsync: true, status: 'async_launched', agentId: 'a76fbebc0fee4081a' })]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual(['a76fbebc0fee4081a']);
  });

  it('takes a task stopped with TaskStop, which sends no note, as ended', () => {
    writeTranscript(PROJECT, SESSION, [
      call('t1', 'Bash', 5), result('t1', 6, { backgroundTaskId: 'bz3s5cvjo' }),
      call('s1', 'TaskStop', 9, { task_id: 'bz3s5cvjo' }),
    ]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
  });

  it('ignores what an earlier process started: a forked transcript copies it with the old times', () => {
    writeTranscript(PROJECT, SESSION, [call('t1', 'Bash', -30), result('t1', -29, { backgroundTaskId: 'from-before' })]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
  });

  /** A note that came during a turn, as claude 2.1.296 writes it: queued, then attached to the turn. */
  const notice = (taskId: string, status: string) => `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n<summary>Background command "sleep 25" completed (exit code 0)</summary>\n</task-notification>`;
  const enqueued = (taskId: string, s: number, status = 'completed') =>
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(s), sessionId: SESSION, content: notice(taskId, status) });
  const attached = (taskId: string, s: number, status = 'completed') =>
    JSON.stringify({ type: 'attachment', timestamp: at(s), sessionId: SESSION, attachment: { type: 'queued_command', prompt: notice(taskId, status), commandMode: 'task-notification' } });

  it('6. takes a note that came during a turn as the end of its task', () => {
    writeTranscript(PROJECT, SESSION, [call('t1', 'Bash', 5), result('t1', 6, { backgroundTaskId: 'bmid0turn' }), enqueued('bmid0turn', 40), attached('bmid0turn', 41)]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
  });

  it('7. takes either of its two records alone as the end', () => {
    writeTranscript(PROJECT, SESSION, [call('t1', 'Bash', 5), result('t1', 6, { backgroundTaskId: 'bq1' }), enqueued('bq1', 40)]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
    writeTranscript(PROJECT, SESSION, [call('t1', 'Bash', 5), result('t1', 6, { backgroundTaskId: 'ba1' }), attached('ba1', 41)]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
    // A Monitor's event, queued during a turn, still carries no end: as claude
    // writes it, a summary and an <event>, no status (GATE-PR389, L2).
    const event = `<task-notification>\n<task-id>bmon</task-id>\n<summary>Monitor event: "gate steps"</summary>\n<event>EXIT=0</event>\n</task-notification>`;
    writeTranscript(PROJECT, SESSION, [
      call('m1', 'Monitor', 5), result('m1', 6, { taskId: 'bmon' }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(40), sessionId: SESSION, content: event }),
      JSON.stringify({ type: 'attachment', timestamp: at(41), sessionId: SESSION, attachment: { type: 'queued_command', prompt: event, commandMode: 'task-notification' } }),
    ]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual(['bmon']);
  });

  it('9. does not take a typed message that quotes a completed note as an end', () => {
    const typed = `Message from agent "Lead" ("o1"): the log said\n${notice('bquoted', 'completed')}\nis it done?`;
    writeTranscript(PROJECT, SESSION, [
      call('t1', 'Bash', 5), result('t1', 6, { backgroundTaskId: 'bquoted' }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(40), sessionId: SESSION, content: typed }),
      JSON.stringify({ type: 'attachment', timestamp: at(41), sessionId: SESSION, attachment: { type: 'queued_command', prompt: typed, commandMode: 'prompt' } }),
    ]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual(['bquoted']);
    // A note pasted as the whole message: its mode alone says it was typed.
    writeTranscript(PROJECT, SESSION, [
      call('t1', 'Bash', 5), result('t1', 6, { backgroundTaskId: 'bpasted' }),
      JSON.stringify({ type: 'attachment', timestamp: at(41), sessionId: SESSION, attachment: { type: 'queued_command', prompt: notice('bpasted', 'completed'), commandMode: 'prompt' } }),
    ]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual(['bpasted']);
  });

  it('8. does not take a note quoted in a tool\'s output as an end', () => {
    const quoted = JSON.stringify({ type: 'user', timestamp: at(30), message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: notice('bstill', 'completed') }] } });
    writeTranscript(PROJECT, SESSION, [call('t1', 'Bash', 5), result('t1', 6, { backgroundTaskId: 'bstill' }), quoted]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual(['bstill']);
  });

  it('does not take a task id from any other tool for background work', () => {
    // The todo tools answer with a taskId too.
    writeTranscript(PROJECT, SESSION, [call('c1', 'TaskCreate', 5), result('c1', 6, { taskId: '3' })]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
  });

  it('reports nothing without a session or a transcript', () => {
    expect(pendingBackgroundWork({ projectPath: PROJECT }, SINCE, home)).toEqual([]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
  });
});

describe('what reading the model costs', () => {
  const fileOf = () => path.join(home, '.claude', 'projects', encodeProjectDirName(PROJECT), `${SESSION}.jsonl`);
  const filler = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'user', message: { content: `${i} ${'x'.repeat(1000)}` } }));
  const readBytes = () => {
    counted.bytes = 0;
    counted.on = true;
    return { bytes: () => counted.bytes, restore: () => { counted.on = false; } };
  };

  it('1. reads the end of a large transcript, not the whole of it', () => {
    writeTranscript(PROJECT, SESSION, [assistant('claude-sonnet-5'), ...filler(20_000), assistant('claude-opus-5')]);
    const size = fs.statSync(fileOf()).size;
    const spy = readBytes();
    try {
      expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe('claude-opus-5');
      expect(spy.bytes(), `read ${spy.bytes()} of ${size} bytes`).toBeLessThanOrEqual(1024 * 1024);
    } finally { spy.restore(); }
  });

  it('2. still finds a last assistant line further back than the first read', () => {
    writeTranscript(PROJECT, SESSION, [assistant('claude-opus-5'), ...filler(2_000)]);
    expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe('claude-opus-5');
  });

  it('3, 5. takes no cut line for a whole one, and keeps a name of several-byte characters whole', () => {
    const named = 'claude-öpus-5-ünïcode';
    writeTranscript(PROJECT, SESSION, [assistant(named), ...filler(600)]);
    expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe(named);
  });

  it('4. reads the model again when the transcript was rewritten to the same size with a new date', () => {
    writeTranscript(PROJECT, SESSION, [assistant('claude-opus-5'), ...filler(10)]);
    vi.useFakeTimers();
    try {
      expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe('claude-opus-5');
      writeTranscript(PROJECT, SESSION, [assistant('claude-opus-6'), ...filler(10)]);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(fileOf(), later, later);
      vi.advanceTimersByTime(60_000);
      expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe('claude-opus-6');
    } finally { vi.useRealTimers(); }
  });

  it('4. reads nothing again while the transcript has not changed', () => {
    writeTranscript(PROJECT, SESSION, [assistant('claude-opus-5'), ...filler(100)]);
    vi.useFakeTimers();
    try {
      expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe('claude-opus-5');
      vi.advanceTimersByTime(60_000);
      const spy = readBytes();
      try {
        expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe('claude-opus-5');
        expect(spy.bytes()).toBe(0);
      } finally { spy.restore(); }
    } finally { vi.useRealTimers(); }
  });
});
