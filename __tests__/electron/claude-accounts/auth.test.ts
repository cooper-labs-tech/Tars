/**
 * Asking Claude Code whether a directory is signed in, and signing it out
 * (electron/services/claude-accounts/auth.ts).
 *
 * The rule: Tars never reads, copies or stores a Claude credential. Claude Code
 * reads its own keychain item or file; Tars runs `claude auth status` and
 * `claude auth logout` with CLAUDE_CONFIG_DIR, and reads their output.
 *
 * What goes wrong if it is wrong, first:
 * - account 1 asked with CLAUDE_CONFIG_DIR=~/.claude: measured, that looks up
 *   another keychain item and ~/.claude/.claude.json, and says "Not logged in".
 *   Account 1 runs with the variable absent, even when Tars's own environment
 *   has one;
 * - CLAUDE_SECURESTORAGE_CONFIG_DIR inherited: Claude Code names the keychain
 *   item after it instead, so every account would read the same one;
 * - the nested-session marker (CLAUDECODE) inherited from a Tars started inside
 *   a claude session changes how the child behaves;
 * - TARS_CLAUDE_ACCOUNT inherited: it names the account a status line reports
 *   for, and a Tars started from an agent's terminal carries that agent's;
 * - the auto-updater downloading a release inside a status check;
 * - a signed-out directory read as an error (exit 1 is the answer, not a
 *   failure), or output that is not JSON read as signed out;
 * - a failed logout reported as done: removing the account would then leave a
 *   signed-in item behind with nobody able to see it;
 * - the command given as a string to a shell.
 * - a check still running when Tars quits goes on without it: measured by QA
 *   on 2026-10-12, a `claude auth status` the accounts list had started wrote
 *   .claude.json into the home after the quit. The quit's first pass ends it
 *   and whatever it started (endAuthCommands), the check fails rather than
 *   reading as signed out, and one asked for during the quit is not started.
 * And from QA's fresh-install report (B3) and Tars-Frontend's first run (first-run-window.md), written before the
 * code (10/11):
 * - a claude that is not there reads like any other failure, so the first run cannot say "install Claude Code": a
 *   binary that does not exist fails as ClaudeCliMissing (`code: 'cli-missing'`), a broken answer does not.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { claudeAccountsNotPorted } from '../../setup/platform-limits';

// Every test runs a binary: 5 s is too short under the fleet's load.
vi.setConfig({ testTimeout: 30_000 });
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { accountEnv, claudeAuthStatus, claudeAuthLogout, loginCommand, endAuthCommands, ClaudeCliMissing } from '../../../electron/services/claude-accounts/auth';
import { makeFakeClaude, signIn, type FakeClaude } from './fake-claude';

let fake: FakeClaude;
let dirA: string;
const saved = { ...process.env };

beforeEach(() => {
  fake = makeFakeClaude();
  dirA = path.join(fs.realpathSync(os.homedir()), '.claude-accounts', `acct-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dirA, { recursive: true });
});

afterEach(() => {
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDECODE']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe.skipIf(claudeAccountsNotPorted())('the environment', () => {
  it('names the directory for an account, and none for account 1', () => {
    const base = { PATH: '/usr/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/elsewhere', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/x', CLAUDECODE: '1', TARS_CLAUDE_ACCOUNT: 'acct-ffffff' };
    const a = accountEnv(dirA, base);
    expect(a.CLAUDE_CONFIG_DIR).toBe(dirA);
    const d = accountEnv(null, base);
    expect('CLAUDE_CONFIG_DIR' in d).toBe(false);
    for (const env of [a, d]) {
      expect('CLAUDE_SECURESTORAGE_CONFIG_DIR' in env).toBe(false);
      expect('CLAUDECODE' in env).toBe(false);
      expect('TARS_CLAUDE_ACCOUNT' in env).toBe(false);
      expect(env.DISABLE_AUTOUPDATER).toBe('1');
      expect(env.HOME).toBe('/h');
    }
  });

  it('passes the directory string exactly as stored', () => {
    expect(accountEnv('/tmp/../tmp/acct-x/', {}).CLAUDE_CONFIG_DIR).toBe('/tmp/../tmp/acct-x/');
  });
});

describe.skipIf(claudeAccountsNotPorted())('claude auth status', () => {
  it('reads signed in, with the e-mail and the plan', async () => {
    signIn(dirA, 'two@example.com');
    expect(await claudeAuthStatus(fake.bin, dirA)).toEqual({
      signedIn: true, email: 'two@example.com', subscriptionType: 'max', orgName: 'Someone Org',
    });
    expect(fake.calls()).toEqual([`${dirA}|<unset>|auth status`]);
  });

  it('reads a signed-out directory (exit 1) as signed out, not as a failure', async () => {
    expect(await claudeAuthStatus(fake.bin, dirA)).toEqual({ signedIn: false, email: null, subscriptionType: null, orgName: null });
  });

  it('asks about account 1 without CLAUDE_CONFIG_DIR, whatever Tars itself has', async () => {
    process.env.CLAUDE_CONFIG_DIR = dirA;
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = dirA;
    signIn(path.join(os.homedir(), '.claude'), 'one@example.com');
    expect((await claudeAuthStatus(fake.bin, null)).email).toBe('one@example.com');
    expect(fake.calls()).toEqual(['<unset>|<unset>|auth status']);
  });

  it('fails with a sentence when the output is not JSON, or the binary does not run', async () => {
    fs.writeFileSync(path.join(dirA, '.fake-broken'), '');
    await expect(claudeAuthStatus(fake.bin, dirA)).rejects.toThrow(/claude auth status/);
    await expect(claudeAuthStatus(path.join(os.tmpdir(), 'no-such-claude'), dirA)).rejects.toThrow(/claude auth status/);
  });

  it('tells a claude that is not there from one that answers badly', async () => {
    const missing = await claudeAuthStatus(path.join(os.tmpdir(), 'no-such-claude'), dirA).catch(e => e);
    expect(missing).toBeInstanceOf(ClaudeCliMissing);
    expect(missing.code).toBe('cli-missing');
    fs.writeFileSync(path.join(dirA, '.fake-broken'), '');
    const broken = await claudeAuthStatus(fake.bin, dirA).catch(e => e);
    expect(broken).toBeInstanceOf(Error);
    expect(broken).not.toBeInstanceOf(ClaudeCliMissing);
  });

  it('runs the binary with an argument list, so a hostile directory stays one argument', async () => {
    const odd = path.join(dirA, "it's $(touch pwned); `x`");
    signIn(odd, 'odd@example.com');
    expect((await claudeAuthStatus(fake.bin, odd)).email).toBe('odd@example.com');
    expect(fs.existsSync(path.join(process.cwd(), 'pwned'))).toBe(false);
  });
});

describe.skipIf(claudeAccountsNotPorted())('claude auth logout', () => {
  it('signs that directory out and no other', async () => {
    const dirB = `${dirA}-b`;
    signIn(dirA, 'two@example.com');
    signIn(dirB, 'three@example.com');
    await claudeAuthLogout(fake.bin, dirA);
    expect((await claudeAuthStatus(fake.bin, dirA)).signedIn).toBe(false);
    expect((await claudeAuthStatus(fake.bin, dirB)).signedIn).toBe(true);
    expect(fake.calls()[0]).toBe(`${dirA}|<unset>|auth logout`);
  });

  it('throws when the logout fails', async () => {
    signIn(dirA, 'two@example.com');
    fs.writeFileSync(path.join(dirA, '.fake-logout-fails'), '');
    await expect(claudeAuthLogout(fake.bin, dirA)).rejects.toThrow(/log out/i);
  });
});

describe.skipIf(claudeAccountsNotPorted())('the login command', () => {
  it('is the binary itself with auth login --claudeai, aimed at the directory', () => {
    const c = loginCommand(fake.bin, dirA, { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/other' });
    expect(c.file).toBe(fake.bin);
    expect(c.args).toEqual(['auth', 'login', '--claudeai']);
    expect(c.env.CLAUDE_CONFIG_DIR).toBe(dirA);
    expect('CLAUDE_CONFIG_DIR' in loginCommand(fake.bin, null, { CLAUDE_CONFIG_DIR: '/other' }).env).toBe(false);
  });
});

describe.skipIf(claudeAccountsNotPorted() || process.platform === 'win32')('a check the quit ends', () => {
  it('ends a running status check and what it started, and the check fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-auth-quit-'));
    const pids = path.join(dir, 'pids');
    const bin = path.join(dir, 'claude');
    // Records its pid and its child's, then waits: a check the quit comes in the middle of.
    fs.writeFileSync(bin, `#!/bin/bash\nsleep 30 &\necho "$$ $!" > ${JSON.stringify(pids)}\nwait\n`, { mode: 0o755 });
    const check = claudeAuthStatus(bin, dirA);
    for (let i = 0; i < 100 && !fs.existsSync(pids); i++) await new Promise(r => setTimeout(r, 50));
    const [cli, child] = fs.readFileSync(pids, 'utf8').trim().split(' ').map(Number);
    endAuthCommands();
    await expect(check).rejects.toThrow(/ended by the quit/);
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 40 && (alive(cli) || alive(child)); i++) await new Promise(r => setTimeout(r, 50));
    expect([alive(cli), alive(child)]).toEqual([false, false]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(claudeAccountsNotPorted() || process.platform === 'win32')('a check asked for once the quit has begun', () => {
  it('is refused and starts nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-auth-quitting-'));
    const ran = path.join(dir, 'ran');
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, `#!/bin/bash\necho "$$" > ${JSON.stringify(ran)}\necho '{"loggedIn":false}'\n`, { mode: 0o755 });
    // A registry of its own, so the quit begun here ends nowhere else.
    vi.resetModules();
    const quit = await import('../../../electron/core/quit-state');
    const auth = await import('../../../electron/services/claude-accounts/auth');
    quit.beginQuit();
    await expect(auth.claudeAuthStatus(bin, dirA)).rejects.toThrow(/quitting/);
    await new Promise(r => setTimeout(r, 300));
    expect(fs.existsSync(ran), 'a claude was started during the quit').toBe(false);
    vi.resetModules();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
