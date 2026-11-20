import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A CLI that sends no SessionStart and takes keys only once its TUI has drawn its field. Kimi Code 2.6.3 writes nothing
 * to disk before its first prompt (its session is made then), and its prompt box came up about 6 s after its process
 * ran (measured 19/11, under load); the conformance run typed its task the moment kimi ran, the paste was lost, and
 * delegate_task waited 200 s on a turn that never began.
 *
 * How it fails, written before the code (19/11):
 * 1. Such a CLI's session reads up the moment its process runs, and a task is typed into a TUI not yet taking keys.
 * 2. It never reads up although its field is drawn: every message would then wait out the launch (CLI_UP_MS).
 * 3. A CLI that says nothing of its screen (codex) now waits for one: it must stay up at its exec, as before.
 * 4. The provider takes another screen for its field: the folder trust question, or the banner drawn before the box.
 * 5. The screen is read from the terminal's whole history (terminalText): a box an earlier CLI left there reads as up
 *    at once, and the task is typed before kimi takes keys (the Audit's L1 on #601). Only the rows drawn since the
 *    launch, at the bottom, count (terminal-mirror.ts, rowsSinceLaunch).
 *
 * Found by Pi's harness conformance run (20/11, Pi 1.5.2), written before the code:
 * 6. Pi is the same kind of CLI: no SessionStart, and keys typed before its TUI runs are lost. Read as up at its exec,
 *    a delegated task was typed while Pi was still starting (on a first run it downloads fd first): the shell's line
 *    discipline echoed the paste, Pi came up with an empty field, and delegate_task waited 200 s on a turn that never
 *    began. A pi session is up once its footer is drawn, the context used over its window (`0.0%/128k (auto)`, or
 *    `?/200k` when the share is unknown), never on its command line, the text typed ahead, or a line of its banner.
 * 7. Pi draws its footer before its startup ends: it first fetches fd and ripgrep when they are missing, and until
 *    then takes text but answers Enter with "Startup is still in progress", keeping the task unsent (its
 *    interactive-mode.js, the conformance run's second try). Up only once every download it announced
 *    (`<tool> not found. Downloading...`) has its outcome (`<tool> installed to ...`, or `Failed to download <tool>`).
 * 8. Pi's first frame holds its footer alone: its banner and its download line come together in the next, 20 to 70 ms
 *    later (measured three times on fresh starts, 20/11). Read on that first frame, the footer made pi up, the task
 *    went in, and its Enter met the download (the conformance run's fourth try). Up only once the banner's hint line
 *    is drawn too (`/ commands` and `! bash`, whatever keys the user bound), or at once when the user's pi starts
 *    quietly (`quietStartup: true` in its settings.json), which draws no banner at all.
 */

const state = vi.hoisted(() => ({ running: true, screen: undefined as string[] | undefined, history: undefined as string[] | undefined }));
vi.mock('../../../electron/core/pty-manager', () => ({ ptyProcesses: new Map([['p1', { pid: 1 }]]) }));
vi.mock('../../../electron/core/agent-pty', () => ({ cliRunningIn: () => state.running }));
vi.mock('../../../electron/core/terminal-mirror', () => ({
  dialogOnScreen: () => false,
  // The whole history, an earlier CLI's box in it, and the rows drawn since the launch.
  terminalText: () => state.history ?? state.screen,
  rowsSinceLaunch: () => state.screen,
  markCliLaunch: () => undefined,
}));
vi.mock('../../../electron/services/agent-truth', () => ({ lastInterruptAt: () => undefined }));

import { launchBegins, sessionStarting, resetLaunches } from '../../../electron/core/agent-launch';
import { KimiCodeProvider } from '../../../electron/providers/kimi-code-provider';
import { PiProvider } from '../../../electron/providers/pi-provider';

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

// Pi 1.5.2's terminal in the conformance run of 20/11: its line, then the task typed ahead and echoed by the shell's
// line discipline (Pi not running yet), then its TUI drawn with its field and footer.
const PI_TYPED_AHEAD = [
  "Mac:project-a you$ cd '/tmp/e2e/projects/project-a' && '/tmp/pi/bin/pi' '--provider' 'tars-endpoint' --model 'stand-in-coder'",
  '^[[200~Message from agent "Lead" ("dddd4444-0000-4000-8000-0000000000c1"), task t-128755ff: ',
  '^[[201~^[[200~Run the shell command that prints the probe marker, then tell me what it printed.^[[201~',
];
const PI_BANNER = [' ▀▀█ v1.5.2', ' █▀ █ escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more'];
const PI_AT_REST = [
  ...PI_BANNER,
  ' Press ctrl+o to show full startup help and loaded resources.',
  ' fd not found. Downloading...',
  ' fd installed to /tmp/e2e/.pi/agent/bin/fd',
  '────────────────────────────────────────────────────────────────────────',
  '',
  '────────────────────────────────────────────────────────────────────────',
  '~/projects/project-a (main)',
  '0.0%/128k (auto)                                              stand-in-coder',
];

beforeEach(() => {
  resetLaunches();
  state.running = true;
  state.screen = undefined;
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

  it('6: a pi session is starting until its footer is drawn, and up once it is', () => {
    const agent = { id: 'pi6', ptyId: 'p1', provider: 'pi' as const };
    launchBegins('pi6');
    state.screen = PI_TYPED_AHEAD;
    expect(sessionStarting(agent)).toBe(true);
    state.screen = [...PI_TYPED_AHEAD, ...PI_BANNER];
    expect(sessionStarting(agent)).toBe(true);
    state.screen = [...PI_TYPED_AHEAD, ...PI_AT_REST];
    expect(sessionStarting(agent)).toBe(false);
  });

  it('6: pi reads its footer in each form it writes, never its line, the text typed ahead or its banner', () => {
    const p = new PiProvider();
    expect(p.upOnScreen(PI_AT_REST)).toBe(true);
    for (const footer of ['12.3%/200k', '?/200k (auto)', '0.0%/512', '98.1%/1.0M', '7.0%/12M (auto)       claude-x  $0.012']) {
      expect(p.upOnScreen([...PI_BANNER, '', footer]), footer).toBe(true);
    }
    expect(p.upOnScreen(PI_TYPED_AHEAD)).toBe(false);
    expect(p.upOnScreen(PI_BANNER)).toBe(false);
    expect(p.upOnScreen(['  Run it at 100%/4 speed, see https://x.dev/a?/b'])).toBe(false);
    expect(p.upOnScreen([])).toBe(false);
  });

  it('7: pi is not up while a tool it announced is still downloading, and up once each has its outcome', () => {
    const p = new PiProvider();
    const footer = ['────────', '', '────────', '~/projects/project-a (main)', '0.0%/128k (auto)      stand-in-coder'];
    const fd = ' fd not found. Downloading...';
    const rg = ' ripgrep not found. Downloading...';
    expect(p.upOnScreen([...PI_BANNER, fd, ...footer])).toBe(false);
    expect(p.upOnScreen([...PI_BANNER, fd, ' Startup is still in progress', rg, ' fd installed to /h/.pi/agent/bin/fd', ...footer])).toBe(false);
    expect(p.upOnScreen([...PI_BANNER, fd, ' fd installed to /h/.pi/agent/bin/fd', ...footer])).toBe(true);
    expect(p.upOnScreen([...PI_BANNER, fd, rg, ' fd installed to /h/.pi/agent/bin/fd', ' Warning: Failed to download ripgrep: fetch failed', ...footer])).toBe(true);
    expect(p.upOnScreen([...PI_BANNER, ' Warning: fd not found. Offline mode enabled, skipping download.', ...footer])).toBe(true);
  });

  it("8: pi's first frame, its footer alone, is not up; the frame with its banner is, under any keys", () => {
    const was = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-pi-agent-'));
    try {
      const p = new PiProvider();
      const footer = ['────────', '', '────────', '~/projects/project-a (main)', '0.0%/128k (auto)      stand-in-coder'];
      expect(p.upOnScreen(footer)).toBe(false);
      expect(p.upOnScreen([...PI_BANNER, ...footer])).toBe(true);
      expect(p.upOnScreen([' ▀▀█ v1.5.2', ' █▀ █ ctrl+x interrupt · ctrl+c/ctrl+q clear/exit · / commands · ! bash · ctrl+o more', ...footer])).toBe(true);
      // A pi that starts quietly draws no banner: its footer is enough, once nothing it announced is still downloading.
      fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ quietStartup: true }));
      expect(p.upOnScreen(footer)).toBe(true);
      expect(p.upOnScreen([' fd not found. Downloading...', ...footer])).toBe(false);
    } finally {
      if (was === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = was;
    }
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
