import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * What the Usage page is handed, in the real app, for every Claude account.
 *
 * The Audit (AUDIT-USAGE-COMPTES.md, gap 6, 2026-10-01): only account 1's
 * status lines write rate-limits.json, so the page showed account 1's 5 h and
 * weekly bars while the agents ran on account 2. Each account's counters are
 * in ~/.dorothy/rate-limits.d (the status line writes them per account), and
 * `claude:getData`, the page's load, now carries them: one pair per account
 * in use, in Settings' order, a window past its reset left out. The bars
 * themselves are the Frontend's; this proves the window receives them.
 *
 * The sandbox has the accounts option on with three accounts, one turned off,
 * and a counter file for each.
 */

type Window = { usedPercentage: number; resetsAt: number } | null;
type Api = { electronAPI: { claude: { getData(): Promise<{ accountRateLimits: Array<{ accountId: string; label: string; fiveHour: Window; sevenDay: Window }> } | null> } } };

test.skip(process.platform === 'win32', 'several Claude accounts are off on a Windows build until they are ported; this runs on macOS and Linux');

test('the Usage page is handed each Claude account its own 5 h and weekly counters', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-account-counters-'));
  const dir = path.join(home, '.dorothy');
  const priv = path.join(home, '.tars-private');
  fs.mkdirSync(path.join(dir, 'rate-limits.d'), { recursive: true });
  fs.mkdirSync(priv, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  fs.writeFileSync(path.join(priv, 'claude-accounts.json'), JSON.stringify({
    enabled: true, fiveHourThreshold: 90, weeklyThreshold: 95,
    accounts: [
      { id: 'default', label: 'Personal', enabled: true },
      { id: 'acct-0b0b0b', label: 'Team B', enabled: true },
      { id: 'acct-0c0c0c', label: 'Paused', enabled: false },
    ],
  }), { mode: 0o600 });
  const now = Math.floor(Date.now() / 1000);
  const counters = (id: string, five: [number, number], week: [number, number]) => fs.writeFileSync(
    path.join(dir, 'rate-limits.d', `${id}.json`),
    JSON.stringify({ updatedAt: now - 60, rate_limits: {
      five_hour: { used_percentage: five[0], resets_at: five[1] },
      seven_day: { used_percentage: week[0], resets_at: week[1] },
    } }),
  );
  counters('default', [97, now + 1800], [40, now + 86_400]);
  counters('acct-0b0b0b', [12, now - 30], [8, now + 86_400]);
  counters('acct-0c0c0c', [50, now + 1800], [50, now + 86_400]);

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31474), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const data = await page.evaluate(() => (window as unknown as Api).electronAPI.claude.getData());
    const handed = data?.accountRateLimits;
    recordValues({ accountRateLimits: handed });

    expect(handed?.map(a => [a.accountId, a.label])).toEqual([['default', 'Personal'], ['acct-0b0b0b', 'Team B']]);
    expect(handed?.[0]).toMatchObject({ fiveHour: { usedPercentage: 97 }, sevenDay: { usedPercentage: 40 } });
    // Team B's 5 h window reset 30 s ago: no figure, not its old 12 %.
    expect(handed?.[1]).toMatchObject({ fiveHour: null, sevenDay: { usedPercentage: 8 } });
  } finally {
    await app.close();
  }
});
