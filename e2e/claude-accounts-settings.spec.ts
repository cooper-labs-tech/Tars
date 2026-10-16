import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Settings > Claude accounts, and the account an agent runs on, driven through
 * the page in the real app on #263's channels. Frames: `Settings · Claude
 * accounts`, its states sheet and `Agent · Claude account`.
 *
 * The claude binary is a stand-in (Settings > CLI paths), as in
 * claude-accounts.spec.ts: `auth status` answers from a marker in the folder
 * CLAUDE_CONFIG_DIR names (~/.claude without it), `auth login` writes it after
 * printing a line. No real account, no keychain, no network.
 *
 * What the run proves, in order, each step a picture:
 * - the section sits under AI & Providers, off, and says how accounts sign in
 *   and that each must be your own, its limits Anthropic's;
 * - turned on, it lists account 1 as Claude Code reports it;
 * - add an account names it, and its terminal shows Claude Code's own sign-in
 *   and says signed in once Claude Code does;
 * - a rename, a move and a threshold reach the registry main keeps, and a
 *   threshold main would refuse never does;
 * - remove asks first, and Cancel removes nothing;
 * - the agent's card names its account, and its menu pins the agent, which
 *   the card hears from main's push (claude-accounts:agent-changed);
 * - a move by Tars (#269) is said as one grey line in the agent's window and
 *   in its Dashboard panel, and the account's title says where it came from.
 *   The move is made by main's own movedLaunch and announceAgentAccount, the
 *   calls a launch on another account ends with; the launch itself is #269's
 *   e2e (claude-accounts-switching.spec.ts);
 * - a registry main cannot read is said in the section, in main's words.
 * Removing for real is left to #263's unit tests: shell.trashItem goes to the
 * real user's Trash.
 */

const AGENT = { id: 'w1', name: 'Worker One' };

function writeFakeClaude(home: string): string {
  const bin = path.join(home, 'fake-claude.cjs');
  fs.writeFileSync(bin, [
    `#!${process.execPath}`,
    "const fs = require('fs'); const path = require('path');",
    "const [cmd, sub] = process.argv.slice(2);",
    "const d = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');",
    "const marker = path.join(d, '.fake-signed-in');",
    "if (cmd === 'auth' && sub === 'status') {",
    "  if (fs.existsSync(marker)) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: fs.readFileSync(marker, 'utf8'), subscriptionType: 'max', configDirectory: d })); process.exit(0); }",
    "  console.log(JSON.stringify({ loggedIn: false, authMethod: 'none', configDirectory: d })); process.exit(1);",
    "} else if (cmd === 'auth' && sub === 'logout') {",
    "  fs.rmSync(marker, { force: true }); process.exit(0);",
    "} else if (cmd === 'auth' && sub === 'login') {",
    "  process.stdout.write('Opening browser to sign in' + String.fromCharCode(13, 10));",
    "  setTimeout(() => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(marker, path.basename(d) + '@example.com'); process.stdout.write('Login successful.'); process.exit(0); }, 600);",
    "} else { process.exit(2); }",
    '',
  ].join('\n'), { mode: 0o755 });
  return bin;
}

/** Main's registry of accounts, kept where no agent is handed it (#263, after the design gate). */
const registry = (home: string) => JSON.parse(fs.readFileSync(path.join(home, '.tars-private', 'claude-accounts.json'), 'utf8'));
const row = (page: Page, id: string) => page.locator(`[data-account-row="${id}"]`);
type Move = { agentId: string; from: string; to: string; reason: 'limit' | 'threshold'; window: 'fiveHour' | 'sevenDay'; usedPercentage: number | null; at: number };
/** What a launch on another account ends with in main (#269): the move told, then the account. */
async function moveInMain(app: ElectronApplication, move: Move): Promise<void> {
  await app.evaluate(({ app: electronApp }, m) => {
    // By absolute path: the module cache then hands back main's own instances.
    const main = (process as unknown as { mainModule: NodeJS.Module }).mainModule;
    const req = (file: string) => main.require(`${electronApp.getAppPath()}/electron/dist/${file}`);
    const { agents } = req('core/agent-manager');
    const { movedLaunch } = req('services/claude-accounts/switching');
    const { announceAgentAccount } = req('handlers/claude-accounts-handlers');
    const agent = agents.get(m.agentId);
    if (!agent) throw new Error(`no agent ${m.agentId} in main`);
    movedLaunch(agent, m);
    agent.claudeAccountId = m.to;
    announceAgentAccount(agent);
  }, move);
}
const hhmm = (at: number) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** Main's sentence for a registry that does not parse (#263, registryProblem). */
const UNREADABLE = '~/.tars-private/claude-accounts.json does not read as a list of accounts. Nothing is changed until it is fixed or removed.';

