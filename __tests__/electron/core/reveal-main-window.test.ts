import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];

vi.mock('electron', () => ({
  app: {
    isPackaged: true, getAppPath: () => '/mock/app/path', getPath: () => '/mock',
    focus: vi.fn((opts?: unknown) => { calls.push(`app.focus:${JSON.stringify(opts ?? null)}`); }),
  },
  BrowserWindow: vi.fn(),
  Notification: vi.fn(),
  ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

import { revealMainWindow, setMainWindow } from '../../../electron/core/window-manager';

/**
 * Bringing the main window forward (window-manager.ts revealMainWindow): what a second launch's hand-over and the
 * tray's Show Tars do (#429, the QA's L1 on its gate: removing the app's focus left every test green).
 *
 * How it fails:
 * 1. The app is not brought forward: on macOS a window's focus does not bring an app that is in the background to
 *    the front, so a second launch, made from the front, leaves the first Tars behind the app it was launched from.
 *    `app.focus({ steal: true })` does; without `steal` it does not.
 * 2. A minimized window is not restored, or a hidden one not shown, before it is focused.
 * 3. With no window (closed, destroyed), it throws, or steals the focus for nothing.
 */

function fakeWindow(minimized: boolean, destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: () => calls.push('win.restore'),
    show: () => calls.push('win.show'),
    focus: () => calls.push('win.focus'),
  };
}

beforeEach(() => {
  calls.length = 0;
});

describe('bringing the main window forward', () => {
  it('1-2. restores a minimized window, shows and focuses it, then brings the app forward with steal', () => {
    setMainWindow(fakeWindow(true) as never);
    revealMainWindow();
    expect(calls).toEqual(['win.restore', 'win.show', 'win.focus', 'app.focus:{"steal":true}']);
  });

  it('2. a window that is not minimized is shown and focused, not restored', () => {
    setMainWindow(fakeWindow(false) as never);
    revealMainWindow();
    expect(calls).toEqual(['win.show', 'win.focus', 'app.focus:{"steal":true}']);
  });

  it('3. no window, or a destroyed one: nothing done, nothing thrown', () => {
    setMainWindow(null);
    expect(() => revealMainWindow()).not.toThrow();
    setMainWindow(fakeWindow(false, true) as never);
    expect(() => revealMainWindow()).not.toThrow();
    expect(calls).toEqual([]);
  });
});
