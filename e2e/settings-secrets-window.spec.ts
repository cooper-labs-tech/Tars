import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The window's side of #466 (2.0.4): since the secrets left ~/.tars, Settings is handed none, and holds none.
 * Frames: `Secrets · Settings, Telegram` (whose rows Slack's now are: Telegram's bot went in 2.0.5, PR 545, and Settings,
 * Telegram says Telegram goes through Hermes, holding nothing), `· Settings, Providers, an API key`, `· Settings, Hermes connection`,
 * `· states`, `· CLIs, one detection` (each with its light copy).
 *
 * The real app on a sandbox HOME whose secrets are where 2.0.4 keeps them (~/.tars-private/settings-secrets.json, and
 * Hermes's connection with its token beside it, in hermes-token), every bot off. Tars's own dialog and the clipboard
 * are stood in for in the main process, so the run reads what Tars showed and copied, and never touches the machine's
 * clipboard. Asserted, once with the classic shell and once with the new interface:
 * 1. Slack, Discord, X, Memory backends and Providers: each secret seeded reads set, and no field, text or attribute
 *    of the page holds it, or the mask main hands the window; Telegram holds no secret at all. Slack's bot token:
 *    replace opens an empty field; a token set through it is the private file's and the row reads set again; clear
 *    asks once, then the file holds none and the row offers its empty field. OpenRouter's key: set and cleared
 *    through its row, its label says so.
 * 2. Hermes: the form's token reads set and is in no field, and its row says switching to OAuth keeps it, unused
 *    (nothing in the form clears it); replace then save puts a new one in its connection; copy secret, on Hermes's
 *    block in Gateways since #469's window, has Tars copy the webhook's secret, which the page never holds.
 * 3. One detection: CLI Paths shows, as it opens, the codex set in the settings (a stand-in that answers
 *    `codex-cli 9.9.9`), and Providers lists it as `codex 9.9.9`, its Command row naming that path, set in CLI Paths;
 *    for every CLI, CLI Paths shows a path exactly when Providers says ready. The login shell the detection asks is
 *    slow here (3 s, as under load), so CLI Paths is read once its detection has answered; opened again after
 *    Providers, it shows at once what Providers read and never says "looking" again.
 * Red on 2a2a019f (#466's head, the page before this): Telegram's bot token field holds the mask (1); Hermes's
 * token field holds it and copy secret copies through the page (2); CLI Paths shows nothing as it opens and Providers
 * reads `codex codex-cli 9.9.9` (3). Red on main 30a1c6b1 (3): CLI Paths opened again after Providers renders
 * "looking" until its own ask of main answers, each page holding a detection of its own; read then, Claude Code
 * showed no path where Providers said ready (the QA's train 3 of 2.0.4).
 * The artefact: values.json (the rows read, the private files before and after, what Tars showed and copied), the
 * screenshots, and with E2E_TRACE=on the app's trace.
 */

const MASK = '•'.repeat(8);
const SEEDED = {
  slackBotToken: 'xoxb-e2e-window-slack', slackAppToken: 'xapp-e2e-window-slack', discordBotToken: 'e2e-window-discord-token',
  socialDataApiKey: 'e2e-window-socialdata', xApiKey: 'e2e-window-x-key', xApiSecret: 'e2e-window-x-secret',
  xAccessToken: 'e2e-window-x-access', xAccessTokenSecret: 'e2e-window-x-access-secret',
  openRouterApiKey: 'sk-or-e2e-window-openrouter', deepSeekApiKey: 'sk-e2e-window-deepseek',
  memoryGbrainAuthToken: 'e2e-window-gbrain', memoryHonchoApiKey: 'e2e-window-honcho',
};
const HERMES_TOKEN = 'e2e-window-hermes-form-token';
const NEW_BOT = 'xoxb-e2e-window-slack-NEW';
const NEW_ROUTER = 'sk-or-e2e-window-openrouter-NEW';
const NEW_HERMES = 'e2e-window-hermes-form-token-NEW';
const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const DRIVEN = ['Claude Code', 'Codex', 'Qwen Code', 'Gemini CLI', 'Grok CLI', 'OpenCode', 'Pi', 'Amp'];
type Handoffs = { copied: string[]; dialogs: { message: string; detail: string }[] };

function seed(newInterface: boolean, tag: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-secrets-window-${tag}-`));
  const dir = path.join(home, '.tars');
  const priv = path.join(home, '.tars-private');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(priv, { recursive: true, mode: 0o700 });
  fs.mkdirSync(bin, { recursive: true });
  const codex = path.join(bin, 'codex');
  fs.writeFileSync(codex, '#!/bin/sh\n[ "$1" = "--version" ] && echo "codex-cli 9.9.9"\nexit 0\n', { mode: 0o755 });
  // A login shell as slow as a loaded machine's: the detection asks it for the PATH (cliPaths:detect, `-ilc`).
  const slowShell = path.join(bin, 'slow-login-shell');
  fs.writeFileSync(slowShell, '#!/bin/sh\nsleep 3\nprintf \'%s\\n\' "$PATH"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface,
    slackEnabled: false, discordEnabled: false, socialDataEnabled: false, xPostingEnabled: false,
    openRouterEnabled: true, deepSeekEnabled: true, memoryGbrainEnabled: false, memoryHonchoEnabled: false,
    cliPaths: { codex, additionalPaths: [] },
  }));
  fs.writeFileSync(path.join(priv, 'settings-secrets.json'), JSON.stringify(SEEDED), { mode: 0o600 });
  fs.writeFileSync(path.join(priv, 'hermes-connection.json'), JSON.stringify({ mode: 'remote', url: 'http://127.0.0.1:9', authMode: 'token' }), { mode: 0o600 });
  fs.writeFileSync(path.join(priv, 'hermes-token'), HERMES_TOKEN, { mode: 0o600 });
  const secrets = () => JSON.parse(fs.readFileSync(path.join(priv, 'settings-secrets.json'), 'utf8')) as Record<string, string>;
  const settings = () => JSON.parse(fs.readFileSync(path.join(dir, 'app-settings.json'), 'utf8')) as Record<string, unknown>;
  /** The gateway's token, which Tars keeps apart from the rest of the connection (hermes-config.ts, since 1.9.2). */
  const hermesToken = () => fs.readFileSync(path.join(priv, 'hermes-token'), 'utf8').trim();
  const webhookSecret = () => fs.readFileSync(path.join(priv, 'hermes-webhook-secret'), 'utf8').trim();
  return { home, codex, slowShell, secrets, settings, hermesToken, webhookSecret };
}

/**
 * Tars's own dialog and the clipboard, stood in for in the main process before anything is copied: a run must never
 * write the machine's clipboard, and checks that each stand-in took before it goes on.
 */
async function standInForHandoffs(app: ElectronApplication) {
  await app.evaluate(({ clipboard, dialog }) => {
    const g = globalThis as unknown as { __e2eHandoffs: { copied: string[]; dialogs: { message: string; detail: string }[] } };
    g.__e2eHandoffs = { copied: [], dialogs: [] };
    const write = (text: string) => { g.__e2eHandoffs.copied.push(text); };
    clipboard.writeText = write as typeof clipboard.writeText;
    const box = (async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { message?: string; detail?: string };
      g.__e2eHandoffs.dialogs.push({ message: String(options.message ?? ''), detail: String(options.detail ?? '') });
      return { response: 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    dialog.showMessageBox = box;
    if (clipboard.writeText !== write || dialog.showMessageBox !== box) throw new Error('the clipboard or the dialog could not be stood in for');
  });
}
const handoffs = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __e2eHandoffs: Handoffs }).__e2eHandoffs);

/** Every place a page can hold a string: its text, its fields, its attributes. Which of `needles` it holds. */
const held = (page: Page, needles: string[]) => page.evaluate((list) => {
  const places = [
    document.body.innerText,
    ...Array.from(document.querySelectorAll('input, textarea')).map((e) => (e as HTMLInputElement).value),
    ...Array.from(document.querySelectorAll('*')).flatMap((e) => Array.from(e.attributes).map((a) => a.value)),
  ];
  return list.filter((n) => places.some((p) => p.includes(n)));
}, needles);

async function open(page: Page) {
  await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('settings-nav')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 15_000 });
}
async function section(page: Page, group: string, child: string) {
  const nav = page.getByTestId('settings-nav');
  await nav.getByText(group, { exact: true }).first().click({ timeout: 30_000 });
  await nav.getByText(child, { exact: true }).first().click({ timeout: 10_000 });
}
const rowsOf = (page: Page) => page.locator('[data-settings-row]');
const rowOf = (page: Page, label: string) =>
  rowsOf(page).filter({ has: page.locator('[data-settings-label]', { hasText: new RegExp(`^${label.replace(/[+()]/g, '\\$&')}$`) }) });

async function launch(newInterface: boolean, tag: string, base: number, env: (sandbox: ReturnType<typeof seed>) => Record<string, string> = () => ({})) {
  const sandbox = seed(newInterface, tag);
  const app = await launchSandboxed(electron, sandbox.home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(base), DOROTHY_E2E: '1', ...env(sandbox) },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  listenForErrors(page, errors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.setViewportSize({ width: 1440, height: 900 });
  await standInForHandoffs(app);
  await open(page);
  await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
  return { ...sandbox, app, page, errors };
}

for (const newInterface of [false, true]) {
  const shell = newInterface ? ' (new interface)' : '';

  test(`settings shows each secret as set and never holds it; slack's and openrouter's are set and cleared through their rows${shell}`, async () => {
    test.setTimeout(300_000);
    const s = await launch(newInterface, 'pages', newInterface ? 31552 : 31551);
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const { page } = s;
    const needles = [...Object.values(SEEDED), MASK];
    try {
      // Telegram: nothing of a bot since 2.0.5, and no secret.
      await section(page, 'Integrations', 'Telegram');
      await expect(rowOf(page, 'Telegram goes through Hermes')).toBeVisible({ timeout: 30_000 });
      await expect(rowsOf(page).locator('input')).toHaveCount(0);
      expect(await held(page, needles), 'Telegram holds no secret').toEqual([]);
      await stepShot(page, '01-telegram-through-hermes');

      // Slack's bot token: replace opens an empty field; the token set lands in the private file and reads set again.
      await section(page, 'Integrations', 'Slack');
      await expect(rowOf(page, 'Bot token')).toContainText('a token is set', { timeout: 30_000 });
      await expect(rowOf(page, 'Bot token').locator('input')).toHaveCount(0);
      expect(s.secrets()).toMatchObject(SEEDED);
      await rowOf(page, 'Bot token').getByRole('button', { name: 'replace', exact: true }).click();
      const field = rowOf(page, 'Bot token').locator('input');
      await expect(field).toHaveValue('');
      await field.fill(NEW_BOT);
      await rowOf(page, 'Bot token').getByRole('button', { name: 'set', exact: true }).click();
      await expect(rowOf(page, 'Bot token')).toContainText('a token is set', { timeout: 15_000 });
      await expect(rowOf(page, 'Bot token').locator('input')).toHaveCount(0);
      await expect.poll(() => s.secrets().slackBotToken, { timeout: 15_000 }).toBe(NEW_BOT);
      expect(await held(page, [...needles, NEW_BOT]), 'the new token is held nowhere').toEqual([]);
      await stepShot(page, '02-slack-replaced');

      // Clear asks once; then the file holds none and the row offers its empty field.
      await rowOf(page, 'Bot token').getByRole('button', { name: 'clear', exact: true }).click();
      const ask = page.getByRole('alertdialog', { name: 'Clear Bot token' });
      await expect(ask).toBeVisible();
      await stepShot(page, '03-slack-clear-asks');
      await ask.getByRole('button', { name: 'clear', exact: true }).click();
      await expect.poll(() => s.secrets().slackBotToken ?? '', { timeout: 15_000 }).toBe('');
      await expect(rowOf(page, 'Bot token').locator('input')).toHaveValue('');
      keep({ slack: { secretsAfter: Object.keys(s.secrets()) } });

      // Slack, Discord, X and SocialData, Memory backends: each set, held nowhere.
      const readsSet: Record<string, string[]> = {};
      for (const [group, child, rows] of [
        ['Integrations', 'Slack', ['App token']],
        ['Integrations', 'Discord', ['Bot token']],
        ['Integrations', 'X (Twitter)', ['SocialData key', 'Consumer key', 'Consumer secret', 'Access token', 'Access token secret']],
        ['Workspace', 'Memory Backends', ['Auth token', 'API key']],
      ] as const) {
        await section(page, group, child);
        for (const label of rows) await expect(rowOf(page, label), `${child}, ${label}`).toContainText(/a (key|token|secret) is set/, { timeout: 30_000 });
        readsSet[child] = await rowsOf(page).locator('[data-settings-label]').allTextContents();
        expect(await held(page, needles), `${child} holds no secret`).toEqual([]);
        await stepShot(page, `05-${child.replace(/\W+/g, '-').toLowerCase()}`);
      }
      keep({ readsSet });

      // Providers: OpenRouter's key set, replaced and cleared through its row.
      await section(page, 'AI & Providers', 'Providers');
      const router = rowsOf(page).filter({ has: page.locator('[data-settings-label]', { hasText: /^OpenRouter/ }) });
      await expect(router).toContainText('key set', { timeout: 30_000 });
      await router.getByRole('button', { name: 'configure' }).click();
      const key = rowOf(page, 'API key');
      await expect(key).toContainText('a key is set');
      await expect(key.locator('input')).toHaveCount(0);
      expect(await held(page, needles), 'Providers holds no secret').toEqual([]);
      await stepShot(page, '06-providers-key-set');
      await key.getByRole('button', { name: 'replace', exact: true }).click();
      await expect(key.locator('input')).toHaveValue('');
      await key.locator('input').fill(NEW_ROUTER);
      await key.getByRole('button', { name: 'set', exact: true }).click();
      await expect.poll(() => s.secrets().openRouterApiKey, { timeout: 15_000 }).toBe(NEW_ROUTER);
      await expect(key).toContainText('a key is set');
      await key.getByRole('button', { name: 'clear', exact: true }).click();
      await page.getByRole('alertdialog', { name: 'Clear API key' }).getByRole('button', { name: 'clear', exact: true }).click();
      await expect.poll(() => s.secrets().openRouterApiKey ?? '', { timeout: 15_000 }).toBe('');
      await expect(router).toContainText('no key');
      expect(await held(page, [...needles, NEW_ROUTER]), 'Providers holds no secret after').toEqual([]);
      await stepShot(page, '07-providers-key-cleared');

      keep({ secretsAfter: Object.fromEntries(Object.entries(s.secrets()).map(([k, v]) => [k, v ? 'set' : ''])), pageErrors: s.errors });
      expect(s.errors, s.errors.join('\n')).toEqual([]);
    } finally {
      await s.app.close().catch(() => { /* gone */ });
      await removeHome(s.home);
    }
  });

  test(`hermes's token reads set and is in no field, and its webhook secret is copied by tars${shell}`, async () => {
    test.setTimeout(240_000);
    const s = await launch(newInterface, 'hermes', newInterface ? 31554 : 31553);
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const { page } = s;
    try {
      await section(page, 'Hermes', 'Connection');
      const auth = rowOf(page, 'Auth');
      await expect(auth).toContainText('a token is set', { timeout: 30_000 });
      // Nothing in the form clears it (main keeps it on the mask or an empty field): the row says what OAuth does to it.
      await expect(auth).toContainText('Switching to OAuth keeps it, unused.');
      await expect(auth.locator('input')).toHaveCount(0);
      expect(await held(page, [HERMES_TOKEN, MASK]), 'Hermes holds no token').toEqual([]);
      await stepShot(page, '01-hermes-token-set');

      // The webhook's secret is the default gateway's: Gateways shows it on Hermes's block since #469's window.
      await section(page, 'Hermes', 'Gateways');
      const webhookRow = page.getByRole('region', { name: 'Hermes', exact: true }).locator('[data-settings-row]')
        .filter({ has: page.locator('[data-settings-label]', { hasText: /^Secret$/ }) });
      await webhookRow.getByRole('button', { name: 'copy secret', exact: true }).click({ timeout: 30_000 });
      await expect(webhookRow.getByRole('button', { name: 'copied', exact: true })).toBeVisible();
      const secret = s.webhookSecret();
      expect(secret.length).toBeGreaterThan(20);
      expect((await handoffs(s.app)).copied).toEqual([secret]);
      expect(await held(page, [secret]), 'the webhook secret is held nowhere').toEqual([]);
      await stepShot(page, '02-hermes-secret-copied');

      await section(page, 'Hermes', 'Connection');
      await auth.getByRole('button', { name: 'replace', exact: true }).click({ timeout: 30_000 });
      await expect(auth.locator('input')).toHaveValue('');
      await auth.locator('input').fill(NEW_HERMES);
      await rowOf(page, 'Status').getByRole('button', { name: 'save', exact: true }).click();
      await expect.poll(() => s.hermesToken(), { timeout: 15_000 }).toBe(NEW_HERMES);
      await expect(auth).toContainText('a token is set', { timeout: 15_000 });
      await expect(auth.locator('input')).toHaveCount(0);
      expect(await held(page, [HERMES_TOKEN, NEW_HERMES, MASK]), 'Hermes holds no token after').toEqual([]);
      await stepShot(page, '03-hermes-token-replaced');

      keep({ copies: (await handoffs(s.app)).copied.length, pageErrors: s.errors });
      expect(s.errors, s.errors.join('\n')).toEqual([]);
    } finally {
      await s.app.close().catch(() => { /* gone */ });
      await removeHome(s.home);
    }
  });

  test(`cli paths and providers read one detection, and a cli's version is its number alone${shell}`, async () => {
    test.setTimeout(240_000);
    const s = await launch(newInterface, 'clis', newInterface ? 31556 : 31555, (sandbox) => ({ SHELL: sandbox.slowShell }));
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const { page } = s;
    try {
      // CLI Paths, as it opens: the codex set in the settings, then what Tars found for the others, once the detection
      // has answered. Codex's path is the settings' and shows before it: read then, the others raced the detection
      // (red once in each full run of trains 2b and 3 of 2.0.4).
      await section(page, 'AI & Providers', 'CLI Paths');
      await expect(rowOf(page, 'Codex').locator('[data-cli-path]')).toHaveText(s.codex, { timeout: 30_000 });
      const looking = page.locator('[data-settings-hint]', { hasText: /^looking$/ });
      await expect(looking).toHaveCount(0, { timeout: 30_000 });
      const found: Record<string, boolean> = {};
      for (const name of DRIVEN) found[name] = (await rowOf(page, name).locator('[data-cli-path]').count()) > 0;
      await stepShot(page, '01-cli-paths');

      // Providers: the same CLIs ready, codex's version its number alone, its Command row naming that path.
      await section(page, 'AI & Providers', 'Providers');
      const list = page.getByRole('list', { name: 'Command-line agents' });
      await expect(list).toBeVisible({ timeout: 30_000 });
      const codex = list.getByRole('button', { name: /^Codex/ });
      await expect(codex).toContainText('codex 9.9.9', { timeout: 30_000 });
      await expect(codex).not.toContainText('codex-cli');
      const ready: Record<string, boolean> = {};
      for (const name of DRIVEN) {
        const item = list.getByRole('button', { name: new RegExp(`^${name}`) });
        await expect(item).not.toContainText('checking', { timeout: 30_000 });
        ready[name] = (await item.innerText()).includes('ready');
      }
      keep({ found, ready });
      expect(ready, 'Providers says ready exactly where CLI Paths shows a path').toEqual(found);

      // CLI Paths again: the window holds the detection already, so it shows it as it opens, read at once, and never
      // says "looking" (watched from before the click). It asked main again on every opening, and said "looking" until
      // main answered: read then, Claude Code had no path where Providers said ready.
      await page.evaluate(() => {
        const w = window as unknown as { __lookingSeen: number };
        w.__lookingSeen = 0;
        const seen = () => { if (Array.from(document.querySelectorAll('[data-settings-hint]')).some((e) => e.textContent === 'looking')) w.__lookingSeen += 1; };
        new MutationObserver(seen).observe(document.body, { childList: true, subtree: true, characterData: true });
      });
      await section(page, 'AI & Providers', 'CLI Paths');
      await expect(rowOf(page, 'Codex').locator('[data-cli-path]')).toHaveText(s.codex);
      const again: Record<string, boolean> = {};
      for (const name of DRIVEN) again[name] = (await rowOf(page, name).locator('[data-cli-path]').count()) > 0;
      const lookingSeen = await page.evaluate(() => (window as unknown as { __lookingSeen: number }).__lookingSeen);
      keep({ again, lookingSeen });
      expect(lookingSeen, 'CLI Paths opened again never says looking').toBe(0);
      expect(again, 'CLI Paths opened again shows at once what Providers read').toEqual(ready);
      await stepShot(page, '02-cli-paths-again');

      await section(page, 'AI & Providers', 'Providers');
      await codex.click();
      const command = page.getByRole('region', { name: 'Codex settings' }).locator('[data-settings-row]').filter({ has: page.locator('[data-settings-label]', { hasText: /^Command$/ }) });
      await expect(command.locator('[data-cli-path]')).toHaveText(s.codex);
      await expect(command).toContainText('set in CLI Paths');
      await stepShot(page, '03-providers-codex');

      keep({ pageErrors: s.errors });
      expect(s.errors, s.errors.join('\n')).toEqual([]);
    } finally {
      await s.app.close().catch(() => { /* gone */ });
      await removeHome(s.home);
    }
  });
}
