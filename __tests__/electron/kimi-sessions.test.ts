import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { kimiEventOf, KimiSessionWatch, type HookPost } from '../../electron/services/kimi-sessions';

/**
 * Kimi Code's turns, read from the session log it writes, and told to Tars as Claude Code's hooks tell it.
 *
 * Measured on kimi-code 2.6.3 (19/11/2026), in a PTY against a loopback stand-in endpoint: each session is
 * `$KIMI_CODE_HOME/sessions/<workspace>/<session id>/agents/main/wire.jsonl`, listed in `session_index.jsonl` as
 * `{sessionId, sessionDir, workDir}`; a turn is `turn.prompt` (its `input` text parts, `turnId` a number), then
 * `context.append_loop_event` records whose `event` is a `content.part` (`turnId` a string, `step`, `block`,
 * `part: {type: 'text', text}`), then `turn.ended` with `reason` `completed`, or `cancelled` after an Esc. While a
 * kimi process holds a session it keeps `locks/sessions/<session id>.lock`, JSON with its `pid`.
 *
 * How it fails, written before the code (19/11):
 * 1. A line that is not JSON, not an object, or not one of the three records is read as an event.
 * 2. A prompt's text loses a part, or takes a part that is not text.
 * 3. A thinking part, or a part of another agent's wire (a subagent's), is read as the answer.
 * 4. The answer is the last text part only, instead of the turn's report (reportOf over its messages).
 * 5. `completed` is not posted as a Stop with the answer; `cancelled` is not an interruption; another reason is
 *    not a failure that says the reason.
 * 6. A session is bound to an agent without evidence: one in another folder, one locked by a process that is not
 *    under the agent's terminal, one whose first prompt names another agent.
 * 7. Two agents launched in one folder take each other's session.
 * 8. A session the launch resumes is read from its start, and its old turns posted again.
 * 9. A line still being written is parsed before its end.
 * 10. The posts are out of the order the hook routes expect: the session's registration, then the prompt, then the
 *     answer, the rest and the stop.
 */

describe('kimiEventOf', () => {
  it('1: only turn.prompt, a text content.part and turn.ended are events', () => {
    for (const line of ['', 'not json', '[]', '"s"', '{"type":"metadata"}', '{"type":"usage.record","usage":{}}',
      '{"type":"context.append_loop_event","event":{"type":"tool.call","turnId":"0"}}']) {
      expect(kimiEventOf(line), line).toBeNull();
    }
  });

  it('2: a prompt is its text parts joined, in order', () => {
    const line = JSON.stringify({ type: 'turn.prompt', agentId: 'main', turnId: 3, origin: { kind: 'user' },
      input: [{ type: 'text', text: 'fix ' }, { type: 'image', url: 'x' }, { type: 'text', text: 'the tests' }] });
    expect(kimiEventOf(line)).toEqual({ kind: 'prompt', turnId: 3, text: 'fix the tests' });
  });

  it('3: a text part is the answer; a thinking part and another agent\'s part are not', () => {
    const part = (p: unknown, agentId = 'main') => JSON.stringify({ type: 'context.append_loop_event', agentId,
      event: { type: 'content.part', turnId: '2', step: 1, block: 0, part: p } });
    expect(kimiEventOf(part({ type: 'text', text: 'done' }))).toEqual({ kind: 'text', turnId: 2, step: 1, block: 0, text: 'done' });
    expect(kimiEventOf(part({ type: 'think', think: 'hm' }))).toBeNull();
    expect(kimiEventOf(part({ type: 'text', text: 'done' }, 'agent-0'))).toBeNull();
  });

  it('5: turn.ended carries its reason', () => {
    expect(kimiEventOf('{"type":"turn.ended","agentId":"main","turnId":0,"reason":"completed"}')).toEqual({ kind: 'ended', turnId: 0, reason: 'completed' });
    expect(kimiEventOf('{"type":"turn.ended","agentId":"main","turnId":4,"reason":"cancelled"}')).toEqual({ kind: 'ended', turnId: 4, reason: 'cancelled' });
  });
});

const IDENTITY = (id: string) => `[Tars: you are agent "Kimi Worker" (id ${id}), worker of project /p.]`;

