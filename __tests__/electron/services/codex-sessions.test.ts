import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';

/**
 * Codex's turns, as Tars sees them (2.0.4).
 *
 * codex has no hook Tars installs, so a codex agent read `running` from its launch to its end: a turn that ended,
 * or failed in a second, changed nothing, and delegate_task waited on a turn it would never see end. codex writes
 * every session to $CODEX_HOME/sessions/<year>/<month>/<day>/rollout-<time>-<id>.jsonl, one JSON object a line:
 * `session_meta` (its id, its folder, who started it), `task_started`, the user's message (`item_completed`,
 * `UserMessage`), `turn_context` (the model, the effort), and `task_complete` with `last_agent_message`, or with
 * `error` when the turn failed (measured on codex-cli 0.163.0: "The 'gpt-5-codex-mini' model is not supported when
 * using Codex with a ChatGPT account"). Tars reads it and posts, as the agent's terminal, what Claude Code's hooks
 * post: the same routes decide (hooks-routes.ts), so a codex agent goes through one state machine with the others.
 *
 * The ways it fails:
 * 1. A turn's end never seen: the status stays running, delegate_task never gets the answer.
 * 2. A session given to the wrong agent: another codex agent's in the same folder, the user's own codex session, one
 *    begun before the agent's launch, or one in another folder. Its id then became the agent's, and the next restart
 *    or wake resumed someone else's conversation in the agent's terminal (the Audit's M1 on #465). A session is
 *    the agent's only on evidence that it is: its first message carries the agent's identity line ("(id <agent
 *    id>)", which every session Tars begins carries), the rollout is held open by the codex under the agent's
 *    terminal (measured on 0.163: from the file's first line to the codex's end, at rest included), or it is a fork
 *    of the agent's own session that its launch began. A first message naming another agent is never the agent's;
 *    and where a process's open files cannot be read (Windows), a session without the line is nobody's.
 * 3. The guardian's session (codex's automatic review, a subagent with a rollout of its own) taken for the agent's:
 *    its task_complete would end the agent's turn in the middle.
 * 4. A turn's end posted before its start, or its start without the task's text: the text carries the sender line
 *    whose request id routes the result back to its asker (task-requests.ts).
 * 5. A failed turn taken for a success: the error is posted as the turn's failure, in codex's own words.
 * 6. A line read while codex was still writing it, taken for garbage or lost: a last line with no end waits for it.
 * 7. An approval waited on, unseen: in normal mode codex asks before each command, in a dialog only the terminal
 *    shows. While it is on screen the agent is waiting on a permission, and running again once it is gone.
 * 8. Every rollout of the machine read at every tick: only the files changed since the oldest launch it waits on,
 *    and of a file already read, only what was added since.
 * 9. A turn interrupted (Esc in its terminal) never seen to end: measured on 0.163, codex then writes `turn_aborted`
 *    (reason `interrupted`) and no task_complete. The agent read running for good and, since codex holds its line
 *    while a turn runs, every later task waited behind a turn that was over; or the interrupt was taken for an end,
 *    and the task said completed, with the turn before's answer.
 * 10. A session Tars resumed (`codex resume <id>`, after a restart of Tars or a sleep) never seen: measured on 0.163,
 *    codex appends to the session's own rollout, under the day it began, and writes no new session_meta. Or its
 *    earlier turns posted again as new, or a fresh session (or a fork) in the same folder taken for the resumed one.
 * 11. A launch given up on while its codex still runs. Measured on 0.163: codex started with no prompt (Start in the
 *    window, a wake) writes no rollout at all before its first turn, so a first task typed more than ten minutes
 *    later began a session nobody's, and Tars never saw a turn of it. Or a launch whose codex is gone kept for good,
 *    so that a later session in that folder, the user's own, is taken for the agent's.
 * 12. A rollout read whole, at every tick, to learn whose it is (the Audit's L3): any session of the machine's day
 *    folders, however large, until it is settled. Only its first lines are read, each byte once.
 * 13. The first message missed for being far into the file: measured on 0.163, session_meta alone is 19 KB, and
 *    codex's instructions, the project's AGENTS.md and its context come before the user's message (at 43 KB).
 * 14. A character codex wrote in two pieces, read in two ticks, decoded as two replacement characters: the answer
 *    posted is not the one codex gave. And the unfinished line kept between two ticks as a slice of the buffer it
 *    was read in, which the heap rules forbid: it is kept as its own bytes.
 * 15. Whose codex holds a new session's file not learned (ps or lsof failed, or timed out under load: the Audit's L5
 *    on #465), and that taken for an answer: the agent's own session, one its user began by typing into its terminal,
 *    settled as nobody's for good and never followed; or bound on no evidence. It is asked again, 1, 2, 4, 8 and 16 s
 *    apart, six times in all; a failure never binds, and once given up on, the session is nobody's. Where a
 *    process's files cannot be listed at all (Windows) it is not asked again: it never will be learned.
 * 16. A codex that asks to sign in, unseen (the Audit's L7 on #465): its home has no login (Tars's, which it is
 *    handed, while the user's rc files set another, where their login is), and codex 0.163 then shows its sign-in
 *    screen and writes no session: the agent read as starting, then running. Why is asked at its launch
 *    (codexSignInGap, codex-sign-in.test.ts) and said in its status, once; never once its session came (it was
 *    signed in after all), nor for a launch a later one replaced, nor when nothing keeps it from signing in.
 * 17. (the DB brief fix-answer-per-task-2810.md, before the code) A turn's answer is codex's last message alone
 *    (`last_agent_message`): a closing line after the report replaces it, as 1212's orchestrator read on 28/10. The
 *    answer is the turn's report, its longest message, and what codex wrote after it.
 */

