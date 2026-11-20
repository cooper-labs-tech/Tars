import '../../setup/home-guard';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { guardUncaught } from '../../../electron/core/uncaught-guard';

/**
 * An uncaught exception in main never freezes Tars (F4 of the maintainer's go of 2026-10-18). Until 2.0.4, Electron's
 * own handler, alone, showed its modal error box ("A JavaScript error occurred in the main process"), and so did the
 * Sentry SDK's when only it and Electron's listened; the box held the main process until someone clicked it, about 5
 * minutes in the QA's run, and the maintainer met it on his screen.
 *
 * How it fails, written before the code (2026-10-19):
 * 1. Electron's handler still shows its box: it does when it is the only listener (lib/browser/init.ts), so Tars
 *    must listen too.
 * 2. The error is lost: not logged, or logged without its stack.
 * 3. Tars quits, or stops answering, after an exception it could have run past.
 * 4. A main module that did not finish loading is kept running: no window will ever open, and the process stays,
 *    unseen. It must quit (code 1), once, after a moment for the report to leave, and never restart (a start that
 *    fails would fail again, in a loop).
 * 5. A rejection Node turned into an uncaught exception (origin unhandledRejection) is not told apart, or not handled.
 * 6. The guard throws itself: on a thrown value that is not an Error, an Error with no stack, a log that throws.
 * 7. The SDK shows the box: it does after its flush unless it is given an onFatalError (or more than two listen).
 * 8. main.ts installs the guard after other modules have loaded (an exception thrown while they load is Electron's
 *    alone), or never tells it that main has loaded.
 * And from the Audit's gate of #474 (L1, written red on 106e1f41, 2026-10-19):
 * 9. An exception in app.whenReady's callback came after main had "loaded" (its module's end), so a callback that
 *    failed before it opened the window left Tars running with none, and nothing on the screen. What counts is the
 *    window: until it is open, Tars quits; and the window opens in that callback.
 * 10. A rejection of that callback, or any other, never reaches the guard while the reports are on: the SDK listens
 *    for rejections, so Node no longer turns them into exceptions. The guard listens for them itself.
 */

afterEach(() => { vi.useRealTimers(); });

/** A process, with Electron's own handler first, as lib/browser/init.ts installs it. */
function processWithElectron() {
  const proc = new EventEmitter();
  const boxes: string[] = [];
  proc.on('uncaughtException', (error: Error) => {
    if (proc.listenerCount('uncaughtException') > 1) return;
    boxes.push(`Uncaught Exception:\n${error.stack}`);
  });
  return { proc, boxes };
}

