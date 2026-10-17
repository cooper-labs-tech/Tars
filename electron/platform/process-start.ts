import { execFileSync as nodeExecFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { childEnv } from './child-env';
import { isPlainAbsolute } from './cli-binary';
import { envValue } from './path-env';

/**
 * When the process under a pid started, as the OS says it: what tells the
 * Tars that wrote the run record from a process that took its pid after it
 * crashed (services/run-state.ts; the Audit's Low on #418). Opaque, compared
 * for equality only.
 *
 * - linux: field 22 of /proc/<pid>/stat, the start in clock ticks since boot.
 *   Read after the last `)`, since the command name may hold spaces and
 *   parentheses.
 * - darwin: `ps -o lstart=`, to the second, from /bin/ps (the packaged main
 *   process has a bare PATH) in the C locale. A process that took the pid
 *   started after the crash, so a second is enough.
 * - win32: none. There is no ps, and asking PowerShell for this run's own
 *   start would hold the first window back at every launch: win32 asks,
 *   only when a live pid must be judged, when its process was created
 *   (windowsProcessCreatedAt, below).
 *
 * Null when the process is gone, the program fails, or the answer is not
 * what the OS writes; never throws.
 */

export interface ProcessStartDeps {
  execFileSync?: (file: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => string;
  readFile?: (path: string) => string;
}

const LSTART = /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
/** Field 22 of /proc/<pid>/stat, counted from the state (field 3), the first after the command's `)`. */
const STARTTIME_AFTER_COMM = 22 - 3;

const runPs = (file: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }): string =>
  nodeExecFileSync(file, args as string[], { ...opts, encoding: 'utf8', timeout: 2_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

export function processStartOf(pid: number, platform: NodeJS.Platform = process.platform, deps: ProcessStartDeps = {}): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'darwin') {
      const out = (deps.execFileSync ?? runPs)('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } }).trim();
      return LSTART.test(out) ? `darwin:${out}` : null;
    }
    if (platform === 'linux') {
      const text = (deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8')))(`/proc/${pid}/stat`);
      const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
      const start = fields[STARTTIME_AFTER_COMM];
      return start !== undefined && /^\d{1,20}$/.test(start) ? `linux:${start}` : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * When the process under a pid was created, epoch ms, on Windows: Win32_Process's
 * CreationDate. What judges a live pid in the run record there
 * (services/run-state.ts): the Tars that wrote it held its pid from its
 * creation, so a process created after the record was opened took the pid.
 *
 * Asked of the Windows PowerShell under SystemRoot (a plain absolute one, else
 * C:\Windows), never one found on the PATH, without a PowerShell 7 parent's
 * PSModulePath (child-env.ts). The pid goes in the environment, never into the
 * script, which is fixed and goes as it is (`-Command`): a base64 one
 * (`-EncodedCommand`) is what security software flags in a powershell.exe
 * command line, and here it would hide nothing (the Audit's Low on #437).
 * Synchronous, and only when a record is left open and its pid lives.
 *
 * Null when the process is gone, PowerShell fails or answers anything but a
 * whole number of milliseconds; never throws.
 */
const CREATED_SCRIPT = "$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$env:TARS_PID) -Property CreationDate; "
  + 'if ($p -and $p.CreationDate) { [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds() }';

export function windowsProcessCreatedAt(pid: number, deps: ProcessStartDeps & { env?: NodeJS.ProcessEnv } = {}): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const env = deps.env ?? process.env;
  const root = envValue(env, 'SystemRoot', 'win32');
  const systemRoot = root && isPlainAbsolute(root) ? root : 'C:\\Windows';
  const file = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const out = (deps.execFileSync ?? runPowerShell)(
      file,
      ['-NoProfile', '-NonInteractive', '-Command', CREATED_SCRIPT],
      { env: childEnv(file, { ...env, TARS_PID: String(pid) }, 'win32') },
    ).trim();
    return /^\d{1,15}$/.test(out) ? Number(out) : null;
  } catch {
    return null;
  }
}

const runPowerShell = (file: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }): string =>
  nodeExecFileSync(file, args as string[], { ...opts, encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
