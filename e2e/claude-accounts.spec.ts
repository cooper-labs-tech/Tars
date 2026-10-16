import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Several Claude accounts, the registry and its Settings contract
 * (DESIGN-COMPTES-CLAUDE.md, B6), driven in the real app through the channels
 * the Settings page will call.
 *
 * The claude binary is a stand-in (Settings > CLI paths): its `auth status`
 * answers from a marker file in the directory CLAUDE_CONFIG_DIR names (or
 * ~/.claude without it), `auth login` writes that marker, `auth logout`
 * removes it, and every call is logged with the CLAUDE_CONFIG_DIR it saw.
 * No real account, no keychain, no network.
 *
 * What the run proves, in order:
 * - the option is off and account 1 is alone until somebody changes it, and
 *   account 1 is asked about without CLAUDE_CONFIG_DIR;
 * - an account added gets its own directory outside ~/.dorothy, with projects/
 *   linked to ~/.claude/projects, and is saved;
 * - its login terminal runs the binary's own login aimed at that directory,
 *   streams to the page, and the account reads as signed in once it closes;
 * - the same Claude account added a second time is signed out again and says
 *   which account already has it;
 * - the option refuses to turn on while ~/.claude/settings.json names an API
 *   key, or turns Bedrock on, and says which without quoting it; the
 *   account's copy of settings.json keeps none of the cloud credentials;
 * - settings, order and an agent's pin are saved where the next launch reads
 *   them, the registry in ~/.tars-private, and the pin is pushed to the window;
 * - a registry that does not parse is shown as such, and never written over.
 * Removing an account is left to the unit tests: shell.trashItem goes through
 * macOS, whose Trash is the real user's, not the sandbox's.
 */

type View = {
  registryError: string | null;
  settings: { enabled: boolean; fiveHourThreshold: number; weeklyThreshold: number; accounts: { id: string }[] };
  accounts: { id: string; label: string; configDir: string | null; signedIn: boolean | null; email: string | null; error: string | null }[];
};
type Api = {
  electronAPI: {
    claudeAccounts: {
      list(): Promise<{ success: boolean } & View>;
      add(p: { label: string }): Promise<{ success: boolean; account: View['accounts'][number]; error?: string }>;
      loginStart(p: { id: string; cols?: number; rows?: number }): Promise<{ success: boolean; ptyId: string; error?: string }>;
      onLoginData(cb: (e: { ptyId: string; data: string }) => void): () => void;
      onLoginExit(cb: (e: { ptyId: string; exitCode: number }) => void): () => void;
      setEnabled(on: boolean): Promise<{ success: boolean } & View>;
      setThresholds(p: { fiveHour: number; weekly: number }): Promise<{ success: boolean } & View>;
      reorder(ids: string[]): Promise<{ success: boolean } & View>;
      remove(id: string): Promise<{ success: boolean; error?: string }>;
      setAgentAccount(p: { agentId: string; accountId: string | null }): Promise<{ success: boolean; error?: string }>;
      onAgentChanged(cb: (e: { agentId: string; claudeAccountId: string | null; claudeAccountPin: string | null }) => void): () => void;
    };
    agent: { list(): Promise<Array<{ id: string; claudeAccountPin?: string }>> };
  };
};
type Win = Api & {
  loginSeen?: Record<string, { data: string; exit?: number }>;
  agentChanges?: { agentId: string; claudeAccountId: string | null; claudeAccountPin: string | null }[];
};

const AGENT = { id: 'w1', name: 'Worker One' };

function writeFakeClaude(home: string): string {
  const bin = path.join(home, 'fake-claude.cjs');
  fs.writeFileSync(bin, [
    `#!${process.execPath}`,
    "const fs = require('fs'); const path = require('path');",
    "const [cmd, sub] = process.argv.slice(2);",
    "const home = process.env.HOME;",
    "const d = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');",
    "fs.appendFileSync(path.join(home, 'fake-claude.log'), JSON.stringify({ cfg: process.env.CLAUDE_CONFIG_DIR ?? null, args: process.argv.slice(2) }) + '\\n');",
    "const marker = path.join(d, '.fake-signed-in');",
    "if (cmd === 'auth' && sub === 'status') {",
    "  if (fs.existsSync(marker)) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: fs.readFileSync(marker, 'utf8'), subscriptionType: 'max', configDirectory: d })); process.exit(0); }",
    "  console.log(JSON.stringify({ loggedIn: false, authMethod: 'none', configDirectory: d })); process.exit(1);",
    "} else if (cmd === 'auth' && sub === 'logout') {",
    "  fs.rmSync(marker, { force: true }); console.log('Successfully logged out from your Anthropic account.'); process.exit(0);",
    "} else if (cmd === 'auth' && sub === 'login') {",
    "  const next = path.join(home, 'fake-next-email');",
    "  const email = fs.existsSync(next) ? fs.readFileSync(next, 'utf8') : path.basename(d) + '@example.com';",
    "  process.stdout.write('Opening browser to sign in' + String.fromCharCode(13, 10));",
    "  setTimeout(() => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(marker, email); process.stdout.write('Login successful.'); process.exit(0); }, 300);",
    "} else { process.exit(2); }",
    '',
  ].join('\n'), { mode: 0o755 });
  return bin;
}