describe('an uncaught exception in main (F4)', () => {
  it('1, 2, 3. Electron shows no box, the error is logged with its stack, and Tars runs on', () => {
    const { proc, boxes } = processWithElectron();
    const lines: string[] = [];
    const quit = vi.fn();
    const guard = guardUncaught(proc as never, { log: line => lines.push(line), quit });
    guard.windowOpened();
    const error = new Error('a timer threw');
    proc.emit('uncaughtException', error, 'uncaughtException');
    expect(boxes).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('an uncaught exception');
    expect(lines[0]).toContain(error.stack);
    expect(quit).not.toHaveBeenCalled();
  });

  it('4, 9. before its window is open, Tars quits with code 1, once, after a moment for the report, and never restarts', () => {
    vi.useFakeTimers();
    const { proc, boxes } = processWithElectron();
    const lines: string[] = [];
    const quit = vi.fn();
    guardUncaught(proc as never, { log: line => lines.push(line), quit, quitAfterMs: 2_000 });
    proc.emit('uncaughtException', new Error('main.ts threw while loading'), 'uncaughtException');
    proc.emit('uncaughtException', new Error('and again'), 'uncaughtException');
    expect(quit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledWith(1);
    expect(boxes).toEqual([]);
    expect(lines.some(line => /before Tars opened its window/.test(line))).toBe(true);
  });

  it('10. a rejection, Node turning it into an exception or not, is told as one and handled the same: logged, then a quit before the window is open', () => {
    vi.useFakeTimers();
    const { proc } = processWithElectron();
    const lines: string[] = [];
    const quit = vi.fn();
    guardUncaught(proc as never, { log: line => lines.push(line), quit, quitAfterMs: 2_000 });
    // The ready callback rejected before it opened the window, the SDK listening too.
    proc.on('unhandledRejection', () => undefined);
    proc.emit('unhandledRejection', new Error('createWindow threw'), Promise.resolve());
    vi.advanceTimersByTime(2_000);
    expect(quit).toHaveBeenCalledWith(1);
    expect(lines[0]).toContain('an unhandled rejection');
    expect(lines[0]).toContain('createWindow threw');
    // After the window: run on.
    const after = processWithElectron();
    const quitAfter = vi.fn();
    guardUncaught(after.proc as never, { log: () => undefined, quit: quitAfter }).windowOpened();
    after.proc.emit('unhandledRejection', 'a string', Promise.resolve());
    vi.advanceTimersByTime(5_000);
    expect(quitAfter).not.toHaveBeenCalled();
  });

  it('5. a rejection Node turned into an exception is told as one, and handled the same', () => {
    const { proc } = processWithElectron();
    const lines: string[] = [];
    guardUncaught(proc as never, { log: line => lines.push(line), quit: vi.fn() }).windowOpened();
    proc.emit('uncaughtException', new Error('a promise nobody awaited'), 'unhandledRejection');
    expect(lines[0]).toContain('an unhandled rejection');
  });

  it('6. never throws itself', () => {
    const { proc } = processWithElectron();
    const guard = guardUncaught(proc as never, { log: () => { throw new Error('stderr closed'); }, quit: vi.fn() });
    guard.windowOpened();
    const noStack = new Error('no stack');
    noStack.stack = undefined;
    expect(() => proc.emit('uncaughtException', 'a string was thrown', 'uncaughtException')).not.toThrow();
    expect(() => proc.emit('uncaughtException', noStack, 'uncaughtException')).not.toThrow();
    expect(() => proc.emit('uncaughtException', undefined, 'uncaughtException')).not.toThrow();
  });

  it("7. the SDK is handed an onFatalError that shows nothing and quits nothing", () => {
    const { proc } = processWithElectron();
    const quit = vi.fn();
    const guard = guardUncaught(proc as never, { log: () => undefined, quit });
    guard.windowOpened();
    expect(typeof guard.onFatalError).toBe('function');
    expect(() => guard.onFatalError(new Error('after the flush'))).not.toThrow();
    expect(quit).not.toHaveBeenCalled();
  });
});

describe('main.ts (F4)', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../../electron/main.ts'), 'utf-8');
  const imports = [...main.matchAll(/^import [^;]*;$/gm)].map(m => m[0]);

  it('8. installs the guard right after the compile cache, before any other module loads', () => {
    // Only #477's sandbox guard comes before them: it exits a sandbox build before the data folder is read.
    expect(imports[0]).toBe("import { SANDBOX_BUILD } from './core/sandbox-guard';");
    expect(imports[1]).toBe("import './core/compile-cache';");
    expect(imports[2]).toMatch(/^import \{ uncaught \} from '\.\/uncaught';$/);
    const install = fs.readFileSync(path.join(__dirname, '../../../electron/uncaught.ts'), 'utf-8');
    expect(install).toMatch(/guardUncaught\(process,/);
  });

  it('8, 9. tells it when the window is open, right after createWindow in the ready callback, and hands the SDK its onFatalError', () => {
    const ready = main.slice(main.indexOf('app.whenReady().then('));
    expect(ready).toMatch(/\n {2}createWindow\(\);\n {2}uncaught\.windowOpened\(\);/);
    expect(main.match(/uncaught\.windowOpened\(\)/g)).toHaveLength(1);
    expect(main).not.toMatch(/mainLoaded/);
    expect(main).toMatch(/startErrorReports\(\(\) => appSettings\.errorReportsEnabled === true, [^;]*onFatalError: uncaught\.onFatalError/s);
  });
});