import { CodexSessionWatch, codexEventOf, type HookPost } from '../../../electron/services/codex-sessions';

let root: string;
let posts: Array<{ agentId: string } & HookPost>;
let screen: Map<string, string | undefined>;
let interrupted: Array<{ agentId: string; sessionId: string }>;
let resumable: Map<string, string>;
let running: Set<string>;
/** A rollout and the agent whose own codex holds it open, as lsof or /proc would say. */
let held: Map<string, string>;
/** Windows: no tool lists a process's open files. */
let openFilesUnread: boolean;
/** Lookups that fail before one answers (ps or lsof failed, or timed out): each learns nothing. */
let failingLookups: number;
let askedHolder: string[];
/** When each lookup was made, by the watch's clock. */
let askedAt: number[];
/** Why an agent's codex will start not signed in, as each launch asks it; and what was said of it. */
let gapOf: (agentId: string) => Promise<string | undefined>;
let said: Array<{ agentId: string; text: string }>;
let now: number;
let watch: CodexSessionWatch;

const AGENT = 'aaaa1111-0000-4000-8000-00000000c0de';
const OTHER = 'bbbb2222-0000-4000-8000-00000000c0de';
const SESSION = '01a14ed5-56c5-78e0-9779-9be42587f6e6';

const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: new Date(now).toISOString(), type, payload });
/** A session_meta; `pad`, its instructions, which make it 19 KB in 0.163. */
const meta = (id: string, cwd: string, source: unknown = 'cli', pad = 0) => line('session_meta', {
  id, session_id: id, cwd, source, originator: 'codex-tui', cli_version: '0.163.0', timestamp: new Date(now).toISOString(),
  ...(pad ? { base_instructions: { text: 'i'.repeat(pad) } } : {}),
});
/** One of the lines codex writes before the user's message (its instructions, AGENTS.md, the context), of about `bytes`. */
const codexOwn = (bytes: number) => line('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'd'.repeat(bytes) }] });
const started = (turn: string) => line('event_msg', { type: 'task_started', turn_id: turn });
const user = (text: string) => line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } });
const aborted = (turn: string) => line('event_msg', { type: 'turn_aborted', turn_id: turn, reason: 'interrupted' });
const done = (turn: string, message: string | null, error?: string) => line('event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: message, ...(error ? { error: { message: error } } : {}) });

function rollout(id: string, lines: string[], partial = ''): string {
  const d = new Date(now);
  const dir = path.join(root, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-18T15-46-06-${id}.jsonl`);
  fs.writeFileSync(file, lines.map(l => `${l}\n`).join('') + partial);
  // Written at the test's own time, which the watch reads: not the machine's.
  fs.utimesSync(file, new Date(now), new Date(now));
  return file;
}
const append = (file: string, text: string) => { fs.appendFileSync(file, text); fs.utimesSync(file, new Date(now), new Date(now)); };
const postsFor = (agentId: string) => posts.filter(p => p.agentId === agentId).map(p => ({ path: p.path, ...p.body }));
const outputsOf = (agentId: string) => postsFor(agentId).filter(p => p.path === '/api/hooks/output').map(p => p.output);
/** The session's file held open by the agent's own codex: the evidence a session with no identity line needs. */
const own = (file: string, agentId: string = AGENT) => { held.set(file, agentId); return file; };

/** How a file is read while this runs: whole (readFileSync), and how many of its bytes through its descriptors. */
const nodeFs = createRequire(import.meta.url)('fs') as typeof fs;
function countReads(file: string) {
  const original = { openSync: nodeFs.openSync, readSync: nodeFs.readSync, readFileSync: nodeFs.readFileSync, closeSync: nodeFs.closeSync };
  const fds = new Set<number>();
  const seen = { wholeFile: 0, bytes: 0 };
  nodeFs.openSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    const fd = (original.openSync as (...a: unknown[]) => number)(p, ...rest);
    if (String(p) === file) fds.add(fd);
    return fd;
  }) as typeof fs.openSync;
  nodeFs.readSync = ((fd: number, ...rest: unknown[]) => {
    const n = (original.readSync as (...a: unknown[]) => number)(fd, ...rest);
    if (fds.has(fd)) seen.bytes += n;
    return n;
  }) as typeof fs.readSync;
  nodeFs.readFileSync = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(p) === file) seen.wholeFile++;
    return (original.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync;
  nodeFs.closeSync = ((fd: number) => { fds.delete(fd); return original.closeSync(fd); }) as typeof fs.closeSync;
  syncBuiltinESMExports();
  return { seen, restore: () => { Object.assign(nodeFs, original); syncBuiltinESMExports(); } };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-sessions-'));
  posts = [];
  screen = new Map();
  interrupted = [];
  resumable = new Map();
  running = new Set();
  held = new Map();
  openFilesUnread = false;
  failingLookups = 0;
  askedHolder = [];
  askedAt = [];
  gapOf = async () => undefined;
  said = [];
  now = Date.parse('2026-10-18T13:46:06Z');
  watch = new CodexSessionWatch({
    codexHome: () => root,
    now: () => now,
    post: async (agentId, post) => { posts.push({ agentId, ...post }); },
    dialogTitle: (agentId) => screen.get(agentId),
    interrupted: (agentId, sessionId) => { interrupted.push({ agentId, sessionId }); posts.push({ agentId, path: '/api/hooks/status', body: { interruptedHere: true } }); },
    resumableSessionOf: (agentId) => resumable.get(agentId),
    codexRunning: (agentId) => running.has(agentId),
    heldOpenBy: async (file, agentIds) => {
      askedHolder.push(file);
      askedAt.push(now);
      if (openFilesUnread) return undefined;
      if (failingLookups > 0) { failingLookups--; return undefined; }
      const holder = held.get(file);
      return holder !== undefined && agentIds.includes(holder) ? holder : null;
    },
    openFilesReadable: () => !openFilesUnread,
    signInGapOf: (agentId) => gapOf(agentId),
    notSignedIn: (agentId, text) => { said.push({ agentId, text }); },
  });
});

const agentSays = (text: string) => line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: `m-${text.length}`, phase: 'final', content: [{ type: 'text', text }] } });

describe("a codex agent's turn", () => {
  it('17. ends with its report and what followed it, not its last line alone', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 1500;
    const report = `Report: both PRs are open, #658 and #660, their checks green. ${'Detail. '.repeat(30)}`;
    own(rollout(SESSION, [meta(SESSION, project), started('t1'), user('ship it'), agentSays('Looking at the PRs.'), agentSays(report), agentSays('Done.'), done('t1', 'Done.')]));
    await watch.tick();
    expect(outputsOf(AGENT)).toEqual([`${report}\n\nDone.`]);
  });

  it('registered, begun with its task, ended with its answer, in that order', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 1500;
    own(rollout(SESSION, [meta(SESSION, project), started('t1'), user('Message from agent "Lead": fix it [task t-1a2b3c4d]'), done('t1', 'Fixed: 2 files.')]));
    await watch.tick();

    expect(postsFor(AGENT)).toEqual([
      { path: '/api/hooks/status', agent_id: AGENT, session_id: SESSION, status: 'running', source: 'startup' },
      { path: '/api/hooks/status', agent_id: AGENT, session_id: SESSION, status: 'running', event: 'UserPromptSubmit', current_task: 'Message from agent "Lead": fix it [task t-1a2b3c4d]' },
      { path: '/api/hooks/output', agent_id: AGENT, session_id: SESSION, hook: 'Stop', output: 'Fixed: 2 files.' },
      { path: '/api/hooks/status', agent_id: AGENT, session_id: SESSION, hook: 'Stop', status: 'idle' },
      { path: '/api/hooks/agent-stopped', agent_id: AGENT, session_id: SESSION, hook: 'Stop' },
    ]);
  });

  it("failed in codex's own words, not taken for an answer", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 1000;
    const refusal = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-5-codex-mini' model is not supported when using Codex with a ChatGPT account." } });
    own(rollout(SESSION, [meta(SESSION, project), started('t1'), user('hello'), done('t1', null, refusal)]));
    await watch.tick();

    const last = postsFor(AGENT).at(-1);
    expect(last).toEqual({ path: '/api/hooks/status', agent_id: AGENT, session_id: SESSION, status: 'error', error_kind: 'codex_turn_failed', error_message: "The 'gpt-5-codex-mini' model is not supported when using Codex with a ChatGPT account." });
    expect(postsFor(AGENT).some(p => p.path === '/api/hooks/output')).toBe(false);
  });

  it('a line codex is still writing waits for its end; the next turns of the session are read as they come', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 500;
    const whole = done('t1', 'one');
    const file = own(rollout(SESSION, [meta(SESSION, project), started('t1'), user('first')], whole.slice(0, 40)));
    await watch.tick();
    expect(postsFor(AGENT).map(p => p.status ?? p.path)).toEqual(['running', 'running']);

    append(file, `${whole.slice(40)}\n`);
    await watch.tick();
    append(file, [started('t2'), user('second'), done('t2', 'two')].map(l => `${l}\n`).join(''));
    await watch.tick();
    const outputs = postsFor(AGENT).filter(p => p.path === '/api/hooks/output').map(p => p.output);
    expect(outputs).toEqual(['one', 'two']);
    expect(postsFor(AGENT).filter(p => p.event === 'UserPromptSubmit').map(p => p.current_task)).toEqual(['first', 'second']);
  });
});

