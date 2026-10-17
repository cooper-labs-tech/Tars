import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The Windows app lifecycle, installed on Windows and nowhere else
 * (desktop-lifecycle.ts): the close to the tray, no menu. And one instance per
 * profile, on every platform (the maintainer's parity rule of 2026-10-16).
 *
 * How it fails, written before the session-end code (2026-09-26; the rest of
 * the file was already there, and a mutant removing the win32 gate from the
 * menu call survived every test):
 * 1. darwin/linux: the application menu is removed (on macOS that is Cmd+Q,
 *    Cmd+C, Cmd+V and every Edit command), an AppUserModelId is set, or a
 *    close, before-quit or session-end listener is added: any of these changes
 *    a Mac or Linux user's app.
 * 2. win32: any of those is missing: the default menu's Ctrl+W still kills
 *    every agent, toasts have no owner, a second launch starts a second Tars,
 *    or a close quits.
 * 3. win32: a close while Tars runs is not turned into a hide; or a close
 *    after before-quit (the tray's Quit Tars, the updater, a test harness)
 *    is still turned into one, and the app never ends.
 * 4. win32, session end: Windows logs off, shuts down or restarts. The window
 *    hides on close, so this is now the usual way Tars ends, and Electron
 *    emits no before-quit then, only the window's `session-end`. The shutdown
 *    steps (flush the bus, save the fleet, end the ACP runs, kill every
 *    terminal) must run there, synchronously, before the handler returns:
 *    Windows ends the process right after. And the closes that follow must
 *    close.
 * 5. The shutdown steps run twice for one session end, or are a second list
 *    beside main.ts's before-quit one, which the next step added there would
 *    miss: by default the session end runs the app's before-quit listeners.
 * And from the parity rule (the Audit's G1, PARITY-NEX-1610.md):
 * 6. darwin/linux take no single-instance lock: a second Tars on the same
 *    profile (Linux: any second launch; macOS: open -n, a second copy, a dev
 *    run) runs beside the first, starts its own terminals, and on quit saves
 *    its fleet over agents.json, losing what the first changed.
 * 7. On any platform, a second launch whose lock is refused goes on (reports
 *    true), or the first is not brought forward when it happens.
 * And Linux (2.0.4, parity P2, the Audit's G6 and G4; 1 narrowed to darwin):
 * 8. linux keeps the default menu bar, or sets an AppUserModelId or listens
 *    for session-end, which are Windows's.
 * 9. linux closes while its tray is shown (the agents end with the window),
 *    hides while none is, or keeps hiding once before-quit has run.
 */

const calls: string[] = [];
const appListeners = new Map<string, (() => void)[]>();

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: vi.fn(() => { calls.push('requestSingleInstanceLock'); return true; }),
    setAppUserModelId: vi.fn(() => calls.push('setAppUserModelId')),
    on: vi.fn((event: string, fn: () => void) => {
      calls.push(`app.on:${event}`);
      appListeners.set(event, [...(appListeners.get(event) ?? []), fn]);
    }),
    quit: vi.fn(() => calls.push('app.quit')),
    emit: vi.fn((event: string) => {
      calls.push(`app.emit:${event}`);
      for (const fn of appListeners.get(event) ?? []) fn();
      return true;
    }),
  },
  Menu: { setApplicationMenu: vi.fn(() => calls.push('setApplicationMenu')) },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
  ipcMain: { handle: vi.fn() },
}));

type Listener = (event?: { preventDefault(): void }) => void;

function fakeWindow() {
  const listeners = new Map<string, Listener[]>();
  const win = {
    hidden: 0,
    on: (event: string, fn: Listener) => {
      calls.push(`win.on:${event}`);
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
    hide: () => { win.hidden++; },
    isDestroyed: () => false,
    emit: (event: string) => {
      let prevented = false;
      for (const fn of listeners.get(event) ?? []) fn({ preventDefault: () => { prevented = true; } });
      return prevented;
    },
  };
  return win;
}

async function load() {
  vi.resetModules();
  return import('../../../electron/core/desktop-lifecycle');
}

const explained = { explained: () => true, markExplained: () => {} };

const HOST = process.platform;
/** claimSingleInstance reads no platform: each case says which one it stands for. */
const onPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true });

beforeEach(() => {
  calls.length = 0;
  appListeners.clear();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: HOST, configurable: true });
});

