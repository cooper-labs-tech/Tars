import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EventEmitter } from 'node:events';
import { parseEnvelope } from '@sentry/core';

/**
 * When the Sentry SDK is loaded and started in the main process, from the one
 * setting the Frontend's toggle writes (`errorReportsEnabled`, default false,
 * saved through app:saveSettings like every other setting).
 *
 * How it fails, written before the code (2026-09-28):
 * 1. With the setting off, the SDK is loaded or started anyway: its handlers,
 *    its IPC listeners and OpenTelemetry would be in the process of a user
 *    who never asked for reports, and its load costs every start.
 * 2. Turned on while Tars runs, nothing starts until a restart.
 * 3. Turned off and on again, the SDK is started a second time: a second
 *    client, and a second `ipcMain.handle` on the same channel, which throws.
 * 4. It is started with the SDK's defaults: native crash dumps (process
 *    memory), screenshots, breadcrumbs of network requests and console lines,
 *    sessions, the renderer preload injection, OpenTelemetry, the offline
 *    queue on disk that sends later; or with another address than Tars's DSN.
 * 4b. The request to Sentry carries the system's language: Chromium adds an
 *    Accept-Language header to every request the net module makes.
 * 5. The SDK failing to load or to start throws out of the main process.
 *    (It is loaded with import(), resolved by the time sync()'s promise is.)
 * 6. The setting's default is not false, in the settings main starts with.
 * 7. A settings change is not followed: main.ts never tells the reports
 *    that the settings were replaced.
 * 8. (QA's I9) The facts main hands the reports are not this machine's: an
 *    empty home folder, or none, would let every path through, and no test
 *    of report.ts alone would see it.
 * 9. (QA's I1) A packaged Tars sends its reports wherever
 *    DOROTHY_ERROR_REPORTS_DSN says; or a development run cannot be pointed
 *    at a stand-in.
 * 10. (QA's gate of #221) A malformed envelope from the renderer throws in
 *    main's listener: an uncaught exception, a fatal report of its own, then
 *    Electron's error box, which holds the main process until it is killed.
 * 11. What reaches the SDK's listener from the renderer is not a string or
 *    bytes, or is larger than any error report.
 * 12. Over-correction: a well-formed envelope no longer reaches the SDK, or a
 *    listener that is not the SDK's is wrapped too.
 */

const loaded = vi.hoisted(() => ({ count: 0, fail: false }));
const init = vi.hoisted(() => vi.fn());
vi.mock('@sentry/electron/main', () => {
  loaded.count++;
  if (loaded.fail) throw new Error('cannot load');
  const integration = (name: string) => () => ({ name });
  return {
    init,
    IPCMode: { Classic: 1, Protocol: 2, Both: 3 },
    onUncaughtExceptionIntegration: integration('OnUncaughtException'),
    onUnhandledRejectionIntegration: integration('OnUnhandledRejection'),
    linkedErrorsIntegration: integration('LinkedErrors'),
    makeElectronTransport: vi.fn(() => ({ send: vi.fn(), flush: vi.fn() })),
    makeElectronOfflineTransport: vi.fn(),
  };
});
const electron = vi.hoisted(() => ({ packaged: false, ipcMain: undefined as EventEmitter | undefined }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  electron.ipcMain ??= new EventEmitter();
  return {
    app: { getVersion: () => '1.9.1', isReady: () => false, getPath: () => '/tmp', get isPackaged() { return electron.packaged; } },
    ipcMain: electron.ipcMain,
  };
});

import { startErrorReports, ERROR_REPORTS_DSN } from '../../../electron/services/error-reports';

