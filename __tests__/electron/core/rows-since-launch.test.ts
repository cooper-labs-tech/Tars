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
 * The Audit's L2 on #601 (launch marker re-read), early "up" from output after the launch moving or dropping a marker:
 * 6. A CSI M on the marked row drops the marker, and a dropped marker reads as never placed: from the first line.
 * 7. Three reverse indexes at the top push the marked row off the bottom, the same.
 * 8. An alternate screen an earlier CLI left on, with its box, is read as the new CLI's.
 * 9. A reused shell whose earlier CLI left the cursor above its intact box: the rows below the mark are that box.
 * 10. What cannot be known (more written since the launch than is kept) reads as up.
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

  it('6: a CSI M on the marked row does not bring back what was before the launch', () => {
    const p = mirrored();
    p.emit(`$ old\r\n${BOX}$ `);
    markCliLaunch(p as never);
    p.emit('\x1b[M  Loading...\r\n');
    expect(hasBox(rowsSinceLaunch(p as never))).toBe(false);
  });

  it('7: three reverse indexes at the top do not bring it back either', () => {
    const p = mirrored();
    // The earlier box at the top, the launch on the last row, and three reverse indexes at the top push that row off.
    p.emit(`${BOX}\x1b[12;1H$ `);
    markCliLaunch(p as never);
    p.emit('\x1b[H\x1bM\x1bM\x1bM\x1b[12;1H  Loading...');
    expect(hasBox(rowsSinceLaunch(p as never))).toBe(false);
  });

  it('8: an alternate screen an earlier CLI left on, with its box, is not the new CLI\'s', () => {
    const p = mirrored();
    p.emit(`\x1b[?1049h\x1b[H${BOX}$ `);
    markCliLaunch(p as never);
    p.emit("'kimi' --auto\r\n  Loading...\r\n");
    expect(hasBox(rowsSinceLaunch(p as never))).toBe(false);
  });

  it('9: a reused shell with the cursor above an earlier CLI\'s intact box', () => {
    const p = mirrored();
    p.emit(`  answer\r\n${BOX}\x1b[5A`);
    markCliLaunch(p as never);
    p.emit("$ 'kimi' --auto\r\n");
    expect(hasBox(rowsSinceLaunch(p as never))).toBe(false);
  });

  it('10: more written since the launch than is kept reads as nothing, not as up', () => {
    const p = mirrored();
    markCliLaunch(p as never);
    p.emit(BOX);
    p.emit('x'.repeat(2 * 1024 * 1024));
    p.emit(BOX);
    expect(rowsSinceLaunch(p as never)).toEqual([]);
  });

  it('no mirror, no rows', () => {
    expect(rowsSinceLaunch(undefined)).toBeUndefined();
    void vi;
  });
});