function calls(home: string): { cfg: string | null; args: string[] }[] {
  const log = path.join(home, 'fake-claude.log');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
}

const api = (page: Page) => ({
  list: () => page.evaluate(() => (window as unknown as Api).electronAPI.claudeAccounts.list()),
  state: async (id: string) => (await page.evaluate(() => (window as unknown as Api).electronAPI.claudeAccounts.list())).accounts.find(a => a.id === id),
});

/** Signs an account in through its login terminal, and returns what the terminal showed. */
async function login(page: Page, id: string): Promise<{ data: string; exit?: number }> {
  const started = await page.evaluate(async (accountId) => {
    const w = window as unknown as Win;
    w.loginSeen = w.loginSeen ?? {};
    const r = await w.electronAPI.claudeAccounts.loginStart({ id: accountId, cols: 100, rows: 30 });
    if (!r.success) return r;
    const seen = (w.loginSeen[r.ptyId] = { data: '' } as { data: string; exit?: number });
    w.electronAPI.claudeAccounts.onLoginData(e => { if (e.ptyId === r.ptyId) seen.data += e.data; });
    w.electronAPI.claudeAccounts.onLoginExit(e => { if (e.ptyId === r.ptyId) seen.exit = e.exitCode; });
    return r;
  }, id);
  expect(started.success, `login terminal for ${id}: ${started.error ?? ''}`).toBe(true);
  await expect.poll(() => page.evaluate(p => (window as unknown as Win).loginSeen?.[p]?.exit, started.ptyId), { timeout: 20_000 }).toBe(0);
  return page.evaluate(p => (window as unknown as Win).loginSeen![p], started.ptyId);
}

test.skip(process.platform === 'win32', 'several Claude accounts are off on a Windows build until they are ported; this runs on macOS and Linux');