describe('a turn interrupted', () => {
  it('9. is said interrupted before the agent rests, with no answer, and the next turn is read as before', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 1000;
    const file = own(rollout(SESSION, [meta(SESSION, project), started('t1'), user('Message from agent "Lead": a long job [task t-1a2b3c4d]'), aborted('t1')]));
    await watch.tick();

    expect(interrupted).toEqual([{ agentId: AGENT, sessionId: SESSION }]);
    const after = postsFor(AGENT).slice(2);
    expect(after).toEqual([
      { path: '/api/hooks/status', interruptedHere: true },
      { path: '/api/hooks/status', agent_id: AGENT, session_id: SESSION, hook: 'Stop', status: 'idle' },
    ]);
    append(file, [started('t2'), user('again'), done('t2', 'done now')].map(l => `${l}\n`).join(''));
    await watch.tick();
    expect(postsFor(AGENT).filter(p => p.path === '/api/hooks/output').map(p => p.output)).toEqual(['done now']);
    expect(interrupted).toHaveLength(1);
  });
});

describe('a codex started with no prompt', () => {
  it('11. is waited on while it runs, its first turn an hour later its own; once gone, a later session is nobody\'s', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    running.add(AGENT);
    watch.noteLaunch(AGENT, project);
    watch.noteLaunch(OTHER, project);
    now += 60 * 60_000;
    await watch.tick();
    own(rollout(SESSION, [meta(SESSION, project), started('t1'), user('Message from Tars: the first task'), done('t1', 'done')]));
    await watch.tick();
    expect(postsFor(AGENT).filter(p => p.path === '/api/hooks/output').map(p => p.output)).toEqual(['done']);

    const LATER = '01a14fb7-0000-7000-8000-00000000c0de';
    now += 1000;
    rollout(LATER, [meta(LATER, project), started('t2'), user('the user, outside Tars'), done('t2', 'not an agent\'s')]);
    await watch.tick();
    expect(postsFor(OTHER)).toEqual([]);
  });
});

