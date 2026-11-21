import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * No error report leaves a Windows build: the reports go to the project's
 * Sentry, which has not agreed to receive a Windows build's. The Settings row is hidden there (renderer), and main, which is
 * what sends, never starts the SDK on win32, whatever the settings say.
 *
 * How it fails, written before the code:
 * 1. On win32 with `errorReportsEnabled` true (a settings file edited by hand,
 *    or copied from a Mac), the SDK is loaded and started, and its transport
 *    can reach the DSN.
 * 2. The same when the setting is turned on while Tars runs (sync()).
 * 3. Over-correction: darwin or linux with the setting on no longer start it.
 * 4. The decision is not the platform layer's: errorReportsAvailable answers
 *    otherwise than "every platform but win32".
 */

const loaded = vi.hoisted(() => ({ count: 0 }));
const init = vi.hoisted(() => vi.fn());
vi.mock('@sentry/electron/main', () => {
  const integration = (name: string) => () => ({ name });
  return {
    // Counted where it is read: the module itself is loaded once per file.
    get init() { loaded.count++; return init; },
    IPCMode: { Classic: 1, Protocol: 2, Both: 3 },
    onUncaughtExceptionIntegration: integration('OnUncaughtException'),
    onUnhandledRejectionIntegration: integration('OnUnhandledRejection'),
    linkedErrorsIntegration: integration('LinkedErrors'),
    makeElectronTransport: vi.fn(() => ({ send: vi.fn(), flush: vi.fn() })),
  };
});
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  // ipcMain: the start guards the SDK's renderer channels (since 1.9.2).
  return { app: { getVersion: () => '1.9.1', isReady: () => false, getPath: () => '/tmp' }, ipcMain: new EventEmitter() };
});

import { errorReportsAvailable } from '../../../electron/platform';

beforeEach(() => {
  loaded.count = 0;
  init.mockReset();
  vi.resetModules();
});

async function fresh() {
  return (await import('../../../electron/services/error-reports')).startErrorReports;
}

describe('error reports on a Windows build', () => {
  it('1. never load nor start the SDK, with the setting on', async () => {
    const start = await fresh();
    const reports = start(() => true, 'win32');
    await reports.sync();
    expect(loaded.count).toBe(0);
    expect(init).not.toHaveBeenCalled();
  });

  it('2. nor when the setting is turned on while Tars runs', async () => {
    let on = false;
    const start = await fresh();
    const reports = start(() => on, 'win32');
    on = true;
    await reports.sync();
    await reports.sync();
    expect(loaded.count).toBe(0);
    expect(init).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'linux'] as const)('3. still start on %s with the setting on', async (platform) => {
    const start = await fresh();
    await start(() => true, platform).sync();
    expect(loaded.count).toBe(1);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('4. are available on every platform but win32', () => {
    expect(errorReportsAvailable('win32')).toBe(false);
    for (const platform of ['darwin', 'linux', 'freebsd'] as const) expect(errorReportsAvailable(platform)).toBe(true);
  });
});
