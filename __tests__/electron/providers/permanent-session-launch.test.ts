import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { argvReached, writeArgvPrinter } from './argv-reached';

/**
 * A task given to an agent starts its permanent, interactive session (2.0.4,
 * the maintainer's decision of 2026-10-18: permanent agents, never a copy that
 * does one task and exits). Every launch with a task goes through the
 * provider's buildInteractiveCommand, so that is where a CLI's one-shot mode
 * must never be reached for.
 *
 * Each CLI's interactive form with a starting prompt, read from its own
 * `--help` on 2026-10-18: claude `-- <task>`; codex 0.x `[PROMPT]` (exec is
 * the one-shot); grok `[PROMPT]` "Initial prompt for the interactive session"
 * (`-p/--single` is the one-shot); pi 0.73 `[messages...]` (`-p/--print` is the
 * one-shot); gemini 0.64 `-i/--prompt-interactive` (a positional query ran
 * one-shot in older releases, `-p` is headless); opencode 1.19
 * `--prompt` on the TUI (`run` is the one-shot); amp has none: `-x/--execute`
 * runs once and exits, and its TUI takes a first message only from its input,
 * so the task is typed in once its CLI runs.
 *
 * Every way it can fail, written before the code:
 *  1. opencode is started as `opencode run <task>`, which exits after the task,
 *     instead of its TUI with `--prompt <task>`.
 *  2. amp is started as `amp -x <task>`, which exits after the task, or with the
 *     task anywhere on its command line.
 *  3. amp says nothing of its task being typed in, so no launch types it, and
 *     the TUI waits with no task.
 *  4. gemini gets its task as a bare query, one-shot on the releases before
 *     0.64, instead of `-i`.
 *  5. claude, codex, grok, pi or a provider that runs claude reach their
 *     one-shot flag (-p, --print, exec, --single) with a task.
 *  6. a CLI that takes its task as an argument loses it, or gets it cut.
 *  7. the task typed into amp goes in before its CLI runs (into the shell, which
 *     would run it as a command), or before its screen is up (lost).
 * 10. (Cline, 21/11; the gap #618 left for Kimi Code and Goose) a CLI that says when it is up from its own screen
 *     (CLIProvider.upOnScreen) is typed into after a fixed settle anyway: Cline drew its field 2.4 to 3.6 s after its
 *     start, idle, and on a loaded machine later still, so a task typed at 2 s is lost, or typed into its onboarding.
 *     With `up`, the task waits for it, and gives up at its bound.
 *  8. a CLI that never comes up, or is gone before its screen is, gets keys
 *     anyway, or the wait never ends.
 *  9. the task is typed more than once.
 */

const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  if (!home.dir) home.dir = mod.tmpdir();
  return { ...mod, homedir: () => home.dir };
});
let tmp: string;

const pty = vi.hoisted(() => ({ running: false, written: [] as string[] }));
vi.mock('../../../electron/core/agent-pty', async (original) => ({
  ...(await original<typeof import('../../../electron/core/agent-pty')>()),
  cliRunningIn: () => pty.running,
}));
vi.mock('../../../electron/core/pty-manager', async (original) => ({
  ...(await original<typeof import('../../../electron/core/pty-manager')>()),
  writeProgrammaticInput: (_p: unknown, data: string) => { pty.written.push(data); return 'written'; },
}));

import { getProvider } from '../../../electron/providers';
import { typeTaskWhenUp } from '../../../electron/core/typed-task';
import type { AgentProvider } from '../../../electron/types';

const TASK = 'Review the release notes, then say what is missing';
const PROVIDERS: AgentProvider[] = [
  'claude', 'codex', 'gemini', 'grok', 'opencode', 'pi', 'amp', 'openrouter', 'deepseek', 'mimo', 'moonshot',
  'qwen', 'zhipu', 'minimax', 'nvidia', 'nous-portal', 'ollama', 'venice', 'ollama-cloud', 'custom-openai',
];
/** What makes each CLI do one task and exit. */
const ONE_SHOT: Record<string, (argv: string[]) => boolean> = {
  claude: (a) => a.includes('-p') || a.includes('--print'),
  codex: (a) => a[0] === 'exec' || a[0] === 'e' || a.includes('exec'),
  gemini: (a) => a.includes('-p') || a.includes('--prompt'),
  grok: (a) => a.includes('-p') || a.includes('--single'),
  pi: (a) => a.includes('-p') || a.includes('--print'),
  opencode: (a) => a.includes('run'),
  amp: (a) => a.includes('-x') || a.includes('--execute'),
};

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-permanent-launch-')); home.dir = tmp; });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function argvOf(id: AgentProvider): string[] {
  const provider = getProvider(id);
  const bin = writeArgvPrinter(path.join(tmp, `${id}-bin`));
  return argvReached(provider.buildInteractiveCommand({ binaryPath: bin, prompt: TASK, skills: [], permissionMode: 'normal' } as never), tmp);
}

