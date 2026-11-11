import { spawn, type ChildProcess } from 'child_process';
import { buildFullPath } from '../../utils/path-builder';
import { refuseWhileQuitting } from '../../core/quit-state';
import { endProbe } from '../../core/version-probe';
import { resolveCliBinary, withPath as pathIn, type Env } from '../../platform';

/**
 * Asking Claude Code about an account, never its credential.
 *
 * Tars never reads, copies or stores a Claude token. `claude auth status`
 * reads the keychain item (or, on Linux, the file) itself and prints JSON;
 * `claude auth logout` removes that directory's item and no other; `claude
 * auth login --claudeai` signs a directory in, in a terminal the user drives.
 * All measured on claude 2.1.283 (DESIGN-COMPTES-CLAUDE.md, A2).
 */

export interface ClaudeAuthInfo {
  signedIn: boolean;
  email: string | null;
  subscriptionType: string | null;
  orgName: string | null;
}

const TIMEOUT_MS = 20_000;

/**
 * The environment a claude command for this account runs with.
 *
 * - CLAUDE_CONFIG_DIR is the directory exactly as stored, and absent for
 *   account 1: measured, CLAUDE_CONFIG_DIR=~/.claude is not the default but
 *   another keychain item and another .claude.json;
 * - CLAUDE_SECURESTORAGE_CONFIG_DIR is dropped: Claude Code names the keychain
 *   item after it when it is set, so one inherited would aim every account at
 *   the same item;
 * - CLAUDECODE, the nested-session marker of a Tars started from a claude
 *   session, is dropped, and so is TARS_CLAUDE_ACCOUNT, which names the
 *   account a status line reports for and would be an agent's own in a Tars
 *   started from its terminal;
 * - the auto-updater is off, as in every terminal Tars starts.
 */
export function accountEnv(configDir: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  delete env.CLAUDECODE;
  delete env.TARS_CLAUDE_ACCOUNT;
  env.DISABLE_AUTOUPDATER = '1';
  if (configDir !== null) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

function withPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The packaged main process has a bare PATH: a claude found by name would
  // not be found at all. Written once, under the spelling Windows already has
  // (Path): a second key beside it, and which one a program reads is chance.
  return pathIn(env as Env, buildFullPath(), process.platform) as NodeJS.ProcessEnv;
}

/**
 * The program to start for `binary` and the argv before its own: on Windows
 * as the platform layer finds it, since neither a bare name (no PATHEXT) nor
 * an npm .cmd shim (refused without a shell) starts there: the shim is read
 * through to node and its script (as core/version-probe.ts). Elsewhere the
 * binary as given.
 */
function invocation(binary: string, env: NodeJS.ProcessEnv): { file: string; prefixArgs: string[] } | { error: Error } {
  const cli = resolveCliBinary(binary, env as Env, process.platform);
  return cli.ok ? { file: cli.file, prefixArgs: cli.prefixArgs } : { error: new Error(cli.detail) };
}

/**
 * The `claude auth` commands still running, so that the quit ends them.
 *
 * Listing the accounts checks every account whose sign-in is not known yet in
 * the background (claude-accounts:list, at page load), with a 20 s timeout.
 * Those were plain execFile calls the quit knew nothing of: one started just
 * before a quit went on and wrote .claude.json and its lock into the home
 * after Tars was gone (measured by QA after app.close() on 2026-10-12, orphaned
 * 1 ms after the quit). Each now runs in a process group of its own, as the
 * version probes do (core/version-probe.ts), and the quit's first pass ends
 * every one still running (endAuthCommands, main.ts). One asked for during the
 * quit is refused.
 */
const running = new Set<ChildProcess>();

/** Ends every `claude auth` command still running and what it started. For the quit. */
export function endAuthCommands(): void {
  for (const child of running) endProbe(child);
  running.clear();
}

function run(binary: string, args: string[], configDir: string | null): Promise<{ code: number; stdout: string; stderr: string; spawnError?: Error }> {
  try {
    refuseWhileQuitting('claude auth');
  } catch (err) {
    return Promise.resolve({ code: -1, stdout: '', stderr: '', spawnError: err as Error });
  }
  const env = withPath(accountEnv(configDir));
  const cli = invocation(binary, env);
  if ('error' in cli) return Promise.resolve({ code: -1, stdout: '', stderr: '', spawnError: cli.error });
  return new Promise(resolve => {
    // detached: a group of its own, which endProbe can signal whole. Not on
    // Windows, where it would open a console of its own and taskkill ends the tree.
    const child = spawn(cli.file, [...cli.prefixArgs, ...args], {
      env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { stdout += String(d); });
    child.stderr?.on('data', d => { stderr += String(d); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; endProbe(child); }, TIMEOUT_MS);
    let settled = false;
    // An exit code is an answer; anything else (ENOENT, the timeout, the quit) means it did not run to the end.
    const settle = (code: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const endedByQuit = !running.delete(child);
      endProbe(child);
      if (spawnError) resolve({ code: -1, stdout, stderr, spawnError });
      else if (timedOut) resolve({ code: -1, stdout, stderr, spawnError: new Error(`claude ${args.join(' ')} did not answer in ${TIMEOUT_MS} ms`) });
      else if (endedByQuit || code === null) resolve({ code: -1, stdout, stderr, spawnError: new Error(`claude ${args.join(' ')} was ended${endedByQuit ? ' by the quit' : ''}`) });
      else resolve({ code, stdout, stderr });
    };
    child.on('error', err => settle(null, err));
    child.on('close', code => settle(code));
  });
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** Whether the directory is signed in, and as whom. Exit 1 is "not signed in", an answer. */
export async function claudeAuthStatus(binary: string, configDir: string | null): Promise<ClaudeAuthInfo> {
  const r = await run(binary, ['auth', 'status'], configDir);
  if (r.spawnError) throw new Error(`claude auth status could not run: ${r.spawnError.message}`);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(`claude auth status did not answer in JSON (exit ${r.code}).`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.loggedIn !== 'boolean') {
    throw new Error(`claude auth status did not say whether it is signed in (exit ${r.code}).`);
  }
  const signedIn = parsed.loggedIn;
  return {
    signedIn,
    email: signedIn ? stringOrNull(parsed.email) : null,
    subscriptionType: signedIn ? stringOrNull(parsed.subscriptionType) : null,
    orgName: signedIn ? stringOrNull(parsed.orgName) : null,
  };
}

/** Signs the directory out, through Claude Code. Throws when it did not. */
export async function claudeAuthLogout(binary: string, configDir: string | null): Promise<void> {
  const r = await run(binary, ['auth', 'logout'], configDir);
  if (r.spawnError) throw new Error(`claude auth logout could not run: ${r.spawnError.message}`);
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.code}`;
    throw new Error(`Claude Code did not log this account out: ${why}`);
  }
}

/**
 * The login terminal's program: the binary itself, as the platform starts it
 * (invocation), no shell in between, with the PATH a packaged Tars lacks.
 * Throws when the binary cannot be started.
 */
export function loginCommand(binary: string, configDir: string | null, base: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env = withPath(accountEnv(configDir, base));
  const cli = invocation(binary, env);
  if ('error' in cli) throw new Error(`claude cannot be started: ${cli.error.message}`);
  return { file: cli.file, args: [...cli.prefixArgs, 'auth', 'login', '--claudeai'], env };
}
