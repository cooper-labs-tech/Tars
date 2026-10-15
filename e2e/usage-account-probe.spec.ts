import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Each Claude account's windows read from Claude Code itself (get_usage), in
 * the real app (usage-probe.ts; PLAN-1.9.3.md, taken from T3 Code).
 *
 * The status line writes an account's counters only while a session on it
 * draws, so an account no agent used for half an hour, or one used on
 * claude.ai, read as unknown. Here the accounts option is on with two signed-in
 * accounts, account 1 has an older status-line file (31 %), and the claude
 * Tars runs is a stand-in that answers `auth status` and, over stream-json, a
 * `get_usage` control request with each account's own windows. A refresh of
 * the accounts (Settings' refresh) probes them: the Usage page is then handed
 * the probed windows, the per-model weekly included, and each probe ran with
 * its account's folder and without the traffic switch, which empties the
 * answer. The stand-in is never handed, and never asked for, a credential.
 *
 * The artefact: values.json with what the page was handed and each call the
 * stand-in saw.
 */

type Window = { usedPercentage: number; resetsAt: number } | null;
type Counters = { accountId: string; fiveHour: Window; sevenDay: Window; models?: Array<{ name: string; usedPercentage: number }>; updatedAt: number | null };
type Api = { electronAPI: {
  claude: { getData(): Promise<{ accountRateLimits: Counters[] } | null> };
  claudeAccounts: { refresh(id?: string): Promise<unknown> };
} };

function writeStandIn(home: string, log: string): string {
  const bin = path.join(home, 'stand-in-claude.cjs');
  const reset = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
  const answers = {
    default: { five: 32, week: 9, model: 4 },
    'acct-0b0b0b': { five: 70, week: 41, model: 12 },
  };
  fs.writeFileSync(bin, [
    `#!${process.execPath}`,
    "const fs = require('fs'); const path = require('path');",
    "const args = process.argv.slice(2);",
    "const d = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, config: process.env.CLAUDE_CONFIG_DIR ?? null, traffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null }) + '\\n');`,
    "if (args[0] === 'auth' && args[1] === 'status') {",
    "  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: path.basename(d) + '@example.com', subscriptionType: 'max', configDirectory: d })); process.exit(0);",
    "}",
    "if (args.includes('--input-format')) {",
    `  const answers = ${JSON.stringify(answers)};`,
    "  const mine = answers[process.env.CLAUDE_CONFIG_DIR ? path.basename(d) : 'default'];",
    "  let buf = '';",
    "  process.stdin.on('data', c => {",
    "    buf += c; const nl = buf.indexOf('\\n'); if (nl < 0) return;",
    "    const req = JSON.parse(buf.slice(0, nl));",
    `    const rate_limits = { five_hour: { utilization: mine.five, resets_at: ${JSON.stringify(reset(3))} }, seven_day: { utilization: mine.week, resets_at: ${JSON.stringify(reset(100))} }, model_scoped: [{ display_name: 'Fable', utilization: mine.model, resets_at: ${JSON.stringify(reset(100))} }] };`,
    "    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { subscription_type: 'max', rate_limits_available: true, rate_limits } } }) + '\\n');",
    "  });",
    "  return;",
    "}",
    "process.exit(2);",
    '',
  ].join('\n'), { mode: 0o755 });
  return bin;
}

test.skip(process.platform === 'win32', 'several Claude accounts are off on a Windows build until they are ported; this runs on macOS and Linux');

test("the Usage page is handed each Claude account's windows as Claude Code reads them, per-model weekly included", async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-account-probe-'));
  const dir = path.join(home, '.dorothy');
  const priv = path.join(home, '.tars-private');
  fs.mkdirSync(path.join(dir, 'rate-limits.d'), { recursive: true });
  fs.mkdirSync(priv, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, '.claude-accounts', 'acct-0b0b0b'), { recursive: true });
  // The registry resolves the home once (accountsRoot): the folder a probe is given.
  const second = path.join(fs.realpathSync(home), '.claude-accounts', 'acct-0b0b0b');
  const log = path.join(home, 'stand-in-calls.jsonl');
  const claude = writeStandIn(home, log);
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude } }));
  fs.writeFileSync(path.join(priv, 'claude-accounts.json'), JSON.stringify({
    enabled: true, fiveHourThreshold: 90, weeklyThreshold: 95,
    accounts: [
      { id: 'default', label: 'Personal', enabled: true },
      { id: 'acct-0b0b0b', label: 'Team B', enabled: true },
    ],
  }), { mode: 0o600 });
  // Account 1's status line, a minute older than the probe will be.
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(dir, 'rate-limits.d', 'default.json'), JSON.stringify({
    updatedAt: now - 60,
    rate_limits: { five_hour: { used_percentage: 31, resets_at: now + 3 * 3600 }, seven_day: { used_percentage: 9, resets_at: now + 100 * 3600 } },
  }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31467), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    await page.evaluate(() => (window as unknown as Api).electronAPI.claudeAccounts.refresh());
    const handed = async () => (await page.evaluate(() => (window as unknown as Api).electronAPI.claude.getData()))?.accountRateLimits ?? [];
    await expect.poll(async () => (await handed()).find(a => a.accountId === 'acct-0b0b0b')?.fiveHour?.usedPercentage ?? null, { timeout: 60_000 }).toBe(70);
    const counters = await handed();
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const probes = calls.filter(c => c.args.includes('--input-format'));
    recordValues({ accountRateLimits: counters, calls });

    const first = counters.find(a => a.accountId === 'default');
    const team = counters.find(a => a.accountId === 'acct-0b0b0b');
    // Newer than the status line's 31 %: the probe's 32 %.
    expect(first).toMatchObject({ fiveHour: { usedPercentage: 32 }, sevenDay: { usedPercentage: 9 }, models: [{ name: 'Fable', usedPercentage: 4 }] });
    expect(team).toMatchObject({ fiveHour: { usedPercentage: 70 }, sevenDay: { usedPercentage: 41 }, models: [{ name: 'Fable', usedPercentage: 12 }] });
    expect(probes.map(p => p.config).sort()).toEqual([null, second].sort());
    expect(probes.every(p => p.traffic === null), 'a probe ran with the traffic switch, which empties the answer').toBe(true);
  } finally {
    await app.close();
  }
});
