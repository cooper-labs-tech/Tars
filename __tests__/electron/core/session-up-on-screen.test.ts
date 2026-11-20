import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * A CLI that sends no SessionStart and takes keys only once its TUI has drawn its field. Kimi Code 2.6.3 writes nothing
 * to disk before its first prompt (its session is made then), and its prompt box came up about 6 s after its process
 * ran (measured 19/11, under load); the conformance run typed its task the moment kimi ran, the paste was lost, and
 * delegate_task waited 200 s on a turn that never began.
 *
 * How it fails, written before the code (19/11):
 * 1. Such a CLI's session reads up the moment its process runs, and a task is typed into a TUI not yet taking keys.
 * 2. It never reads up although its field is drawn: every message would then wait out the launch (CLI_UP_MS).
 * 3. A CLI that says nothing of its screen (codex, pi) now waits for one: it must stay up at its exec, as before.
 * 4. The provider takes another screen for its field: the folder trust question, or the banner drawn before the box.
 * 5. The screen is read from the terminal's whole history (terminalText): a box an earlier CLI left there reads as up
 *    at once, and the task is typed before kimi takes keys (the Audit's L1 on #601). Only the rows drawn since the
 *    launch, at the bottom, count (terminal-mirror.ts, rowsSinceLaunch).
 *
 * Found by opencode's conformance run with a restart (the Audit's M1 on #613, 20/11), written before the code:
 * 6. What a CLI shows once it takes keys depends on its launch: opencode 1.19.6 started on a session it forks
 *    (`--session <S> --fork`, every restart's) draws its home view's bar first, then clears and draws the forked
 *    session's, about 5 s later; a task typed at the home view started a new session without the history (measured on
 *    real opencode, twice), and the reader, bound to the fork, never saw its turn. The launch's line reaches the
 *    provider (terminal-mirror.ts, launchLineOf), so opencode waits for its session's view on such a launch.
 */

const state = vi.hoisted(() => ({ running: true, screen: undefined as string[] | undefined, history: undefined as string[] | undefined, line: undefined as string | undefined }));
vi.mock('../../../electron/core/pty-manager', () => ({ ptyProcesses: new Map([['p1', { pid: 1 }]]) }));
vi.mock('../../../electron/core/agent-pty', () => ({ cliRunningIn: () => state.running }));
vi.mock('../../../electron/core/terminal-mirror', () => ({
  dialogOnScreen: () => false,
  // The whole history, an earlier CLI's box in it, and the rows drawn since the launch.
  terminalText: () => state.history ?? state.screen,
  rowsSinceLaunch: () => state.screen,
  markCliLaunch: () => undefined,
  launchLineOf: () => state.line,
}));
vi.mock('../../../electron/services/agent-truth', () => ({ lastInterruptAt: () => undefined }));

import { launchBegins, sessionStarting, resetLaunches } from '../../../electron/core/agent-launch';
import { KimiCodeProvider } from '../../../electron/providers/kimi-code-provider';

// Kimi Code 2.6.3's screen at rest in --auto, as the mirror reads it (19/11), and before its box is drawn.
const AT_REST = [
  '  Kimi Code v2.6.3',
  '',
  ' ╭──────────────────────────────────────────────────────────────╮',
  ' │ >                                                            │',
  ' ╰──────────────────────────────────────────────────────────────╯',
  ' Never Ask  stand-in-coder  ~/project            /compact compresses context when it gets long',
];
const BOOTING = ['  Kimi Code v2.6.3', '', '  Loading...'];
const TRUST = ['  Trust this folder?', '  ↑↓ navigate · Enter select · Esc exit', '', '   ❯ Trust and continue', '     Exit'];

beforeEach(() => {
  resetLaunches();
  state.running = true;
  state.screen = undefined;
  state.line = undefined;
});

describe('a session up on its screen', () => {
  it('1 and 2: a kimi session is starting until its field is drawn, and up once it is', () => {
    const agent = { id: 'k', ptyId: 'p1', provider: 'kimi-code' as const };
    launchBegins('k');
    state.screen = BOOTING;
    expect(sessionStarting(agent)).toBe(true);
    state.screen = AT_REST;
    expect(sessionStarting(agent)).toBe(false);
  });

  it('5: a box an earlier CLI left in the history does not make a kimi session up', () => {
    const agent = { id: 'k5', ptyId: 'p1', provider: 'kimi-code' as const };
    launchBegins('k5');
    state.history = [...AT_REST, '$ ', ...BOOTING];
    state.screen = BOOTING;
    expect(sessionStarting(agent)).toBe(true);
    state.history = undefined;
  });

  it('3: a codex session is up at its exec, whatever its screen', () => {
    const agent = { id: 'c', ptyId: 'p1', provider: 'codex' as const };
    launchBegins('c');
    state.screen = BOOTING;
    expect(sessionStarting(agent)).toBe(false);
  });

  it('4: kimi reads its field, never the trust question or the banner', () => {
    const p = new KimiCodeProvider();
    expect(p.upOnScreen(AT_REST)).toBe(true);
    expect(p.upOnScreen(BOOTING)).toBe(false);
    expect(p.upOnScreen(TRUST)).toBe(false);
    expect(p.upOnScreen([])).toBe(false);
  });
});

describe("a launch's own line (6)", () => {
  // opencode 1.19.6 forking a session, as the mirror read it (20/11): its home view first, then the forked session's.
  const HOME_VIEW = ['  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀', '                                    tab agents  ctrl+p commands', '        ● Tip Run /connect to add an AI provider', '  ~/project                                   1.19.6'];
  const FORK_VIEW = ['  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀', '   /home/someone/project                                    132  ctrl+p commands'];
  it('an opencode launch that forks a session is up on that session\'s view, never on its home view; a fresh one on either', () => {
    const agent = { id: 'o6', ptyId: 'p1', provider: 'opencode' as const };
    launchBegins('o6');
    state.line = "'/bin/opencode' --model 'tars-endpoint/m' --auto --session 'ses_e085d0587ffeOy1kXK0heSjjPE' --fork";
    state.screen = HOME_VIEW;
    expect(sessionStarting(agent)).toBe(true);
    state.screen = FORK_VIEW;
    expect(sessionStarting(agent)).toBe(false);

    launchBegins('o6');
    state.line = "'/bin/opencode' --model 'tars-endpoint/m' --auto";
    state.screen = HOME_VIEW;
    expect(sessionStarting(agent)).toBe(false);
  });
});
