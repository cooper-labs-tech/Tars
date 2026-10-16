import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent starts on the Claude account with the most room, and a pin moves
 * it (DESIGN-COMPTES-CLAUDE.md B3 and B4), in the real app.
 *
 * The agent's CLI is a stand-in: it writes down the account variables its
 * process was started with, then waits like a CLI. The same script answers
 * `claude auth status` for the sign-ins, from a marker in each folder. The app
 * itself is started with a CLAUDE_CONFIG_DIR, as a Tars opened from a terminal
 * that had one would be: account 1 must not inherit it.
 *
 * What the run proves, in order:
 * - with account 1's 5 h counter at 95 % (over the 90 % threshold) and account
 *   2 measured at 10 %, a new agent starts on account 2: CLAUDE_CONFIG_DIR is
 *   account 2's folder, TARS_CLAUDE_ACCOUNT its id, the folder provisioned with
 *   the project's trust, and the Settings view lists the agent on it;
 * - pinned to account 1 and started again, it runs with CLAUDE_CONFIG_DIR
 *   removed and TARS_CLAUDE_ACCOUNT=default, and its record says so.
 */

type Api = {
  electronAPI: {
    claudeAccounts: {
      list(): Promise<{ success: boolean; accounts: { id: string; signedIn: boolean | null; agentIds: string[]; fiveHour: { usedPercentage: number } | null }[] }>;
      add(p: { label: string }): Promise<{ success: boolean; account: { id: string; configDir: string }; error?: string }>;
      setEnabled(on: boolean): Promise<{ success: boolean; error?: string }>;
      refresh(): Promise<{ success: boolean }>;
      setAgentAccount(p: { agentId: string; accountId: string | null }): Promise<{ success: boolean; error?: string }>;
    };
    agent: {
      start(p: { id: string; prompt: string }): Promise<unknown>;
      stop(id: string): Promise<unknown>;
      list(): Promise<Array<{ id: string; cliRunning?: boolean; claudeAccountId?: string }>>;
    };
  };
};

const AGENT = { id: 'w1', name: 'Worker One' };

function writeStandIn(home: string): string {
  const bin = path.join(home, 'fake-claude.cjs');
  fs.writeFileSync(bin, [
    `#!${process.execPath}`,
    "const fs = require('fs'); const path = require('path');",
    "const [cmd, sub] = process.argv.slice(2);",
    "const home = process.env.HOME;",
    "const d = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');",
    "if (cmd === 'auth' && sub === 'status') {",
    "  const m = path.join(d, '.fake-signed-in');",
    "  if (fs.existsSync(m)) { console.log(JSON.stringify({ loggedIn: true, email: fs.readFileSync(m, 'utf8'), subscriptionType: 'max' })); process.exit(0); }",
    "  console.log(JSON.stringify({ loggedIn: false })); process.exit(1);",
    "}",
    "const seen = {};",
    "for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'TARS_CLAUDE_ACCOUNT']) seen[k] = k in process.env ? process.env[k] : null;",
    "fs.appendFileSync(path.join(home, 'launches.jsonl'), JSON.stringify(seen) + '\\n');",
    "process.stdout.write('stand-in ready\\n');",
    "process.stdin.resume();",
    '',
  ].join('\n'), { mode: 0o755 });
  return bin;
}

