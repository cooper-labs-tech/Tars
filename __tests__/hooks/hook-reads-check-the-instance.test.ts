import '../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shHooksNotShipped } from '../setup/platform-limits';

/**
 * The reads a hook makes with its terminal's token go only to the Tars that
 * spawned its CLI, as its posts do (hook-checks-the-instance.test.ts; the
 * Audit's Info on #355).
 *
 * session-start.sh fetches the agent's bootstrap and its memory context, and
 * post-tool-use.sh posts what the agent wrote to the memory, each with
 * CLAUDE_MGR_API_TOKEN in the clear, before or without the instance check
 * the status posts make: whatever held the port got the token.
 *
 * How it fails, written before the code (2026-10-12):
 * 1. A port that does not prove it knows the CLI's TARS_INSTANCE_ID gets the
 *    terminal's token on the bootstrap, the memory context or the memory post.
 * 2. Falling back to the shared token there: a squatter gets that instead.
 * 3. Over-correction: the Tars that spawned the CLI no longer gets the token
 *    on these reads, and the agent starts without its name and its memory.
 * 4. A CLI Tars did not start (no token in its environment) loses the shared
 *    token it read the bootstrap with until now. Since 2.0.4 that is the rule:
 *    the shared token is in ~/.tars-private, out of every agent's reach, and
 *    such a CLI reads nothing.
 * 5. The memory post goes out anyway, with an empty Bearer, when the port did
 *    not prove itself: no token leaks, but what the agent did ('Created/wrote
 *    file: <path>', 'Ran command: <command>', its id and project) reaches the
 *    squatter. Gemini's post-tool-use.sh and the Node runner (Claude's and
 *    Gemini's post-tool-use, the hooks on win32) each hold their own guard.
 *
 * The real hook scripts and their helper, with only the port pointed at a
 * server here that plays Tars, or plays the squatter.
 */

const HOOKS = path.join(__dirname, '../../hooks');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hook-reads-'));
const home = path.join(tmp, 'home');
const INSTANCE = crypto.randomBytes(16).toString('hex');
const TOKEN = 'token-of-a1s-terminal';
const SHARED = 'the-shared-token';

