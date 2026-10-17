import { execFileSync as nodeExecFileSync } from 'child_process';
import * as fs from 'fs';

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
 * - win32: none. The single-instance lock ends a second Tars before it reads
 *   the record (core/desktop-lifecycle.ts): a live pid there is never one.
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
