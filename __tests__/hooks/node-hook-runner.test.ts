import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The Node hook runner, what Windows runs for the .sh hooks:
 * `node hooks/tars-hook.mjs <event>` does what `hooks/<event>.sh` does,
 * request for request. Each case states what the .sh sends and prints, read
 * off the script: every request (method, route, query, Authorization, content
 * type, and the body as parsed JSON) and stdout byte for byte.
 *
 * On Windows the .sh hooks never ran: bash eats the backslashes of their
 * unquoted path, jq is absent, and Git Bash's curl cannot read the
 * `-H @<(tars_auth)` process substitution. The runner uses
 * Node built-ins only, so Windows gets the same hooks Linux and macOS have.
 *
 * How the runner can fail, written before it existed:
 *  1. Wrong route, method, or header: a post that goes elsewhere, or carries
 *     no `Authorization: Bearer <CLAUDE_MGR_API_TOKEN>`, is refused (403) and
 *     the agent's status freezes with no error anywhere.
 *  2. A body that differs from the .sh one in any field (a missing `source`
 *     makes SessionStart a status change instead of a registration; a
 *     `current_task` without the .sh trailing newline; `opened_at` absent).
 *  3. Ignores CLAUDE_MGR_API_URL and posts to 31415, i.e. into the live Tars.
 *  4. Uses the shared ~/.dorothy/api-token where the .sh uses the CLI token,
 *     or the reverse (memory calls fall back to the file, hook posts never).
 *  5. stdout that is not what Claude Code parses: SessionStart context lost,
 *     `continue` missing, a stack trace printed, or output where the .sh
 *     prints none (StopFailure).
 *  6. Transcript parsing that differs: a partial last line voids the whole
 *     extraction, a final tool_use-only record hides the last text, blocks
 *     are not joined by "\n", the 4000-byte cut splits differently.
 *  7. Truncations in characters where the .sh cuts bytes (head -c) or the
 *     reverse (jq .[0:n] cuts code points).
 *  8. No retry where the .sh retries once after 1s (SessionStart,
 *     UserPromptSubmit, StopFailure), so one lost post unowns the session.
 *  9. Blocks the CLI: an API that is down, or accepts and never answers, must
 *     cost a bounded time and still exit 0, as curl --max-time does.
 * 10. A non-zero exit or a crash on bad stdin, where the .sh exits 0.
 * 11. Logs written elsewhere than ~/.dorothy/logs of the HOME it runs in.
 * 12. The Windows bugs kept: a backslash path pasted raw into JSON or into a
 *     query string.
 * 13. An unknown event swallowed silently instead of failing loudly.
 * 14. A transcript read whole: memory grows with the session, and past
 *     Node's string limit (about 512 MB) the read throws and the output is
 *     lost without a word. The runner reads it from
 *     the end, 1 MB at a time, and stops at the last assistant text.
 * 15. That backwards read losing what the .sh finds: a record cut across a
 *     chunk boundary, a multibyte character split in two, a last line still
 *     being flushed. And when the last text is further from the end than
 *     the cap (8 MB), the output is not posted, idle and agent-stopped still
 *     are: documented here, since the .sh would have read the whole file.
 * 16. The token sent where the .sh sends none (upstream #212): the hook
 *     posts carry the CLI's token only once /api/health has proved to know
 *     TARS_INSTANCE_ID, and no Authorization header at all otherwise. The
 *     server here answers the check for INSTANCE, outside the recorded
 *     requests; node-hook-checks-the-instance.test.ts holds the check itself.
 *
 * Where bash, curl and jq exist (CI on Linux and macOS) the .sh runs too,
 * against the same server, on every case but the two Windows fixes: the same
 * requests, compared the same way, and the same stdout as parsed JSON. On
 * Windows that half is skipped: `bash` on PATH is the WSL launcher, and
 * Git Bash has no jq and its curl cannot read `-H @<(...)`.
 */

const HOOKS_DIR = path.join(__dirname, '../../hooks');
const RUNNER = path.join(HOOKS_DIR, 'tars-hook.mjs');
const S = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-node-hook-'));

function has(cmd: string): boolean {
  if (process.platform === 'win32') return false;
  return spawnSync('/bin/sh', ['-c', `command -v ${cmd}`]).status === 0;
}
const SH_AVAILABLE = process.platform !== 'win32' && has('bash') && has('curl') && has('jq');
const SH_SKIP_REASON = process.platform === 'win32'
  ? 'the .sh side needs bash + curl + jq: on Windows bash is the WSL launcher, Git Bash has no jq and its curl cannot read -H @<(...)'
  : 'bash, curl or jq is missing on this machine';

type Recorded = {
  method: string;
  path: string;
  query: Record<string, string>;
  auth: string | undefined;
  ctype: string | undefined;
  body: unknown;
};

type Responder = (req: { method: string; path: string; n: number }) => { status?: number; body?: string; drop?: boolean; hang?: boolean };

let server: http.Server;
let port = 0;
let recorded: Recorded[] = [];
let responder: Responder = () => ({});
let seen = 0;
/** The instance id the server proves it knows, as the Tars that spawned the CLI would. */
const INSTANCE = crypto.randomBytes(16).toString('hex');
const hung: http.ServerResponse[] = [];

function parseBody(raw: string): unknown {
  if (raw === '') return undefined;
  try { return JSON.parse(raw); } catch { return { __raw: raw }; }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      // The instance check (16), answered as Tars answers it and kept out of what is compared.
      if (url.pathname === '/api/health' && url.searchParams.has('challenge')) {
        const proof = crypto.createHash('sha256').update(`${INSTANCE}:${url.searchParams.get('challenge')}`).digest('hex');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, proof }));
        return;
      }
      recorded.push({
        method: req.method ?? '',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        auth: req.headers.authorization,
        ctype: req.headers['content-type'],
        body: parseBody(raw),
      });
      const answer = responder({ method: req.method ?? '', path: url.pathname, n: seen++ });
      if (answer.drop) { req.socket.destroy(); return; }
      if (answer.hang) { hung.push(res); return; }
      res.writeHead(answer.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(answer.body ?? '{"success":true}');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const r of hung) { try { r.destroy(); } catch { /* gone */ } }
  await new Promise<void>(r => server.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A clean environment: nothing of the real agent this suite may run inside. */
function baseEnv(home: string, extra: Record<string, string | undefined>, apiPort = port): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE_|DOROTHY_|GEMINI_|TARS_)/.test(k)) continue;
    env[k] = v;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.CLAUDE_MGR_API_URL = `http://127.0.0.1:${apiPort}`;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

