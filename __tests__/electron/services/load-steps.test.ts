import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runStep, stepEnv } from '../../../electron/services/load-steps';

/**
 * A load task's steps (trace feature C3, part 3): its setup lines before its session and its test_cmd after it, from
 * the approved snapshot only, run unattended in its worktree under the heavy-run slot (load-engine.ts holds the slot,
 * this the process).
 *
 * How it fails, written before the code:
 *  S1. A step's exit code is lost, or a step that exits non-zero reads as passed.
 *  S2. A step waits on its standard input (an install asking a question): it is not run non-interactively, and hangs
 *      until its cap.
 *  S3. At its cap only the shell is killed: what it started (a test runner's workers, a server) goes on, and holds the
 *      worktree, the slot's machine and its ports. The whole tree must go (a process group on macOS and Linux;
 *      `taskkill /PID <pid> /T /F` on Windows, platform/kill-tree.ts).
 *  S4. Tars's tokens or identities reach a step's environment (CLAUDE_MGR_API_TOKEN, TARS_ENDPOINT_TOKEN, an agent's
 *      id), or a step can push (the push block is missing), or it can ask git for credentials.
 *  S5. A step runs elsewhere than in the worktree it is given.
 *  S6. A stop of the window (an AbortSignal) leaves a step running.
 */

const NODE = JSON.stringify(process.execPath);
const node = (code: string) => `${NODE} -e ${JSON.stringify(code)}`;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-steps-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('a load task\'s step', () => {
  it('S1. gives its exit code; non-zero is not zero', async () => {
    expect(await runStep({ command: node('process.exit(0)'), cwd: dir, env: stepEnv(process.env), capMs: 20_000 })).toMatchObject({ exitCode: 0, atCap: false, aborted: false });
    expect(await runStep({ command: node('process.exit(3)'), cwd: dir, env: stepEnv(process.env), capMs: 20_000 })).toMatchObject({ exitCode: 3, atCap: false });
  });

  it('S2. runs with its standard input closed: a step reading it gets its end at once', async () => {
    const started = Date.now();
    const r = await runStep({ command: node("process.stdin.on('data',()=>{}).on('end',()=>process.exit(7))"), cwd: dir, env: stepEnv(process.env), capMs: 20_000 });
    expect(r).toMatchObject({ exitCode: 7, atCap: false });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it.skipIf(process.platform === 'win32')('S3. at its cap, its whole tree goes, what it started too', async () => {
    const child = "require('fs').writeFileSync('grandchild.pid', String(process.pid)); setInterval(()=>{}, 1000)";
    const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' }); setInterval(()=>{}, 1000)`;
    const r = await runStep({ command: node(parent), cwd: dir, env: stepEnv(process.env), capMs: 1500 });
    expect(r).toMatchObject({ atCap: true, aborted: false });
    const grandchild = Number(fs.readFileSync(path.join(dir, 'grandchild.pid'), 'utf8'));
    expect(grandchild).toBeGreaterThan(0);
    await expect.poll(() => alive(grandchild), { timeout: 5000 }).toBe(false);
  });

  it('S4. its environment holds none of Tars\'s tokens or identities, blocks a push, and asks git for nothing', () => {
    const env = stepEnv({
      PATH: '/usr/bin', HOME: '/home/someone', LANG: 'C',
      CLAUDE_MGR_API_TOKEN: 'tok-1', CLAUDE_MGR_API_TOKEN_FILE: '/x', CLAUDE_MGR_API_URL: 'http://127.0.0.1:31415',
      TARS_ENDPOINT_TOKEN: 'tep_1', TARS_INSTANCE_ID: 'i-1', DOROTHY_E2E: '1',
      CLAUDE_AGENT_ID: 'a-1', CLAUDE_AGENT_NAME: 'Load 1', CLAUDE_PROJECT_PATH: '/p', CLAUDE_SKILLS: 's',
      ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_API_KEY: 'k2',
    });
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/someone', LANG: 'C', CI: '1', GIT_TERMINAL_PROMPT: '0' });
    for (const name of ['CLAUDE_MGR_API_TOKEN', 'CLAUDE_MGR_API_TOKEN_FILE', 'CLAUDE_MGR_API_URL', 'TARS_ENDPOINT_TOKEN', 'TARS_INSTANCE_ID', 'DOROTHY_E2E',
      'CLAUDE_AGENT_ID', 'CLAUDE_AGENT_NAME', 'CLAUDE_PROJECT_PATH', 'CLAUDE_SKILLS', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
      expect(env[name], name).toBeUndefined();
    }
    expect(Object.values(env)).not.toContain('tok-1');
    expect(env.GIT_CONFIG_KEY_0).toBe('url.tars-load-push-blocked://.pushInsteadOf');
  });

  it('S4. a step sees that environment', async () => {
    const r = await runStep({
      command: node("require('fs').writeFileSync('env.json', JSON.stringify(process.env))"), cwd: dir,
      env: stepEnv({ ...process.env, CLAUDE_MGR_API_TOKEN: 'planted-token' }), capMs: 20_000,
    });
    expect(r.exitCode).toBe(0);
    const seen = fs.readFileSync(path.join(dir, 'env.json'), 'utf8');
    expect(seen).not.toContain('planted-token');
    expect(JSON.parse(seen).CI).toBe('1');
  });

  it('S5. runs in the worktree it is given', async () => {
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    await runStep({ command: node("require('fs').writeFileSync('here.txt', process.cwd())"), cwd: work, env: stepEnv(process.env), capMs: 20_000 });
    expect(fs.realpathSync(fs.readFileSync(path.join(work, 'here.txt'), 'utf8'))).toBe(fs.realpathSync(work));
  });

  it.skipIf(process.platform === 'win32')('S6. a stop ends it, its tree too', async () => {
    const ac = new AbortController();
    const running = runStep({ command: node("require('fs').writeFileSync('me.pid', String(process.pid)); setInterval(()=>{}, 1000)"), cwd: dir, env: stepEnv(process.env), capMs: 60_000, signal: ac.signal });
    await expect.poll(() => fs.existsSync(path.join(dir, 'me.pid')), { timeout: 5000 }).toBe(true);
    ac.abort();
    expect(await running).toMatchObject({ aborted: true, atCap: false });
    await expect.poll(() => alive(Number(fs.readFileSync(path.join(dir, 'me.pid'), 'utf8'))), { timeout: 5000 }).toBe(false);
  });
});
