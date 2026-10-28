import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * pi's turns, read from its own session file and told to Tars the way Claude
 * Code's hooks tell it (2.0.4, the CLI matrix's pi row). pi runs no hook Tars
 * installs: a pi agent read `running` from its launch to its end, and a task
 * delegated into it was said `delivered`, its answer never read, and the next
 * task never knew when to go in.
 *
 * What pi writes, read in @earendil-works/pi-coding-agent 1.3.0 (docs/session-format.md,
 * dist/core/session-manager.js, dist/core/agent-session.js): one JSONL file per
 * session, created at the session's first message, its first line the header
 * `{"type":"session","id":...,"cwd":...}`, then one line per message appended
 * as it ends. An assistant message carries `stopReason`: `stop` or `length` end
 * the turn, `toolUse`, `pending` and `deferred` do not, `error` ends it on an
 * error (pi may retry it, writing another assistant line with no new user
 * line), `aborted` is an Esc. Each pi agent is handed a session folder of its
 * own (PI_CODING_AGENT_SESSION_DIR, which pi ranks above its own setting), so
 * every file in it is that agent's.
 *
 * Every way it can fail, written before the code (2026-10-19):
 *  P1. A line that is not one of pi's (bad JSON, another type, a system or
 *      tool result message, an assistant still calling a tool) is taken for a
 *      turn's start or end.
 *  P2. A user message is not posted as the turn's start (UserPromptSubmit,
 *      with its text), or is posted twice.
 *  P3. An assistant message that ends the turn (stop, length) does not post
 *      the answer, then the rest (output, idle, agent-stopped); one that calls a
 *      tool, or is pending or deferred, ends it.
 *  P4. An Esc (aborted) is not said interrupted before the rest, or posts an
 *      answer.
 *  P5. An error is posted as a completed rest, or before pi has had the time to
 *      retry it; or a retry that answers is lost behind the error.
 *  P6. The session is not registered once, with its own id (SessionStart:
 *      `startup`, or `resume` for a file written before this launch); a file
 *      in another agent's folder is taken for this one's.
 *  P7. A line still being written is read half; a byte is read twice.
 *  P10. (the DB brief fix-answer-per-task-2810.md, before the code) A turn's answer is its last message alone: a
 *      closing line after the report replaces it. It is the turn's report, its longest message, and what followed.
 *  P8. A new session in the folder (pi's /new) is not followed: the newest
 *      file written since the launch is the agent's session.
 *  P9. The agent's folder is shared with another agent's, or lies outside
 *      Tars's data folder.
 */

import { PiSessionWatch, piEventOf, piSessionDir, type HookPost } from '../../../electron/services/pi-sessions';

let root: string;
let now: number;
let posts: Array<{ agentId: string } & HookPost>;
let interrupted: string[];
let watch: PiSessionWatch;

const SID = '0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b';
const dirOf = (agentId: string) => path.join(root, agentId);
const file = (agentId: string, sid = SID, stamp = '2026-10-19T10-00-00-000Z') => path.join(dirOf(agentId), `${stamp}_${sid}.jsonl`);
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const header = (sid = SID) => line({ type: 'session', version: 3, id: sid, timestamp: new Date(now).toISOString(), cwd: '/p' });
const user = (text: string) => line({ type: 'message', id: 'u1', parentId: null, timestamp: '', message: { role: 'user', content: text, timestamp: now } });
const assistant = (stopReason: string, text = '', more: Record<string, unknown> = {}) => line({
  type: 'message', id: 'a1', parentId: 'u1', timestamp: '',
  message: { role: 'assistant', content: text ? [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text }] : [{ type: 'toolCall', id: 't', name: 'bash', arguments: {} }], stopReason, ...more, timestamp: now },
});
const write = (agentId: string, text: string, f = file(agentId)) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, text); };
const kinds = () => posts.map((p) => `${p.path.replace('/api/hooks/', '')}:${String(p.body.event ?? p.body.status ?? p.body.hook ?? '')}${p.body.source ? `/${String(p.body.source)}` : ''}`);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sessions-'));
  now = Date.parse('2026-10-19T10:00:00.000Z');
  posts = [];
  interrupted = [];
  watch = new PiSessionWatch({
    dirOf,
    now: () => now,
    post: async (agentId, post) => { posts.push({ agentId, ...post }); },
    interrupted: (agentId) => { interrupted.push(agentId); },
  });
});