let mode: 'tars' | 'squatter' = 'tars';
const received: { path: string; authorization?: string }[] = [];
let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    received.push({ path: url.pathname, authorization: req.headers.authorization });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (url.pathname === '/api/health') {
        const challenge = url.searchParams.get('challenge') ?? '';
        const instance = mode === 'tars' ? INSTANCE : 'someone-else';
        res.end(JSON.stringify({ ok: true, proof: crypto.createHash('sha256').update(`${instance}:${challenge}`).digest('hex') }));
        return;
      }
      if (url.pathname.endsWith('/bootstrap')) { res.end(JSON.stringify({ context: 'You are a1.' })); return; }
      res.end(JSON.stringify({ success: true, context: 'remembered things' }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  fs.mkdirSync(path.join(home, '.tars'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tars', 'api-token'), SHARED);
  for (const name of ['session-start.sh', 'post-tool-use.sh', 'tars-hook.sh']) {
    const original = fs.readFileSync(path.join(HOOKS, name), 'utf-8');
    fs.writeFileSync(path.join(tmp, name), original.replaceAll('http://127.0.0.1:31415', `http://127.0.0.1:${port}`), { mode: 0o755 });
  }
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(r => { server.close(() => r()); });
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => { received.length = 0; });

function run(hook: string, env: Record<string, string>, input: unknown): Promise<string> {
  return spawnHook('/bin/bash', [path.join(tmp, hook)], env, input);
}
/** A hook of the repo as shipped, pointed at this server by CLAUDE_MGR_API_URL, as Tars points a terminal's. */
function runShipped(command: string, args: string[], env: Record<string, string>, input: unknown): Promise<string> {
  return spawnHook(command, args, { ...env, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}` }, input);
}
function spawnHook(command: string, args: string[], env: Record<string, string>, input: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    const child = spawn(command, args, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env } });
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.end(JSON.stringify(input));
  });
}
const START = { session_id: '5b0c6a1e-7d7f-4c1e-9b1a-2f3c4d5e6f70', source: 'startup', cwd: '/work/demo' };
const WROTE = { session_id: '5b0c6a1e-7d7f-4c1e-9b1a-2f3c4d5e6f70', cwd: '/work/demo', tool_name: 'Write', tool_input: { file_path: '/work/demo/x.ts' } };
const env = { CLAUDE_AGENT_ID: 'a1', CLAUDE_PROJECT_PATH: '/work/demo', CLAUDE_MGR_API_TOKEN: TOKEN, TARS_INSTANCE_ID: INSTANCE };
const reads = () => received.filter((r) => r.path.endsWith('/bootstrap') || r.path.startsWith('/api/memory'));
const remembered = () => received.filter((r) => r.path === '/api/memory/remember');
// The .sh posts the memory in the background (curl &): what it sends lands after the script ends.
const settle = () => new Promise((r) => setTimeout(r, 1500));
const GEMINI_SH: [string, string[]] = ['/bin/bash', [path.join(HOOKS, 'gemini', 'post-tool-use.sh')]];
const RUNNER = (event: string): [string, string[]] => [process.execPath, [path.join(HOOKS, 'tars-hook.mjs'), event]];
const MEMORY_POSTERS: Array<[string, [string, string[]]]> = [
  ["Gemini's post-tool-use.sh", GEMINI_SH],
  ["the Node runner's post-tool-use (Claude)", RUNNER('post-tool-use')],
  ["the Node runner's post-tool-use (Gemini)", RUNNER('gemini/post-tool-use')],
];

describe.skipIf(shHooksNotShipped())("a hook's reads, before they carry its token", () => {
  it('1, 2. a squatter gets neither the terminal\'s token nor the shared one', async () => {
    mode = 'squatter';
    await run('session-start.sh', env, START);
    await run('post-tool-use.sh', env, WROTE);
    const leaked = received.filter((r) => r.authorization && r.authorization !== 'Bearer ');
    expect(leaked).toEqual([]);
  }, 60_000);

  it('3. the Tars that spawned the CLI gets the token on the bootstrap, the memory context and the memory post', async () => {
    mode = 'tars';
    const out = await run('session-start.sh', env, START);
    await run('post-tool-use.sh', env, WROTE);
    const paths = reads().map((r) => [r.path, r.authorization]);
    expect(paths).toEqual(expect.arrayContaining([
      ['/api/agents/a1/bootstrap', `Bearer ${TOKEN}`],
      ['/api/memory/context', `Bearer ${TOKEN}`],
      ['/api/memory/remember', `Bearer ${TOKEN}`],
    ]));
    expect(out).toContain('You are a1.');
  }, 60_000);

  it("5. a squatter gets no memory post at all from Claude's post-tool-use.sh", async () => {
    mode = 'squatter';
    await run('post-tool-use.sh', env, WROTE);
    await settle();
    expect(remembered()).toEqual([]);
  }, 60_000);

  for (const [name, [command, args]] of MEMORY_POSTERS) {
    it(`5. a squatter gets no memory post at all from ${name}`, async () => {
      mode = 'squatter';
      await runShipped(command, args, env, WROTE);
      await settle();
      expect(remembered()).toEqual([]);
    }, 60_000);

    it(`3. the Tars that spawned the CLI gets ${name}'s memory post, with the token`, async () => {
      mode = 'tars';
      await runShipped(command, args, env, WROTE);
      await settle();
      expect(remembered().map((r) => r.authorization)).toEqual([`Bearer ${TOKEN}`]);
    }, 60_000);
  }

  it('4. a CLI Tars did not start reads nothing: the shared token is out of its reach since 2.0.4', async () => {
    mode = 'tars';
    await run('session-start.sh', { CLAUDE_AGENT_ID: 'a1', CLAUDE_PROJECT_PATH: '/work/demo' }, START);
    expect(reads().map((r) => r.authorization)).toEqual([]);
  }, 60_000);
});