describe('a launch with a task starts the interactive session', () => {
  it.each(PROVIDERS)('%s: never its one-shot mode (1, 2, 5)', (id) => {
    const argv = argvOf(id);
    expect(ONE_SHOT[getProvider(id).binaryName](argv), argv.join(' ')).toBe(false);
  });

  it.each(PROVIDERS.filter((id) => id !== 'amp'))('%s: the task reaches the CLI whole (6)', (id) => {
    expect(argvOf(id)).toContain(TASK);
  });

  it('opencode: its TUI, with the task as --prompt (1)', () => {
    const argv = argvOf('opencode');
    expect(argv[argv.indexOf('--prompt') + 1]).toBe(TASK);
  });

  it('gemini: the task as -i, interactive on every release (4)', () => {
    const argv = argvOf('gemini');
    expect(argv[argv.indexOf('-i') + 1]).toBe(TASK);
  });

  it('amp: no task on its command line, and it says its task is typed in (2, 3)', () => {
    expect(argvOf('amp').join(' ')).not.toContain('Review the release notes');
    expect(getProvider('amp').taskTypedAfterLaunch).toBe(true);
    for (const id of PROVIDERS.filter((p) => p !== 'amp')) expect(getProvider(id).taskTypedAfterLaunch ?? false, id).toBe(false);
  });
});

describe('a task typed into a CLI once it runs', () => {
  const terminal = {} as never;

  it('waits for the CLI, then for its screen, and types the task once (7, 9)', async () => {
    pty.running = false;
    pty.written.length = 0;
    const typed = typeTaskWhenUp(terminal, TASK, { settleMs: 300, maxMs: 5_000, stepMs: 20 });
    await new Promise((r) => setTimeout(r, 200));
    expect(pty.written, 'typed before the CLI ran').toEqual([]);
    pty.running = true;
    await new Promise((r) => setTimeout(r, 120));
    expect(pty.written, 'typed before its screen was up').toEqual([]);
    expect(await typed).toBe('written');
    expect(pty.written).toEqual([TASK]);
  });

  it('types nothing to a CLI that never comes up, and gives up at its bound (8)', async () => {
    pty.running = false;
    pty.written.length = 0;
    const started = Date.now();
    expect(await typeTaskWhenUp(terminal, TASK, { settleMs: 50, maxMs: 300, stepMs: 20 })).toBe('never-up');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(pty.written).toEqual([]);
  });

  it("waits for the CLI's own word that it is up, when it has one, and gives up at its bound (10)", async () => {
    pty.running = true;
    pty.written.length = 0;
    let up = false;
    const typed = typeTaskWhenUp(terminal, TASK, { settleMs: 50, maxMs: 5_000, stepMs: 20, up: () => up });
    await new Promise((r) => setTimeout(r, 300));
    expect(pty.written, 'typed before its screen said it was up').toEqual([]);
    up = true;
    expect(await typed).toBe('written');
    expect(pty.written).toEqual([TASK]);
    pty.written.length = 0;
    expect(await typeTaskWhenUp(terminal, TASK, { settleMs: 50, maxMs: 300, stepMs: 20, up: () => false })).toBe('never-up');
    expect(pty.written).toEqual([]);
  });

  it('types nothing to a CLI gone before its screen was up (8)', async () => {
    pty.running = true;
    pty.written.length = 0;
    const typed = typeTaskWhenUp(terminal, TASK, { settleMs: 200, maxMs: 5_000, stepMs: 20 });
    await new Promise((r) => setTimeout(r, 50));
    pty.running = false;
    expect(await typed).toBe('never-up');
    expect(pty.written).toEqual([]);
  });
});
