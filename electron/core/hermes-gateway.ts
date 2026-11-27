import { execFile, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { hermesGatewayEnv } from '../services/hermes-home';
import { envValue, killTree, resolveCliBinary } from '../platform';

/**
 * Tars's Hermes gateway, started by Tars itself (the orchestrator's go of 27/11). One gateway per Hermes home runs
 * every profile's sessions; left to Hermes, the first agent's chat starts it, with that terminal's environment: every
 * session's tools then had that agent's id and temporary folder, and that agent's stop ended the gateway the others
 * shared (core/born-processes.ts ends what an agent started by the id in its environment). Measured on the real
 * binary, then the fix on the bench (Hermes's own code): started this way, the chats attach to it, A's stop leaves it
 * and B, and each session's detached tools carry their own agent's id (the profiles' client_env_passthrough).
 *
 * - Started at the first Hermes terminal (core/hermes-terminals.ts), before that terminal's chat looks for a gateway:
 *   the chat's line waits until this one holds its home (`ready`), so the chat attaches to it instead of starting its
 *   own. With nothing of Tars's starting (its start failed), nothing waits, and the chat starts one as Hermes does.
 * - `<hermes> gateway run --quiet`, no --idle-exit (it ends when Tars stops it), detached: on macOS and Linux a session
 *   of its own, which ending a terminal's tree never reaches; on Windows a process with no console, its own group.
 *   Its environment is services/hermes-home.ts's hermesGatewayEnv: no agent's identity, token or project.
 * - Stopped by the stop's rule (hermes-home.ts, the record, then its own HERMES_HOME on macOS and Linux, its start
 *   time on Windows), with its tree on Windows (taskkill /T), at the last Hermes terminal, at quit and at the next
 *   start; a gateway of another home (the user's ~/.hermes, a second Tars's) is never one of them.
 * - Exited while a Hermes terminal is open and no stop was asked: started again, three times a minute at most. A chat
 *   that needs a gateway in between finds none and starts its own, with its terminal's environment, as Hermes does;
 *   Tars stops that one by the same rule.
 * hermes-gateway.test.ts says each way this goes wrong.
 */

/** What the supervisor needs of a started gateway: its exit (or a spawn that failed). */
export interface GatewayChild {
  readonly pid?: number;
  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown;
}

export interface GatewaySupervisorDeps {
  /** The live gateway of Tars's home (its record, by the stop's checks), or null. */
  find: () => Promise<number | null>;
  /** Starts one with that binary; null when it could not be started at all. */
  start: (binary: string) => GatewayChild | null;
  /** How many Hermes terminals are open. */
  terminals: () => number;
  now?: () => number;
  log?: (message: string) => void;
}

/** Starts again after an exit Tars did not ask for, at most this many times a minute. */
const RESTARTS_PER_MINUTE = 3;

export class HermesGatewaySupervisor {
  private ensuring: Promise<'running' | 'started' | 'failed'> | null = null;
  private child: GatewayChild | null = null;
  private stopAsked = false;
  private restarts: number[] = [];
  private binary = 'hermes';

  constructor(private readonly deps: GatewaySupervisorDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private log(message: string): void { (this.deps.log ?? console.log)(message); }

  /** A gateway of Tars's home running, or one started: once, whoever asks at the same time. */
  ensure(binary: string): Promise<'running' | 'started' | 'failed'> {
    this.binary = binary;
    if (this.ensuring) return this.ensuring.then(r => (r === 'started' ? 'running' : r));
    this.ensuring = this.ensureOnce().finally(() => { this.ensuring = null; });
    return this.ensuring;
  }

  private async ensureOnce(): Promise<'running' | 'started' | 'failed'> {
    if (await this.deps.find() !== null) return 'running';
    this.stopAsked = false;
    const child = this.deps.start(this.binary);
    if (!child) {
      this.log('[hermes] the gateway of Tars\'s Hermes home was not started: the chat will start one itself');
      return 'failed';
    }
    this.child = child;
    this.log(`[hermes] started the gateway of Tars's Hermes home (pid ${child.pid ?? 'unknown'})`);
    const gone = () => this.exited(child);
    child.once('exit', gone);
    child.once('error', gone);
    return 'started';
  }

  private exited(child: GatewayChild): void {
    if (this.child !== child) return;
    this.child = null;
    if (this.stopAsked || this.deps.terminals() === 0) return;
    const now = this.now();
    this.restarts = this.restarts.filter(t => now - t < 60_000);
    if (this.restarts.length >= RESTARTS_PER_MINUTE) {
      this.log('[hermes] the gateway of Tars\'s Hermes home exited again: not started again for now (the next terminal starts it)');
      return;
    }
    this.restarts.push(now);
    this.log('[hermes] the gateway of Tars\'s Hermes home exited: started again');
    void this.ensure(this.binary);
  }

  /** Before Tars stops the gateway: its exit is not one to start it again after. */
  stopping(): void {
    this.stopAsked = true;
  }

  /**
   * True once a gateway holds Tars's home (its record names it, by the stop's checks): a chat started then attaches to
   * it. False at the timeout, or at once when nothing of Tars's is starting (nothing to wait for).
   */
  async ready(timeoutMs: number, everyMs = 250): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.deps.find() !== null) return true;
      if (!this.child && !this.ensuring) {
        this.log('[hermes] no gateway of Tars\'s Hermes home is starting: the chat starts without one to attach to');
        return false;
      }
      if (Date.now() >= deadline) {
        this.log('[hermes] the gateway of Tars\'s Hermes home did not take its home in time: the chat starts anyway');
        return false;
      }
      await new Promise(r => setTimeout(r, everyMs));
    }
  }
}

