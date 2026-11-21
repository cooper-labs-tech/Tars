import type * as pty from 'node-pty';
import { cliRunningIn } from './agent-pty';
import { writeProgrammaticInput, type WriteOutcome } from './pty-manager';
import type { CLIProvider, InteractiveCommandParams } from '../providers/cli-provider';
import { launchLineOf, rowsSinceLaunch } from './terminal-mirror';

/**
 * A task typed into a CLI that takes none on its command line (amp: its only
 * way is `-x`, which runs once and exits, and its TUI takes a first message
 * from its input alone). The agent's permanent session is started bare, and
 * the task goes in like any message, once the CLI runs in its terminal (typed
 * earlier, it would reach the shell, which runs it as a command) and its
 * screen has had time to come up (keys sent to a TUI still starting are lost).
 */

/** How long a TUI is given to draw itself once its process runs. */
export const TUI_SETTLE_MS = 2_000;
/** How long a CLI is given to start at all, as a launch is (agent-launch.ts, CLI_BOOT_MS). */
export const CLI_START_MS = 15_000;
/**
 * How long a CLI that says from its own screen when it is up (CLIProvider.upOnScreen) is given to say it: Kilo drew
 * its bar 13 to 47 s after its start on a loaded machine (20/11).
 */
export const CLI_UP_MS = 60_000;

export async function typeTaskWhenUp(
  ptyProcess: pty.IPty,
  task: string,
  opts: { settleMs?: number; maxMs?: number; stepMs?: number; up?: () => boolean } = {},
): Promise<WriteOutcome | 'never-up'> {
  const step = opts.stepMs ?? 200;
  const until = Date.now() + (opts.maxMs ?? CLI_START_MS);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (!cliRunningIn(ptyProcess)) {
    if (Date.now() >= until) return 'never-up';
    await sleep(step);
  }
  // Up by its own screen, when it says (CLIProvider.upOnScreen): its field drawn, where keys are taken. A fixed settle
  // alone typed into Cline before its field, or into its onboarding.
  if (opts.up) {
    while (!opts.up()) {
      if (Date.now() >= until || !cliRunningIn(ptyProcess)) return 'never-up';
      await sleep(step);
    }
  }
  // Up, then given its settle time, and still up at its end.
  const settled = Date.now() + (opts.settleMs ?? TUI_SETTLE_MS);
  while (Date.now() < settled) {
    await sleep(Math.min(step, settled - Date.now()));
    if (!cliRunningIn(ptyProcess)) return 'never-up';
  }
  return writeProgrammaticInput(ptyProcess, task, true);
}

/**
 * Every launch with a task calls this once its CLI's terminal is known: for a
 * CLI whose command carries no task (taskTypedAfterLaunch), the task is typed
 * in once it runs; for every other CLI, nothing.
 */
export function typeLaunchTask(
  provider: Pick<CLIProvider, 'id' | 'taskTypedAfterLaunch' | 'typedTask' | 'upOnScreen'>,
  ptyProcess: pty.IPty,
  params: Pick<InteractiveCommandParams, 'prompt' | 'skills' | 'isSuperAgent'>,
): void {
  if (!provider.taskTypedAfterLaunch) return;
  const text = provider.typedTask?.(params) ?? '';
  if (!text) return;
  // A CLI that says when it is up from its own screen is typed into once it says so, read as the launch reads it
  // (agent-launch.ts, sessionUp): the rows drawn since its launch, with its line.
  const up = provider.upOnScreen
    ? { up: () => provider.upOnScreen!(rowsSinceLaunch(ptyProcess) ?? [], launchLineOf(ptyProcess)), maxMs: CLI_UP_MS }
    : {};
  void typeTaskWhenUp(ptyProcess, text, up).then((outcome) => {
    if (outcome === 'never-up' || outcome === 'refused') console.warn(`[launch] ${provider.id}: the task was not typed in (${outcome})`);
  });
}