function launches(home: string): Record<string, string | null>[] {
  const f = path.join(home, 'launches.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
}

const win = (page: Page) => page.evaluate.bind(page);

test.skip(process.platform === 'win32', 'several Claude accounts are off on a Windows build until they are ported; this runs on macOS and Linux');

test('an agent starts on the account with room, and a pin moves it', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-accounts-launch-'));
  const resolvedHome = fs.realpathSync(home);
  const dataDir = path.join(home, '.dorothy');
  const project = path.join(resolvedHome, 'projects', 'demo');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.fake-signed-in'), 'one@example.com');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  const cli = writeStandIn(home);
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify([{
    id: AGENT.id, name: AGENT.name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-09-28T08:00:00.000Z', lastActivity: '2026-09-28T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dataDir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude: cli } }));

  const app = await launchSandboxed(electron, home, {
    env: {
      NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31486), DOROTHY_E2E: '1',
      // As a Tars opened from a shell that had one.
      CLAUDE_CONFIG_DIR: path.join(home, 'inherited-config'),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI?.claudeAccounts);
    const ev = win(page);

    // Account 2, signed in; the option on.
    const added = await ev(() => (window as unknown as Api).electronAPI.claudeAccounts.add({ label: 'Max two' }));
    expect(added.success, added.error).toBe(true);
    const two = added.account;
    fs.writeFileSync(path.join(two.configDir, '.fake-signed-in'), 'two@example.com');
    await ev(() => (window as unknown as Api).electronAPI.claudeAccounts.refresh());
    const on = await ev(() => (window as unknown as Api).electronAPI.claudeAccounts.setEnabled(true));
    expect(on.success, on.error).toBe(true);

    // Account 1 at 95 % of its 5 h window, account 2 at 10 %: as their status lines would leave them.
    const now = Math.floor(Date.now() / 1000);
    const counters = path.join(dataDir, 'rate-limits.d');
    fs.mkdirSync(counters, { recursive: true });
    const limits = (p: number) => JSON.stringify({ updatedAt: now, rate_limits: { five_hour: { used_percentage: p, resets_at: now + 3600 }, seven_day: { used_percentage: 5, resets_at: now + 86400 } } });
    fs.writeFileSync(path.join(counters, 'default.json'), limits(95));
    fs.writeFileSync(path.join(counters, `${two.id}.json`), limits(10));

    await ev(id => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), AGENT.id);
    await expect.poll(() => launches(home).length, { timeout: 30_000, message: 'the stand-in CLI started' }).toBe(1);
    expect(launches(home)[0]).toEqual({ CLAUDE_CONFIG_DIR: two.configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: null, TARS_CLAUDE_ACCOUNT: two.id });
    const own = JSON.parse(fs.readFileSync(path.join(two.configDir, '.claude.json'), 'utf8'));
    expect(own.projects?.[project]?.hasTrustDialogAccepted, 'the project is trusted in account 2').toBe(true);
    const listed = await ev(() => (window as unknown as Api).electronAPI.claudeAccounts.list());
    expect(listed.accounts.find(a => a.id === two.id)).toMatchObject({ signedIn: true, agentIds: [AGENT.id], fiveHour: { usedPercentage: 10 } });
    expect((await ev(() => (window as unknown as Api).electronAPI.agent.list())).find(a => a.id === AGENT.id)?.claudeAccountId).toBe(two.id);

    // Pinned to account 1, started again: nothing of the inherited folder.
    await ev(id => (window as unknown as Api).electronAPI.agent.stop(id), AGENT.id);
    const pinned = await ev(p => (window as unknown as Api).electronAPI.claudeAccounts.setAgentAccount(p), { agentId: AGENT.id, accountId: 'default' });
    expect(pinned.success, pinned.error).toBe(true);
    await ev(id => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), AGENT.id);
    await expect.poll(() => launches(home).length, { timeout: 30_000, message: 'the stand-in CLI started again' }).toBe(2);
    expect(launches(home)[1]).toEqual({ CLAUDE_CONFIG_DIR: null, CLAUDE_SECURESTORAGE_CONFIG_DIR: null, TARS_CLAUDE_ACCOUNT: 'default' });
    expect((await ev(() => (window as unknown as Api).electronAPI.agent.list())).find(a => a.id === AGENT.id)?.claudeAccountId).toBe('default');

    recordValues({ launches: launches(home), accounts: (await ev(() => (window as unknown as Api).electronAPI.claudeAccounts.list())).accounts });
  } finally {
    await app.close();
    await removeHome(home);
  }
});