type Run = { code: number | null; stdout: string; stderr: string; ms: number };

function runProcess(cmd: string, args: string[], env: NodeJS.ProcessEnv, stdin: string, killAfterMs = 30_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(cmd, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(killer); resolve({ code, stdout, stderr, ms: Date.now() - started }); });
    child.stdin.on('error', () => { /* a hook that exits without reading */ });
    child.stdin.end(stdin);
  });
}

const runNode = (event: string, env: NodeJS.ProcessEnv, stdin: string) => runProcess(process.execPath, [RUNNER, event], env, stdin);
const runSh = (event: string, env: NodeJS.ProcessEnv, stdin: string) => runProcess('/bin/bash', [path.join(HOOKS_DIR, `${event}.sh`)], env, stdin);

/** Wait for backgrounded posts (the Gemini .sh hooks end with `curl ... &`). */
async function settle(expected: number): Promise<void> {
  const until = Date.now() + 4_000;
  while (recorded.length < expected && Date.now() < until) await new Promise(r => setTimeout(r, 25));
  await new Promise(r => setTimeout(r, 50));
}

/** What the two sides are compared on. opened_at is a clock reading, checked for type only. */
function normalize(list: Recorded[]): Recorded[] {
  return list.map(r => {
    const body = r.body && typeof r.body === 'object' && 'opened_at' in (r.body as object)
      ? { ...(r.body as Record<string, unknown>), opened_at: typeof (r.body as { opened_at: unknown }).opened_at }
      : r.body;
    return { ...r, body };
  });
}

type Expect = { method: 'GET' | 'POST'; path: string; auth: string | undefined; body?: unknown; query?: Record<string, string> };

function expected(list: Expect[]): Recorded[] {
  return list.map(e => ({
    method: e.method,
    path: e.path,
    query: e.query ?? {},
    auth: e.auth,
    ctype: e.method === 'POST' ? 'application/json' : undefined,
    body: e.body,
  }));
}

const CONTINUE = '{"continue":true,"suppressOutput":true}\n';

type Case = {
  name: string;
  event: string;
  payload: unknown;
  env?: Record<string, string | undefined>;
  respond?: Responder;
  setup?: (home: string) => void;
  requests: Expect[];
  stdout: string;
  /** A deliberate difference from the .sh (a Windows bug fixed): not cross-checked. */
  nodeOnly?: string;
};

const AGENT = { CLAUDE_AGENT_ID: 'agent-1', CLAUDE_MGR_API_TOKEN: 'tok-1', TARS_INSTANCE_ID: INSTANCE };
const GEMINI_AGENT = { DOROTHY_AGENT_ID: 'gem-1', CLAUDE_AGENT_ID: 'gem-1', CLAUDE_MGR_API_TOKEN: 'tok-g', TARS_INSTANCE_ID: INSTANCE };
const BEARER = 'Bearer tok-1';

