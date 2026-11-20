import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * Cline's hooks, as Tars installs them for a Cline agent (hooks/cline-hook.mjs): Cline 3.0.74 runs each `<Event>.mjs`
 * of the agent's `--config` folder's `hooks/` with `node`, its JSON payload on stdin, Cline's whole environment
 * inherited (the agent's id and token with it). The hook tells Tars the turn the way Claude Code's hooks do.
 *
 * Measured on 3.0.74 (20-21/11/2026, its TUI in a PTY against a loopback endpoint, and read in its build): every task
 * of a process fires TaskStart, or TaskResume in a process started with `--id` (the CLI sets CLINE_HOOK_AGENT_RESUME),
 * never UserPromptSubmit (its hook file installed, it never ran); TaskComplete carries `turn.outputText`, TaskCancel
 * comes on an Esc, SessionShutdown when Cline quits (Ctrl+C quits it). Each payload names the session
 * (`sessionContext.rootSessionId`, `<ms>_<5 chars>`) and the folder (`workspaceRoots`), never the prompt. The TUI writes
 * each prompt it is given into its input history (`<data>/cache/user_input_history.jsonl`, rewritten whole, the latest
 * last, a repeat moved to the end, 20 kept) on the Enter, before the run begins; the session's messages file is written
 * at the end of each round (iteration_end) and nowhere sooner. A paste of 5 lines or more is in the field, and so in
 * the history, as Cline's marker (`[<its first 48 characters>... Pasted +N lines]`): Tars pastes the sender line, with
 * the task's id, on its own, so the id stays whole. Cline runs its hooks detached, each in a process of its own, none
 * waited for. The hook is a child of the Cline process the session's sessions.db names.
 *
 * How it fails, written before the code:
 * 1. Posted under Cline's own id: the hook routes take a UUID and nothing else. Under the UUID made from it, the same
 *    every time, the one providers/cline-cli.ts makes (the resume check maps it back).
 * 2. A session never registered (no SessionStart in Cline), registered without its CLI's pid (refused as another CLI's
 *    session), or registered again at every task (each turn read as a new session's).
 * 3. A turn opened without its prompt: the request id its sender line carries never binds the turn to its asker, and
 *    delegate_task waits out its timeout.
 * 4. A turn's answer lost, its end not said (idle, agent-stopped), or a turn that did not complete said done.
 * 5. A resumed session's first task not registered as a resume.
 * 6. An Esc (TaskCancel) leaving the agent running.
 * 7. A hook that fails, or waits on a Tars that is not there, holding Cline up: it always answers `{}` and exits 0. A
 *    post with no proof that the port is this Tars carries no token.
 * 8. An event Tars does not read (PreToolUse, SessionShutdown) posting anything.
 * 9. (Found by the conformance on 66214ddc4) The CLI named as the hook's parent: that is the `.cline` binary, a child
 *    of Cline's node launcher, which is the process Tars started (the terminal's own on an exec launch). The hook
 *    routes refused the session as another CLI's. The CLI is the launcher, the hook's grandparent.
 * 10. (Found by the conformance on bd51c1068) A later task's prompt read from the session's messages file, which Cline
 *    writes at the end of the task's first round: TaskStart read the earlier task's prompt, the second delegation's turn
 *    was never bound to its request, and delegate_task waited out its 200 s. A turn's prompt is the input history's
 *    last line, written before the run begins.
 * 11. Registration decided by whether the messages file held a user message yet: the same race, a first round that
 *    ends fast enough makes a first task look like a later one, and its session goes unregistered. Or registering at
 *    every task. Once per Cline process: the first TaskStart or TaskResume of each process registers it, through a
 *    marker only one hook can create; a new process of the same session (a resume) registers again.
 * 12. A turn's end posted before its start: hooks run detached and in parallel, so a fast turn's TaskComplete can reach
 *    Tars before its TaskStart, and the agent is left running after its turn. An end waits for its turn's opening, a
 *    bounded while: an opening that never comes holds it 10 s at most.
 */

