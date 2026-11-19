import { describe, it, expect, vi } from 'vitest';
import { attachTerminalMirror, markCliLaunch, rowsSinceLaunch } from '../../../electron/core/terminal-mirror';

/**
 * The rows a CLI drew since it was launched into its terminal, at the bottom of what it drew: what a provider's
 * upOnScreen reads to say its TUI takes keys (core/agent-launch.ts, sessionUp). The Audit's L1 on #601: read from the
 * whole history (terminalText), a `│ >` left there by an earlier box read as up at once, and the task was typed
 * before kimi took keys, the very bug upOnScreen exists for.
 *
 * How it fails, written before the code (19/11):
 * 1. A row drawn before the launch (an earlier CLI's box, in the history or still on the screen) is read.
 * 2. A row higher up in what the CLI drew since (an answer quoting `│ >`) is read: only the bottom rows count.
 * 3. The box drawn since the launch, at the bottom, is not read.
 * 4. A full-screen CLI, on the alternate screen, is read from the normal one under it.
 * 5. A terminal never marked counts from its first line (a CLI spawned as the terminal itself).
 */

type FakePty = { onData: (l: (d: string) => void) => { dispose(): void }; onExit: () => { dispose(): void }; emit(d: string): void };
function fakePty(): FakePty {
  const listeners: Array<(d: string) => void> = [];
  return {
    onData: (l) => { listeners.push(l); return { dispose() {} }; },
    onExit: () => ({ dispose() {} }),
    emit: (d) => { for (const l of listeners) l(d); },
  };
}
const BOX = ' ╭──────────────╮\r\n │ >            │\r\n ╰──────────────╯\r\n Never Ask  m  ~/p\r\n';
const hasBox = (rows: string[] | undefined) => !!rows?.some((r) => /^\s*│ >/.test(r));
const mirrored = () => {
  const p = fakePty();
  attachTerminalMirror(p as never, { cols: 60, rows: 12, watchRepaint: false, label: 't' });
  return p;
};

describe('the rows a CLI drew since its launch', () => {
  it('1 and 3: an earlier box is not read; the new one is, once drawn', () => {
    const p = mirrored();
    p.emit(`$ kimi\r\n${BOX}$ `);
    markCliLaunch(p as never);
    p.emit("'kimi' --auto\r\n  Kimi Code v2.6.3\r\n  Loading...\r\n");
    expect(hasBox(rowsSinceLaunch(p as never))).toBe(false);
    p.emit(BOX);
    expect(hasBox(rowsSinceLaunch(p as never))).toBe(true);
  });

  it('2: a quote higher up in what the CLI drew is not read', () => {
    const p = mirrored();
    markCliLaunch(p as never);
    p.emit(`  answer: the box looks like\r\n │ >  this\r\n${Array.from({ length: 9 }, (_, i) => `  line ${i}`).join('\r\n')}\r\n`);
    expect(hasBox(rowsSinceLaunch(p as never))).toBe(false);
  });

  it('4: a full-screen CLI is read on its alternate screen', () => {
    const p = mirrored();
    p.emit(`$ old\r\n${BOX}$ `);
    markCliLaunch(p as never);
    p.emit('\x1b[?1049h\x1b[H  Loading...');
    expect(hasBox(rowsSinceLaunch(p as never))).toBe(false);
    p.emit(`\x1b[2J\x1b[H${BOX}`);
    expect(hasBox(rowsSinceLaunch(p as never))).toBe(true);
  });

  it('5: a terminal never marked counts from its first line', () => {
    const p = mirrored();
    p.emit(BOX);
    expect(hasBox(rowsSinceLaunch(p as never))).toBe(true);
  });

  it('no mirror, no rows', () => {
    expect(rowsSinceLaunch(undefined)).toBeUndefined();
    void vi;
  });
});
