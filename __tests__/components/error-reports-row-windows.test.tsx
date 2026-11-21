import '../setup/home-guard';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, ofType, settle, type Mount } from './hook-runtime';
import { GeneralSection } from '../../src/components/Settings/GeneralSection';
import { SettingsRow } from '../../src/components/Settings/SettingsRow';
import { DEFAULT_APP_SETTINGS } from '../../src/components/Settings/constants';
import type { AppSettings } from '../../src/components/Settings/types';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * Settings > Preferences on a Windows build offers no "Send error reports"
 * row: the reports would go to a Sentry project that has not agreed to
 * receive a Windows build's, and main never starts them there
 * (error-report-windows-off.test.ts). A row hidden, nothing drawn in its place.
 *
 * How it fails:
 * 1. The row is shown on win32, with the setting on or off.
 * 2. Over-correction: a Mac or Linux window no longer shows it
 *    (error-reports-switch.test.tsx holds the row itself).
 */

type El = { props: Record<string, unknown> };
const g = globalThis as unknown as { window?: unknown };
let page: Mount<unknown> | null = null;
afterEach(() => {
  page?.unmount();
  page = null;
  delete g.window;
});

async function reportRows(platform: string, errorReportsEnabled: boolean): Promise<number> {
  g.window = { electronAPI: { platform } };
  const appSettings = { ...DEFAULT_APP_SETTINGS, errorReportsEnabled } as AppSettings;
  page = mount(() => GeneralSection({ info: null, appSettings, onSaveAppSettings: () => {} }));
  await settle();
  return (ofType(page.result, SettingsRow) as unknown as El[]).filter(el => el.props.label === 'Send error reports').length;
}

describe('the Send error reports row', () => {
  it.each([true, false])('1. is not offered on win32 (setting %s)', async (on) => {
    expect(await reportRows('win32', on)).toBe(0);
  });

  it.each(['darwin', 'linux'])('2. is still offered on %s', async (platform) => {
    expect(await reportRows(platform, false)).toBe(1);
  });
});
