import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Error reports on a Windows build too (the maintainer's parity rule of
 * 2026-10-16, "toujours a parite", and his go for error reports on Windows,
 * the parity program's P5). Until 2.0.4 no report left a Windows build: the
 * Settings row was hidden and main never started the SDK on win32. Now the
 * switch decides there as it does on macOS and Linux, and so it does for the
 * report of an abrupt end and the diagnostic. What a Windows report carries
 * is held by error-report-windows-home.test.ts: no home, no user name, in
 * any of the spellings a Windows path reaches an error in.
 *
 * How it fails, written before the code:
 * 1. On win32 with `errorReportsEnabled` on, the SDK is never loaded nor
 *    started: the old gate left in.
 * 2. The same when the setting is turned on while Tars runs (sync()).
 * 3. Over-correction: on win32 with the setting off, the SDK is loaded.
 * 4. The diagnostic and the abrupt end refused on win32 with the switch on,
 *    or let through with it off: refusal() must answer as on the other
 *    platforms, never a sentence about Windows.
 * 5. The three platforms answer differently for the same settings.
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

import { HEALTH_REFUSALS } from '../../../electron/services/error-reports';

beforeEach(() => {
  loaded.count = 0;
  init.mockReset();
  vi.resetModules();
});

async function fresh() {
  return (await import('../../../electron/services/error-reports')).startErrorReports;
}

describe('error reports on a Windows build', () => {
  it('1. load and start the SDK, with the setting on', async () => {
    const start = await fresh();
    await start(() => true, 'win32').sync();
    expect(loaded.count).toBe(1);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('2. and when the setting is turned on while Tars runs', async () => {
    let on = false;
    const start = await fresh();
    const reports = start(() => on, 'win32');
    await reports.sync();
    expect(init).not.toHaveBeenCalled();
    on = true;
    await reports.sync();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('3. never load it with the setting off', async () => {
    const start = await fresh();
    await start(() => false, 'win32').sync();
    expect(loaded.count).toBe(0);
    expect(init).not.toHaveBeenCalled();
  });

  it('4. the diagnostic and the abrupt end are refused only by the switch, as elsewhere', async () => {
    const start = await fresh();
    let on = true;
    const reports = start(() => on, 'win32');
    expect(reports.refusal()).toBeNull();
    on = false;
    expect(reports.refusal()).toBe(HEALTH_REFUSALS.off);
    expect(Object.keys(HEALTH_REFUSALS)).not.toContain('windows');
  });

  it('5. the same on the three platforms, for the same settings', async () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const on of [true, false]) {
        loaded.count = 0;
        init.mockReset();
        vi.resetModules();
        const start = await fresh();
        const reports = start(() => on, platform);
        await reports.sync();
        expect({ platform, on, started: init.mock.calls.length, refusal: reports.refusal() })
          .toEqual({ platform, on, started: on ? 1 : 0, refusal: on ? null : HEALTH_REFUSALS.off });
      }
    }
  });
});