test.skip(process.platform === 'win32', 'several Claude accounts are off on a Windows build until they are ported; this runs on macOS and Linux');

test('claude accounts: the section, the sign-in terminal, and an agent pinned from its card', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-accounts-ui-'));
  const dataDir = path.join(home, '.dorothy');
  const project = path.join(home, 'projects', 'demo');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  // Account 1 is signed in already, as on a Mac that has Claude Code.
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
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: `${DEV_URL}/settings`, DOROTHY_API_PORT: apiPort(31486), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });

    // Under AI & Providers, after Providers; off, with its three lines.
    await page.getByText('AI & Providers', { exact: true }).click();
    await page.getByText('Claude accounts', { exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Use several Claude subscriptions' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText('Each account signs in through Claude Code itself, in a terminal Tars opens. Tars never sees the sign-in.')).toBeVisible();
    await expect(page.getByText("Each account must be your own, and its limits are Anthropic's.")).toBeVisible();
    await expect(page.locator('[data-account-row]')).toHaveCount(0);
    await stepShot(page, '01-off');

    // On: account 1, as Claude Code reports it.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(row(page, 'default')).toContainText('Account 1');
    await expect(row(page, 'default')).toContainText('signed in', { timeout: 20_000 });
    await expect(row(page, 'default')).toContainText('one@example.com · max · 0 agents');
    await expect(row(page, 'default')).toContainText('~/.claude');
    await expect(row(page, 'default').getByRole('button', { name: 'remove' })).toHaveCount(0);
    await expect(page.getByText('Agents go where the most room is left, and this order breaks ties. 1 of 5.')).toBeVisible();
    await stepShot(page, '02-on-one-account');

    // Add an account: named, then Claude Code's own sign-in in its terminal.
    await page.getByRole('button', { name: 'add an account' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add a Claude account' })).toBeVisible();
    await expect(dialog.getByLabel('Name')).toHaveValue('Account 2');
    await dialog.getByLabel('Name').fill('Max two');
    await dialog.getByRole('button', { name: 'Add and sign in' }).click();
    await expect(dialog.locator('.xterm-rows')).toContainText('Opening browser to sign in', { timeout: 20_000 });
    await stepShot(page, '03-signing-in');
    const two = (registry(home).accounts as Array<{ id: string; label: string }>).find(a => a.label === 'Max two')!;
    expect(two.id).toMatch(/^acct-[0-9a-f]{6}$/);
    await expect(dialog.getByText(`Signed in as ${two.id}@example.com.`)).toBeVisible({ timeout: 20_000 });
    await stepShot(page, '04-signed-in');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row(page, two.id)).toContainText('signed in');
    await expect(row(page, two.id)).toContainText(`~/.claude-accounts/${two.id}`);
    await expect(row(page, two.id)).toContainText('No use seen yet: the first agent that runs on it measures it.');

    // A rename, a move and a threshold reach main's registry.
    await row(page, two.id).getByRole('button', { name: 'Rename Max two' }).click();
    await row(page, two.id).getByLabel('Name of Max two').fill('Work');
    await row(page, two.id).getByLabel('Name of Max two').press('Enter');
    await expect.poll(() => registry(home).accounts.find((a: { id: string }) => a.id === two.id)?.label).toBe('Work');
    await row(page, two.id).getByRole('button', { name: 'Move Work up' }).click();
    await expect.poll(() => registry(home).accounts.map((a: { id: string }) => a.id)).toEqual([two.id, 'default']);
    const five = page.getByLabel('5 h threshold');
    await five.fill('85');
    await five.press('Tab');
    await expect.poll(() => registry(home).fiveHourThreshold).toBe(85);
    await five.fill('120');
    await five.press('Tab');
    await expect(page.getByText('A threshold is a whole percentage from 50 to 100.')).toBeVisible();
    await expect(five).toHaveValue('85');
    expect(registry(home).fiveHourThreshold).toBe(85);
    await stepShot(page, '05-renamed-moved-threshold-refused');

    // Remove asks first; Cancel removes nothing.
    await row(page, two.id).getByRole('button', { name: 'remove' }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Remove Work?' })).toBeVisible();
    await stepShot(page, '06-remove-asks');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(registry(home).accounts).toHaveLength(2);

    // The agent's card names its account, and its menu pins the agent.
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    const control = page.getByRole('button', { name: `Claude account of ${AGENT.name}` });
    await expect(control).toHaveText('Account 1', { timeout: 20_000 });
    await expect(control).toHaveAttribute('title', 'Runs on Account 1, chosen by Tars.');
    await control.click();
    await expect(page.getByText('Run this agent on', { exact: true })).toBeVisible();
    await stepShot(page, '07-agent-menu');
    await page.locator(`[role="option"][data-value="${two.id}"]`).click();
    await expect.poll(() => {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'agents.json'), 'utf8'));
      const agents = (Array.isArray(raw) ? raw : raw.agents) as Array<{ id: string; claudeAccountPin?: string }>;
      return agents.find(a => a.id === AGENT.id)?.claudeAccountPin;
    }, { timeout: 10_000 }).toBe(two.id);
    await expect(control).toHaveText('Work · pinned', { timeout: 10_000 });
    await stepShot(page, '08-agent-pinned');

    // Back to Automatic, then a move by Tars while the agent's window is open:
    // one grey line in its terminal, and the account's title says it.
    await control.click();
    await page.locator('[role="option"][data-value="auto"]').click();
    await expect(control).toHaveText('Account 1', { timeout: 10_000 });
    await page.getByRole('button', { name: 'open', exact: true }).click();
    const agentWindow = page.getByRole('dialog');
    const windowControl = agentWindow.getByRole('button', { name: `Claude account of ${AGENT.name}` });
    await expect(windowControl).toHaveText('Account 1', { timeout: 20_000 });
    // The header shows before the terminal: a line is written in a terminal
    // that is there when the move is told, so wait for its first line.
    await expect(agentWindow.locator('.xterm-rows')).toContainText(`${AGENT.name} is not running`, { timeout: 30_000 });
    const past: Move = { agentId: AGENT.id, from: 'default', to: two.id, reason: 'threshold', window: 'fiveHour', usedPercentage: 91.4, at: Date.now() };
    await moveInMain(app, past);
    const pastLine = `(Moved to Work at ${hhmm(past.at)}: Account 1 was at 91% of its 5 h window.)`;
    await expect(agentWindow.locator('.xterm-rows')).toContainText(pastLine, { timeout: 10_000 });
    await expect(windowControl).toHaveText('Work', { timeout: 10_000 });
    const pastTitle = `Runs on Work, chosen by Tars. Moved from Account 1 at ${hhmm(past.at)}: Account 1 was at 91% of its 5 h window.`;
    await expect(windowControl).toHaveAttribute('title', pastTitle);
    await expect(agentWindow.locator('.xterm-rows').getByText('(Moved to', { exact: false })).toHaveCount(1);
    await stepShot(page, '09-moved-in-the-window');
    // Its close button: Escape goes to the terminal, which has the focus.
    await agentWindow.getByRole('button', { name: 'close', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Then one at a limit while its Dashboard panel shows.
    await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
    const panelControl = page.getByRole('button', { name: `Claude account of ${AGENT.name}` });
    await expect(panelControl).toHaveText('Work', { timeout: 20_000 });
    await expect(panelControl).toHaveAttribute('title', pastTitle);
    await expect(page.locator('.xterm-rows').first()).toContainText('(Session idle)', { timeout: 30_000 });
    const cut: Move = { agentId: AGENT.id, from: two.id, to: 'default', reason: 'limit', window: 'fiveHour', usedPercentage: 100, at: Date.now() };
    await moveInMain(app, cut);
    const cutLine = `(Moved to Account 1 at ${hhmm(cut.at)}: Work hit its 5 h limit.)`;
    await expect(page.locator('.xterm-rows').first()).toContainText(cutLine, { timeout: 10_000 });
    await expect(panelControl).toHaveText('Account 1', { timeout: 10_000 });
    await expect(panelControl).toHaveAttribute('title', `Runs on Account 1, chosen by Tars. Moved from Work at ${hhmm(cut.at)}: Work hit its 5 h limit.`);
    await stepShot(page, '10-moved-in-the-panel');

    // A registry main cannot read: the section says so, in main's words, and
    // every change waits for it to be fixed or removed.
    const kept = registry(home);
    fs.writeFileSync(path.join(home, '.tars-private', 'claude-accounts.json'), '{ not a list');
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await page.getByText('AI & Providers', { exact: true }).click();
    await page.getByText('Claude accounts', { exact: true }).click();
    await expect(page.getByText(UNREADABLE)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(UNREADABLE)).toHaveCount(1);
    await stepShot(page, '11-registry-unreadable');

    expect(errors, errors.join('\n')).toEqual([]);
    recordValues({
      registry: kept,
      pin: two.id,
      moves: { windowLine: pastLine, windowTitle: pastTitle, panelLine: cutLine },
      unreadableSaid: UNREADABLE,
      pageErrors: errors,
    });
  } finally {
    await app.close();
    await removeHome(home);
  }
});