beforeEach(() => {
  loaded.count = 0;
  loaded.fail = false;
  electron.packaged = false;
  electron.ipcMain?.removeAllListeners();
  init.mockReset();
  vi.resetModules();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/**
 * On darwin, where Tars sends reports: a Windows build never starts them
 * (error-report-windows-off.test.ts), and this file runs on Windows too.
 */
async function fresh() {
  const { startErrorReports: start } = await import('../../../electron/services/error-reports');
  return (isEnabled: () => boolean) => start(isEnabled, 'darwin');
}

describe('the SDK in the main process', () => {
  it('1. is neither loaded nor started while the setting is off', async () => {
    const start = await fresh();
    const reports = start(() => false);
    await reports.sync();
    await reports.sync();
    expect(loaded.count).toBe(0);
    expect(init).not.toHaveBeenCalled();
  });

  it('2, 3. starts when the setting is turned on while running, once for the run', async () => {
    let on = false;
    const start = await fresh();
    const reports = start(() => on);
    on = true;
    await reports.sync();
    on = false;
    await reports.sync();
    on = true;
    await reports.sync();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('4. with Tars\'s DSN, errors only, and none of the SDK\'s defaults', async () => {
    const start = await fresh();
    await start(() => true).sync();
    const options = init.mock.calls[0][0];

    expect(options.dsn).toBe(ERROR_REPORTS_DSN);
    expect(options.dsn).toBe('https://d3d853ef128291b07daad0c136b0c82d@o4511321063620608.ingest.de.sentry.io/4512140890996816');
    expect(options.defaultIntegrations).toBe(false);
    expect(options.integrations.map((i: { name: string }) => i.name))
      .toEqual(['OnUncaughtException', 'OnUnhandledRejection', 'LinkedErrors']);
    expect(options.ipcMode).toBe(1);
    expect(options.skipOpenTelemetrySetup).toBe(true);
    expect(options.attachScreenshot).toBeFalsy();
    expect(options.enableRendererProfiling).toBeFalsy();
    expect(typeof options.beforeSend).toBe('function');
    expect(typeof options.transport).toBe('function');
    expect(options.transportOptions).toEqual({ headers: { 'Accept-Language': 'en' } });
  });

  it('5. never throws when the SDK cannot be loaded or started', async () => {
    loaded.fail = true;
    let start = await fresh();
    await expect(start(() => true).sync()).resolves.toBeUndefined();

    vi.resetModules();
    loaded.fail = false;
    init.mockImplementation(() => { throw new Error('init failed'); });
    start = await fresh();
    await expect(start(() => true).sync()).resolves.toBeUndefined();
  });
});

describe('what the reports are started with', () => {
  it('8. rewrites this machine\'s home folder and name, through the beforeSend main hands the SDK', async () => {
    const start = await fresh();
    await start(() => true).sync();
    const { beforeSend } = init.mock.calls[0][0];
    const value = `ENOENT ${os.homedir()}/clients/acme/notes.md on ${os.hostname()}`;

    const report = beforeSend({ exception: { values: [{ type: 'Error', value }] } });

    expect(report.exception.values[0].value).toBe('ENOENT ~/clients/acme/notes.md on <host>');
  });

  it('9. reads DOROTHY_ERROR_REPORTS_DSN in a development run only', async () => {
    vi.stubEnv('DOROTHY_ERROR_REPORTS_DSN', 'http://key@127.0.0.1:9/1');
    electron.packaged = true;
    await (await fresh())(() => true).sync();
    expect(init.mock.calls[0][0].dsn).toBe(ERROR_REPORTS_DSN);

    vi.resetModules();
    init.mockReset();
    electron.packaged = false;
    await (await fresh())(() => true).sync();
    expect(init.mock.calls[0][0].dsn).toBe('http://key@127.0.0.1:9/1');
  });
});

describe('what the renderer sends main', () => {
  /** The SDK's listeners, as IPCMode.Classic registers them: its envelope parser throws on a malformed one. */
  function sdkListeners() {
    const received: unknown[] = [];
    init.mockImplementation(() => {
      electron.ipcMain!.on('sentry-ipc.start', () => undefined);
      electron.ipcMain!.on('sentry-ipc.envelope', (_event: unknown, env: string | Uint8Array) => {
        parseEnvelope(env);
        received.push(env);
      });
    });
    return received;
  }
  const send = (env: unknown) => electron.ipcMain!.emit('sentry-ipc.envelope', { sender: {} }, env);

  it('10. never throws out of main for a malformed envelope, and says it dropped it', async () => {
    sdkListeners();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await (await fresh())(() => true).sync();

    // QA's trigger: an item with no length whose payload is not JSON.
    expect(() => send('{}\n{"type":"event"}\nnot json')).not.toThrow();
    expect(() => send({ length: 1 })).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('11, 12. hands the SDK a well-formed envelope, and nothing that is not text or bytes, or too large', async () => {
    const received = sdkListeners();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await (await fresh())(() => true).sync();
    const good = '{}\n{"type":"event"}\n{"exception":{"values":[{"type":"Error","value":"x"}]}}';

    send(good);
    send(new TextEncoder().encode(good));
    send({ length: 1 });
    send(`{}\n{"type":"event"}\n{"message":"${'x'.repeat(2_000_000)}"}`);

    expect(received).toHaveLength(2);
    expect(received[0]).toBe(good);
  });

  it('12. leaves the other channels\' listeners alone', async () => {
    sdkListeners();
    await (await fresh())(() => true).sync();
    const other = () => { throw new Error('not the SDK\'s'); };
    electron.ipcMain!.on('agent:start', other);

    expect(electron.ipcMain!.listeners('agent:start')).toEqual([other]);
  });
});

describe('main.ts', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../../electron/main.ts'), 'utf-8');

  it('6. starts with errorReportsEnabled false', () => {
    expect(main).toMatch(/errorReportsEnabled: false,/);
  });

  it('7. starts the reports before the app is ready, and tells them each time the settings are replaced', () => {
    // 2.0.4 hands it main's onFatalError and what an agent tool error may name (error-report-start-coverage.test.ts).
    expect(main).toMatch(/startErrorReports\(\(\) => appSettings\.errorReportsEnabled === true[,)]/);
    expect(main.indexOf('startErrorReports(')).toBeLessThan(main.indexOf('app.whenReady()'));
    const setters = main.match(/setAppSettings: \([^)]*\)[^\n]*=> \{[^}]*\}/g) ?? [];
    expect(setters.length).toBeGreaterThanOrEqual(2);
    for (const setter of setters) expect(setter, setter).toContain('errorReports.sync()');
  });
});

void startErrorReports;
