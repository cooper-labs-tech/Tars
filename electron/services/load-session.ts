import { isUnsafePathSegment } from '../platform/windows-names';

/**
 * What a load task's session is given (trace feature C3, part 2): the branch of its worktree, and the environment that
 * blocks every push from it.
 *
 * The push block goes through the session's environment alone, never the shared git config and never a hook (the
 * orchestrator's rule): git reads `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` as config given on
 * the command line, and `url.<base>.pushInsteadOf` with an empty value matches every URL, so a push to a named remote
 * or to a URL goes to the helper `tars-load-push-blocked`, which does not exist, and fails. A fetch is not rewritten.
 * Measured on 27/11 against a bare repository (load-session.test.ts).
 */

const BLOCK_KEY = 'url.tars-load-push-blocked://.pushInsteadOf';

/** The variables that block every push, after the GIT_CONFIG entries the environment already has. */
export function pushBlockEnv(env: Record<string, string | undefined>): Record<string, string> {
  const raw = env.GIT_CONFIG_COUNT;
  // A count git would refuse makes every git command fail: ours replaces it.
  const n = raw !== undefined && /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
  return { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: BLOCK_KEY, [`GIT_CONFIG_VALUE_${n}`]: '' };
}

/**
 * The branch of one arrival of a task: `load/<run>/<task id>-<n>`, one per arrival, since a task may run more than once
 * in a window, at once even (its max_runs). The task id is made a single segment the worktree guard takes
 * (utils/worktree-path.ts) on every system: any character but letters, digits, `.`, `_` and `-` becomes `-`, runs of
 * dots become one `-`, it starts with a letter or a digit, and it holds at most 80 characters.
 */
export function loadBranchOf(runId: string, taskId: string, n: number): string {
  let id = taskId.normalize('NFC').replace(/[^A-Za-z0-9._-]/g, '-').replace(/\.{2,}/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 80);
  if (!id || isUnsafePathSegment(`${id}-${n}`, 'win32')) id = `t-${id}`;
  return `load/${runId}/${id}-${n}`;
}
