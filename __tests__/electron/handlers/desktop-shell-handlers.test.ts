import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The renderer's two calls into the Windows desktop shell, through the real
 * handlers (desktop-shell-handlers.ts).
 *
 * How it fails, written before the handlers took the platform as an argument:
 * 1. darwin/linux: `desktop:setTitleBarOverlay` acts on the window, which has
 *    no overlay there, or `desktop:detectShells` offers shells there. Until
 *    2.0.4: since the parity program's P3 (2026-10-17) it offers the login
 *    shells there, each keyed by its absolute path and named by its shell,
 *    and fails by offering none, or what is not one.
 * 2. win32: a call from another window's contents (the tray panel, any page
 *    loaded in another window) recolours the main window's caption buttons.
 * 3. win32: with no main window, or a destroyed one, the call throws instead
 *    of refusing.
 * 4. win32: colours that are not two `#rrggbb` reach the native call.
 * 5. win32: the main window's own contents with two colours get nothing, or
 *    a band of another height than the window was made with.
 */

const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, fn); } },
}));

import { registerDesktopShellHandlers } from '../../../electron/handlers/desktop-shell-handlers';
import { TITLE_BAR_OVERLAY_HEIGHT } from '../../../electron/platform/desktop-shell';

function fakeWindow() {
  const set: unknown[] = [];
  const win = {
    webContents: { id: 'main' },
    destroyed: false,
    isDestroyed: () => win.destroyed,
    setTitleBarOverlay: (o: unknown) => { set.push(o); },
  };
  return { win, set };
}

const COLOURS = { color: '#121212', symbolColor: '#F5F4F2' };

function register(platform: NodeJS.Platform, win: ReturnType<typeof fakeWindow>['win'] | null) {
  handlers.clear();
  registerDesktopShellHandlers({ getMainWindow: () => win as unknown as Electron.BrowserWindow | null, platform });
  return {
    overlay: (sender: unknown, colours: unknown) => handlers.get('desktop:setTitleBarOverlay')!({ sender }, colours) as { success: boolean; error?: string },
    shells: () => handlers.get('desktop:detectShells')!({}),
  };
}

beforeEach(() => handlers.clear());

describe('desktop:setTitleBarOverlay', () => {
  it.each(['darwin', 'linux'] as const)('1. refuses on %s, and leaves the window alone', (platform) => {
    const { win, set } = fakeWindow();
    const r = register(platform, win).overlay(win.webContents, COLOURS);
    expect(r.success).toBe(false);
    expect(set).toEqual([]);
  });

  it('2. refuses a call from another window\'s contents', () => {
    const { win, set } = fakeWindow();
    const r = register('win32', win).overlay({ id: 'tray-panel' }, COLOURS);
    expect(r.success).toBe(false);
    expect(set).toEqual([]);
  });

  it('3. refuses, without throwing, when there is no main window or it is destroyed', () => {
    expect(register('win32', null).overlay({ id: 'main' }, COLOURS).success).toBe(false);
    const { win, set } = fakeWindow();
    win.destroyed = true;
    expect(register('win32', win).overlay(win.webContents, COLOURS).success).toBe(false);
    expect(set).toEqual([]);
  });

  it('4. refuses colours that are not two #rrggbb', () => {
    const { win, set } = fakeWindow();
    const { overlay } = register('win32', win);
    for (const bad of [null, 'x', { color: '#121212' }, { color: 'red', symbolColor: '#ffffff' }, { color: '#12121', symbolColor: '#ffffff' }]) {
      expect(overlay(win.webContents, bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(set).toEqual([]);
  });

  it('5. sets the main window\'s buttons, in the band the window was made with', () => {
    const { win, set } = fakeWindow();
    expect(register('win32', win).overlay(win.webContents, COLOURS)).toEqual({ success: true });
    expect(set).toEqual([{ ...COLOURS, height: TITLE_BAR_OVERLAY_HEIGHT }]);
  });
});

describe('desktop:detectShells', () => {
  it.each(['darwin', 'linux'] as const)('1. offers the login shells on %s, each by its path and its name', (platform) => {
    const r = register(platform, null).shells() as { defaultPath: string; choices: { id: string; path: string | null; name?: string }[] } | null;
    expect(r).not.toBeNull();
    expect(typeof r!.defaultPath).toBe('string');
    for (const c of r!.choices) {
      expect(c.id).toBe(c.path);
      expect(c.path!.startsWith('/')).toBe(true);
      expect(c.name).toBe(c.path!.slice(c.path!.lastIndexOf('/') + 1));
    }
  });

  it('offers the Windows shells on win32, PowerShell 7, Windows PowerShell and cmd always listed', () => {
    const r = register('win32', null).shells() as { defaultPath: string; choices: { id: string }[] };
    expect(r.choices.map(c => c.id).slice(0, 3)).toEqual(['pwsh', 'powershell', 'cmd']);
    expect(typeof r.defaultPath).toBe('string');
  });
});
