import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { mount, settle, type Mount } from './hook-runtime';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
const store = vi.hoisted(() => ({
  mobileMenuOpen: false, setMobileMenuOpen: () => {}, darkMode: true, setDarkMode: () => {}, setVaultUnreadCount: () => {},
  updateBannerDismissed: false, setUpdateBannerDismissed: () => {}, setPendingUpdateVersion: () => {},
}));
vi.mock('../../src/store', () => ({ useStore: Object.assign(() => store, { getState: () => store }) }));
vi.mock('../../src/lib/error-reports', () => ({
  followErrorReports: vi.fn(async () => true),
  followErrorReportsSetting: vi.fn(async () => false),
}));

import ClientLayout from '../../src/components/ClientLayout';
import { useSettings } from '../../src/hooks/useSettings';
import { followErrorReports, followErrorReportsSetting } from '../../src/lib/error-reports';

/**
 * Where the window's half of error reports is started (#220, the two holes
 * QA's gate found): nothing in the suite would see either start go.
 * - US1: the Settings switch. A save that turns errorReportsEnabled on or off
 *   hands the new value to followErrorReports; a save that fails, or does not
 *   carry the key, hands it nothing.
 * - CL1: the start at launch. The shell (ClientLayout) reads the setting from
 *   main once, through followErrorReportsSetting, when it mounts.
 * Each test fails on the mutant that removes its start.
 */

const g = globalThis as unknown as { window?: unknown; document?: unknown; localStorage?: unknown };
let page: Mount<unknown> | null = null;
beforeEach(() => {
  vi.mocked(followErrorReports).mockClear();
  vi.mocked(followErrorReportsSetting).mockClear();
});
afterEach(() => {
  page?.unmount();
  page = null;
  delete g.window;
  delete g.document;
  delete g.localStorage;
});

describe('the Settings switch starts them (US1)', () => {
  const settings = (save: (delta: unknown) => Promise<{ success: boolean; error?: string }>) => {
    g.window = {
      electronAPI: {
        settings: { get: vi.fn(async () => ({})), getInfo: vi.fn(async () => ({})), save: vi.fn(async () => ({ success: true })) },
        claude: { getData: vi.fn(async () => ({ skills: [] })) },
        appSettings: { get: vi.fn(async () => ({})), save: vi.fn(save), onUpdated: vi.fn(() => () => {}) },
      },
    };
    page = mount(() => useSettings());
    return page as Mount<ReturnType<typeof useSettings>>;
  };

  it('hands the new value to the window once main has saved it, on and off', async () => {
    const p = settings(async () => ({ success: true }));
    await settle();
    await p.result.handleSaveAppSettings({ errorReportsEnabled: true });
    await p.result.handleSaveAppSettings({ errorReportsEnabled: false });
    expect(vi.mocked(followErrorReports).mock.calls).toEqual([[true], [false]]);
  });

  it('hands it nothing when the save fails, or carries another key', async () => {
    const p = settings(async () => ({ success: false, error: 'disk full' }));
    await settle();
    await p.result.handleSaveAppSettings({ errorReportsEnabled: true });
    expect(followErrorReports).not.toHaveBeenCalled();
    page!.unmount();
    const q = settings(async () => ({ success: true }));
    await settle();
    await q.result.handleSaveAppSettings({ autoCheckUpdates: false });
    expect(followErrorReports).not.toHaveBeenCalled();
  });
});

describe('the shell starts them at launch (CL1)', () => {
  it('reads the setting from main once, when it mounts', async () => {
    const electronAPI = { appSettings: { get: vi.fn(async () => ({ errorReportsEnabled: true })) } };
    g.window = { electronAPI, innerWidth: 1440, addEventListener: () => {}, removeEventListener: () => {} };
    g.document = { documentElement: { classList: { toggle: () => {} } }, addEventListener: () => {}, removeEventListener: () => {} };
    g.localStorage = { getItem: () => null, setItem: () => {} };
    // ClientLayout hands the page to its inner shell; call that too, so the
    // shell's own effects run in this mount.
    page = mount(() => {
      const shell = ClientLayout({ children: null }) as ReactElement<{ children: null }>;
      return (shell.type as (props: { children: null }) => unknown)(shell.props);
    });
    await settle();
    page.rerender();
    await settle();
    expect(followErrorReportsSetting).toHaveBeenCalledTimes(1);
    expect(vi.mocked(followErrorReportsSetting).mock.calls[0][0]).toBe(electronAPI);
  });
});
