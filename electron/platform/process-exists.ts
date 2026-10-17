/**
 * Whether a process of this user runs under `pid` (the run record's Tars,
 * services/run-state.ts). Signal 0 probes without signalling, on the three
 * platforms: POSIX checks the pid and the right to signal it, win32 (libuv)
 * opens the process. ESRCH: no such process. EPERM: a process of another user,
 * which is no Tars of this one.
 *
 * Only a positive whole pid is probed: kill(0, 0) signals this process's own
 * group and kill(-1, 0) every process the user owns, so either would always
 * read as live.
 */
export function processExists(pid: number, kill: typeof process.kill = process.kill): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
