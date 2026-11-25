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
 * Every hook post carries the token of the CLI it runs in, and logs where only
 * its user reads.
 *
 * The hook routes took no credential until 2026-09-23, and anybody on the
 * loopback could register a session for any agent (the Audit's 4.3). They now
 * take the agent's own token and nothing else (api-server.ts), so a hook that
 * forgot it would leave its agent's status frozen with no error anywhere. And
 * the logs were in /tmp, readable by every user and shared by every Tars on
 * the machine, a sandbox's included.
 *
 * The real script and its helper, with only the port pointed at a server here.
 */

const HOOKS = path.join(__dirname, '../../hooks');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hook-token-'));
const home = path.join(tmp, 'home');
let server: http.Server;
let port: number;
const received: { path: string; authorization?: string; body: string }[] = [];
const INSTANCE = crypto.randomBytes(16).toString('hex');

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ path: req.url ?? '', authorization: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // This server plays the Tars that spawned the CLI: it proves it knows
      // the instance id, which a hook checks before it sends its token (#11,
      // hook-checks-the-instance.test.ts).
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
  for (const name of ['user-prompt-submit.sh', 'tars-hook.sh']) {
    const original = fs.readFileSync(path.join(HOOKS, name), 'utf-8');
    fs.writeFileSync(path.join(tmp, name), original.replaceAll('http://127.0.0.1:31415', `http://127.0.0.1:${port}`), { mode: 0o755 });
  }
});

afterAll(async () => {
  await new Promise<void>(r => { server.close(() => r()); });
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runHook(env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [path.join(tmp, 'user-prompt-submit.sh')], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env },
    });
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
    child.stdin.end(JSON.stringify({ session_id: 'session-token-1', prompt: 'rebase onto main' }));
  });
}

describe.skipIf(shHooksNotShipped())('a hook post', () => {
  it('carries the token of the CLI it runs in', async () => {
    received.length = 0;
    await runHook({ CLAUDE_AGENT_ID: 'a1', CLAUDE_MGR_API_TOKEN: 'token-of-a1s-terminal', TARS_INSTANCE_ID: INSTANCE });

    const posts = received.filter(r => r.path.startsWith('/api/hooks/'));
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) expect(post.authorization).toBe('Bearer token-of-a1s-terminal');
    expect(JSON.parse(posts[0].body).agent_id).toBe('a1');
  }, 30_000);

  it('logs in the data folder of the Tars that owns the CLI, for its user only', async () => {
    await runHook({ CLAUDE_AGENT_ID: 'a1', CLAUDE_MGR_API_TOKEN: 'token-of-a1s-terminal', TARS_INSTANCE_ID: INSTANCE });

    const dir = path.join(home, '.tars', 'logs');
    const log = path.join(dir, 'hooks.log');
    expect(fs.readFileSync(log, 'utf-8')).toContain('session-token-1');
    expect(fs.statSync(log).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o077).toBe(0);
  }, 30_000);
});

describe('every hook script', () => {
  const scripts = [
    ...fs.readdirSync(HOOKS).filter(f => f.endsWith('.sh') && f !== 'tars-hook.sh').map(f => path.join(HOOKS, f)),
    ...fs.readdirSync(path.join(HOOKS, 'gemini')).filter(f => f.endsWith('.sh')).map(f => path.join(HOOKS, 'gemini', f)),
  ];

  it('sources the helper, posts to the hook routes with the token, and writes nothing to /tmp', () => {
    expect(scripts.length).toBeGreaterThan(10);
    for (const script of scripts) {
      const source = fs.readFileSync(script, 'utf-8');
      expect(source, script).toMatch(/^source "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/(\.\.\/)?tars-hook\.sh"$/m);
      expect(source, script).not.toContain('/tmp/');
      for (const line of source.split('\n').filter(l => /curl .*\/api\/hooks\//.test(l))) {
        expect(line, script).toContain('-H @<(tars_auth)');
      }
    }
  });
});
