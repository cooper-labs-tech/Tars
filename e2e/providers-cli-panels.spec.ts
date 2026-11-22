import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Settings > Providers, one panel per CLI (2.0.4, the maintainer's request of 18/10; frame `Providers · one panel per
 * CLI · Codex`, design PR #457), on PR 459's key per CLI (cliKeys.list and cliKeys.set).
 *
 * The real app on a sandbox HOME. Asserted, once with the classic shell and once with the new interface:
 * 1. the page lists the CLIs from the one list every page reads: the eight Tars drives, Grok CLI among them (it was
 *    missing from Providers), Qwen Code under its command `qwen` (it showed `qwen-code`), and the three to come;
 * 2. Codex's panel has an API key row: with no key it says so; a key pasted and set is saved for Codex (cliKeys.list
 *    says it is set) and never shown back, in the page or its fields;
 * 3. clear asks once, then the key is gone (cliKeys.list says so);
 * 4. Settings > CLI Paths lists the same CLIs under the same names;
 * 5. Claude Code's panel has the frame's Sign-in row and no key field: an Anthropic key an earlier version saved in
 *    app-settings.json (nothing in the main process reads it) is never shown back, in the page or its fields, and the
 *    row's Claude accounts button opens Settings, Claude accounts.
 * Red on 24469620 (PR 459's head): Providers has a row per CLI and a panel for Claude Code only, no key for Codex.
 * Point 5 red on b775aed2 (#460 with main merged): Claude Code's API key row puts the saved key in its field.
 * The artefact: values.json (the lists as read, cliKeys.list before and after), the screenshots.
 */

const KEY = 'sk-e2e-CODEX-SECRET-7f3a';
const CLAUDE_KEY = 'sk-ant-e2e-CLAUDE-SECRET-41d3';
type Api = { electronAPI: { cliKeys: { list(): Promise<Array<{ id: string; hasKey: boolean; envVar: string | null }>> } } };

for (const newInterface of [false, true]) {
  test(`providers: one panel per CLI from one list, a key set and cleared and never shown back${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-providers-'));
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, anthropicApiKey: CLAUDE_KEY }));
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const pageErrors: string[] = [];
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31502 : 31501), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      const nav = page.getByTestId('settings-nav');
      const open = async (group: string, child: string) => {
        await nav.getByText(group, { exact: true }).first().click({ timeout: 30_000 });
        await nav.getByText(child, { exact: true }).first().click({ timeout: 10_000 });
      };
      const keys = () => page.evaluate(() => (window as unknown as Api).electronAPI.cliKeys.list());
      await open('AI & Providers', 'Providers');

      // 1. One list.
      const clis = page.getByRole('list', { name: 'Command-line agents' });
      await expect.soft(clis, 'the CLIs, in one list').toBeVisible({ timeout: 20_000 });
      const listed = (await clis.count()) ? await clis.innerText() : '';
      const soon = page.getByRole('list', { name: 'To come' });
      const toCome = (await soon.count()) ? await soon.innerText() : '';
      keep({ listed, toCome, before: await keys() });
      for (const name of ['Claude Code', 'Codex', 'Qwen Code', 'Gemini CLI', 'Grok CLI', 'OpenCode', 'Pi', 'Amp', 'Cline']) expect.soft(listed, `${name} is listed`).toContain(name);
      expect.soft(listed, 'Qwen Code under its command').toMatch(/Qwen Code[\s\S]*\bqwen\b/);
      expect.soft(listed, 'never qwen-code').not.toContain('qwen-code');
      for (const name of ['oh-my-pi', 'Kilo CLI']) expect.soft(toCome, `${name} is to come`).toContain(name);
      expect.soft(toCome, 'Cline is driven, no longer to come').not.toContain('Cline');
      await stepShot(page, '01-providers-claude');

      // 5. Claude Code: the Sign-in row, and the key saved by an earlier version never shown back.
      if (await clis.count()) await clis.getByRole('button', { name: /^Claude Code/ }).click();
      const claude = page.getByRole('region', { name: 'Claude Code settings' });
      await expect.soft(claude, "Claude Code's panel").toBeVisible({ timeout: 10_000 });
      await expect.soft(claude.getByText(/Claude Code signs in with your Claude account/), 'the Sign-in row').toBeVisible({ timeout: 10_000 });
      const claudeShown = await page.evaluate((key) => {
        const inText = document.body.innerText.includes(key);
        const inFields = Array.from(document.querySelectorAll('input')).some((i) => (i as HTMLInputElement).value.includes(key));
        return { inText, inFields };
      }, CLAUDE_KEY);
      keep({ claudeShown });
      expect.soft(claudeShown, "Claude Code's saved key is never shown back").toEqual({ inText: false, inFields: false });

      // 2. Codex's key: none, then set, never shown back.
      if (await clis.count()) await clis.getByRole('button', { name: /^Codex/ }).click();
      const codex = page.getByRole('region', { name: 'Codex settings' });
      await expect.soft(codex, "Codex's panel").toBeVisible({ timeout: 10_000 });
      await expect.soft(codex.getByText(/No key set/), 'no key yet').toBeVisible({ timeout: 10_000 });
      await stepShot(page, '02-codex-no-key');
      const field = codex.getByLabel('Codex API key');
      if (await field.count()) {
        await field.fill(KEY);
        await codex.getByRole('button', { name: 'set', exact: true }).click();
      }
      await expect.soft(codex.getByText('a key is set'), 'the row says a key is set').toBeVisible({ timeout: 10_000 });
      await expect.poll(async () => (await keys()).find((k) => k.id === 'codex')?.hasKey ?? false, { timeout: 10_000 }).toBe(true);
      const shown = await page.evaluate((key) => {
        const inText = document.body.innerText.includes(key);
        const inFields = Array.from(document.querySelectorAll('input')).some((i) => (i as HTMLInputElement).value.includes(key));
        return { inText, inFields };
      }, KEY);
      keep({ afterSet: await keys(), shown });
      expect.soft(shown, 'the key is never shown back').toEqual({ inText: false, inFields: false });
      await stepShot(page, '03-codex-key-set');

      // 3. Clear asks once.
      if (await codex.count()) await codex.getByRole('button', { name: 'clear', exact: true }).first().click();
      const ask = page.getByRole('alertdialog', { name: "Clear Codex's key" });
      await expect.soft(ask, 'clear asks once').toBeVisible({ timeout: 10_000 });
      if (await ask.count()) await ask.getByRole('button', { name: 'clear', exact: true }).click();
      await expect.poll(async () => (await keys()).find((k) => k.id === 'codex')?.hasKey ?? true, { timeout: 10_000 }).toBe(false);
      await expect.soft(codex.getByText(/No key set/), 'no key again').toBeVisible({ timeout: 10_000 });
      keep({ afterClear: await keys() });
      await stepShot(page, '04-codex-cleared');

      // 4. CLI Paths names the same CLIs.
      await open('AI & Providers', 'CLI Paths');
      const paths = page.locator('main');
      await expect.soft(paths.getByText('Grok CLI', { exact: true }).first(), 'CLI Paths: Grok CLI').toBeVisible({ timeout: 10_000 });
      await expect.soft(paths.getByText('Gemini CLI', { exact: true }).first(), 'CLI Paths: Gemini CLI').toBeVisible();

      // 5, end. Claude Code's Claude accounts button opens that section.
      await open('AI & Providers', 'Providers');
      if (await clis.count()) await clis.getByRole('button', { name: /^Claude Code/ }).click();
      const accounts = page.getByRole('region', { name: 'Claude Code settings' }).getByRole('button', { name: 'Claude accounts' });
      if (await accounts.count()) await accounts.click();
      await expect.soft(page.getByRole('heading', { name: 'Claude accounts' }), 'the button opens Claude accounts').toBeVisible({ timeout: 10_000 });
      await stepShot(page, '05-claude-accounts');
      keep({ pageErrors });
      expect.soft(pageErrors, 'no page error').toEqual([]);
    } finally {
      await app.close();
      removeHome(home);
    }
  });
}