describe('darwin: the lock, and nothing else of the Windows lifecycle', () => {
  it('darwin: the lock and the hand-over; no menu change, no AUMID, no window listener', async () => {
    const { installDesktopShell, claimSingleInstance } = await load();
    const win = fakeWindow();
    const shutdown = vi.fn();
    onPlatform('darwin');
    expect(claimSingleInstance(() => {})).toBe(true);
    installDesktopShell({
      getMainWindow: () => win as never, explanation: explained, onSessionEnd: shutdown, platform: 'darwin', trayShown: () => true,
    });
    expect(calls).toEqual(['requestSingleInstanceLock', 'app.on:second-instance']);
    expect(shutdown).not.toHaveBeenCalled();
  });
});

describe('linux: no menu bar, and a close that hides to a tray that is shown', () => {
  it('8. removes the menu and listens for a quit and a close; no AUMID, no session-end', async () => {
    const { installDesktopShell } = await load();
    const win = fakeWindow();
    installDesktopShell({ getMainWindow: () => win as never, explanation: explained, platform: 'linux', trayShown: () => true });
    expect(calls).toEqual(['setApplicationMenu', 'app.on:before-quit', 'win.on:close']);
  });

  it('9. hides while its tray is shown, closes while none is, and closes once before-quit has run', async () => {
    const { installDesktopShell } = await load();
    const win = fakeWindow();
    let shown = false;
    installDesktopShell({ getMainWindow: () => win as never, explanation: explained, platform: 'linux', trayShown: () => shown });
    expect(win.emit('close'), 'no tray: a close').toBe(false);
    shown = true;
    expect(win.emit('close'), 'a tray: a hide').toBe(true);
    expect(win.hidden).toBe(1);
    for (const fn of appListeners.get('before-quit') ?? []) fn();
    expect(win.emit('close'), 'quitting').toBe(false);
    expect(win.hidden).toBe(1);
  });
});

describe('one Tars per profile, on every platform', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    it(`${platform}: a second launch is refused the lock and says so; the first is brought forward`, async () => {
      const { claimSingleInstance } = await load();
      const { app } = await import('electron');
      const reveal = vi.fn();
      onPlatform(platform);
      vi.mocked(app.requestSingleInstanceLock).mockReturnValueOnce(false);
      expect(claimSingleInstance(reveal), 'the second').toBe(false);
      expect(calls).not.toContain('app.on:second-instance');
      calls.length = 0;
      expect(claimSingleInstance(reveal), 'the first').toBe(true);
      app.emit('second-instance');
      expect(reveal).toHaveBeenCalledTimes(1);
    });
  }
});

describe('win32', () => {
  it('takes the lock, sets the AUMID, removes the menu, and listens for the end', async () => {
    const { installDesktopShell, claimSingleInstance } = await load();
    const win = fakeWindow();
    onPlatform('win32');
    expect(claimSingleInstance(() => {})).toBe(true);
    installDesktopShell({ getMainWindow: () => win as never, explanation: explained, onSessionEnd: () => {}, platform: 'win32' });
    for (const c of ['requestSingleInstanceLock', 'app.on:second-instance', 'setAppUserModelId', 'setApplicationMenu',
      'app.on:before-quit', 'win.on:close', 'win.on:session-end']) {
      expect(calls, c).toContain(c);
    }
  });

  it('hides on close while Tars runs, closes once before-quit has run', async () => {
    const { installDesktopShell } = await load();
    const win = fakeWindow();
    installDesktopShell({ getMainWindow: () => win as never, explanation: explained, onSessionEnd: () => {}, platform: 'win32' });
    expect(win.emit('close')).toBe(true);
    expect(win.hidden).toBe(1);
    for (const fn of appListeners.get('before-quit') ?? []) fn();
    expect(win.emit('close')).toBe(false);
    expect(win.hidden).toBe(1);
  });

  it('runs the shutdown steps at session end, once, synchronously, and lets the closes through', async () => {
    const { installDesktopShell } = await load();
    const win = fakeWindow();
    const shutdown = vi.fn();
    installDesktopShell({ getMainWindow: () => win as never, explanation: explained, onSessionEnd: shutdown, platform: 'win32' });
    win.emit('session-end');
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(win.emit('close')).toBe(false);
    win.emit('session-end');
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("by default runs the app's own before-quit listeners at session end", async () => {
    const { installDesktopShell } = await load();
    const win = fakeWindow();
    const quitSteps = vi.fn();
    appListeners.set('before-quit', [quitSteps]);
    installDesktopShell({ getMainWindow: () => win as never, explanation: explained, platform: 'win32' });
    win.emit('session-end');
    expect(calls.filter(c => c === 'app.emit:before-quit')).toHaveLength(1);
    expect(quitSteps).toHaveBeenCalledTimes(1);
    expect(win.emit('close')).toBe(false);
  });
});
