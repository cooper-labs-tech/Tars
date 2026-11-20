import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The renderer's half of keeping error reports off on Windows: on a Windows build the
 * window never loads the Sentry SDK and Settings offers no "Send error
 * reports" row. Main's half, the one that sends, is
 * error-report-windows-off.test.ts.
 *
 * How it fails, written before the code:
 * 1. On win32 a settings file with `errorReportsEnabled` true starts the
 *    window's SDK at start (followErrorReportsSetting).
 * 2. On win32 the switch, or any save carrying the key, starts it
 *    (followErrorReports).
 * 3. The row is offered on win32 (errorReportsOffered), so a user turns on
 *    something that never runs.
 * 4. Over-correction: a Mac or Linux window no longer starts it, or no longer
 *    offers the row.
 */

const sdk = vi.hoisted(() => ({ loads: 0, inits: 0 }));
const fakeSdk = () => {
  sdk.loads += 1;
  const integration = (name: string) => () => ({ name });
  return {
    init: () => { sdk.inits += 1; },
    globalHandlersIntegration: integration('GlobalHandlers'),
    linkedErrorsIntegration: integration('LinkedErrors'),
  };
};

type Lib = typeof import('../../src/lib/error-reports');
let lib: Lib;
const g = globalThis as unknown as { window?: { electronAPI?: { platform?: string } } };

async function inWindowOf(platform: string): Promise<void> {
  g.window = { electronAPI: { platform } };
  vi.resetModules();
  vi.doMock('@sentry/electron/renderer', fakeSdk);
  lib = await import('../../src/lib/error-reports');
}

beforeEach(() => { sdk.loads = 0; sdk.inits = 0; });
afterEach(() => { delete g.window; });

const api = { appSettings: { get: async () => ({ errorReportsEnabled: true }) } };

describe('the window of a Windows build', () => {
  it('1. does not start the SDK from settings that have it on', async () => {
    await inWindowOf('win32');
    expect(await lib.followErrorReportsSetting(api)).toBe(false);
    expect(sdk.loads).toBe(0);
  });

  it('2. does not start it from the switch', async () => {
    await inWindowOf('win32');
    expect(await lib.followErrorReports(true)).toBe(false);
    expect(sdk.loads).toBe(0);
  });

  it('3. offers no row', async () => {
    await inWindowOf('win32');
    expect(lib.errorReportsOffered()).toBe(false);
  });
});

describe.each(['darwin', 'linux'])('the window of a %s build', (platform) => {
  it('4. starts it from settings that have it on, and offers the row', async () => {
    await inWindowOf(platform);
    expect(await lib.followErrorReportsSetting(api)).toBe(true);
    expect(sdk.loads).toBe(1);
    expect(sdk.inits).toBe(1);
    expect(lib.errorReportsOffered()).toBe(true);
  });
});
