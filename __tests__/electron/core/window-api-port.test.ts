import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';

/**
 * The window knows the port its own local API listens on (electron/preload.ts `apiPort`, handed by main in each
 * window's arguments: core/window-manager.ts `windowArguments`).
 *
 * The window built a vault note's local picture on 31415, written in: a Tars on another port (the sandbox's
 * 31499, every E2E run, any DOROTHY_API_PORT) asked whatever answered on 31415, which is the user's own Tars, and
 * under the window's policy (window-csp.ts, img-src names the API's own port) it is refused outright.
 *
 * How it fails, written before the code (26/11/2026):
 * 1. The window gets no port, or 31415 whatever the API listens on: a Tars started with DOROTHY_API_PORT=31499
 *    hands its window 31415, and the hardcoded port has only moved.
 * 2. The port reaches the window as a string, NaN or undefined, so a URL built from it reads `:NaN` or
 *    `:undefined`.
 * 3. A switch that is not a port is taken for one: letters after the digits, 0, a port past 65535, a sign, a
 *    fraction, spaces, an empty value; or a switch whose name only starts the same way.
 * 4. More than the port crosses: a token or any other value in the window's arguments.
 * 5. One of the two windows that load the bridge (the main window, the tray panel) opens without it.
 * 6. A window main did not open (no switch) gets a default port instead of none: the bug again, silently.
 */

const state = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>>, exposed: {} as Record<string, unknown> }));
vi.mock('electron', () => {
  class FakeWindow {
    webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn(), openDevTools: vi.fn() };
    constructor(options: Record<string, unknown>) { state.options.push(options); }
    loadURL() { return Promise.resolve(); }
    on() { return this; }
    once() { return this; }
    showInactive() {}
    setAlwaysOnTop() {}
    isDestroyed() { return false; }
  }
  return {
    app: { isPackaged: true, getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '2.0.7', on: vi.fn(), dock: { hide: vi.fn() } },
    BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: vi.fn() },
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
    protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
    shell: { openExternal: vi.fn() },
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
    contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { state.exposed[key] = api; } },
    ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  };
});

const argvBefore = [...process.argv];
const portBefore = process.env.DOROTHY_API_PORT;
beforeEach(() => {
  state.options.length = 0;
  for (const key of Object.keys(state.exposed)) delete state.exposed[key];
  vi.resetModules();
});
afterEach(() => {
  process.argv.splice(0, process.argv.length, ...argvBefore);
  if (portBefore === undefined) delete process.env.DOROTHY_API_PORT;
  else process.env.DOROTHY_API_PORT = portBefore;
});

/** Both windows, opened as main opens them, and the arguments each was given. */
async function windowsArguments(): Promise<unknown[]> {
  const { createWindow } = await import('../../../electron/core/window-manager');
  const { createTrayPanel } = await import('../../../electron/core/tray-panel-manager');
  createWindow();
  createTrayPanel();
  return state.options.map((options) => (options.webPreferences as { additionalArguments?: unknown }).additionalArguments);
}

/** What the window's bridge says, loaded in a renderer whose arguments are `argv`'s. */
async function bridgePort(extra: string[]): Promise<unknown> {
  process.argv.splice(0, process.argv.length, ...argvBefore, ...extra);
  await import('../../../electron/preload');
  return (state.exposed.electronAPI as { apiPort?: unknown }).apiPort;
}

describe('the window\'s API port', () => {
  it('1, 5: both windows are handed the port the API listens on, DOROTHY_API_PORT\'s override included', async () => {
    process.env.DOROTHY_API_PORT = '31499';
    const { API_PORT } = await import('../../../electron/constants');
    expect(API_PORT).toBe(31499);
    expect(await windowsArguments()).toEqual([['--tars-api-port=31499'], ['--tars-api-port=31499']]);
  });

  it('1: without the override, 31415, as the API', async () => {
    delete process.env.DOROTHY_API_PORT;
    expect(await windowsArguments()).toEqual([['--tars-api-port=31415'], ['--tars-api-port=31415']]);
  });

  it('1, 2: the window reads what main handed it, as a number', async () => {
    process.env.DOROTHY_API_PORT = '31499';
    const [handed] = (await windowsArguments()) as string[][];
    vi.resetModules();
    const port = await bridgePort(handed);
    expect(port).toBe(31499);
    expect(typeof port).toBe('number');
  });

  it('3: a switch that is not a port gives none', async () => {
    for (const value of ['31499abc', '0', '70000', '-1', '+31499', '3.5', ' 31499', '', '0x7aeb']) {
      vi.resetModules();
      expect(await bridgePort([`--tars-api-port=${value}`]), value).toBeNull();
    }
    vi.resetModules();
    expect(await bridgePort(['--tars-api-port-x=31499'])).toBeNull();
  });

  it('4: the arguments carry the port and nothing else', async () => {
    for (const handed of await windowsArguments()) {
      expect(handed).toHaveLength(1);
      expect((handed as string[])[0]).toMatch(/^--tars-api-port=\d{1,5}$/);
    }
  });

  it('6: a window main did not open gets no port, never a default one', async () => {
    expect(await bridgePort([])).toBeNull();
  });
});
