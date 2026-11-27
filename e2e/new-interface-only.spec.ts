import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * 2.1.0: the new interface is the only one (the owner's decision of 26/11). The shell of
 * `Shell · chats` opens for everyone, whatever the settings file
 * says, the classic sidebar is gone, and nothing it gave a user is lost with it: the Light/Dark toggle
 * (now a row of Settings, Preferences, the owner's choice), the Cmd+digit page shortcuts (Ctrl on
 * Windows), and the chats' conversations, which the main process followed only while the switch was on.
 * The Windows caption over the new shell is in desktop-shell.win32.spec.ts.
 *
 * Written before the code, red on main (2.0.6). How it can fail, each test below for one of them:
 * 1. A fresh install, with no settings file, still opens the classic shell: the switch's default is off.
 * 2. A settings file that says `newInterface: false` (whoever turned the preview off) still opens the
 *    classic shell; or the key stays in the file after the next save, read by nothing: the save must drop
 *    it, as it drops the other retired settings, even when a window still sends it.
 * 3. The theme can no longer be switched: the toggle lived in the classic sidebar only. Or it is in
 *    Settings, Preferences but does not switch the theme, or the choice is lost at the next launch. Or
 *    Preferences still offers the New interface switch, which would do nothing.
 * 4. The digit shortcuts are dead: they were mounted by the classic sidebar only. Or a digit is moved:
 *    1 Dashboard, 2 Agents, 3 Kanban, 4 Schedules, 5 Review, 6 Logs, 7 Vault, 8 Projects, 9 Extensions,
 *    0 Usage. A page of the main menu is navigated to and its entry is current; a page of More opens as
 *    its card, over the page that was there, which does not move.
 * 5. A chat's conversation is not followed: the follower ran only while the switch was on, so for
 *    everyone who never turned the preview on a chat would stay silent.
 *
 * Tests 3 and 4 seed `newInterface: true`, the preview's own users: on a build where the shell still
 * follows the switch, they are then red for their own reason (no theme row, no digit), not for test 1's.
 *
 * What the theme row may be, as the frame draws it: a `[data-settings-row]` of Preferences whose label
 * names the theme ("Theme", "Appearance", "Light mode", "Dark mode"...), with either one choice per theme
 * (radios named Light and Dark, as SegmentedControl renders them) or one switch or button that swaps it.
 *
 * The artefact: values.json with what each test read, and a screenshot per state, in the test's output
 * folder. Reproduce: npx playwright test e2e/new-interface-only.spec.ts --retries=0
 */

/** The launch splash, over the page on every document load until its checks answer (4 s at most). */
const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const MAIN = ['Chat', 'Projects', 'Dashboard', 'Kanban', 'Schedules'];
const SETTINGS = (dir: string) => path.join(dir, 'app-settings.json');
const QUIET = { autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' };
const THEME_LABEL = /\b(theme|appearance|light|dark)\b/i;
/** Cmd on macOS and Linux, Ctrl on Windows (pageShortcutDigit). */
const MOD = process.platform === 'win32' ? 'Control' : 'Meta';
const DIGITS: Array<{ digit: string; label: string; kind: 'main' | 'more'; href?: string }> = [
  { digit: '1', label: 'Dashboard', kind: 'main', href: '/' },
  { digit: '2', label: 'Agents', kind: 'more' },
  { digit: '3', label: 'Kanban', kind: 'main', href: '/kanban' },
  { digit: '4', label: 'Schedules', kind: 'main', href: '/crons' },
  { digit: '5', label: 'Review', kind: 'more' },
  { digit: '6', label: 'Logs', kind: 'more' },
  { digit: '7', label: 'Vault', kind: 'more' },
  { digit: '8', label: 'Projects', kind: 'main', href: '/projects' },
  { digit: '9', label: 'Extensions', kind: 'more' },
  { digit: '0', label: 'Usage', kind: 'more' },
];

/** A sandbox with nothing to start and nothing to reach; `settings` null leaves no settings file at all. */
function sandbox(prefix: string, settings: Record<string, unknown> | null): { home: string; dir: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-${prefix}-`));
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'projects.json'), '[]');
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  if (settings) fs.writeFileSync(SETTINGS(dir), JSON.stringify(settings, null, 2));
  return { home, dir };
}

async function open(home: string, port: number, route: string, pageErrors: string[]) {
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(port), DOROTHY_E2E: '1' },
  });
  const page = await app.firstWindow();
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${DEV_URL}${route}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
  return { app, page };
}

const sidebarOf = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' });
const menuOf = (page: Page) => sidebarOf(page).getByRole('navigation', { name: 'Main menu' });

/** The new shell, and nothing of the classic one: its main menu, More, and no sidebar theme button. */
async function expectNewShell(page: Page): Promise<string[]> {
  await expect(menuOf(page), 'the new shell: its main menu').toBeVisible({ timeout: 90_000 });
  await expect(menuOf(page).getByRole('link')).toHaveText(MAIN);
  await expect(sidebarOf(page).getByRole('button', { name: 'More' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Light|Dark) Mode$/ }), 'the classic sidebar\'s theme button').toHaveCount(0);
  return (await menuOf(page).getByRole('link').allInnerTexts()).map(s => s.trim());
}

const readFile = (dir: string): Record<string, unknown> | null =>
  fs.existsSync(SETTINGS(dir)) ? JSON.parse(fs.readFileSync(SETTINGS(dir), 'utf8')) : null;
const pathOf = (page: Page) => new URL(page.url()).pathname.replace(/(.)\/$/, '$1');
const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains('dark'));
const storedTheme = (page: Page) => page.evaluate(() => localStorage.getItem('tars-theme'));

async function openMorePage(page: Page, label: string): Promise<Locator> {
  await sidebarOf(page).getByRole('button', { name: 'More' }).click();
  await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: label, exact: true }).click();
  const card = page.getByRole('dialog', { name: label });
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

/** Settings, opened from More, at Preferences, which it opens on. */
async function openPreferences(page: Page): Promise<Locator> {
  const card = await openMorePage(page, 'Settings');
  await expect(card.locator('[data-settings-row]', { hasText: 'Start agents when Tars opens' })).toBeVisible({ timeout: 60_000 });
  return card;
}

function themeRow(scope: Locator): Locator {
  return scope.locator('[data-settings-row]').filter({ has: scope.page().locator('[data-settings-label]', { hasText: THEME_LABEL }) });
}

/** Puts the theme to `want` through its row, whatever control the frame gives it. */
async function chooseTheme(page: Page, row: Locator, want: 'light' | 'dark'): Promise<string> {
  const option = row.getByRole('radio', { name: new RegExp(`^${want}`, 'i') });
  if (await option.count() === 1) {
    await option.click();
    return 'radio';
  }
  const control = row.getByRole('switch').or(row.getByRole('button'));
  await expect(control, 'the theme row: one control that swaps the theme').toHaveCount(1);
  if ((await isDark(page)) === (want === 'light')) await control.click();
  return (await control.getAttribute('role')) ?? 'button';
}

test('a fresh install, with no settings file, opens the new shell', async () => {
  test.setTimeout(300_000);
  const { home, dir } = sandbox('only-fresh', null);
  const pageErrors: string[] = [];
  const seen: Record<string, unknown> = { settingsFileBefore: readFile(dir) };
  const { app, page } = await open(home, 31531, '/', pageErrors);
  try {
    seen.menu = await expectNewShell(page);
    await stepShot(page, '01-fresh-install');
    const after = readFile(dir);
    seen.settingsFileAfterLaunch = after;
    // Whatever the launch writes, a fresh install never gets the key.
    expect(after === null || !('newInterface' in after)).toBe(true);
    expect(pageErrors, 'no uncaught page error').toEqual([]);
  } finally {
    recordValues({ fresh: seen });
    await app.close().catch(() => {});
    await removeHome(home);
  }
});

test('a settings file that says newInterface: false opens the new shell, and the next save drops the key, even when a window still sends it', async () => {
  test.setTimeout(300_000);
  const older = { ...QUIET, terminalFontSize: 17, newInterface: false };
  const { home, dir } = sandbox('only-off', older);
  const pageErrors: string[] = [];
  const seen: Record<string, unknown> = { settingsFileBefore: readFile(dir) };
  const { app, page } = await open(home, 31532, '/', pageErrors);
  type Settings = Record<string, unknown>;
  const save = (s: Settings) => page.evaluate((s) =>
    (window as unknown as { electronAPI: { appSettings: { save: (s: Settings) => Promise<unknown> } } }).electronAPI.appSettings.save(s), s);
  const read = () => page.evaluate(() =>
    (window as unknown as { electronAPI: { appSettings: { get: () => Promise<Settings> } } }).electronAPI.appSettings.get());
  try {
    seen.menu = await expectNewShell(page);
    await stepShot(page, '01-turned-off-before');

    // The next save, of something else: the key goes, the rest stays.
    seen.saveAnswer = await save({ terminalFontSize: 15 });
    const first = readFile(dir)!;
    seen.fileAfterSave = first;
    expect('newInterface' in first, 'the key, after the next save').toBe(false);
    expect(first).toMatchObject({ ...QUIET, terminalFontSize: 15 });

    // A window that still sends it: dropped the same way, and the shell does not move.
    seen.saveSendingItAnswer = await save({ newInterface: false });
    const second = readFile(dir)!;
    seen.fileAfterSaveSendingIt = second;
    expect('newInterface' in second, 'the key, sent by a window').toBe(false);
    const got = await read();
    seen.readAfterSaves = { newInterface: got.newInterface ?? '(absent)', terminalFontSize: got.terminalFontSize };
    expect('newInterface' in got).toBe(false);
    await expectNewShell(page);
    expect(pageErrors, 'no uncaught page error').toEqual([]);
  } finally {
    recordValues({ turnedOff: seen });
    await app.close().catch(() => {});
    await removeHome(home);
  }
});

test('Settings, Preferences switches the theme, light and back to dark, and the choice survives a restart', async () => {
  test.setTimeout(300_000);
  const { home } = sandbox('only-theme', { ...QUIET, newInterface: true });
  const pageErrors: string[] = [];
  const seen: Record<string, unknown> = {};
  let { app, page } = await open(home, 31533, '/chats', pageErrors);
  try {
    await expectNewShell(page);
    seen.darkAtFirstLaunch = await isDark(page);
    expect(seen.darkAtFirstLaunch, 'dark, the launch default').toBe(true);

    let card = await openPreferences(page);
    seen.preferencesRows = (await card.locator('[data-settings-row] [data-settings-label]').allInnerTexts()).map(s => s.trim());
    const row = themeRow(card);
    await expect(row, 'one theme row in Settings, Preferences').toHaveCount(1);
    await expect(card.locator('[data-settings-row]', { hasText: 'New interface' }), 'the switch is gone').toHaveCount(0);
    seen.themeRow = (await row.innerText()).replace(/\s+/g, ' ').trim();

    seen.controlToLight = await chooseTheme(page, row, 'light');
    await expect.poll(() => isDark(page), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => storedTheme(page), { timeout: 10_000 }).toBe('light');
    await stepShot(page, '01-light-from-preferences');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await stepShot(page, '02-light-shell');

    // A restart: the same profile, the theme it was left in.
    await app.close();
    ({ app, page } = await open(home, 31533, '/chats', pageErrors));
    await expectNewShell(page);
    seen.darkAfterRestart = await isDark(page);
    seen.storedAfterRestart = await storedTheme(page);
    expect(seen.darkAfterRestart, 'still light after a restart').toBe(false);
    expect(seen.storedAfterRestart).toBe('light');
    await stepShot(page, '03-light-after-restart');

    card = await openPreferences(page);
    seen.controlToDark = await chooseTheme(page, themeRow(card), 'dark');
    await expect.poll(() => isDark(page), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => storedTheme(page), { timeout: 10_000 }).not.toBe('light');
    seen.storedAtTheEnd = await storedTheme(page);
    await stepShot(page, '04-dark-again');
    expect(pageErrors, 'no uncaught page error').toEqual([]);
  } finally {
    recordValues({ theme: seen });
    await app.close().catch(() => {});
    await removeHome(home);
  }
});

test('every digit shortcut keeps its page: a main menu page is navigated to, a page of More opens as its card', async () => {
  test.setTimeout(300_000);
  const { home } = sandbox('only-digits', { ...QUIET, newInterface: true });
  const pageErrors: string[] = [];
  const results: Array<Record<string, unknown>> = [];
  const { app, page } = await open(home, 31534, '/chats', pageErrors);
  try {
    await expectNewShell(page);
    for (const d of DIGITS) {
      // Aimed at the page, not at a field: a digit typed in a field is the field's.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
      const before = pathOf(page);
      await page.keyboard.press(`${MOD}+${d.digit}`);
      let ok: boolean;
      if (d.kind === 'main') {
        const entry = menuOf(page).getByRole('link', { name: d.label, exact: true });
        ok = await expect.poll(async () => pathOf(page) === d.href && (await entry.getAttribute('aria-current')) === 'page', { timeout: 8_000 })
          .toBe(true).then(() => true, () => false);
      } else {
        const card = page.getByRole('dialog', { name: d.label });
        ok = await expect(card).toBeVisible({ timeout: 8_000 }).then(() => pathOf(page) === before, () => false);
        if (ok) await stepShot(page, `digit-${d.digit}-${d.label.toLowerCase()}-card`);
        if (await card.count()) {
          await page.keyboard.press('Escape');
          await expect(card).toHaveCount(0);
        }
      }
      results.push({ key: `${MOD}+${d.digit}`, expected: d.kind === 'main' ? `navigates to ${d.href}` : `opens the ${d.label} card`, from: before, at: pathOf(page), ok });
    }
    recordValues({ digits: results });
    expect(results.map(r => [r.key, r.ok])).toEqual(DIGITS.map(d => [`${MOD}+${d.digit}`, true]));
    expect(pageErrors, 'no uncaught page error').toEqual([]);
  } finally {
    recordValues({ digits: results });
    await app.close().catch(() => {});
    await removeHome(home);
  }
});

test("a chat's conversation is followed live with no newInterface in the settings", async () => {
  test.setTimeout(300_000);
  const S1 = 'e2e00000-0000-4000-8000-00000000d001';
  const { home, dir } = sandbox('only-follower', { ...QUIET });
  const project = path.join(home, 'projects', 'demo');
  fs.mkdirSync(project, { recursive: true });
  const cli = path.join(home, 'lead-cli.cjs');
  fs.writeFileSync(cli, [
    `#!${process.execPath}`,
    'if (process.stdin.isTTY) process.stdin.setRawMode(true);',
    "process.stdin.on('data', () => {});",
    "process.stdout.write('stand-in ready\\n');",
    '',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'lead', name: 'Lead', character: 'robot', provider: 'claude', status: 'idle', role: 'orchestrator', orchestratorMode: true,
    projectPath: project, skills: [], cliPath: cli, resumableSessionId: S1,
    createdAt: '2026-11-26T08:00:00.000Z', lastActivity: '2026-11-26T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  let n = 0;
  const line = (role: 'user' | 'assistant', content: unknown) => JSON.stringify({
    type: role, uuid: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, timestamp: new Date(Date.UTC(2026, 10, 26, 10, 0, n)).toISOString(),
    sessionId: S1, version: '2.1.296', message: { role, content },
  }) + '\n';
  // Where Claude Code files the session: under the project's real path.
  const transcripts = path.join(home, '.claude', 'projects', fs.realpathSync(project).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(transcripts, { recursive: true });
  const s1File = path.join(transcripts, `${S1}.jsonl`);
  fs.writeFileSync(s1File, line('user', 'ship the receipts') + line('assistant', [{ type: 'text', text: 'On it.' }]));

  type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => unknown>> };
  const pageErrors: string[] = [];
  const seen: Record<string, unknown> = { settingsFile: readFile(dir) };
  const { app, page } = await open(home, 31535, '/chats', pageErrors);
  const heard = () => page.evaluate(() => (window as unknown as { __heard: Array<Record<string, unknown>> }).__heard);
  try {
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const call = (group: string, name: string, arg?: unknown) => page.evaluate(([g, c, a]) =>
      (window as unknown as Api).electronAPI[g as string][c as string](a), [group, name, arg] as const) as Promise<Record<string, unknown>>;
    await page.evaluate(() => {
      const w = window as unknown as Api & { __heard: unknown[] };
      w.__heard = [];
      w.electronAPI.chat.onEvent((e: unknown) => w.__heard.push(e));
    });

    const listing = await call('chat', 'list') as { chats: Array<{ id: string; number: number; sessionIds: string[] }> };
    const main = listing.chats.find(c => c.number === 1);
    seen.main = main ?? null;
    expect(main?.sessionIds).toEqual([S1]);
    const history = await call('chat', 'history', { chatId: main!.id }) as { items: Array<{ kind: string; text: string }> };
    seen.history = history.items.map(i => [i.kind, i.text]);
    expect(seen.history).toEqual([['user', 'ship the receipts'], ['text', 'On it.']]);

    // A line the live runner's transcript gains, after the window's snapshot.
    fs.appendFileSync(s1File, line('assistant', [{ type: 'text', text: 'Receipts shipped.' }]));
    await call('agent', 'start', { id: 'lead', prompt: '' });
    await expect.poll(async () => ((await call('agent', 'list')) as unknown as Array<{ id: string; cliRunning?: boolean }>)
      .find(a => a.id === 'lead')?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
    const item = (e: Record<string, unknown>) => e.type === 'item' && e.chatId === main!.id
      && (e.item as { text?: string } | undefined)?.text === 'Receipts shipped.';
    const followed = await expect.poll(async () => (await heard()).some(item), { timeout: 30_000 }).toBe(true).then(() => true, () => false);
    seen.followed = followed;
    expect(followed, 'the line arrives as a chat:events item').toBe(true);
    expect(pageErrors, 'no uncaught page error').toEqual([]);
  } finally {
    seen.heard = await heard().catch(() => null);
    recordValues({ follower: seen });
    await app.close().catch(() => {});
    await removeHome(home);
  }
});
