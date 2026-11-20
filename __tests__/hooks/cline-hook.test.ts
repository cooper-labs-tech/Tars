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
 * Measured on 3.0.74 (20-21/11/2026, its TUI in a PTY against a loopback endpoint): every task of a session fires
 * TaskStart (never UserPromptSubmit), TaskResume on the first task of a session resumed with `--id`, TaskComplete with
 * `turn.outputText` and `turn.status`, TaskCancel on an Esc, SessionShutdown when Cline quits (Ctrl+C quits it). Each
 * payload names the session (`sessionContext.rootSessionId`, `<ms>_<5 chars>`) and the folder (`workspaceRoots`), never
 * the prompt: the first prompt is in the session's record (`<data>/sessions/<id>/<id>.json`, `prompt`) when the first
 * TaskStart runs, every later one is the last user message of `<id>.messages.json` when its TaskStart runs, each
 * wrapped as `<user_input mode="act">…</user_input>`. The hook runs as a child of the Cline process the session's pid
 * names in its sessions.db.
 *
 * How it fails, written before the code:
 * 1. Posted under Cline's own id: the hook routes take a UUID and nothing else. Under the UUID made from it, the same
 *    every time, the one providers/cline-cli.ts makes (the resume check maps it back).
 * 2. A session never registered (no SessionStart in Cline), registered without its CLI's pid (refused as another CLI's
 *    session), or registered again at every task (each turn read as a new session's).
 * 3. A turn opened without its prompt: the request id its sender line carries never binds the turn to its asker, and
 *    delegate_task waits out its timeout. Or the prompt left wrapped in Cline's <user_input> tag.
 * 4. A turn's answer lost, its end not said (idle, agent-stopped), or a turn that did not complete said done.
 * 5. A resumed session's first task not registered as a resume.
 * 6. An Esc (TaskCancel) leaving the agent running.
 * 7. A hook that fails, or waits on a Tars that is not there, holding Cline up: it always answers `{}` and exits 0. A
 *    post with no proof that the port is this Tars carries no token.
 * 8. An event Tars does not read (PreToolUse, SessionShutdown) posting anything.
 * 9. (Found by the conformance on 66214ddc4) The CLI named as the hook's parent: that is the `.cline` binary, a child
 *    of Cline's node launcher, which is the process Tars started (the terminal's own on an exec launch). The hook
 *    routes refused the session as another CLI's. The CLI is the launcher, the hook's grandparent.
 */

const HOOK = path.resolve('hooks', 'cline-hook.mjs');
type Post = { path: string; body: Record<string, unknown> };
type HookModule = {
  clineUuidOf(id: string): string | null;
  promptOf(text: string): string;
  currentPrompt(dataDir: string, sessionId: string): { prompt: string | null; first: boolean };
  postsFor(event: string, payload: unknown, ctx: { agentId: string; cliPid: number; prompt: string | null; first: boolean }): Post[];
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
function session(record: Record<string, unknown> | null, messages: unknown[] | null): void {
  const at = path.join(dir, 'sessions', SID);
  fs.mkdirSync(at, { recursive: true });
  if (record) fs.writeFileSync(path.join(at, `${SID}.json`), JSON.stringify(record));
  if (messages) fs.writeFileSync(path.join(at, `${SID}.messages.json`), JSON.stringify({ version: 1, messages }));
}

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

describe('the prompt of the task a TaskStart opens (3)', () => {
  it("the first task's from the session's record, a later one's from its messages, the <user_input> tag taken off", () => {
    expect(hook.promptOf('<user_input mode="act">Run the probe.\nTwo lines.</user_input>')).toBe('Run the probe.\nTwo lines.');
    expect(hook.promptOf('<user_input mode="plan">Plan it.</user_input>')).toBe('Plan it.');
    expect(hook.promptOf('no tag at all')).toBe('no tag at all');
    session({ prompt: '<user_input mode="act">[Tars: you are agent "W" (id x)] the first task</user_input>' }, []);
    expect(hook.currentPrompt(dir, SID)).toEqual({ prompt: '[Tars: you are agent "W" (id x)] the first task', first: true });
    session({ prompt: '<user_input mode="act">the first task</user_input>' }, [
      { role: 'user', content: [{ type: 'text', text: '<user_input mode="act">the first task</user_input>' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'x' }] },
      { role: 'user', content: [{ type: 'text', text: '<user_input mode="act">Message from agent "Lead", task t-1a2b3c4d: the second</user_input>' }] },
    ]);
    expect(hook.currentPrompt(dir, SID)).toEqual({ prompt: 'Message from agent "Lead", task t-1a2b3c4d: the second', first: false });
    expect(hook.currentPrompt(path.join(dir, 'nowhere'), SID)).toEqual({ prompt: null, first: true });
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

  it('a later TaskStart opens its turn only; a TaskResume registers a resume', () => {
    expect(hook.postsFor('TaskStart', payload(), { ...ctx, first: false }).map((p) => p.body.source ?? p.body.event)).toEqual(['UserPromptSubmit']);
    expect(hook.postsFor('TaskResume', payload(), { ...ctx, first: false }).map((p) => [p.body.source ?? p.body.event, p.body.cli_pid ?? null])).toEqual([['resume', 4242], ['UserPromptSubmit', null]]);
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

  it('a port that does not prove this Tars gets no token; no Tars at all, or a payload that is not JSON, still answers {} and exits 0', async () => {
    const squatter = await standIn('another-instance');
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