/**
 * `<binary> gateway run --quiet`, detached, in Tars's Hermes home, with the gateway's environment (hermesGatewayEnv),
 * its output to `<home>/logs/tars-gateway.log`. Null when the binary cannot be started (said).
 */
export function startHermesGatewayProcess(binary: string, o: { root: string; path: string; source?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): ChildProcess | null {
  const platform = o.platform ?? process.platform;
  const env = hermesGatewayEnv(o.source ?? process.env, o.root, o.path, platform);
  const bin = resolveCliBinary(binary, env, platform);
  if (!bin.ok) {
    console.error(`[hermes] the gateway's binary cannot be started (${bin.reason}): ${bin.detail}`);
    return null;
  }
  let log: number | undefined;
  try {
    fs.mkdirSync(path.join(o.root, 'tmp'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(o.root, 'logs'), { recursive: true, mode: 0o700 });
    log = fs.openSync(path.join(o.root, 'logs', 'tars-gateway.log'), 'a', 0o600);
    // Exactly hermesGatewayEnv's names (the renderer's types require NODE_ENV in a ProcessEnv; nothing here sets it).
    const child = spawn(bin.file, [...bin.prefixArgs, 'gateway', 'run', '--quiet'], {
      cwd: o.root, env: env as NodeJS.ProcessEnv, detached: true, stdio: ['ignore', log, log], windowsHide: true,
    });
    child.on('error', err => console.error(`[hermes] the gateway did not start: ${err.message}`));
    child.unref();
    return child;
  } catch (err) {
    console.error(`[hermes] the gateway did not start: ${(err as Error).message}`);
    return null;
  } finally {
    if (log !== undefined) fs.closeSync(log);
  }
}

/** The command line under a pid: /bin/ps on macOS and Linux, Win32_Process on Windows; null when none. */
export function commandOf(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const root = envValue(process.env, 'SystemRoot', 'win32') || 'C:\\Windows';
      const powershell = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`;
      execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000 }, (err, out) => resolve(err ? null : (String(out).trim() || null)));
    } else {
      execFile('/bin/ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5_000, env: { ...process.env, LC_ALL: 'C' } }, (err, out) => resolve(err ? null : (String(out).trim() || null)));
    }
  });
}

/**
 * The HERMES_HOME of a process's own environment (macOS and Linux), null when it has none or it cannot be read:
 * Linux /proc/<pid>/environ, exact; macOS `/bin/ps -E`, which prints the command and then the environment, readable
 * for a same-user process that is no platform binary (SECURITY.md § 3 and § 10), the last HERMES_HOME= being the
 * environment's.
 */
export function homeOf(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    return fs.promises.readFile(`/proc/${pid}/environ`, 'utf8')
      .then(text => text.split('\0').find(v => v.startsWith('HERMES_HOME='))?.slice('HERMES_HOME='.length) || null)
      .catch(() => null);
  }
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, out) => {
      if (err) return resolve(null);
      const found = [...String(out).matchAll(/ HERMES_HOME=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|\n|$)/g)];
      resolve(found.length ? found[found.length - 1][1] : null);
    });
  });
}

/** When a process started (Windows, Win32_Process.CreationDate), null when it cannot be read. */
export function startedAt(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    const root = envValue(process.env, 'SystemRoot', 'win32') || 'C:\\Windows';
    const powershell = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToUniversalTime().ToString('o')`;
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000 }, (err, out) => {
      const at = err ? NaN : Date.parse(String(out).trim());
      resolve(Number.isFinite(at) ? at : null);
    });
  });
}

/** The stop of a gateway found by the stop's rule: TERM on macOS and Linux, its tree on Windows (taskkill /T /F). */
export async function stopTarsHermesGatewayPid(pid: number): Promise<void> {
  if (process.platform === 'win32') await killTree(pid);
  else process.kill(pid, 'SIGTERM');
}
