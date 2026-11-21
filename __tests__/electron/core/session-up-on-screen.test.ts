import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * A CLI that sends no SessionStart and takes keys only once its TUI has drawn its field. Kimi Code 2.6.3 writes nothing
 * to disk before its first prompt (its session is made then), and its prompt box came up about 6 s after its process
 * ran (measured 19/11, under load); the conformance run typed its task the moment kimi ran, the paste was lost, and
 * delegate_task waited 200 s on a turn that never began.
 *
 * How it fails, written before the code (19/11):
 * 1. Such a CLI's session reads up the moment its process runs, and a task is typed into a TUI not yet taking keys.
 * 2. It never reads up although its field is drawn: every message would then wait out the launch (CLI_UP_MS).
 * 3. A CLI that says nothing of its screen (codex, pi) now waits for one: it must stay up at its exec (once its exec
 *    has held the terminal, failure 7), whatever its screen.
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
 *
 * And at its exec, written before the code (21/11, QA's gate of the stack under #613: codex's restart step red):
 * 7. The launch line reaches the CLI through steps, and one of them can bear the shell's own name: `env CODEX_HOME=...
 *    codex fork ...`, then `#!/usr/bin/env node` finds a `#!/bin/sh` relay for node (the e2e sandbox's, an asdf or
 *    nodenv shim in bash), then node, then codex. Read at `env`, the session reads up; a message sent in that moment
 *    reads the relay's `bash` in the foreground 8 ms later, takes it for the agent's shell (cliRunningIn goes by the
 *    name), and starts a new session over the launch, without the conversation (traced in the app: up at +513 ms on
 *    `env`, the dispatch at +521 ms on `bash`). A CLI with no SessionStart reads up once it has held the terminal for
 *    CLI_SETTLED_MS, not at the first read that is not the shell.
 * 8. A read of the shell inside that time does not start it again, and the session reads up while the line is still
 *    on its way through a shim of a few hundred milliseconds.
 * 9. The window never closes, or a CLI with a surer sign waits on it too: claude (its SessionStart), kimi (its field
 *    drawn, case 1).
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

import { launchBegins, sessionStarting, resetLaunches, CLI_SETTLED_MS } from '../../../electron/core/agent-launch';
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
    vi.useFakeTimers({ now: new Date('2026-11-21T10:00:00.000Z') });
    try {
      const agent = { id: 'c', ptyId: 'p1', provider: 'codex' as const };
      launchBegins('c');
      state.screen = BOOTING;
      sessionStarting(agent);
      vi.advanceTimersByTime(CLI_SETTLED_MS);
      expect(sessionStarting(agent)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('read at a step of its launch line (7 to 9)', () => {
    beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-21T10:00:00.000Z') }); });
    afterEach(() => { vi.useRealTimers(); });

    it('7: a codex restart read at `env` is still starting through the relay\'s `bash`, and up once codex has held the terminal', () => {
      const agent = { id: 'c6', ptyId: 'p1', provider: 'codex' as const };
      launchBegins('c6');
      vi.advanceTimersByTime(513);
      state.running = true; // env
      expect(sessionStarting(agent)).toBe(true);
      vi.advanceTimersByTime(8);
      state.running = false; // the #!/bin/sh relay, exec'd into bash: the shell's name
      expect(sessionStarting(agent)).toBe(true);
      vi.advanceTimersByTime(40);
      state.running = true; // node, then codex
      expect(sessionStarting(agent)).toBe(true);
      vi.advanceTimersByTime(CLI_SETTLED_MS - 1);
      expect(sessionStarting(agent)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(sessionStarting(agent)).toBe(false);
    });

    it('8: a read of the shell inside the window starts it again, through a shim of a few hundred milliseconds', () => {
      const agent = { id: 'c7', ptyId: 'p1', provider: 'codex' as const };
      launchBegins('c7');
      state.running = true; // env
      expect(sessionStarting(agent)).toBe(true);
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersByTime(100);
        state.running = false; // an asdf shim in bash, 400 ms
        expect(sessionStarting(agent)).toBe(true);
      }
      vi.advanceTimersByTime(100);
      state.running = true; // node
      expect(sessionStarting(agent)).toBe(true);
      vi.advanceTimersByTime(CLI_SETTLED_MS - 1);
      expect(sessionStarting(agent)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(sessionStarting(agent)).toBe(false);
    });

    it('9: the window closes by itself, read or not in between, and claude waits on its SessionStart alone', () => {
      const codex = { id: 'c8', ptyId: 'p1', provider: 'codex' as const };
      launchBegins('c8');
      expect(sessionStarting(codex)).toBe(true);
      vi.advanceTimersByTime(CLI_SETTLED_MS);
      expect(sessionStarting(codex)).toBe(false);

      launchBegins('cl');
      vi.advanceTimersByTime(5);
      const claude = { id: 'cl', ptyId: 'p1', provider: 'claude' as const, sessionRegisteredAt: new Date().toISOString() };
      expect(sessionStarting(claude)).toBe(false);
    });
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
