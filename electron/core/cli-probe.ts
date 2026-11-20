import { spawn, type ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { refuseWhileQuitting } from './quit-state';
import { cliEnv, resolveCliBinary, killTree } from '../platform';
import { CliNotRunnableError } from '../providers/cli-exec';

/**
 * One way for Tars to run a one-shot CLI probe, so a probe never outlives its give-up or the app's quit (the Audit's
 * report on probe orphans, 20/11): codex's `--help` and `login status`, the login shells Tars reads a PATH or a
 * CODEX_HOME from, gws's `auth status`, tailscale's `status`, `claude mcp list` and the other `claude mcp` calls, and
 * every CLI's `--version` (version-probe.ts).
 *
 * Each was a plain execFile, or a spawn of its own: its timeout sent SIGTERM to the binary alone, which an interactive
 * zsh ignores and which never reaches what the binary started, and nothing ended one still running at the quit. QA
 * found four orphans of PID 1, 4 to 6 h old, a codex stand-in's `--help` and `login status`, after a sandboxed app
 * quit within 10 s of a codex launch.
 *
 * Here, as probeVersion was since the gate of #298: a process group of the probe's own, so what it starts ends with
 * it; the whole group SIGKILLed at its time, at its answer and at the quit (endCliProbes, main.ts's first pass); none
 * started once the quit has begun. Windows has no process group: the probe's tree is ended by taskkill /T while it
 * runs, never by its id once Node has read its exit (endProbe).
 */

/** Why a probe gave no answer: it failed (its exit code and words), hung past its time, was ended by the quit, or said too much. */
export type ProbeFailure = 'exit' | 'timeout' | 'quit' | 'too-long';

/** A probe that gave no answer, with what execFile's error carried: the exit code or signal, and what it printed. */
export class CliProbeError extends Error {
  readonly reason: ProbeFailure;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  constructor(message: string, reason: ProbeFailure, out: { code?: number | null; signal?: NodeJS.Signals | null; stdout: string; stderr: string }) {
    super(message);
    this.name = 'CliProbeError';
    this.reason = reason;
    this.code = out.code ?? null;
    this.signal = out.signal ?? null;
    this.stdout = out.stdout;
    this.stderr = out.stderr;
  }
}

export interface ProbeOptions {
  /** The probe's environment: else the one Tars hands a CLI it runs (cliEnv), which is Tars's own off Windows. */
  env?: NodeJS.ProcessEnv;
  /** How long it is waited for, then given up on and ended with what it started. */
  timeoutMs: number;
  /** The most it may print, stdout and stderr together, before it is ended: 1 MiB, execFile's, unless said. */
  maxBuffer?: number;
  /**
   * An answer read before the process ends (a login shell whose rc files leave a job running): once this holds of
   * its output so far, it is answered, and its group is ended.
   */
  until?: (stdout: string) => boolean;
}

const running = new Set<ChildProcess>();

/**
 * The probe's whole group, then the probe itself should it have left it. Also for the other short commands Tars runs
 * in a group of their own so the quit ends them (claude-accounts/auth.ts).
 */
export function endProbe(child: ChildProcess): void {
  if (child.pid === undefined) return;
  // Windows has no process groups: taskkill /T ends the probe and what it started, while the probe runs. Once Node
  // has read its exit, its id is free and Windows may have handed it to another process, whose tree /T would end
  // (as acp/client.ts's endProcessTreeOnWindows; version-probe-windows.test.ts).
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) void killTree(child.pid).catch(() => {});
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * `<binary> <args>`, run so that its give-up, its answer and the quit end it with what it started. Resolves with what
 * it printed once it exits 0 (or once `until` holds); rejects with a CliProbeError otherwise, with the spawn's own
 * error when it could not start, and with CliNotRunnableError when Windows finds no such CLI.
 */
export function probeCli(binary: string, args: readonly string[], opts: ProbeOptions): Promise<{ stdout: string; stderr: string }> {
  try {
    refuseWhileQuitting('CLI probe');
  } catch (err) {
    return Promise.reject(err);
  }
  const env = opts.env ?? (cliEnv(process.platform) as NodeJS.ProcessEnv | undefined) ?? process.env;
  // On Windows the binary as the platform layer finds it: an npm .cmd shim cannot be started without a shell
  // (EINVAL), so it is read through to node and its script. Elsewhere it is the binary as given.
  const cli = resolveCliBinary(binary, env, process.platform);
  if (!cli.ok) return Promise.reject(new CliNotRunnableError(cli));
  // Named by the binary and its first argument only: an argument may carry a path or a value no log should keep.
  const label = `${binary}${args.length ? ` ${args[0]}` : ''}`;
  const cap = opts.maxBuffer ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    // detached: a group of its own, which endProbe() can signal whole. Not on Windows, where it would open a console
    // of its own and taskkill ends the tree.
    const child = spawn(cli.file, [...cli.prefixArgs, ...args], {
      env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.add(child);
    let stdout = '';
    let stderr = '';
    let failure: ProbeFailure | null = null;
    let settled = false;
    const timer = setTimeout(() => { failure = 'timeout'; endProbe(child); }, opts.timeoutMs);
    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!running.delete(child) && !err) err = new CliProbeError(`${label} was ended by the quit`, 'quit', { stdout, stderr });
      endProbe(child);
      if (err) reject(err);
      else resolve({ stdout, stderr });
    };
    // Decoded as it comes, a character cut between two chunks kept whole.
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const took = (data: Buffer | string, into: 'stdout' | 'stderr') => {
      if (failure || settled) return;
      const chunk = decoders[into].write(typeof data === 'string' ? Buffer.from(data) : data);
      if (into === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > cap) {
        failure = 'too-long';
        endProbe(child);
        return;
      }
      if (into === 'stdout' && opts.until?.(stdout)) settle(null);
    };
    child.stdout?.on('data', (d: Buffer | string) => took(d, 'stdout'));
    child.stderr?.on('data', (d: Buffer | string) => took(d, 'stderr'));
    child.on('error', err => settle(err));
    child.on('close', (code, signal) => {
      const out = { code, signal, stdout, stderr };
      if (!running.has(child)) settle(new CliProbeError(`${label} was ended by the quit`, 'quit', out));
      else if (failure === 'timeout') settle(new CliProbeError(`${label} did not answer in ${opts.timeoutMs} ms`, 'timeout', out));
      else if (failure === 'too-long') settle(new CliProbeError(`${label} printed more than ${cap} bytes`, 'too-long', out));
      else if (code === 0) settle(null);
      else settle(new CliProbeError(`${label} ${signal ? `was ended by ${signal}` : `exited with ${code}`}${stderr ? `: ${stderr.trim()}` : ''}`, 'exit', out));
    });
  });
}

/** Ends every probe still running and what it started. For the quit's first pass (main.ts). */
export function endCliProbes(): void {
  for (const child of running) endProbe(child);
  running.clear();
}