const HOOK = path.resolve('hooks', 'cline-hook.mjs');
type Post = { path: string; body: Record<string, unknown> };
type HookModule = {
  clineUuidOf(id: string): string | null;
  typedPrompt(dataDir: string | undefined): string | null;
  claimRegistration(dataDir: string | undefined, key: string): boolean;
  markTurn(dataDir: string | undefined, key: string, mark: 'open' | 'end'): void;
  waitForOpening(dataDir: string | undefined, key: string, opts?: { maxMs?: number; stepMs?: number }): Promise<boolean>;
  postsFor(event: string, payload: unknown, ctx: { agentId: string; cliPid: number | null; prompt: string | null; first: boolean }): Post[];
};
let hook: HookModule;
const SID = '1795204260136_9ovct';
const AGENT = 'a1b2c3d4-0000-4000-8000-0000000000c1';
let dir: string;

beforeEach(async () => {
  hook = await import(pathToFileURL(HOOK).href) as HookModule;
  dir = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-cline-hook-')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const payload = (extra: Record<string, unknown> = {}) => ({ hookName: 'x', taskId: 'conv_1', sessionContext: { rootSessionId: SID }, workspaceRoots: ['/p'], ...extra });
/** The session's files as Cline leaves them: its record, and its messages as of its last round's end. */
function session(record: Record<string, unknown> | null, messages: unknown[] | null): void {
  const at = path.join(dir, 'sessions', SID);
  fs.mkdirSync(at, { recursive: true });
  if (record) fs.writeFileSync(path.join(at, `${SID}.json`), JSON.stringify(record));
  if (messages) fs.writeFileSync(path.join(at, `${SID}.messages.json`), JSON.stringify({ version: 1, messages }));
}
/** The TUI's input history as Cline 3.0.74 writes it on an Enter: every line rewritten, the latest last, one ts. */
function typed(...prompts: string[]): void {
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  const ts = Date.now();
  fs.writeFileSync(path.join(dir, 'cache', 'user_input_history.jsonl'), `${prompts.map((prompt) => JSON.stringify({ prompt, ts })).join('\n')}\n`);
}
/** The key the hook files a turn under: Cline's session and the Cline process that runs the hook (its parent). */
const KEY = `${SID}.${process.pid}`;

describe("Cline's session id (1)", () => {
  it('becomes a UUID, the same every time, and the provider makes the same one', async () => {
    const uuid = hook.clineUuidOf(SID)!;
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(hook.clineUuidOf(SID)).toBe(uuid);
    const { clineUuidOf } = await import('../../electron/providers/cline-cli');
    expect(clineUuidOf(SID)).toBe(uuid);
    expect(hook.clineUuidOf('../x')).toBeNull();
    expect(hook.clineUuidOf('conv_1795204261103_x7q2rcn')).toBeNull();
  });
});

describe('the prompt of the task a TaskStart opens (3, 10)', () => {
  it("is the input history's last line, while the messages file still holds only the earlier task (10)", () => {
    // The second delegation of the conformance on bd51c1068, as its TaskStart found the files.
    session({ prompt: '<user_input mode="act">Message from agent "Lead" ("d1"), task t-11111111:\nthe first</user_input>' }, [
      { role: 'user', content: [{ type: 'text', text: '<user_input mode="act">Message from agent "Lead" ("d1"), task t-11111111:\nthe first</user_input>' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'PROBE-OK' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'x' }] },
    ]);
    typed('Message from agent "Lead" ("d1"), task t-11111111:\nthe first', 'Message from agent "Lead" ("d1"), task t-22222222:\nthe second');
    expect(hook.typedPrompt(dir)).toBe('Message from agent "Lead" ("d1"), task t-22222222:\nthe second');
  });

  it('a prompt typed again is the latest, as Cline moves it last; a pasted body is its marker, the sender line whole', () => {
    typed('the second', 'the first');
    expect(hook.typedPrompt(dir)).toBe('the first');
    typed('Message from agent "Lead" ("d1"), task t-33333333:\n[Do the five things below, in order:... Pasted +6 lines]');
    expect(hook.typedPrompt(dir)).toBe('Message from agent "Lead" ("d1"), task t-33333333:\n[Do the five things below, in order:... Pasted +6 lines]');
  });

  it('no history, a line that is not one, or an empty prompt: the last good one, else none', () => {
    expect(hook.typedPrompt(dir)).toBeNull();
    expect(hook.typedPrompt(undefined)).toBeNull();
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cache', 'user_input_history.jsonl'), `${JSON.stringify({ prompt: 'the good one', ts: 1 })}\nnot json\n${JSON.stringify({ prompt: '  ', ts: 1 })}\n${JSON.stringify({ ts: 1 })}\n`);
    expect(hook.typedPrompt(dir)).toBe('the good one');
  });
});

describe('a session registered once per Cline process (11)', () => {
  it('the first claim of a process wins, a later one of the same process does not, another process (a resume) wins again', () => {
    expect(hook.claimRegistration(dir, `${SID}.4001`)).toBe(true);
    expect(hook.claimRegistration(dir, `${SID}.4001`)).toBe(false);
    expect(hook.claimRegistration(dir, `${SID}.4001`)).toBe(false);
    expect(hook.claimRegistration(dir, `${SID}.4002`)).toBe(true);
    expect(hook.claimRegistration(dir, `1795204260137_abcde.4001`)).toBe(true);
  });

  it('with no data folder to keep the mark in, every task registers rather than none', () => {
    expect(hook.claimRegistration(undefined, `${SID}.4001`)).toBe(true);
    expect(hook.claimRegistration(undefined, `${SID}.4001`)).toBe(true);
  });
});

describe("a turn's end waits for its start (12)", () => {
  it('is let through at once when its turn opened, and after the bound when it never did', async () => {
    hook.markTurn(dir, KEY, 'open');
    let at = Date.now();
    expect(await hook.waitForOpening(dir, KEY, { maxMs: 2000, stepMs: 20 })).toBe(true);
    expect(Date.now() - at).toBeLessThan(500);
    hook.markTurn(dir, KEY, 'end');
    at = Date.now();
    expect(await hook.waitForOpening(dir, KEY, { maxMs: 300, stepMs: 20 })).toBe(false);
    expect(Date.now() - at).toBeGreaterThanOrEqual(280);
    // The next turn opens: its end goes.
    hook.markTurn(dir, KEY, 'open');
    expect(await hook.waitForOpening(dir, KEY, { maxMs: 2000, stepMs: 20 })).toBe(true);
    expect(await hook.waitForOpening(undefined, KEY, { maxMs: 2000, stepMs: 20 })).toBe(true);
  });
});

describe('what each event posts (2 to 6, 8)', () => {
  const ctx = { agentId: AGENT, cliPid: 4242, prompt: 'the task', first: true };
  const uuid = () => hook.clineUuidOf(SID);

  it("a session's first TaskStart registers it, with its CLI's pid, then opens the turn with its prompt", () => {
    expect(hook.postsFor('TaskStart', payload(), ctx)).toEqual([
      { path: '/api/hooks/status', body: { agent_id: AGENT, session_id: uuid(), status: 'running', source: 'startup', cli_pid: 4242 } },
      { path: '/api/hooks/status', body: { agent_id: AGENT, session_id: uuid(), status: 'running', event: 'UserPromptSubmit', current_task: 'the task' } },
    ]);
  });

  it("a later TaskStart opens its turn only; a resumed process's first TaskResume registers a resume, its later ones open only (11)", () => {
    expect(hook.postsFor('TaskStart', payload(), { ...ctx, first: false }).map((p) => p.body.source ?? p.body.event)).toEqual(['UserPromptSubmit']);
    expect(hook.postsFor('TaskResume', payload(), ctx).map((p) => [p.body.source ?? p.body.event, p.body.cli_pid ?? null])).toEqual([['resume', 4242], ['UserPromptSubmit', null]]);
    expect(hook.postsFor('TaskResume', payload(), { ...ctx, first: false }).map((p) => p.body.source ?? p.body.event)).toEqual(['UserPromptSubmit']);
    // A CLI it could not read (Windows) is named nowhere: the routes take the post as before.
    expect(hook.postsFor('TaskStart', payload(), { ...ctx, cliPid: null })[0].body).not.toHaveProperty('cli_pid');
  });

  it("TaskComplete says the answer, then the turn's end; a turn that did not complete is the agent's error", () => {
    expect(hook.postsFor('TaskComplete', payload({ turn: { outputText: 'PROBE-OK x', status: 'completed' } }), ctx)).toEqual([
      { path: '/api/hooks/output', body: { agent_id: AGENT, session_id: uuid(), hook: 'Stop', output: 'PROBE-OK x' } },
      { path: '/api/hooks/status', body: { agent_id: AGENT, session_id: uuid(), hook: 'Stop', status: 'idle' } },
      { path: '/api/hooks/agent-stopped', body: { agent_id: AGENT, session_id: uuid(), hook: 'Stop' } },
    ]);
    const failed = hook.postsFor('TaskComplete', payload({ turn: { outputText: '', status: 'failed' } }), ctx);
    expect(failed.map((p) => [p.path, p.body.status ?? null])).toEqual([['/api/hooks/status', 'error']]);
    expect(failed[0].body.error_kind).toBe('cline_turn_failed');
    expect(hook.postsFor('TaskError', payload({ taskError: { message: 'the endpoint refused' } }), ctx)[0].body).toMatchObject({ status: 'error', error_message: 'the endpoint refused' });
  });

  it('TaskCancel ends the turn; the events Tars does not read post nothing; a payload without a session posts nothing', () => {
    expect(hook.postsFor('TaskCancel', payload(), ctx).map((p) => [p.path, p.body.status ?? null])).toEqual([['/api/hooks/status', 'idle']]);
    for (const e of ['PreToolUse', 'PostToolUse', 'SessionShutdown', 'Notification']) expect(hook.postsFor(e, payload(), ctx)).toEqual([]);
    expect(hook.postsFor('TaskStart', { taskId: 'conv_1' }, ctx)).toEqual([]);
  });
});

describe('the hook as Cline runs it (7)', () => {
  /** A stand-in of Tars's API: answers the health challenge for `instance`, records each post with its headers. */
  async function standIn(instance: string) {
    const posts: Array<{ path: string; auth?: string; pid?: string; body: Record<string, unknown> }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/api/health') {
          const proof = createHash('sha256').update(`${instance}:${url.searchParams.get('challenge')}`).digest('hex');
          res.end(JSON.stringify({ ok: true, proof }));
          return;
        }
        posts.push({ path: url.pathname, auth: req.headers.authorization, pid: req.headers['x-tars-cli-pid'] as string | undefined, body: JSON.parse(raw || '{}') });
        res.end('{"success":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return { posts, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
  }
  function runHook(event: string, stdin: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(HOOK).href)}).then((m) => m.run(${JSON.stringify(event)}))`], { env: { PATH: process.env.PATH ?? '', ...env } });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
      child.stdin.end(stdin);
    });
  }

  it("posts TaskComplete with the agent's token and its CLI's pid, answers {} and exits 0", async () => {
    const tars = await standIn('instance-1');
    hook.markTurn(dir, KEY, 'open');
    try {
      const r = await runHook('TaskComplete', JSON.stringify(payload({ turn: { outputText: 'PROBE-OK y', status: 'completed' } })), {
        CLAUDE_MGR_API_URL: tars.url, CLAUDE_MGR_API_TOKEN: 'agent-token', TARS_INSTANCE_ID: 'instance-1', CLAUDE_AGENT_ID: AGENT, CLINE_DATA_DIR: dir,
      });
      expect(r).toEqual({ code: 0, out: '{}\n' });
      expect(tars.posts.map((p) => p.path)).toEqual(['/api/hooks/output', '/api/hooks/status', '/api/hooks/agent-stopped']);
      expect(tars.posts.every((p) => p.auth === 'Bearer agent-token' && /^\d+$/.test(p.pid ?? ''))).toBe(true);
      expect(tars.posts[0].body.output).toBe('PROBE-OK y');
    } finally {
      tars.close();
    }
  });

  it("names its grandparent as the CLI, Cline's launcher, which Tars started (9)", async () => {
    const tars = await standIn('instance-2');
    try {
      // A process standing for Cline's binary: it runs the hook as its child, as Cline does, and waits for it.
      const intermediate = `const { spawn } = require('node:child_process');
const c = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(`import(${JSON.stringify(pathToFileURL(HOOK).href)}).then((m) => m.run('TaskResume'))`)}], { stdio: ['pipe', 'inherit', 'inherit'] });
c.stdin.end(process.argv[1]);
c.on('close', (code) => process.exit(code ?? 1));`;
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, ['-e', intermediate, JSON.stringify(payload())], {
          stdio: ['ignore', 'pipe', 'inherit'],
          env: { PATH: process.env.PATH ?? '', CLAUDE_MGR_API_URL: tars.url, CLAUDE_MGR_API_TOKEN: 'agent-token', TARS_INSTANCE_ID: 'instance-2', CLAUDE_AGENT_ID: AGENT, CLINE_DATA_DIR: dir },
        });
        child.on('close', resolve);
      });
      expect(code).toBe(0);
      const registered = tars.posts.find((p) => p.body.source === 'resume');
      expect(registered?.body.cli_pid).toBe(process.pid);
      expect(tars.posts.every((p) => p.pid === String(process.pid))).toBe(true);
    } finally {
      tars.close();
    }
  });

  it("opens a turn with the history's last line, registering its session once per process (10, 11)", async () => {
    const tars = await standIn('instance-3');
    const env = { CLAUDE_MGR_API_URL: tars.url, CLAUDE_MGR_API_TOKEN: 'agent-token', TARS_INSTANCE_ID: 'instance-3', CLAUDE_AGENT_ID: AGENT, CLINE_DATA_DIR: dir };
    try {
      typed('Message from agent "Lead" ("d1"), task t-11111111:\nthe first');
      expect(await runHook('TaskStart', JSON.stringify(payload()), env)).toEqual({ code: 0, out: '{}\n' });
      typed('Message from agent "Lead" ("d1"), task t-11111111:\nthe first', 'Message from agent "Lead" ("d1"), task t-22222222:\nthe second');
      expect(await runHook('TaskStart', JSON.stringify(payload()), env)).toEqual({ code: 0, out: '{}\n' });
      expect(tars.posts.map((p) => [p.body.source ?? p.body.event, p.body.current_task ?? null])).toEqual([
        ['startup', null],
        ['UserPromptSubmit', 'Message from agent "Lead" ("d1"), task t-11111111:\nthe first'],
        ['UserPromptSubmit', 'Message from agent "Lead" ("d1"), task t-22222222:\nthe second'],
      ]);
    } finally {
      tars.close();
    }
  });

  it('registers the session again from a new Cline process on it, a resume (11)', async () => {
    const tars = await standIn('instance-5');
    const env = { CLAUDE_MGR_API_URL: tars.url, CLAUDE_MGR_API_TOKEN: 'agent-token', TARS_INSTANCE_ID: 'instance-5', CLAUDE_AGENT_ID: AGENT, CLINE_DATA_DIR: dir };
    try {
      typed('the first');
      expect(await runHook('TaskStart', JSON.stringify(payload()), env)).toEqual({ code: 0, out: '{}\n' });
      // Cline started again on the same session (--id): its hooks are another process's children.
      const intermediate = `const { spawn } = require('node:child_process');