describe('a line of pi\'s session file', () => {
  it('P1. is read for what it is, and nothing else is a turn\'s start or end', () => {
    expect(piEventOf('{ not json')).toBeNull();
    expect(piEventOf(line({ type: 'model_change', id: 'x', provider: 'a', modelId: 'b' }))).toBeNull();
    expect(piEventOf(line({ type: 'message', message: { role: 'system', content: '' } }))).toBeNull();
    expect(piEventOf(line({ type: 'message', message: { role: 'toolResult', content: [] } }))).toBeNull();
    expect(piEventOf(header())).toEqual({ kind: 'session', id: SID });
    expect(piEventOf(user('do it'))).toEqual({ kind: 'user', text: 'do it' });
    expect(piEventOf(line({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] } }))).toEqual({ kind: 'user', text: 'ab' });
    expect(piEventOf(assistant('stop', 'done'))).toEqual({ kind: 'assistant', stop: 'stop', text: 'done' });
    expect(piEventOf(assistant('error', '', { errorMessage: '429 rate limited' }))).toEqual({ kind: 'assistant', stop: 'error', text: '', error: '429 rate limited' });
  });
});

describe('the agent\'s folder', () => {
  it('P9. is its own, under Tars\'s data folder', () => {
    const data = path.join(os.tmpdir(), 'tars-data');
    expect(piSessionDir(data, 'a')).toBe(path.join(data, 'pi', 'sessions', 'a'));
    expect(piSessionDir(data, 'a')).not.toBe(piSessionDir(data, 'b'));
    expect(() => piSessionDir(data, '../x')).toThrow();
  });
});

