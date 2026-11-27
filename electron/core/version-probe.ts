import { spawn, type ChildProcess } from 'child_process';
import { refuseWhileQuitting } from './quit-state';
import { resolveCliBinary, killTree } from '../platform';

/**
 * `<binary> --version`, run so that the quit ends it.
 *
 * Settings asks each CLI for its version (`shell:version`: amp, gemini, codex
 * and the rest) and Settings > System asks claude, with an 8 s timeout. Those
 * were plain execFile calls the quit knew nothing of: amp, started just before
 * a quit, kept writing into the home after Tars was gone (the Audit's gate of
 * #298, measured by QA's bench). Each probe now runs in a process group of its
 * own, so what it starts ends with it, and the quit's first pass ends every
 * group still running (endVersionProbes, main.ts). One asked for during the
 * quit is refused.
 */

const running = new Set<ChildProcess>();

/**
 * The probe's whole group, then the probe itself should it have left it. Also
 * for the other short commands Tars runs in a group of their own so the quit
 * ends them (claude-accounts/auth.ts).
 */
export function endProbe(child: ChildProcess): void {
  if (child.pid === undefined) return;
  // Windows has no process groups: taskkill /T ends the probe and what it
  // started, while the probe runs. Once Node has read its exit, its id is free
  // and Windows may have handed it to another process, whose tree /T would end
  // (as acp/client.ts's endProcessTreeOnWindows; version-probe-windows.test.ts).
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) void killTree(child.pid).catch(() => {});
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * `cwd`: the folder the probe runs in. Without one it runs in Tars's own (`/` packaged on macOS, the install folder on
 * Windows, the home from a Linux desktop entry), where a CLI that reads or writes relative to its working folder
 * touches the owner's folders: a probe that must not (the traces' harness version) gives its throwaway folder.
 */
export function probeVersion(
  binary: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 8000,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    refuseWhileQuitting('version probe');
  } catch (err) {
    return Promise.reject(err);
  }
  // On Windows the binary as the platform layer finds it: an npm .cmd shim
  // cannot be started without a shell (EINVAL), so it is read through to node
  // and its script. Elsewhere it is the binary as given.
  const cli = resolveCliBinary(binary, env, process.platform);
  if (!cli.ok) return Promise.reject(new Error(cli.detail));
  return new Promise((resolve, reject) => {
    // detached: a group of its own, which endProbe() can signal whole; a timeout on
    // the binary alone would leave what it started running. Not on Windows,
    // where it would open a console of its own and taskkill ends the tree.
    const child = spawn(cli.file, [...cli.prefixArgs, '--version'], {
      env, ...(cwd ? { cwd } : {}), detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { stdout += String(d); });
    child.stderr?.on('data', d => { stderr += String(d); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; endProbe(child); }, timeoutMs);
    const settle = (err: Error | null) => {
      clearTimeout(timer);
      if (!running.delete(child) && !err) err = new Error(`${binary} --version was ended by the quit`);
      endProbe(child);
      if (err) reject(err);
      else resolve({ stdout, stderr });
    };
    child.on('error', err => settle(err));
    child.on('close', (code, signal) => {
      if (timedOut) settle(new Error(`${binary} --version did not answer in ${timeoutMs} ms`));
      else if (code === 0) settle(null);
      else settle(new Error(`${binary} --version ${signal ? `was ended by ${signal}` : `exited with ${code}`}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

/** Ends every probe still running and what it started. For the quit. */
export function endVersionProbes(): void {
  for (const child of running) endProbe(child);
  running.clear();
}
