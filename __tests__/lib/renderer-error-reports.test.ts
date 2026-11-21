import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The renderer's half of error reports (src/lib/error-reports.ts). Main's half
 * is #221's electron/services/error-reports: it loads @sentry/electron only
 * while `errorReportsEnabled` is on, rebuilds every report field by field, and
 * drops everything once the setting is off. The renderer's SDK sends through
 * Tars's preload bridge to main. Written before the code, as the ways it can
 * fail:
 * 1. the SDK is loaded while the setting is off: at start, from a settings
 *    file without the key, when the settings cannot be read, or because
 *    something in src/ imports it outright and every window loads it;
 * 2. turned on, at start or from the switch, it does not start, or starts
 *    more than once;
 * 3. it starts with the browser SDK's defaults (breadcrumbs of clicks and
 *    console lines, the page's URL and user agent, wrapped timers and
 *    listeners) rather than the errors alone that main's side takes;
 * 4. an SDK that cannot load or start throws into the page, or can never be
 *    started again in that run.
 */

const sdk = vi.hoisted(() => ({ loads: 0, inits: [] as Array<Record<string, unknown>>, fail: null as null | 'import' | 'init' }));

/** The SDK as the page would import it, counting each time it is loaded. */
const fakeSdk = () => {
  sdk.loads += 1;
  if (sdk.fail === 'import') throw new Error('the SDK could not load');
  const integration = (name: string) => () => ({ name });
  return {
    init: (options: Record<string, unknown>) => {
      if (sdk.fail === 'init') throw new Error('the SDK could not start');
      sdk.inits.push(options);
    },
    globalHandlersIntegration: integration('GlobalHandlers'),
    linkedErrorsIntegration: integration('LinkedErrors'),
    breadcrumbsIntegration: integration('Breadcrumbs'),
    dedupeIntegration: integration('Dedupe'),
  };
};

type Lib = typeof import('../../src/lib/error-reports');
let lib: Lib;
const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(async () => {
  sdk.loads = 0;
  sdk.inits = [];
  sdk.fail = null;
  warn.mockClear();
  // A fresh module each time: what it started is per run of the app. The mock
  // is registered again too, or vitest hands back the SDK an earlier test loaded.
  vi.resetModules();
  vi.doMock('@sentry/electron/renderer', fakeSdk);
  lib = await import('../../src/lib/error-reports');
});
afterEach(() => { sdk.fail = null; });

const api = (get: () => Promise<unknown>) => ({ appSettings: { get } });

describe('off: nothing is loaded (1)', () => {
  it('loads nothing while the setting is off, however often it is told', async () => {
    await lib.followErrorReports(false);
    await lib.followErrorReports(false);
    expect(sdk.loads).toBe(0);
    expect(sdk.inits).toEqual([]);
  });

  it.each([
    ['the setting off', async () => ({ errorReportsEnabled: false })],
    ['a settings file written before the key', async () => ({ autoCheckUpdates: true })],
    ['no settings at all', async () => null],
    ['a read that fails', async () => { throw new Error('no answer'); }],
  ])('loads nothing at start with %s', async (_what, get) => {
    await lib.followErrorReportsSetting(api(get));
    expect(sdk.loads).toBe(0);
  });

  it('loads nothing when the window has no bridge to main', async () => {
    await lib.followErrorReportsSetting(undefined);
    expect(sdk.loads).toBe(0);
  });

  it('is imported by nothing in src/ but its own module, and only on demand', () => {
    const SRC = path.resolve(__dirname, '../../src');
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return files(full);
      return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
    });
    const naming = files(SRC).filter(f => fs.readFileSync(f, 'utf8').includes('@sentry/'));
    expect(naming.map(f => path.relative(SRC, f))).toEqual([path.join('lib', 'error-reports.ts')]);
    const own = fs.readFileSync(path.join(SRC, 'lib', 'error-reports.ts'), 'utf8');
    expect(own).not.toMatch(/^\s*import\b[^('"]*['"]@sentry\//m);
    expect(own.match(/import\(\s*['"]@sentry\/electron\/renderer['"]\s*\)/g)).toHaveLength(1);
  });
});

describe('on: it starts once (2)', () => {
  it('starts at start when the settings say on', async () => {
    await lib.followErrorReportsSetting(api(async () => ({ errorReportsEnabled: true })));
    expect(sdk.loads).toBe(1);
    expect(sdk.inits).toHaveLength(1);
  });

  it('starts when the switch turns it on, and only once however often it is told', async () => {
    await lib.followErrorReports(false);
    expect(sdk.loads).toBe(0);
    await Promise.all([lib.followErrorReports(true), lib.followErrorReports(true)]);
    await lib.followErrorReports(false);
    await lib.followErrorReports(true);
    expect(sdk.loads).toBe(1);
    expect(sdk.inits).toHaveLength(1);
  });
});

describe('errors alone, as main takes them (3)', () => {
  it('starts with no default integrations, only the error handlers and linked causes', async () => {
    await lib.followErrorReports(true);
    const [options] = sdk.inits;
    expect(options.defaultIntegrations).toBe(false);
    expect((options.integrations as Array<{ name: string }>).map(i => i.name)).toEqual(['GlobalHandlers', 'LinkedErrors']);
    expect(options.sendDefaultPii).toBe(false);
    for (const key of ['tracesSampleRate', 'tracesSampler', 'replaysSessionSampleRate', 'replaysOnErrorSampleRate', 'profilesSampleRate', 'enableLogs', 'dsn', 'initialScope']) {
      expect(options).not.toHaveProperty(key);
    }
  });
});

describe('a failure to start (4)', () => {
  it('does not throw into the page when the SDK cannot load, and says so', async () => {
    sdk.fail = 'import';
    await expect(lib.followErrorReports(true)).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('does not throw when the SDK cannot start, and can start later in the run', async () => {
    sdk.fail = 'init';
    await expect(lib.followErrorReports(true)).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    sdk.fail = null;
    await expect(lib.followErrorReports(true)).resolves.toBe(true);
    expect(sdk.inits).toHaveLength(1);
  });
});