describe('KimiSessionWatch', () => {
  let home: string;
  let work: string;
  let posts: Array<{ agentId: string; post: HookPost }>;
  let interrupted: string[];
  let pids: Record<string, number[] | undefined>;
  let clock: number;
  let watch: KimiSessionWatch;

  const session = (id: string, workDir = work) => {
    const dir = path.join(home, 'sessions', 'wd_x_000000000000', id);
    fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'agents', 'agent-0'), { recursive: true });
    fs.appendFileSync(path.join(home, 'session_index.jsonl'), `${JSON.stringify({ sessionId: id, sessionDir: dir, workDir })}\n`);
    fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), '{"type":"metadata","protocol_version":"1.5"}\n');
    return path.join(dir, 'agents', 'main', 'wire.jsonl');
  };
  const lock = (id: string, pid: number) => {
    fs.mkdirSync(path.join(home, 'locks', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'locks', 'sessions', `${id}.lock`), JSON.stringify({ pid, token: `${pid}:x` }));
  };
  const write = (file: string, ...records: unknown[]) => fs.appendFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const prompt = (turnId: number, text: string) => ({ type: 'turn.prompt', agentId: 'main', turnId, origin: { kind: 'user' }, input: [{ type: 'text', text }] });
  const said = (turnId: number, step: number, text: string, block = 0) => ({ type: 'context.append_loop_event', agentId: 'main', event: { type: 'content.part', turnId: String(turnId), step, block, part: { type: 'text', text } } });
  const ended = (turnId: number, reason: string) => ({ type: 'turn.ended', agentId: 'main', turnId, reason });
  const of = (agentId: string) => posts.filter((p) => p.agentId === agentId).map((p) => [p.post.path, p.post.body.status ?? p.post.body.hook ?? '', p.post.body.output ?? p.post.body.current_task ?? p.post.body.source ?? p.post.body.error_message ?? '', p.post.body.session_id]);

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-home-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-work-'));
    posts = [];
    interrupted = [];
    pids = {};
    clock = 1_000_000;
    watch = new KimiSessionWatch({
      homeOf: () => home,
      now: () => clock,
      post: async (agentId, post) => { posts.push({ agentId, post }); },
      interrupted: (agentId) => { interrupted.push(agentId); },
      pidsOf: async (agentId) => pids[agentId],
    });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('5 and 10: a session locked by the agent\'s kimi is followed, its turn posted in order, its report the answer', async () => {
    watch.noteLaunch('a1', work);
    pids.a1 = [100, 101];
    const wire = session('session_1');
    lock('session_1', 101);
    write(wire, prompt(0, 'do it'), said(0, 1, 'Looking at the files.'), said(0, 2, 'The report: all tests pass, and here is why in detail.'), said(0, 3, 'Saved.'), ended(0, 'completed'));
    await watch.tick();
    expect(of('a1')).toEqual([
      ['/api/hooks/status', 'running', 'startup', 'session_1'],
      ['/api/hooks/status', 'running', 'do it', 'session_1'],
      ['/api/hooks/output', 'Stop', 'The report: all tests pass, and here is why in detail.\n\nSaved.', 'session_1'],
      ['/api/hooks/status', 'idle', '', 'session_1'],
      ['/api/hooks/agent-stopped', 'Stop', '', 'session_1'],
    ]);
  });

  it('4: text parts of one block are one message, read whole', async () => {
    watch.noteLaunch('a1', work);
    pids.a1 = [7];
    const wire = session('session_1');
    lock('session_1', 7);
    write(wire, prompt(0, 'go'), said(0, 1, 'Part one, '), said(0, 1, 'part two.'), ended(0, 'completed'));
    await watch.tick();
    expect(of('a1').find((p) => p[0] === '/api/hooks/output')?.[2]).toBe('Part one, part two.');
  });

  it('5: cancelled is an interruption, with no answer; another reason is a failure that says it', async () => {
    watch.noteLaunch('a1', work);
    pids.a1 = [7];
    const wire = session('session_1');
    lock('session_1', 7);
    write(wire, prompt(0, 'long'), said(0, 1, 'half'), ended(0, 'cancelled'));
    await watch.tick();
    expect(interrupted).toEqual(['a1']);
    expect(of('a1').some((p) => p[0] === '/api/hooks/output')).toBe(false);
    expect(of('a1').at(-1)).toEqual(['/api/hooks/status', 'idle', '', 'session_1']);
    posts = [];
    write(wire, prompt(1, 'again'), ended(1, 'max_steps_reached'));
    await watch.tick();
    const failed = posts.find((p) => p.post.body.status === 'error');
    expect(failed?.post.body).toMatchObject({ error_kind: 'kimi_turn_failed', error_message: expect.stringContaining('max_steps_reached') });
  });

  it('6: no evidence, no binding: another folder, a lock of a process outside the terminal, a prompt naming another agent', async () => {
    watch.noteLaunch('a1', work);
    pids.a1 = [7];
    const elsewhere = session('session_x', path.join(work, 'other'));
    lock('session_x', 7);
    write(elsewhere, prompt(0, 'not here'), ended(0, 'completed'));
    const foreign = session('session_y');
    lock('session_y', 999);
    write(foreign, prompt(0, 'the user\'s own kimi'), ended(0, 'completed'));
    const named = session('session_z');
    write(named, prompt(0, `${IDENTITY('other-agent-id-1234')} work`), ended(0, 'completed'));
    await watch.tick();
    clock += 60_000;
    await watch.tick();
    expect(posts).toEqual([]);
  });

  it('6: where no process can be read, the first prompt naming the agent binds the session', async () => {
    watch.noteLaunch('a1-0000-1111', work);
    pids['a1-0000-1111'] = undefined;
    const wire = session('session_1');
    write(wire, prompt(0, `${IDENTITY('a1-0000-1111')} the task`), said(0, 1, 'ok'), ended(0, 'completed'));
    await watch.tick();
    expect(of('a1-0000-1111').map((p) => p[1])).toEqual(['running', 'running', 'Stop', 'idle', 'Stop']);
  });

  it('6: a turn too short for its lock to be seen: the first prompt holding what Tars typed into the agent\'s terminal binds it', async () => {
    // Measured on 2.6.3: kimi holds the lock only while a turn writes, and a turn on a fast endpoint ends in 0.4 s.
    watch.noteLaunch('a1', work);
    watch.noteLaunch('a2', work);
    pids.a1 = [10];
    pids.a2 = [20];
    const typed = 'Message from agent "Lead" ("lead-id"), task t-1a2b3c4d:\n\nRun the tests\nand say what failed.';
    watch.noteTyped('a2', 'Message from agent "Lead" ("lead-id"), task t-99999999:\n\nsomething else entirely');
    watch.noteTyped('a1', typed);
    watch.noteTyped('a1', 'ok');
    const wire = session('session_1');
    write(wire, prompt(0, typed), said(0, 1, 'none failed'), ended(0, 'completed'));
    const short = session('session_2');
    write(short, prompt(0, 'ok'), ended(0, 'completed'));
    await watch.tick();
    expect(of('a1').find((p) => p[0] === '/api/hooks/output')?.slice(2)).toEqual(['none failed', 'session_1']);
    expect(of('a2')).toEqual([]);
  });

  it('7: two agents in one folder each get the session their own kimi holds', async () => {
    watch.noteLaunch('a1', work);
    watch.noteLaunch('a2', work);
    pids.a1 = [10, 11];
    pids.a2 = [20, 21];
    const one = session('session_1');
    const two = session('session_2');
    lock('session_1', 21);
    lock('session_2', 11);
    write(one, prompt(0, 'for a2'), said(0, 1, 'two'), ended(0, 'completed'));
    write(two, prompt(0, 'for a1'), said(0, 1, 'one'), ended(0, 'completed'));
    await watch.tick();
    expect(of('a1').find((p) => p[0] === '/api/hooks/output')?.slice(2)).toEqual(['one', 'session_2']);
    expect(of('a2').find((p) => p[0] === '/api/hooks/output')?.slice(2)).toEqual(['two', 'session_1']);
  });

  it('8: a resumed session is followed from where it stood at the launch, registered as a resume', async () => {
    const wire = session('session_1');
    write(wire, prompt(0, 'old task'), said(0, 1, 'old answer'), ended(0, 'completed'));
    watch.noteLaunch('a1', work, 'session_1');
    pids.a1 = [7];
    lock('session_1', 7);
    await watch.tick();
    expect(posts).toEqual([]);
    write(wire, prompt(1, 'new task'), said(1, 1, 'new answer'), ended(1, 'completed'));
    await watch.tick();
    expect(of('a1')).toEqual([
      ['/api/hooks/status', 'running', 'resume', 'session_1'],
      ['/api/hooks/status', 'running', 'new task', 'session_1'],
      ['/api/hooks/output', 'Stop', 'new answer', 'session_1'],
      ['/api/hooks/status', 'idle', '', 'session_1'],
      ['/api/hooks/agent-stopped', 'Stop', '', 'session_1'],
    ]);
  });

  it('8: a session already there at the launch, bound by its lock, is read from where it stood, as a resume', async () => {
    const wire = session('session_1');
    write(wire, prompt(0, 'old task'), said(0, 1, 'old answer'), ended(0, 'completed'));
    watch.noteLaunch('a1', work);
    pids.a1 = [7];
    lock('session_1', 7);
    write(wire, prompt(1, 'new task'), said(1, 1, 'new answer'), ended(1, 'completed'));
    await watch.tick();
    expect(of('a1').map((p) => p.slice(1, 3))).toEqual([
      ['running', 'resume'], ['running', 'new task'], ['Stop', 'new answer'], ['idle', ''], ['Stop', ''],
    ]);
  });

  it('9: a line still being written waits for its end', async () => {
    watch.noteLaunch('a1', work);
    pids.a1 = [7];
    const wire = session('session_1');
    lock('session_1', 7);
    const whole = `${JSON.stringify(prompt(0, 'go'))}\n${JSON.stringify(ended(0, 'completed'))}\n`;
    const cut = whole.length - 10;
    fs.appendFileSync(wire, whole.slice(0, cut));
    await watch.tick();
    expect(of('a1').map((p) => p[1])).toEqual(['running', 'running']);
    fs.appendFileSync(wire, whole.slice(cut));
    await watch.tick();
    expect(of('a1').map((p) => p[1])).toEqual(['running', 'running', 'idle', 'Stop']);
  });
});