const TRANSCRIPT_LINES = [
  JSON.stringify({ type: 'user', message: { content: 'go' } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first part' }, { type: 'tool_use', name: 'Bash' }, { type: 'text', text: 'second part' }] } }),
  '',
  'not json at all',
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }] } }),
  '{"type":"assistant","message":{"content":[{"type":"text","text":"cut mid-fl',
];
function writeTranscript(home: string, lines = TRANSCRIPT_LINES): string {
  const file = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

function caseHome(name: string): string {
  const home = fs.mkdtempSync(path.join(tmp, `${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}-`));
  return home;
}

const bootstrapAndMemory: Responder = ({ path: p }) => {
  if (p === '/api/agents/agent-1/bootstrap') return { body: JSON.stringify({ context: 'You are agent-1.\n' }) };
  if (p === '/api/memory/context') return { body: JSON.stringify({ context: 'Remember the port.' }) };
  return {};
};

const PROJECT = '/work/proj';
const CASES: Case[] = [
  {
    name: 'SessionStart registers, then injects bootstrap and memory',
    event: 'session-start',
    payload: { session_id: S, cwd: PROJECT, source: 'startup', hook_event_name: 'SessionStart' },
    env: AGENT,
    respond: bootstrapAndMemory,
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'idle', source: 'startup', hook: 'SessionStart', cli_pid: '' } },
      { method: 'GET', path: '/api/agents/agent-1/bootstrap', auth: BEARER },
      { method: 'GET', path: '/api/memory/context', auth: BEARER, query: { agent_id: 'agent-1', project_path: PROJECT } },
    ],
    stdout: `${JSON.stringify({ continue: true, suppressOutput: false, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'You are agent-1.\n\nRemember the port.' } })}\n`,
  },
  {
    name: 'SessionStart outside Tars: session id as agent, no bootstrap, empty memory, resume source, no instance id so no token on the post',
    event: 'session-start',
    payload: { session_id: S, cwd: PROJECT, source: 'resume' },
    env: { CLAUDE_MGR_API_TOKEN: 'tok-1' },
    respond: ({ path: p }) => (p === '/api/memory/context' ? { body: JSON.stringify({ context: 'No previous context found for this agent/project.' }) } : {}),
    // No instance to prove: its token reads nothing either (the Audit's Info on #355).
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: undefined, body: { agent_id: S, session_id: S, status: 'idle', source: 'resume', hook: 'SessionStart', cli_pid: '' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'SessionStart on a port that does not prove the CLI\'s instance: no token on the post, no bootstrap, no memory read (the Audit\'s Info on #355)',
    event: 'session-start',
    payload: { session_id: S, cwd: PROJECT, source: 'startup' },
    env: { ...AGENT, TARS_INSTANCE_ID: 'not-the-instance-this-port-knows' },
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: undefined, body: { agent_id: 'agent-1', session_id: S, status: 'idle', source: 'startup', hook: 'SessionStart', cli_pid: '' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'SessionStart retries a registration that got no answer, once',
    event: 'session-start',
    payload: { session_id: S, cwd: PROJECT },
    env: { ...AGENT, CLAUDE_PROJECT_PATH: '/from/env' },
    respond: ({ n }) => (n === 0 ? { drop: true } : {}),
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'idle', source: 'startup', hook: 'SessionStart', cli_pid: '' } },
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'idle', source: 'startup', hook: 'SessionStart', cli_pid: '' } },
      { method: 'GET', path: '/api/agents/agent-1/bootstrap', auth: BEARER },
      { method: 'GET', path: '/api/memory/context', auth: BEARER, query: { agent_id: 'agent-1', project_path: '/from/env' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'SessionStart with no CLI token reads the shared token for bootstrap and memory only',
    event: 'session-start',
    payload: { session_id: S, cwd: PROJECT },
    env: { CLAUDE_AGENT_ID: 'agent-1' },
    setup: home => {
      fs.mkdirSync(path.join(home, '.dorothy'), { recursive: true });
      fs.writeFileSync(path.join(home, '.dorothy', 'api-token'), 'shared-tok\n');
    },
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: undefined, body: { agent_id: 'agent-1', session_id: S, status: 'idle', source: 'startup', hook: 'SessionStart', cli_pid: '' } },
      { method: 'GET', path: '/api/agents/agent-1/bootstrap', auth: 'Bearer shared-tok' },
      { method: 'GET', path: '/api/memory/context', auth: 'Bearer shared-tok', query: { agent_id: 'agent-1', project_path: PROJECT } },
    ],
    stdout: CONTINUE,
  },
  {
    name: "SessionStart names its CLI by CLAUDE_PID, so Tars refuses a CLI run inside the agent's terminal",
    event: 'session-start',
    payload: { session_id: S, cwd: PROJECT, source: 'startup' },
    env: { ...AGENT, CLAUDE_PID: '4242' },
    respond: bootstrapAndMemory,
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'idle', source: 'startup', hook: 'SessionStart', cli_pid: '4242' } },
      { method: 'GET', path: '/api/agents/agent-1/bootstrap', auth: BEARER },
      { method: 'GET', path: '/api/memory/context', auth: BEARER, query: { agent_id: 'agent-1', project_path: PROJECT } },
    ],
    stdout: `${JSON.stringify({ continue: true, suppressOutput: false, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'You are agent-1.\n\nRemember the port.' } })}\n`,
  },
  {
    name: 'SessionStart sends no CLAUDE_PID that is not a pid, and keeps its JSON whole',
    event: 'session-start',
    payload: { session_id: S, cwd: PROJECT, source: 'startup' },
    env: { ...AGENT, CLAUDE_PID: '1", "source": "x' },
    respond: bootstrapAndMemory,
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'idle', source: 'startup', hook: 'SessionStart', cli_pid: '' } },
      { method: 'GET', path: '/api/agents/agent-1/bootstrap', auth: BEARER },
      { method: 'GET', path: '/api/memory/context', auth: BEARER, query: { agent_id: 'agent-1', project_path: PROJECT } },
    ],
    stdout: `${JSON.stringify({ continue: true, suppressOutput: false, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'You are agent-1.\n\nRemember the port.' } })}\n`,
  },
  {
    name: 'SessionStart sends a Windows project path with spaces, & and # intact',
    event: 'session-start',
    payload: { session_id: S, cwd: 'C:\\Users\\n\\Claude Project\\a&b #1' },
    env: AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'idle', source: 'startup', hook: 'SessionStart', cli_pid: '' } },
      { method: 'GET', path: '/api/agents/agent-1/bootstrap', auth: BEARER },
      { method: 'GET', path: '/api/memory/context', auth: BEARER, query: { agent_id: 'agent-1', project_path: 'C:\\Users\\n\\Claude Project\\a&b #1' } },
    ],
    stdout: CONTINUE,
    nodeOnly: 'the .sh pastes the path into the query unencoded, so the server reads project_path=C:\\Users\\n\\Claude Project\\a and loses the rest',
  },
  {
    name: 'UserPromptSubmit sets running with the first 200 bytes of `echo "$PROMPT"`',
    event: 'user-prompt-submit',
    payload: { session_id: S, prompt: 'rebase onto main', hook_event_name: 'UserPromptSubmit' },
    env: AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'running', event: 'UserPromptSubmit', hook: 'UserPromptSubmit', current_task: 'rebase onto main\n' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'UserPromptSubmit cuts a long multibyte prompt at 200 bytes, and retries once',
    event: 'user-prompt-submit',
    payload: { session_id: S, prompt: `${'é'.repeat(150)} "quoted" \\ end` },
    env: AGENT,
    respond: ({ n }) => (n === 0 ? { drop: true } : {}),
    requests: [0, 1].map(() => ({
      method: 'POST' as const, path: '/api/hooks/status', auth: BEARER,
      body: { agent_id: 'agent-1', session_id: S, status: 'running', event: 'UserPromptSubmit', hook: 'UserPromptSubmit', current_task: 'é'.repeat(100) },
    })),
    stdout: CONTINUE,
  },
  {
    name: 'PostToolUse Edit: running, then an observation cut at 100 bytes each side',
    event: 'post-tool-use',
    payload: { session_id: S, cwd: PROJECT, tool_name: 'Edit', tool_input: { file_path: '/work/proj/a.ts', old_string: `x${'o'.repeat(150)}`, new_string: 'new "v"\nline' } },
    env: AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'running' } },
      { method: 'POST', path: '/api/memory/remember', auth: BEARER, body: { agent_id: 'agent-1', project_path: PROJECT, content: `Edited /work/proj/a.ts: replaced 'x${'o'.repeat(99)}...' with 'new "v"\nline...'`, type: 'file_edit' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'PostToolUse Bash with a description, token from the shared file for memory only',
    event: 'post-tool-use',
    payload: { session_id: S, cwd: PROJECT, tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run tests' } },
    env: { CLAUDE_AGENT_ID: 'agent-1' },
    setup: home => {
      fs.mkdirSync(path.join(home, '.dorothy'), { recursive: true });
      fs.writeFileSync(path.join(home, '.dorothy', 'api-token'), 'shared-tok');
    },
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: undefined, body: { agent_id: 'agent-1', session_id: S, status: 'running' } },
      { method: 'POST', path: '/api/memory/remember', auth: 'Bearer shared-tok', body: { agent_id: 'agent-1', project_path: PROJECT, content: 'Ran command: Run tests (npm test)', type: 'command' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'PostToolUse Read stores nothing, an MCP tool is remembered, Write and Task too',
    event: 'post-tool-use',
    payload: { session_id: S, cwd: PROJECT, tool_name: 'mcp__tars__send', tool_input: {} },
    env: AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'running' } },
      { method: 'POST', path: '/api/memory/remember', auth: BEARER, body: { agent_id: 'agent-1', project_path: PROJECT, content: 'Used MCP tool: mcp__tars__send', type: 'tool_use' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'PostToolUse Read only reports running',
    event: 'post-tool-use',
    payload: { session_id: S, cwd: PROJECT, tool_name: 'Read', tool_input: { file_path: '/x' } },
    env: AGENT,
    requests: [{ method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'running' } }],
    stdout: CONTINUE,
  },
  {
    name: 'PostToolUse with no tool name does nothing',
    event: 'post-tool-use',
    payload: { session_id: S },
    env: AGENT,
    requests: [],
    stdout: CONTINUE,
  },
  {
    name: 'Stop posts the message it was given, then idle, then agent-stopped',
    event: 'on-stop',
    payload: { session_id: S, last_assistant_message: 'Done: "all" green\n\n' },
    env: AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/output', auth: BEARER, body: { agent_id: 'agent-1', hook: 'Stop', session_id: S, output: 'Done: "all" green' } },
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'idle', hook: 'Stop' } },
      { method: 'POST', path: '/api/hooks/agent-stopped', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, hook: 'Stop' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'Stop reads the last text from the transcript, past tool_use records and a partial line',
    event: 'on-stop',
    payload: { session_id: S, transcript_path: '@TRANSCRIPT' },
    env: AGENT,
    setup: home => { writeTranscript(home); },
    requests: [
      { method: 'POST', path: '/api/hooks/output', auth: BEARER, body: { agent_id: 'agent-1', hook: 'Stop', session_id: S, output: 'first part\nsecond part' } },
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'idle', hook: 'Stop' } },
      { method: 'POST', path: '/api/hooks/agent-stopped', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, hook: 'Stop' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'Stop cuts a long message at 4000 bytes',
    event: 'on-stop',
    payload: { session_id: S, last_assistant_message: `${'a'.repeat(3999)}€tail` },
    env: AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/output', auth: BEARER, body: { agent_id: 'agent-1', hook: 'Stop', session_id: S, output: `${'a'.repeat(3999)}\ufffd` } },
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'idle', hook: 'Stop' } },
      { method: 'POST', path: '/api/hooks/agent-stopped', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, hook: 'Stop' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'Stop posts what waits at rest: its crons, and its background tasks still running',
    event: 'on-stop',
    payload: { session_id: S, session_crons: [{ id: 'c1' }, { id: 'c2' }], background_tasks: [{ status: 'running' }, { status: 'completed' }, 'x', { status: 'failed' }, {}] },
    env: AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', hook: 'Stop', session_id: S, status: 'idle', pending: { crons: 2, background: 3 } } },
      { method: 'POST', path: '/api/hooks/agent-stopped', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, hook: 'Stop' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'Stop while a stop hook is already active does nothing',
    event: 'on-stop',
    payload: { session_id: S, stop_hook_active: true, last_assistant_message: 'x' },
    env: AGENT,
    requests: [],
    stdout: CONTINUE,
  },
  {
    name: 'StopFailure posts the error with the CLI words, prints nothing',
    event: 'stop-failure',
    payload: { session_id: S, hook_event_name: 'StopFailure', error: 'authentication_failed', last_assistant_message: 'Not logged in · "run" /login\nnow' },
    env: AGENT,
    respond: ({ n }) => (n === 0 ? { drop: true } : {}),
    requests: [0, 1].map(() => ({
      method: 'POST' as const, path: '/api/hooks/status', auth: BEARER,
      body: { agent_id: 'agent-1', session_id: S, status: 'error', event: 'StopFailure', hook: 'StopFailure', error_kind: 'authentication_failed', error_message: 'Not logged in · "run" /login\nnow' },
    })),
    stdout: '',
  },
  {
    name: 'SessionEnd posts the transcript output, then completed with the reason',
    event: 'session-end',
    payload: { session_id: S, transcript_path: '@TRANSCRIPT', cwd: PROJECT, reason: 'prompt_input_exit' },
    env: AGENT,
    setup: home => { writeTranscript(home); },
    requests: [
      { method: 'POST', path: '/api/hooks/output', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, output: 'first part\nsecond part' } },
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'completed', reason: 'prompt_input_exit' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'SessionEnd with no transcript reports completed, reason other',
    event: 'session-end',
    payload: { session_id: S, transcript_path: '/no/such/file.jsonl' },
    env: AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'completed', reason: 'other' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'Notification idle_prompt forwards it and sets waiting',
    event: 'notification',
    payload: { session_id: S, notification_type: 'idle_prompt', title: 'Claude "Code"', message: 'Claude is waiting for your input\n' },
    env: AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/notification', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, type: 'idle_prompt', title: 'Claude "Code"', message: 'Claude is waiting for your input' } },
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'waiting', waiting_reason: 'idle' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'Notification permission_prompt only forwards',
    event: 'notification',
    payload: { session_id: S, notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' },
    env: AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/notification', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, type: 'permission_prompt', title: '', message: 'Claude needs your permission to use Bash' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'Notification without a type does nothing',
    event: 'notification',
    payload: { session_id: S, message: 'x' },
    env: AGENT,
    requests: [],
    stdout: CONTINUE,
  },
  {
    name: 'PermissionRequest sends what the dialog asks, cut at 1000 code points, and when it opened',
    event: 'permission-request',
    payload: {
      session_id: S, tool_name: 'AskUserQuestion',
      tool_input: { command: `${'😀'.repeat(1200)}`, content: 'x'.repeat(5000), url: 'https://e.x', questions: [{ question: 'Which port?', options: [1] }, null, { header: 'h' }] },
    },
    env: AGENT,
    requests: [
      {
        method: 'POST', path: '/api/hooks/status', auth: BEARER,
        body: {
          agent_id: 'agent-1', session_id: S, status: 'waiting', waiting_reason: 'permission', opened_at: 'number', tool_name: 'AskUserQuestion',
          tool_input: { command: '😀'.repeat(1000), url: 'https://e.x', questions: [{ question: 'Which port?' }, { question: '' }, { question: '' }] },
        },
      },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'PermissionRequest with an input it cannot read falls back to the bare waiting post',
    event: 'permission-request',
    payload: { session_id: S, tool_name: 'Bash', tool_input: 'not an object' },
    env: AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, status: 'waiting', waiting_reason: 'permission' } },
    ],
    stdout: CONTINUE,
  },
  {
    // jq reads every field of `null` as null: its program still runs, with nothing to name the dialog.
    name: 'PermissionRequest on a null input builds the body jq builds, not the bare fallback',
    event: 'permission-request',
    payload: null,
    env: AGENT,
    requests: [
      {
        method: 'POST', path: '/api/hooks/status', auth: BEARER,
        body: { agent_id: 'agent-1', session_id: '', status: 'waiting', waiting_reason: 'permission', opened_at: 'number', tool_name: '', tool_input: {} },
      },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'TaskCompleted posts the output then task-completed',
    event: 'task-completed',
    payload: { session_id: S, transcript_path: '@TRANSCRIPT' },
    env: AGENT,
    setup: home => { writeTranscript(home); },
    requests: [
      { method: 'POST', path: '/api/hooks/output', auth: BEARER, body: { agent_id: 'agent-1', session_id: S, output: 'first part\nsecond part' } },
      { method: 'POST', path: '/api/hooks/task-completed', auth: BEARER, body: { agent_id: 'agent-1', session_id: S } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'Gemini SessionStart registers as running with source startup',
    event: 'gemini/session-start',
    payload: { session_id: S, cwd: PROJECT, hook_event_name: 'SessionStart' },
    env: GEMINI_AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: 'Bearer tok-g', body: { agent_id: 'gem-1', session_id: S, status: 'running', source: 'startup' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'Gemini BeforeAgent (user-prompt-submit) sets running',
    event: 'gemini/user-prompt-submit',
    payload: { session_id: S, prompt: 'hi' },
    env: GEMINI_AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: 'Bearer tok-g', body: { agent_id: 'gem-1', session_id: S, status: 'running' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'Gemini AfterTool remembers a shell command, cut at 200 bytes, and posts no status',
    event: 'gemini/post-tool-use',
    payload: { session_id: S, cwd: PROJECT, tool_name: 'Shell', tool_input: { command: `echo ${'z'.repeat(300)}` } },
    env: GEMINI_AGENT,
    requests: [
      { method: 'POST', path: '/api/memory/remember', auth: 'Bearer tok-g', body: { agent_id: 'gem-1', project_path: PROJECT, content: `Ran command: echo ${'z'.repeat(195)}`, type: 'command' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'Gemini AfterAgent sets waiting',
    event: 'gemini/on-stop',
    payload: { session_id: S },
    env: GEMINI_AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: 'Bearer tok-g', body: { agent_id: 'gem-1', session_id: S, status: 'waiting' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'Gemini AfterAgent while a stop hook is active does nothing',
    event: 'gemini/on-stop',
    payload: { session_id: S, stop_hook_active: true },
    env: GEMINI_AGENT,
    requests: [],
    stdout: CONTINUE,
  },
  {
    name: 'Gemini SessionEnd sets completed',
    event: 'gemini/session-end',
    payload: { session_id: S },
    env: GEMINI_AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/status', auth: 'Bearer tok-g', body: { agent_id: 'gem-1', session_id: S, status: 'completed' } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'Gemini Notification forwards the message with its echo newline and the project path',
    event: 'gemini/notification',
    payload: { session_id: S, cwd: PROJECT, message: 'Tool "x" needs approval' },
    env: GEMINI_AGENT,
    requests: [
      { method: 'POST', path: '/api/hooks/notification', auth: 'Bearer tok-g', body: { agent_id: 'gem-1', session_id: S, message: 'Tool "x" needs approval\n', project_path: PROJECT } },
    ],
    stdout: CONTINUE,
  },
  {
    name: 'Gemini Notification keeps a Windows project path valid JSON',
    event: 'gemini/notification',
    payload: { session_id: S, message: 'm' },
    env: { ...GEMINI_AGENT, DOROTHY_PROJECT_PATH: 'C:\\Users\\owner\\new "proj"' },
    requests: [
      { method: 'POST', path: '/api/hooks/notification', auth: 'Bearer tok-g', body: { agent_id: 'gem-1', session_id: S, message: 'm\n', project_path: 'C:\\Users\\owner\\new "proj"' } },
    ],
    stdout: CONTINUE,
    nodeOnly: 'the .sh pastes the path raw into the JSON body, which then does not parse (400)',
  },
];

function stdinFor(c: Case, home: string): string {
  return JSON.stringify(c.payload).replace('"@TRANSCRIPT"', JSON.stringify(path.join(home, 'transcript.jsonl')));
}

async function runCase(c: Case, side: 'node' | 'sh'): Promise<{ run: Run; requests: Recorded[] }> {
  const home = caseHome(`${side}-${c.name}`);
  c.setup?.(home);
  recorded = [];
  seen = 0;
  responder = c.respond ?? (() => ({}));
  const env = baseEnv(home, c.env ?? {});
  const run = side === 'node' ? await runNode(c.event, env, stdinFor(c, home)) : await runSh(c.event, env, stdinFor(c, home));
  await settle(c.requests.length);
  return { run, requests: normalize(recorded) };
}

describe('tars-hook.mjs posts what the .sh posts, and answers the CLI what it answers', () => {
  for (const c of CASES) {
    it(`${c.event}: ${c.name}`, async () => {
      const { run, requests } = await runCase(c, 'node');
      expect(run.stderr, 'the runner wrote to stderr').toBe('');
      expect(run.code).toBe(0);
      expect(requests).toEqual(expected(c.requests));
      expect(run.stdout).toBe(c.stdout);
    }, 30_000);
  }
});

describe.skipIf(!SH_AVAILABLE)(`the .sh, run beside it (skipped here: ${SH_SKIP_REASON})`, () => {
  for (const c of CASES.filter(x => !x.nodeOnly)) {
    it(`${c.event}: ${c.name}`, async () => {
      const node = await runCase(c, 'node');
      const sh = await runCase(c, 'sh');
      expect(node.requests).toEqual(sh.requests);
      const parse = (s: string) => (s.trim() === '' ? '' : JSON.parse(s));
      expect(parse(node.run.stdout)).toEqual(parse(sh.run.stdout));
      expect(node.run.code).toBe(sh.run.code);
    }, 60_000);
  }
});

describe('the runner never blocks the CLI', () => {
  async function deadPort(): Promise<number> {
    const s = http.createServer();
    await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
    const p = (s.address() as { port: number }).port;
    await new Promise<void>(r => s.close(() => r()));
    return p;
  }

  const EVENTS = ['session-start', 'user-prompt-submit', 'post-tool-use', 'on-stop', 'stop-failure', 'session-end',
    'notification', 'permission-request', 'task-completed', 'gemini/session-start', 'gemini/user-prompt-submit',
    'gemini/post-tool-use', 'gemini/on-stop', 'gemini/session-end', 'gemini/notification'];
  const PAYLOAD = { session_id: S, cwd: PROJECT, tool_name: 'Bash', tool_input: { command: 'ls' }, notification_type: 'idle_prompt', message: 'm', last_assistant_message: 'x', prompt: 'p' };

  it.each(EVENTS)('%s exits 0 quickly and answers in the expected shape when the API is down', async event => {
    const home = caseHome(`dead-${event}`);
    const run = await runNode(event, baseEnv(home, AGENT, await deadPort()), JSON.stringify(PAYLOAD));
    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(8_000);
    if (event === 'stop-failure') expect(run.stdout).toBe('');
    else expect(JSON.parse(run.stdout)).toHaveProperty('continue', true);
  }, 30_000);

  it('session-start still posts and returns inside the hook timeout when the API accepts and never answers', async () => {
    const home = caseHome('half-open');
    recorded = [];
    responder = () => ({ hang: true });
    const run = await runNode('session-start', baseEnv(home, AGENT), JSON.stringify({ session_id: S, cwd: PROJECT }));
    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(20_000);
    expect(recorded.filter(r => r.path === '/api/hooks/status').length).toBe(2);
    expect(JSON.parse(run.stdout)).toEqual({ continue: true, suppressOutput: true });
  }, 40_000);

  it.each(['', 'not json', '[1,2]', '"str"'])('exits 0 on stdin %j, as jq failing leaves the .sh going', async stdin => {
    const home = caseHome('bad-stdin');
    recorded = [];
    responder = () => ({});
    const run = await runNode('user-prompt-submit', baseEnv(home, AGENT), stdin);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(CONTINUE);
    await settle(1);
    expect(recorded.map(r => r.body)).toEqual([{ agent_id: 'agent-1', session_id: '', status: 'running', event: 'UserPromptSubmit', hook: 'UserPromptSubmit', current_task: '\n' }]);
  }, 30_000);

  it('fails loudly on an event it does not know, and posts nothing', async () => {
    const home = caseHome('unknown');
    recorded = [];
    const run = await runNode('no-such-event', baseEnv(home, AGENT), '{}');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no-such-event');
    expect(recorded).toEqual([]);
  }, 30_000);
});

describe('a long transcript', () => {
  const MB = 1024 * 1024;
  /** A user record of about 1 KB, with multibyte text so chunk edges fall inside characters. */
  const filler = (i: number) => JSON.stringify({ type: 'user', message: { content: `step ${i} ${'é€😀'.repeat(120)}` } });
  const toolOnly = (i: number) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo ${i} ${'x'.repeat(900)}` } }] } });
  const text = (t: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });

  function writeLines(file: string, parts: Array<{ count: number; line: (i: number) => string } | string>): void {
    const fd = fs.openSync(file, 'w');
    try {
      for (const part of parts) {
        if (typeof part === 'string') { fs.writeSync(fd, `${part}\n`); continue; }
        let batch = '';
        for (let i = 0; i < part.count; i++) {
          batch += `${part.line(i)}\n`;
          if (batch.length > MB) { fs.writeSync(fd, batch); batch = ''; }
        }
        if (batch) fs.writeSync(fd, batch);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  async function stopWith(file: string): Promise<{ run: Run; requests: Recorded[] }> {
    const home = caseHome('long-transcript');
    recorded = [];
    seen = 0;
    responder = () => ({});
    const run = await runNode('on-stop', baseEnv(home, AGENT), JSON.stringify({ session_id: S, transcript_path: file }));
    await settle(3);
    return { run, requests: recorded };
  }

  it('14, 15. finds the last text at the end of a 40 MB transcript, past tool records and a partial line', async () => {
    const file = path.join(tmp, 'long.jsonl');
    const last = `The answer, ${'ü'.repeat(3000)} and more`;
    writeLines(file, [
      { count: 40 * 1024, line: filler },
      text('an older answer'),
      text(last),
      { count: 300, line: toolOnly },
      '{"type":"assistant","message":{"content":[{"type":"text","text":"still flush',
    ]);
    expect(fs.statSync(file).size).toBeGreaterThan(40 * MB);

    const { run, requests } = await stopWith(file);
    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(10_000);
    const output = requests.find(r => r.path === '/api/hooks/output');
    expect(output?.body).toEqual({ agent_id: 'agent-1', hook: 'Stop', session_id: S, output: Buffer.from(last).subarray(0, 4000).toString('utf8').replace(/\n+$/, '') });
    expect(requests.map(r => r.path)).toEqual(['/api/hooks/output', '/api/hooks/status', '/api/hooks/agent-stopped']);
  }, 60_000);

  it('14. finds a text record that straddles the 1 MB chunk boundaries', async () => {
    const file = path.join(tmp, 'straddle.jsonl');
    const big = `start ${'z'.repeat(3 * MB)} end`;
    writeLines(file, [{ count: 100, line: filler }, text(big), { count: 5, line: toolOnly }]);
    const { requests } = await stopWith(file);
    const output = requests.find(r => r.path === '/api/hooks/output');
    expect((output?.body as { output: string }).output).toBe(big.slice(0, 4000));
  }, 60_000);

  it('15. posts no output when the last text is further than 8 MB from the end, and still settles the agent', async () => {
    const file = path.join(tmp, 'beyond.jsonl');
    writeLines(file, [text('too far back'), { count: 9 * 1024, line: toolOnly }]);
    expect(fs.statSync(file).size).toBeGreaterThan(8 * MB);

    const { run, requests } = await stopWith(file);
    expect(run.code).toBe(0);
    expect(requests.map(r => r.path)).toEqual(['/api/hooks/status', '/api/hooks/agent-stopped']);
    expect(run.stdout).toBe(CONTINUE);
  }, 60_000);
});

describe('the runner logs where the .sh logs', () => {
  it('appends to hooks.log and hooks-debug.log under ~/.dorothy/logs of its HOME', async () => {
    const home = caseHome('logs');
    responder = () => ({});
    await runNode('session-start', baseEnv(home, AGENT), JSON.stringify({ session_id: S, cwd: PROJECT }));
    await runNode('on-stop', baseEnv(home, AGENT), JSON.stringify({ session_id: S, last_assistant_message: 'hello' }));
    const dir = path.join(home, '.dorothy', 'logs');
    const hooksLog = fs.readFileSync(path.join(dir, 'hooks.log'), 'utf-8');
    expect(hooksLog).toMatch(new RegExp(`SESSION_START hook\\. AGENT_ID=agent-1 SESSION_ID=${S}`));
    expect(hooksLog).toContain('SESSION_START curl result: {"success":true}');
    const debugLog = fs.readFileSync(path.join(dir, 'hooks-debug.log'), 'utf-8');
    expect(debugLog).toContain('STOP hook');
    expect(debugLog).toContain('Output sent (5 chars)');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, 'hooks.log')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o077).toBe(0);
    }
  }, 30_000);
});