test('claude accounts: added, signed in by their own login, refused twice, saved', async () => {
  test.setTimeout(150_000);
  // As the OS spells it (the fixture checks the app's folders against it), and
  // resolved once, as Tars resolves the accounts' root.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-accounts-'));
  const resolvedHome = fs.realpathSync(home);
  const dataDir = path.join(home, '.dorothy');
  const project = path.join(home, 'projects', 'demo');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  // Account 1 is already signed in, as a Mac with Claude Code is.
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.fake-signed-in'), 'one@example.com');
  const cli = writeFakeClaude(home);
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify([{
    id: AGENT.id, name: AGENT.name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], createdAt: '2026-09-28T08:00:00.000Z', lastActivity: '2026-09-28T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dataDir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude: cli },
  }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31487), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI?.claudeAccounts);
    const a = api(page);

    // Off, account 1 alone, and asked about without CLAUDE_CONFIG_DIR.
    const first = await a.list();
    expect(first.settings.enabled).toBe(false);
    expect(first.accounts.map(x => x.id)).toEqual(['default']);
    await expect.poll(async () => (await a.state('default'))?.email, { timeout: 20_000 }).toBe('one@example.com');
    expect(calls(home).filter(c => c.args.join(' ') === 'auth status')[0]?.cfg).toBeNull();

    // Added: its own directory, outside ~/.dorothy, sharing ~/.claude/projects.
    const added = await page.evaluate(() => (window as unknown as Api).electronAPI.claudeAccounts.add({ label: 'Max two' }));
    expect(added.success, added.error).toBe(true);
    const two = added.account;
    expect(two.signedIn).toBe(false);
    expect(two.configDir).toBe(path.join(resolvedHome, '.claude-accounts', two.id));
    expect(fs.readlinkSync(path.join(two.configDir!, 'projects'))).toBe(path.join(home, '.claude', 'projects'));
    expect((fs.statSync(two.configDir!).mode & 0o777).toString(8)).toBe('700');

    // Its own login, in a terminal aimed at its directory.
    const shown = await login(page, two.id);
    expect(shown.data).toContain('Opening browser to sign in');
    const loginCall = calls(home).find(c => c.args.join(' ') === 'auth login --claudeai');
    expect(loginCall?.cfg).toBe(two.configDir);
    await expect.poll(async () => (await a.state(two.id))?.email, { timeout: 20_000 }).toBe(`${two.id}@example.com`);

    // The same Claude account twice: signed out again, and the page is told who has it.
    const third = (await page.evaluate(() => (window as unknown as Api).electronAPI.claudeAccounts.add({ label: 'Max three' }))).account;
    fs.writeFileSync(path.join(home, 'fake-next-email'), 'one@example.com');
    await login(page, third.id);
    await expect.poll(async () => (await a.state(third.id))?.error ?? '', { timeout: 20_000 }).toContain('Account 1');
    expect((await a.state(third.id))?.signedIn).toBe(false);
    expect(fs.existsSync(path.join(third.configDir!, '.fake-signed-in'))).toBe(false);

    // Not while Claude Code would sign every folder in with one API key (the Audit's B3).
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-e2e-never-shown' } }));
    const refused = await page.evaluate(() => (window as unknown as Api).electronAPI.claudeAccounts.setEnabled(true)) as { success: boolean; error?: string };
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('ANTHROPIC_API_KEY');
    expect(refused.error).not.toContain('sk-ant-e2e-never-shown');

    // Nor while it runs on Bedrock, whose credentials every folder would share;
    // and the account's copy of settings.json keeps none of them.
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: {
      CLAUDE_CODE_USE_BEDROCK: '1', AWS_SECRET_ACCESS_KEY: 'e2e-aws-never-shown', KEEP: 'me',
    } }));
    const bedrock = await page.evaluate(() => (window as unknown as Api).electronAPI.claudeAccounts.setEnabled(true)) as { success: boolean; error?: string };
    expect(bedrock.success).toBe(false);
    expect(bedrock.error).toContain('CLAUDE_CODE_USE_BEDROCK');
    expect(bedrock.error).not.toContain('e2e-aws-never-shown');
    await login(page, third.id);
    const copied = fs.readFileSync(path.join(third.configDir!, 'settings.json'), 'utf8');
    expect(JSON.parse(copied)).toEqual({ env: { KEEP: 'me' } });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');

    // Settings, order and a pin, saved where the next launch reads them.
    const enabled = await page.evaluate(() => (window as unknown as Api).electronAPI.claudeAccounts.setEnabled(true));
    expect(enabled.success).toBe(true);
    await page.evaluate(() => (window as unknown as Api).electronAPI.claudeAccounts.setThresholds({ fiveHour: 85, weekly: 97 }));
    const order = [two.id, 'default', third.id];
    const reordered = await page.evaluate(ids => (window as unknown as Api).electronAPI.claudeAccounts.reorder(ids), order);
    expect(reordered.accounts.map(x => x.id)).toEqual(order);
    const saved = JSON.parse(fs.readFileSync(path.join(home, '.tars-private', 'claude-accounts.json'), 'utf8'));
    expect(saved).toMatchObject({ enabled: true, fiveHourThreshold: 85, weeklyThreshold: 97 });
    expect(saved.accounts.map((x: { id: string }) => x.id)).toEqual(order);
    expect(fs.statSync(path.join(home, '.tars-private', 'claude-accounts.json')).mode & 0o777).toBe(0o600);

    await page.evaluate(() => {
      const w = window as unknown as Win;
      w.agentChanges = [];
      w.electronAPI.claudeAccounts.onAgentChanged(e => w.agentChanges!.push(e));
    });
    const pinned = await page.evaluate(p => (window as unknown as Api).electronAPI.claudeAccounts.setAgentAccount(p), { agentId: AGENT.id, accountId: two.id });
    expect(pinned.success, pinned.error).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).agentChanges), { timeout: 10_000 })
      .toEqual([{ agentId: AGENT.id, claudeAccountId: null, claudeAccountPin: two.id }]);
    expect((await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find(x => x.id === AGENT.id)?.claudeAccountPin).toBe(two.id);
    await expect.poll(() => {
      // A bare array before the app first saves it, { version, agents } after.
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'agents.json'), 'utf8'));
      const onDisk = (Array.isArray(raw) ? raw : raw.agents) as { id: string; claudeAccountPin?: string }[];
      return onDisk.find(x => x.id === AGENT.id)?.claudeAccountPin;
    }, { timeout: 10_000 }).toBe(two.id);

    expect(await page.evaluate(() => (window as unknown as Api).electronAPI.claudeAccounts.remove('default'))).toMatchObject({ success: false });

    // A registry that does not parse: shown as account 1 alone, said so, and
    // never written over by the next change.
    const registry = path.join(home, '.tars-private', 'claude-accounts.json');
    const good = fs.readFileSync(registry, 'utf8');
    fs.writeFileSync(registry, '{ "accounts": [ broken');
    const frozen = await a.list();
    expect(frozen.registryError).toContain('claude-accounts.json');
    expect(frozen.accounts.map(x => x.id)).toEqual(['default']);
    const blocked = await page.evaluate(() => (window as unknown as Api).electronAPI.claudeAccounts.add({ label: 'Max four' }));
    expect(blocked.success).toBe(false);
    expect(fs.readFileSync(registry, 'utf8')).toBe('{ "accounts": [ broken');
    fs.writeFileSync(registry, good);
    expect((await a.list()).registryError).toBeNull();

    recordValues({
      accounts: (await a.list()).accounts.map(x => ({ id: x.id, label: x.label, signedIn: x.signedIn, email: x.email, error: x.error })),
      claudeCalls: calls(home),
      savedRegistry: saved,
      bedrockRefusal: bedrock.error,
      frozenRegistryError: frozen.registryError,
    });
  } finally {
    await app.close();
    await removeHome(home);
  }
});
