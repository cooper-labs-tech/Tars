import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { claudeAccountsNotPorted } from '../../setup/platform-limits';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The 5 h and weekly counters of every Claude account, on the Usage page.
 *
 * The Audit (AUDIT-USAGE-COMPTES.md, gap 6, 2026-10-01): with several
 * accounts, only account 1's status lines write rate-limits.json, the file the
 * Usage page reads, so the page showed account 1's bars under "Claude" even
 * while every agent ran on account 2, or account 1 sat at its limit. Each
 * account's counters live in ~/.tars/rate-limits.d/<account>.json (#267),
 * and reached Settings only. `claude:getData`, what the Usage page loads, now
 * hands them too: `accountRateLimits`, one pair of windows per account.
 *
 * How it fails, written before the code:
 * 1. The page gets account 1's counters alone while agents run on another.
 * 2. An account turned off, or the option off, is shown all the same.
 * 3. A window whose reset has passed is shown at its old percentage ("97 %"
 *    on a fresh window, for hours when no agent runs).
 * 4. The accounts come in another order than the list the user set in
 *    Settings, or without the label that list gives them.
 * 5. A counter file an agent planted (~/.tars is every agent's) reaches
 *    the page as anything but two percentages and two times.
 * 6. account 1's own rateLimits, what the page shows today, changes.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-account-counters-${process.pid}-${Date.now()}`,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '1.9.2', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { writeAccountsSettings } from '../../../electron/services/claude-accounts/registry';
import type { ClaudeAccountsSettings } from '../../../electron/types';

function deps(): IpcHandlerDependencies {
  const fn = () => vi.fn() as never;
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(t, key: string) {
      if (key in t) return t[key];
      const value = key.endsWith('ptyProcesses') || key === 'agents' ? new Map() : fn();
      t[key] = value;
      return value;
    },
  }) as IpcHandlerDependencies;
}

type Window = { usedPercentage: number; resetsAt: number } | null;
type Counters = { accountId: string; label: string; fiveHour: Window; sevenDay: Window; updatedAt: number | null };
type Data = { rateLimits: unknown; accountRateLimits: Counters[] };

async function getData(): Promise<Data> {
  return handlers.get('claude:getData')!({}) as Promise<Data>;
}

const NOW_S = Math.floor(Date.now() / 1000);
const A = 'acct-0a0a0a';
const B = 'acct-0b0b0b';

function accounts(over: Partial<ClaudeAccountsSettings> = {}, disabled: string[] = []): void {
  writeAccountsSettings({
    enabled: true,
    fiveHourThreshold: 90,
    weeklyThreshold: 95,
    accounts: [
      { id: 'default', label: 'Personal', configDir: null, enabled: true },
      { id: B, label: 'Team B', configDir: path.join(tmpHome, '.claude-accounts', B), enabled: !disabled.includes(B) },
      { id: A, label: 'Team A', configDir: path.join(tmpHome, '.claude-accounts', A), enabled: !disabled.includes(A) },
    ],
    ...over,
  });
}

function counters(id: string, fiveHour: [number, number] | null, sevenDay: [number, number] | null, extra: Record<string, unknown> = {}): void {
  const dir = path.join(tmpHome, '.tars', 'rate-limits.d');
  fs.mkdirSync(dir, { recursive: true });
  const w = (x: [number, number] | null) => (x ? { used_percentage: x[0], resets_at: x[1] } : undefined);
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    updatedAt: NOW_S - 60,
    rate_limits: { five_hour: w(fiveHour), seven_day: w(sevenDay), ...extra },
  }));
}

beforeAll(() => {
  registerIpcHandlers(deps());
});

beforeEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpHome, '.tars'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe.skipIf(claudeAccountsNotPorted())('claude:getData, for the Usage page', () => {
  it('1, 4. hands every account its own 5 h and weekly counters, in the order and with the names of Settings', async () => {
    accounts();
    counters('default', [12, NOW_S + 3600], [40, NOW_S + 86_400]);
    counters(A, [97, NOW_S + 1800], [60, NOW_S + 86_400]);
    counters(B, [3, NOW_S + 7200], [5, NOW_S + 86_400]);

    const { accountRateLimits } = await getData();

    expect(accountRateLimits.map(a => [a.accountId, a.label])).toEqual([['default', 'Personal'], [B, 'Team B'], [A, 'Team A']]);
    expect(accountRateLimits.find(a => a.accountId === A)).toMatchObject({
      fiveHour: { usedPercentage: 97, resetsAt: NOW_S + 1800 },
      sevenDay: { usedPercentage: 60, resetsAt: NOW_S + 86_400 },
      updatedAt: (NOW_S - 60) * 1000,
    });
  });

  it('1. names an account no status line has reported for yet, with no figures', async () => {
    accounts();
    const { accountRateLimits } = await getData();
    expect(accountRateLimits.find(a => a.accountId === A)).toEqual({ accountId: A, label: 'Team A', fiveHour: null, sevenDay: null, updatedAt: null });
  });

  it('2. leaves out an account turned off, and every account while the option is off', async () => {
    accounts({}, [B]);
    counters(B, [3, NOW_S + 7200], [5, NOW_S + 86_400]);
    expect((await getData()).accountRateLimits.map(a => a.accountId)).toEqual(['default', A]);

    accounts({ enabled: false });
    expect((await getData()).accountRateLimits).toEqual([]);
  });

  it('3. shows a window whose reset has passed as no figure', async () => {
    accounts();
    counters(A, [97, NOW_S - 10], [60, NOW_S + 86_400]);
    const a = (await getData()).accountRateLimits.find(x => x.accountId === A)!;
    expect(a.fiveHour).toBeNull();
    expect(a.sevenDay).toEqual({ usedPercentage: 60, resetsAt: NOW_S + 86_400 });
  });

  it('5. hands nothing but numbers from a planted file', async () => {
    accounts();
    counters(A, null, null, { five_hour: { used_percentage: '<img src=x>', resets_at: NOW_S + 60, extra: 'x' }, path: '/etc/passwd' });
    const a = (await getData()).accountRateLimits.find(x => x.accountId === A)!;
    expect(a).toEqual({ accountId: A, label: 'Team A', fiveHour: null, sevenDay: null, updatedAt: (NOW_S - 60) * 1000 });
  });

  it("6. keeps account 1's rateLimits as the page reads them today", async () => {
    accounts();
    const legacy = { five_hour: { used_percentage: 12, resets_at: NOW_S + 3600 } };
    fs.writeFileSync(path.join(tmpHome, '.tars', 'rate-limits.json'), JSON.stringify(legacy));
    expect((await getData()).rateLimits).toEqual(legacy);
  });
});
