import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The tray panel loads the dev server only in an unpackaged build (the Audit's
 * table on a3d7c125, #4).
 *
 * The main window stopped trusting NODE_ENV long ago (window-manager.ts,
 * isDevBuild): a shell with `export NODE_ENV=development` made the shipped
 * build load whatever answered on localhost:3000, with the preload bridge
 * (pty.create, pty.write) and DevTools. The tray panel carries the same
 * preload and still read NODE_ENV.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. A packaged build launched with NODE_ENV=development loads localhost:3000.
 * 2. An unpackaged build does not load the dev server the main window loads
 *    (DOROTHY_DEV_URL, as resolveDevUrl allows it), and the e2e's port is not
 *    the tray's.
 * 3. A DOROTHY_DEV_URL that is not loopback http is loaded.
 */

const state = vi.hoisted(() => ({ isPackaged: true, loaded: [] as string[] }));
vi.mock('electron', () => {
  class FakeWindow {
    webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn(), session: { webRequest: { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() }, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } };
    loadURL(url: string) { state.loaded.push(url); return Promise.resolve(); }
    on() { return this; }
    isDestroyed() { return false; }
  }
  return {
    app: { get isPackaged() { return state.isPackaged; }, getPath: () => '/tmp', on: vi.fn() },
    BrowserWindow: FakeWindow,
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
    protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
    shell: { openExternal: vi.fn() },
    session: { defaultSession: { webRequest: { onBeforeRequest: vi.fn() } } },
    net: { fetch: vi.fn() },
  };
});

const envBefore = { NODE_ENV: process.env.NODE_ENV, DOROTHY_DEV_URL: process.env.DOROTHY_DEV_URL };
beforeEach(() => { state.loaded.length = 0; vi.resetModules(); });
afterEach(() => {
  for (const [k, v] of Object.entries(envBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function trayLoads(): Promise<string> {
  const { createTrayPanel } = await import('../../../electron/core/tray-panel-manager');
  createTrayPanel();
  return state.loaded.at(-1)!;
}

describe('the tray panel\'s page', () => {
  it('1. is the packaged one in a packaged build, whatever NODE_ENV says', async () => {
    state.isPackaged = true;
    process.env.NODE_ENV = 'development';
    process.env.DOROTHY_DEV_URL = 'http://localhost:3000';

    expect(await trayLoads()).toBe('app://-/tray-panel/index.html');
  });

  it('2. is the dev server the main window uses, in an unpackaged build', async () => {
    state.isPackaged = false;
    delete process.env.NODE_ENV;
    process.env.DOROTHY_DEV_URL = 'http://127.0.0.1:3100';

    expect(await trayLoads()).toBe('http://127.0.0.1:3100/tray-panel');
  });

  it('3. is never a dev URL that is not loopback http', async () => {
    state.isPackaged = false;
    process.env.DOROTHY_DEV_URL = 'https://attacker.example';

    expect(await trayLoads()).toBe('http://localhost:3000/tray-panel');
  });
});