describe('a session resumed', () => {
  const OLD = '01a14fb7-9e95-7c81-8980-2b82c8316805';
  /** The session as an earlier run of Tars left it: begun three days ago, its folder that day's. */
  function oldRollout(project: string): string {
    const dir = path.join(root, 'sessions', '2026', '10', '15');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-10-15T09-00-00-${OLD}.jsonl`);
    fs.writeFileSync(file, [meta(OLD, project), started('t0'), user('the first task'), done('t0', 'the first answer')].map(l => `${l}\n`).join(''));
    return file;
  }

  it('10. is bound to its own rollout from where it was, told as a resume, and only its new turns are posted', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    const file = oldRollout(project);
    resumable.set(AGENT, OLD);
    watch.noteLaunch(AGENT, project);
    await watch.tick();
    expect(postsFor(AGENT)).toEqual([]);

    now += 2000;
    append(file, [started('t1'), user('again'), done('t1', 'the second answer')].map(l => `${l}\n`).join(''));
    await watch.tick();
    expect(postsFor(AGENT)).toEqual([
      { path: '/api/hooks/status', agent_id: AGENT, session_id: OLD, status: 'running', source: 'resume' },
      { path: '/api/hooks/status', agent_id: AGENT, session_id: OLD, status: 'running', event: 'UserPromptSubmit', current_task: 'again' },
      { path: '/api/hooks/output', agent_id: AGENT, session_id: OLD, hook: 'Stop', output: 'the second answer' },
      { path: '/api/hooks/status', agent_id: AGENT, session_id: OLD, hook: 'Stop', status: 'idle' },
      { path: '/api/hooks/agent-stopped', agent_id: AGENT, session_id: OLD, hook: 'Stop' },
    ]);
  });

  it('10. a fresh session in that folder, or a fork, is the one bound, and the old rollout is left alone', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    const file = oldRollout(project);
    resumable.set(AGENT, OLD);
    watch.noteLaunch(AGENT, project);
    now += 1500;
    own(rollout(SESSION, [meta(SESSION, project), started('t1'), user('new'), done('t1', 'new answer')]));
    await watch.tick();
    append(file, [started('tx'), user('someone else'), done('tx', 'not this agent\'s')].map(l => `${l}\n`).join(''));
    await watch.tick();
    expect(new Set(postsFor(AGENT).map(p => p.session_id))).toEqual(new Set([SESSION]));
    expect(postsFor(AGENT).filter(p => p.path === '/api/hooks/output').map(p => p.output)).toEqual(['new answer']);
  });

  it("10. a fork its launch began of the agent's own session is the agent's at once, before any message", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    oldRollout(project);
    resumable.set(AGENT, OLD);
    watch.noteLaunch(AGENT, project);
    watch.noteLaunch(OTHER, project);
    now += 1300;
    // Measured on 0.163: `codex fork <id>` with no prompt writes its session_meta at once, then nothing until a turn.
    const FORK = '01a14fc3-eac2-7f33-8e4c-630805508299';
    rollout(FORK, [line('session_meta', { id: FORK, session_id: FORK, cwd: project, source: 'cli', forked_from_id: OLD, timestamp: new Date(now).toISOString() }), line('event_msg', { type: 'thread_settings_applied' })]);
    await watch.tick();
    expect(postsFor(AGENT)).toEqual([{ path: '/api/hooks/status', agent_id: AGENT, session_id: FORK, status: 'running', source: 'startup' }]);
    expect(postsFor(OTHER)).toEqual([]);
  });
});

describe('whose session it is', () => {
  it("PA (the Audit's probe on #465). the user's own codex in the agent's folder, while the agent's codex idles with no prompt, is not the agent's", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    running.add(AGENT);
    watch.noteLaunch(AGENT, project);   // Start with no task: codex writes no rollout yet
    now += 60_000;
    const USERS = '01a14ed5-56c5-78e0-9779-000000000aaa';
    rollout(USERS, [meta(USERS, project), started('u1'), user('refactor the parser for me'), done('u1', 'Done, my own session.')]);
    await watch.tick();
    expect(postsFor(AGENT)).toEqual([]);
  });

  it("PB (the Audit's probe on #465). a first message naming another agent is not bound to the one launch waiting", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    running.add(AGENT);
    watch.noteLaunch(AGENT, project);
    now += 5_000;
    const S2 = '01a14ed5-56c5-78e0-9779-000000000bbb';
    rollout(S2, [meta(S2, project), started('t1'), user(`Message from agent "Lead" (id ${OTHER}): hello`), done('t1', 'x')]);
    await watch.tick();
    expect(postsFor(AGENT)).toEqual([]);
  });

  it("2. a first message its user typed into the agent's own codex, with no identity line: the agent's, its codex holding the file", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    running.add(AGENT);
    watch.noteLaunch(AGENT, project);
    now += 60_000;
    own(rollout(SESSION, [meta(SESSION, project), started('t1'), user('refactor the parser'), done('t1', 'Refactored.')]));
    await watch.tick();
    expect(outputsOf(AGENT)).toEqual(['Refactored.']);
  });

  it("2. which codex holds a session's file is asked once, and one no waiting agent's codex holds stays nobody's", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    running.add(AGENT);
    watch.noteLaunch(AGENT, project);
    now += 1000;
    const file = rollout(SESSION, [meta(SESSION, project), started('t1'), user('mine, outside Tars')]);
    await watch.tick();
    await watch.tick();
    append(file, `${done('t1', 'not the agent\'s')}\n`);
    await watch.tick();
    expect(postsFor(AGENT)).toEqual([]);
    expect(askedHolder.filter(f => f === file)).toHaveLength(1);
  });

  it("2. where a process's open files cannot be read (Windows), only the identity line binds, and it is not asked again (15)", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    openFilesUnread = true;
    watch.noteLaunch(AGENT, project);
    now += 1000;
    const file = own(rollout(SESSION, [meta(SESSION, project), started('t1'), user('typed by its user'), done('t1', 'unseen')]));
    for (let i = 0; i < 80; i++) { await watch.tick(); now += 500; }
    expect(postsFor(AGENT)).toEqual([]);
    expect(askedHolder.filter(f => f === file)).toHaveLength(1);
    const NAMED = '01a14ed5-3333-7000-8000-000000000003';
    now += 1000;
    rollout(NAMED, [meta(NAMED, project), started('t2'), user(`[Tars: you are agent "Cody" (id ${AGENT}), worker of project ${project}.]\n\nMessage from Tars: hello`), done('t2', 'seen')]);
    await watch.tick();
    expect(outputsOf(AGENT)).toEqual(['seen']);
  });

  it("PC (the Audit's probe on #465, L5). a lookup that failed once is asked again, and the session its user typed into the agent's codex is followed", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    running.add(AGENT);
    watch.noteLaunch(AGENT, project);
    now += 60_000;
    const file = own(rollout(SESSION, [meta(SESSION, project), started('t1'), user('refactor the parser'), done('t1', 'Refactored.')]));
    failingLookups = 1;
    await watch.tick();
    expect(postsFor(AGENT), 'bound on a lookup that failed').toEqual([]);
    now += 1000;
    await watch.tick();
    expect(outputsOf(AGENT)).toEqual(['Refactored.']);
    expect(askedHolder.filter(f => f === file)).toHaveLength(2);
  });

  it('15. a lookup that keeps failing is asked six times, 1, 2, 4, 8 and 16 s apart, never binds, and is then given up on', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    running.add(AGENT);
    watch.noteLaunch(AGENT, project);
    now += 60_000;
    const file = own(rollout(SESSION, [meta(SESSION, project), started('t1'), user('refactor the parser'), done('t1', 'Refactored.')]));
    failingLookups = Number.POSITIVE_INFINITY;
    const first = now;
    for (let i = 0; i < 240; i++) { await watch.tick(); now += 500; }
    expect(askedAt.map(at => at - first)).toEqual([0, 1000, 3000, 7000, 15000, 31000]);
    expect(postsFor(AGENT), 'bound on a lookup that failed').toEqual([]);
    // lsof answers again, after the session was given up on: it stays nobody's.
    failingLookups = 0;
    for (let i = 0; i < 20; i++) { await watch.tick(); now += 500; }
    expect(askedHolder.filter(f => f === file)).toHaveLength(6);
    expect(postsFor(AGENT)).toEqual([]);
  });

  it("2. a first message naming another agent is never bound, even with the file held by the codex of the one waiting", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 1000;
    own(rollout(SESSION, [meta(SESSION, project), started('t1'), user(`[Tars: you are agent "Lead" (id ${OTHER}), orchestrator of project ${project}.]\n\nwork`), done('t1', 'not yours')]));
    await watch.tick();
    expect(postsFor(AGENT)).toEqual([]);
  });

  it("the agent its first message names, whichever launched first in that folder", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(OTHER, project);
    now += 100;
    watch.noteLaunch(AGENT, project);
    now += 900;
    rollout(SESSION, [meta(SESSION, project), started('t1'), user(`[Tars: you are agent "Codex" (id ${AGENT}), worker of project ${project}. Work autonomously]\n\nfix it`), done('t1', 'ok')]);
    await watch.tick();
    expect(postsFor(AGENT).length).toBeGreaterThan(0);
    expect(postsFor(OTHER)).toEqual([]);
  });

  it('nobody: a session in another folder, one begun before the launch, the guardian of the automatic review', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-elsewhere-'));
    rollout('01a14ed5-0000-7000-8000-00000000before', [meta('01a14ed5-0000-7000-8000-00000000before', project), started('t0'), done('t0', 'old')]);
    now += 5000;
    watch.noteLaunch(AGENT, project);
    now += 500;
    rollout('01a14ed5-0000-7000-8000-0000000000else', [meta('01a14ed5-0000-7000-8000-0000000000else', elsewhere), started('t1'), done('t1', 'x')]);
    rollout('01a14ed5-0000-7000-8000-00000guardian', [meta('01a14ed5-0000-7000-8000-00000guardian', project, { subagent: { other: 'guardian' } }), started('g1'), done('g1', '{"outcome":"allow"}')]);
    await watch.tick();
    expect(postsFor(AGENT), JSON.stringify(posts)).toEqual([]);

    own(rollout(SESSION, [meta(SESSION, project), started('t1'), user('hello'), done('t1', 'mine')]));
    await watch.tick();
    expect(postsFor(AGENT).filter(p => p.path === '/api/hooks/output').map(p => p.output)).toEqual(['mine']);
  });

  it('two codex agents launched in one folder each get the session their own codex holds, whichever launched first', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 200;
    watch.noteLaunch(OTHER, project);
    now += 800;
    const first = '01a14ed5-1111-7000-8000-000000000001';
    const second = '01a14ed5-2222-7000-8000-000000000002';
    own(rollout(first, [meta(first, project), started('a'), user('a'), done('a', 'A')]), OTHER);
    now += 300;
    own(rollout(second, [meta(second, project), started('b'), user('b'), done('b', 'B')]), AGENT);
    await watch.tick();
    expect(outputsOf(OTHER)).toEqual(['A']);
    expect(outputsOf(AGENT)).toEqual(['B']);
  });
});

describe('a codex that asks to sign in', () => {
  const WHY = "codex asks to sign in: Tars starts it on ~/.codex, and your login is in ~/elsewhere, the CODEX_HOME your shell sets.";
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('16. is said at its launch, once, while the launch waits for its session', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    gapOf = async () => WHY;
    watch.noteLaunch(AGENT, project);
    await settle();
    await watch.tick();
    expect(said).toEqual([{ agentId: AGENT, text: WHY }]);
  });

  it('16. is not said once its session came, nor for a launch a later one replaced', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    const answers: Array<(text: string | undefined) => void> = [];
    gapOf = () => new Promise(resolve => { answers.push(resolve); });
    watch.noteLaunch(AGENT, project);
    now += 1000;
    rollout(SESSION, [meta(SESSION, project), started('t1'), user(`[Tars: you are agent "Cody" (id ${AGENT}), worker of project ${project}.]\n\nhello`), done('t1', 'signed in after all')]);
    await watch.tick();
    expect(outputsOf(AGENT)).toEqual(['signed in after all']);
    answers[0](WHY);
    await settle();
    expect(said).toEqual([]);

    watch.noteLaunch(OTHER, project);
    watch.noteLaunch(OTHER, project);
    answers[1](WHY);
    await settle();
    expect(said, 'said for a launch a later one replaced').toEqual([]);
    answers[2](WHY);
    await settle();
    expect(said).toEqual([{ agentId: OTHER, text: WHY }]);
  });

  it('16. nothing is said when nothing keeps it from signing in', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    await settle();
    expect(said).toEqual([]);
  });
});

describe('an approval codex waits on', () => {
  it('reads as waiting on a permission while its dialog is on screen, and running once it is gone', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 500;
    const file = own(rollout(SESSION, [meta(SESSION, project), started('t1'), user('run the tests')]));
    await watch.tick();
    screen.set(AGENT, 'Would you like to run the following command? $ npm test');
    await watch.tick();
    await watch.tick();
    screen.set(AGENT, undefined);
    await watch.tick();
    append(file, `${done('t1', 'tests pass')}\n`);
    await watch.tick();

    const statuses = postsFor(AGENT).filter(p => p.path === '/api/hooks/status').map(p => [p.status, p.waiting_reason, p.event, p.hook].filter(Boolean).join(' '));
    expect(statuses).toEqual(['running', 'running UserPromptSubmit', 'waiting permission', 'running', 'idle Stop']);
    const asked = postsFor(AGENT).find(p => p.waiting_reason === 'permission');
    expect(asked).toMatchObject({ tool_name: 'codex', tool_input: { command: 'Would you like to run the following command? $ npm test' } });
  });

  it('is not looked for outside a turn', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 500;
    own(rollout(SESSION, [meta(SESSION, project), started('t1'), user('x'), done('t1', 'y')]));
    await watch.tick();
    screen.set(AGENT, 'Would you like to run the following command?');
    await watch.tick();
    expect(postsFor(AGENT).some(p => p.waiting_reason === 'permission')).toBe(false);
  });
});

describe('what is read', () => {
  it('not a file older than the oldest launch Tars waits on, and of a file read, only what was added', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    const old = rollout('01a14ed5-0000-7000-8000-000000000old', [meta('01a14ed5-0000-7000-8000-000000000old', project)]);
    fs.utimesSync(old, new Date(now - 3_600_000), new Date(now - 3_600_000));
    expect(watch.filesToRead()).toEqual([]);
    now += 1000;
    watch.noteLaunch(AGENT, project);
    now += 1000;
    const file = rollout(SESSION, [meta(SESSION, project), started('t1')]);
    expect(watch.filesToRead()).toEqual([file]);
  });

  it('12. a rollout is never read whole to learn whose it is: its first lines are read once, from where the last tick stopped', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(OTHER, project);
    now += 100;
    watch.noteLaunch(AGENT, project);
    now += 900;
    // Its first message not written yet, codex's own long lines before it, the kind 0.163 writes (13).
    const file = rollout(SESSION, [meta(SESSION, project), started('t1'), codexOwn(150_000)]);
    const reads = countReads(file);
    try {
      await watch.tick();
      await watch.tick();
      await watch.tick();
      append(file, `${user(`[Tars: you are agent "Cody" (id ${AGENT}), worker of project ${project}.]\n\nfix it`)}\n${done('t1', 'fixed')}\n`);
      await watch.tick();
    } finally {
      reads.restore();
    }
    expect(outputsOf(AGENT)).toEqual(['fixed']);
    expect(reads.seen.wholeFile, 'read whole').toBe(0);
    // Once to learn whose it is, once more to follow it from its start: never at every tick.
    expect(reads.seen.bytes).toBeLessThanOrEqual(2 * fs.statSync(file).size);
  });

  it("13. the first message found however far codex's own lines put it", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(OTHER, project);
    now += 100;
    watch.noteLaunch(AGENT, project);
    now += 900;
    rollout(SESSION, [meta(SESSION, project, 'cli', 19_000), started('t1'), codexOwn(150_000), codexOwn(150_000),
      user(`[Tars: you are agent "Cody" (id ${AGENT}), worker of project ${project}.]\n\nfix it`), done('t1', 'fixed')]);
    await watch.tick();
    expect(outputsOf(AGENT)).toEqual(['fixed']);
    expect(postsFor(OTHER)).toEqual([]);
  });

  it('14. a character codex wrote in two pieces is read whole', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 500;
    const file = own(rollout(SESSION, [meta(SESSION, project), started('t1'), user('say it')]));
    await watch.tick();
    const bytes = Buffer.from(`${done('t1', 'café ☕ prêt')}\n`, 'utf8');
    const cut = bytes.indexOf(Buffer.from('☕', 'utf8')) + 1;
    fs.appendFileSync(file, bytes.subarray(0, cut));
    await watch.tick();
    fs.appendFileSync(file, bytes.subarray(cut));
    await watch.tick();
    expect(outputsOf(AGENT)).toEqual(['café ☕ prêt']);
  });

  it('a line that is not JSON, or not an event, is no event', () => {
    for (const odd of ['', 'not json', '{"type":"event_msg"}', '{"type":"event_msg","payload":{"type":"task_complete"}}', '[1,2]']) {
      expect(() => codexEventOf(odd)).not.toThrow();
    }
    expect(codexEventOf('not json')).toBeNull();
  });
});