const c = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(`import(${JSON.stringify(pathToFileURL(HOOK).href)}).then((m) => m.run('TaskResume'))`)}], { stdio: ['pipe', 'inherit', 'inherit'] });
c.stdin.end(process.argv[1]);
c.on('close', (code) => process.exit(code ?? 1));`;
      typed('the first', 'the second');
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, ['-e', intermediate, JSON.stringify(payload())], { stdio: ['ignore', 'pipe', 'inherit'], env: { PATH: process.env.PATH ?? '', ...env } });
        child.on('close', resolve);
      });
      expect(code).toBe(0);
      expect(tars.posts.map((p) => p.body.source ?? p.body.event)).toEqual(['startup', 'UserPromptSubmit', 'resume', 'UserPromptSubmit']);
    } finally {
      tars.close();
    }
  });

  it("holds a turn's end until its start has reached Tars, the order Cline fired them in (12)", async () => {
    const tars = await standIn('instance-4');
    const env = { CLAUDE_MGR_API_URL: tars.url, CLAUDE_MGR_API_TOKEN: 'agent-token', TARS_INSTANCE_ID: 'instance-4', CLAUDE_AGENT_ID: AGENT, CLINE_DATA_DIR: dir };
    try {
      typed('Message from agent "Lead" ("d1"), task t-11111111:\nthe first');
      // The end's hook is up first: Cline fired the start first, and its hook is slower to post.
      const end = runHook('TaskComplete', JSON.stringify(payload({ turn: { outputText: 'PROBE-OK z', status: 'completed' } })), env);
      await new Promise((r) => setTimeout(r, 1500));
      const start = runHook('TaskStart', JSON.stringify(payload()), env);
      expect(await Promise.all([end, start])).toEqual([{ code: 0, out: '{}\n' }, { code: 0, out: '{}\n' }]);
      expect(tars.posts.map((p) => p.body.source ?? p.body.event ?? `${p.path}:${p.body.status ?? ''}`)).toEqual([
        'startup', 'UserPromptSubmit', '/api/hooks/output:', '/api/hooks/status:idle', '/api/hooks/agent-stopped:',
      ]);
    } finally {
      tars.close();
    }
  });

  it('a port that does not prove this Tars gets no token; no Tars at all, or a payload that is not JSON, still answers {} and exits 0', async () => {
    const squatter = await standIn('another-instance');
    hook.markTurn(dir, KEY, 'open');
    try {
      const r = await runHook('TaskCancel', JSON.stringify(payload()), { CLAUDE_MGR_API_URL: squatter.url, CLAUDE_MGR_API_TOKEN: 'agent-token', TARS_INSTANCE_ID: 'instance-1', CLAUDE_AGENT_ID: AGENT, CLINE_DATA_DIR: dir });
      expect(r).toEqual({ code: 0, out: '{}\n' });
      expect(squatter.posts.every((p) => p.auth === undefined)).toBe(true);
    } finally {
      squatter.close();
    }
    expect(await runHook('TaskComplete', JSON.stringify(payload()), { CLAUDE_MGR_API_URL: 'http://127.0.0.1:9', CLAUDE_MGR_API_TOKEN: 't', TARS_INSTANCE_ID: 'i', CLAUDE_AGENT_ID: AGENT })).toEqual({ code: 0, out: '{}\n' });
    expect(await runHook('TaskStart', 'not json', { CLAUDE_AGENT_ID: AGENT })).toEqual({ code: 0, out: '{}\n' });
  });
});
