import '../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { shHooksNotShipped } from '../setup/platform-limits';

/**
 * The four shell hooks the state mod stands in for name themselves in every
 * post (`hook`), so that Tars sets them aside for a session the mod registered
 * and takes them for every other one (services/state-mod.ts, hooks-routes.ts).
 *
 * How it fails, written before the code (2026-10-05):
 * 1. A post of one of the four carries no `hook`, or the wrong one: Tars takes
 *    it beside the mod's, twice and in the wrong order.
 * 2. Another hook names itself as one of the four: a permission dialog's
 *    waiting would be set aside while the mod runs.
 */

const HOOKS = path.join(__dirname, '../../hooks');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hook-names-'));
const home = path.join(tmp, 'home');
const INSTANCE = crypto.randomBytes(16).toString('hex');
let server: http.Server;
let port: number;
const received: { path: string; body: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ path: req.url ?? '', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const challenge = new URL(req.url ?? '/', 'http://x').searchParams.get('challenge');
      if (challenge) {
        res.end(JSON.stringify({ ok: true, proof: crypto.createHash('sha256').update(`${INSTANCE}:${challenge}`).digest('hex') }));
        return;
      }
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  fs.mkdirSync(home, { recursive: true });
});

afterAll(async () => {
  await new Promise<void>(r => { server.close(() => r()); });
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(script: string, input: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [path.join(HOOKS, script)], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        CLAUDE_AGENT_ID: 'a1',
        CLAUDE_MGR_API_TOKEN: 'token-of-a1',
        CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`,
        TARS_INSTANCE_ID: INSTANCE,
      },
    });
    child.on('error', reject);
    child.on('close', () => resolve());
    child.stdin.end(JSON.stringify(input));
  });
}

const SESSION = '5f0c2d4e-8a61-4b7e-9d3a-2c1b0e9f7a64';
/** What each of the four posts to the routes that drive an agent's state. */
const DRIVING = /^\/api\/hooks\/(status|output|agent-stopped)\b/;

describe('the four hooks the state mod stands in for', () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['session-start.sh', 'SessionStart', { session_id: SESSION, source: 'startup' }],
    ['user-prompt-submit.sh', 'UserPromptSubmit', { session_id: SESSION, prompt: 'rebase onto main' }],
    ['on-stop.sh', 'Stop', { session_id: SESSION, last_assistant_message: 'done' }],
    ['stop-failure.sh', 'StopFailure', { session_id: SESSION, error: 'rate_limit', last_assistant_message: 'limit reached' }],
  ];

  // Each of these runs a .sh hook in bash; 2 only reads their sources, and runs everywhere.
  for (const [script, name, input] of cases) {
    it.skipIf(shHooksNotShipped())(`1. ${script} names itself ${name} in every post that drives the agent`, async () => {
      received.length = 0;
      await run(script, input);
      const posts = received.filter(r => DRIVING.test(r.path));
      expect(posts.length, `${script} posted nothing`).toBeGreaterThan(0);
      for (const post of posts) expect(JSON.parse(post.body).hook, `${script} ${post.path}`).toBe(name);
    }, 30_000);
  }

  it('2. no other hook names itself as one of the four', () => {
    const others = fs.readdirSync(HOOKS).filter(f => f.endsWith('.sh') && !cases.some(c => c[0] === f));
    expect(others.length).toBeGreaterThan(3);
    for (const other of others) {
      const source = fs.readFileSync(path.join(HOOKS, other), 'utf-8');
      expect(source, other).not.toMatch(/"hook"\s*:|hook:\s*\$|--arg hook/);
    }
  });
});