describe('a pi agent\'s session, followed', () => {
  it('P6, P2, P3. registered once, its turn opened with its prompt and ended with its answer', async () => {
    watch.noteLaunch('a');
    await watch.tick();
    expect(posts).toEqual([]);
    now += 1000;
    write('a', header() + user('review the notes'));
    await watch.tick();
    write('a', assistant('toolUse') + line({ type: 'message', message: { role: 'toolResult', content: [] } }));
    await watch.tick();
    write('a', assistant('stop', 'The notes are fine.'));
    await watch.tick();
    await watch.tick();
    expect(kinds()).toEqual(['status:running/startup', 'status:UserPromptSubmit', 'output:Stop', 'status:idle', 'agent-stopped:Stop']);
    expect(posts.every((p) => p.agentId === 'a' && p.body.agent_id === 'a' && p.body.session_id === SID)).toBe(true);
    expect(posts[1].body.current_task).toBe('review the notes');
    expect(posts[2].body.output).toBe('The notes are fine.');
  });

  it('P10. ended with its report and what followed it, not its last line alone', async () => {
    watch.noteLaunch('a');
    await watch.tick();
    now += 1000;
    const report = `Report: the migration is reversible. ${'Detail. '.repeat(30)}`;
    write('a', header() + user('ship the migration'));
    await watch.tick();
    write('a', assistant('toolUse', 'Let me look.') + assistant('toolUse', report) + assistant('stop', 'Done.'));
    await watch.tick();
    await watch.tick();
    expect(posts.filter((p) => p.path === '/api/hooks/output').map((p) => p.body.output)).toEqual([`${report}\n\nDone.`]);
  });

  it('P3. pending and deferred end nothing; length ends the turn', async () => {
    watch.noteLaunch('a');
    now += 1000;
    write('a', header() + user('x') + assistant('pending') + assistant('deferred'));
    await watch.tick();
    expect(kinds()).toEqual(['status:running/startup', 'status:UserPromptSubmit']);
    write('a', assistant('length', 'cut short'));
    await watch.tick();
    expect(kinds().slice(2)).toEqual(['output:Stop', 'status:idle', 'agent-stopped:Stop']);
  });

  it('P4. an Esc is said interrupted, then the rest, with no answer', async () => {
    watch.noteLaunch('a');
    now += 1000;
    write('a', header() + user('long job') + assistant('aborted', 'half'));
    await watch.tick();
    expect(interrupted).toEqual(['a']);
    expect(kinds()).toEqual(['status:running/startup', 'status:UserPromptSubmit', 'status:idle']);
  });

  it('P5. an error waits for pi\'s retry, and is posted as an error once none came', async () => {
    watch.noteLaunch('a');
    now += 1000;
    write('a', header() + user('x') + assistant('error', '', { errorMessage: '503 overloaded' }));
    await watch.tick();
    expect(kinds()).toEqual(['status:running/startup', 'status:UserPromptSubmit']);
    now += 5_000;
    await watch.tick();
    expect(kinds()).toHaveLength(2);
    now += 30_000;
    await watch.tick();
    expect(kinds().slice(2)).toEqual(['status:error']);
    expect(posts[2].body.error_message).toBe('503 overloaded');
  });

  it('P5. a retry that answers after an error ends the turn with that answer, and no error', async () => {
    watch.noteLaunch('a');
    now += 1000;
    write('a', header() + user('x') + assistant('error', '', { errorMessage: '503 overloaded' }));
    await watch.tick();
    now += 3_000;
    write('a', assistant('stop', 'second try worked'));
    await watch.tick();
    now += 60_000;
    await watch.tick();
    expect(kinds()).toEqual(['status:running/startup', 'status:UserPromptSubmit', 'output:Stop', 'status:idle', 'agent-stopped:Stop']);
  });

  it('P6. a file written before the launch is a resumed session; another agent\'s folder is not this one\'s', async () => {
    write('a', header() + user('old') + assistant('stop', 'old answer'));
    write('b', header('11111111-2222-4333-8444-555555555555') + user('b\'s'));
    now += 60_000;
    watch.noteLaunch('a');
    await watch.tick();
    expect(kinds()).toEqual([]);
    write('a', user('again'));
    await watch.tick();
    expect(kinds()).toEqual(['status:running/resume', 'status:UserPromptSubmit']);
    expect(posts.every((p) => p.agentId === 'a')).toBe(true);
  });

  it('P7. a line still being written is read once whole', async () => {
    watch.noteLaunch('a');
    now += 1000;
    const whole = user('split me');
    write('a', header() + whole.slice(0, 20));
    await watch.tick();
    write('a', whole.slice(20));
    await watch.tick();
    await watch.tick();
    expect(kinds()).toEqual(['status:running/startup', 'status:UserPromptSubmit']);
    expect(posts[1].body.current_task).toBe('split me');
  });

  it('P8. pi\'s /new: the newest file since the launch is followed, registered under its own id', async () => {
    watch.noteLaunch('a');
    now += 1000;
    write('a', header() + user('one') + assistant('stop', 'first'));
    await watch.tick();
    const NEW = '22222222-3333-4444-8555-666666666666';
    now += 1000;
    const second = file('a', NEW, '2026-10-19T10-00-02-000Z');
    write('a', header(NEW) + user('two'), second);
    await watch.tick();
    const fromNew = posts.filter((p) => p.body.session_id === NEW).map((p) => `${String(p.body.event ?? p.body.status)}${p.body.source ? `/${String(p.body.source)}` : ''}`);
    expect(fromNew).toEqual(['running/startup', 'UserPromptSubmit']);
  });
});
