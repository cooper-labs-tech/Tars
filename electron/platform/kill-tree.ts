import { execFile as nodeExecFile } from 'child_process';
import * as path from 'path';
import type { Env } from './fs-probe';
import { envValue } from './path-env';

/**
 * End a process and every process under it.
 *
 * win32: `taskkill /PID <pid> /T /F`, by its absolute path under
 * %SystemRoot%\System32 (never looked up on the PATH, where an agent's project
 * could plant one), with an argv. `child.kill()` there ends the root only:
 * `node npx-cli.js` > adapter > claude.exe > tool shells survive it.
 *
 * darwin/linux: nothing runs, the answer is `not-win32`. The callers keep the
 * process-group kill they have today (acp/client.ts `process.kill(-pid)`,
 * with its `ps` walk); nothing here changes it.
 */

export type KillTreeResult = { outcome: 'killed' } | { outcome: 'already-gone' } | { outcome: 'not-win32' };

export type KillTreeErrorCode = 'invalid-pid' | 'taskkill-failed';

export class KillTreeError extends Error {
  constructor(readonly code: KillTreeErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'KillTreeError';
  }
}

export interface KillTreeDeps {
  /** Resolves on exit 0, rejects like child_process.execFile (err.code: exit code or errno). */
  execFile(file: string, args: string[]): Promise<void>;
  env?: Env;
  /** How long taskkill may take before it is said to have failed (TASKKILL_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * How long taskkill may take. A stop, a removal and a replaced terminal's end wait for it, and while a replaced one
 * ends, every sender waits too (endReplacedTerminal, core/agent-launch.ts): with no bound, a taskkill that never
 * returned held a bot for good and the window's save never answered (the Audit's L1 on #621). Past it, the failure
 * is said and the caller closes the console all the same, as for any other failure of taskkill.
 */
export const TASKKILL_TIMEOUT_MS = 10_000;

/** taskkill's exit code when no process has that PID, whatever the language of its message. */
const TASKKILL_NOT_FOUND = 128;

const realDeps: KillTreeDeps = {
  // The same bound on the process itself: a taskkill given up on is not left running.
  execFile: (file, args) => new Promise((resolve, reject) => {
    nodeExecFile(file, args, { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS, killSignal: 'SIGKILL' }, (err) => (err ? reject(err) : resolve()));
  }),
};

export async function killTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  deps: KillTreeDeps = realDeps,
): Promise<KillTreeResult> {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new KillTreeError('invalid-pid', `Not a process id: ${String(pid)}`);
  }
  if (platform !== 'win32') return { outcome: 'not-win32' };

  const systemRoot = envValue(deps.env ?? process.env, 'SystemRoot', 'win32') || 'C:\\Windows';
  const taskkill = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
  const bound = deps.timeoutMs ?? TASKKILL_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`it did not end within ${bound} ms`)), bound);
  });
  try {
    // Raced, so taskkill's own end after the bound is handled: never an unhandled rejection in the main process.
    await Promise.race([deps.execFile(taskkill, ['/PID', String(pid), '/T', '/F']), late]);
    return { outcome: 'killed' };
  } catch (err) {
    if ((err as { code?: unknown }).code === TASKKILL_NOT_FOUND) return { outcome: 'already-gone' };
    throw new KillTreeError('taskkill-failed', `taskkill /PID ${pid} /T /F failed: ${err instanceof Error ? err.message : String(err)}`, err);
  } finally {
    clearTimeout(timer);
  }
}
