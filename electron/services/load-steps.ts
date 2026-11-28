import { spawn } from 'child_process';
import { killTree } from '../platform/kill-tree';
import { pushBlockEnv } from './load-session';

/**
 * A load task's steps (trace feature C3, part 3): its setup lines before its session and its test_cmd after it, from
 * the approved snapshot only (load-engine.ts holds the heavy-run slot around them, this runs the process).
 *
 * - Through the system's shell (`/bin/sh -c`, `cmd.exe /d /s /c`): the pool writes them as command lines.
 * - Unattended: its standard input closed, so a step that asks waits on nothing; its output not kept (a step's output
 *   can hold anything, and nothing reads it).
 * - In its worktree, in a process group of its own on macOS and Linux, so the whole tree goes at its cap or at a stop
 *   (`kill(-pid)`); on Windows, `taskkill /PID <pid> /T /F` by its absolute path (platform/kill-tree.ts).
 * - In an environment without Tars's tokens and identities, with the push block (load-session.ts), CI=1 and no git
 *   prompt for credentials.
 */

export interface StepResult {
  /** The step's exit code; null when it was killed. */
  exitCode: number | null;
  /** Killed at its cap, its whole tree. */
  atCap: boolean;
  /** Killed by a stop of the window. */
  aborted: boolean;
  durationMs: number;
}

/** What never reaches a step: Tars's tokens, its identities for an agent, and the providers' keys it hands a CLI. */
const DROPPED_PREFIXES = ['CLAUDE_MGR_', 'TARS_', 'DOROTHY_'];
const DROPPED = new Set(['CLAUDE_AGENT_ID', 'CLAUDE_AGENT_NAME', 'CLAUDE_PROJECT_PATH', 'CLAUDE_SKILLS', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);

/** A step's environment, from the one given (Tars's own, its PATH completed by the caller). */
export function stepEnv(base: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || DROPPED.has(name) || DROPPED_PREFIXES.some(p => name.startsWith(p))) continue;
    kept[name] = value;
  }
  return { ...kept, ...pushBlockEnv(kept), CI: '1', GIT_TERMINAL_PROMPT: '0' };
}

/** Ends the step and everything under it. */
function killStepTree(pid: number): void {
  if (process.platform === 'win32') {
    void killTree(pid).catch(err => console.error(`[load] the step ${pid} was not killed: ${(err as Error).message}`));
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* the group is gone */ }
}

/** Runs one step to its end, its cap, or a stop. */
export function runStep(o: { command: string; cwd: string; env: Record<string, string>; capMs: number; signal?: AbortSignal }): Promise<StepResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const child = win
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', o.command], { cwd: o.cwd, env: o.env, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
      : spawn('/bin/sh', ['-c', o.command], { cwd: o.cwd, env: o.env, stdio: 'ignore', detached: true });
    let atCap = false;
    let aborted = false;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      o.signal?.removeEventListener('abort', onAbort);
      // The group's last member may outlive the shell: what it started goes with it.
      if (!win && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
      resolve({ exitCode: atCap || aborted ? null : exitCode, atCap, aborted, durationMs: Date.now() - started });
    };
    const kill = () => { if (child.pid) killStepTree(child.pid); };
    const cap = setTimeout(() => { atCap = true; kill(); }, Math.max(0, o.capMs));
    const onAbort = () => { aborted = true; kill(); };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => finish(null));
    child.on('exit', (code) => finish(code));
  });
}
