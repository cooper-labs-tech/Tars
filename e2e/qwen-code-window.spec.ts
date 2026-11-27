import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The window's side of Qwen Code (2.0.4, on PR 461's provider `qwen-code`, the CLI `qwen`).
 *
 * The real app on a sandbox HOME whose ~/.qwen/settings.json names two models, and an agent on Qwen Code.
 * Asserted:
 * 1. Settings > Providers > Qwen Code lists the models of Qwen Code's own settings, read from the CLI (models.ofCli),
 *    not a list kept in the window;
 * 2. the agent's card names its CLI Qwen Code, never `qwen-code`.
 * Red on d8cb31e1 (PR 461 with PR 460 merged): no Qwen Code entry in the window, so no models and a raw id.
 * The artefact: values.json (the panel and the card as read), the screenshots.
 */

test(`qwen code in the window: its models from the cli, its name on the card`, async () => {
  test.setTimeout(150_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-qwen-window-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir, path.join(home, '.qwen')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify({
    model: { name: 'deepseek-v4-pro' },
    modelProviders: { deepseek: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', envKey: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', envKey: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com' },
    ] },
  }));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'qw', name: 'Qwen Worker', character: 'robot', provider: 'qwen-code', status: 'idle', role: 'worker', projectPath: project,
    skills: [], permissionMode: 'normal', createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const pageErrors: string[] = [];
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31504), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (e) => pageErrors.push(e.message));

    // 1. Its models, from the CLI.
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    const nav = page.getByTestId('settings-nav');
    await nav.getByText('AI & Providers', { exact: true }).first().click({ timeout: 30_000 });
    await nav.getByText('Providers', { exact: true }).first().click();
    await page.getByRole('list', { name: 'Command-line agents' }).getByRole('button', { name: /^Qwen Code/ }).click({ timeout: 20_000 });
    const models = page.getByRole('list', { name: 'Qwen Code models' });
    await expect.soft(models, "Qwen Code's own models").toBeVisible({ timeout: 15_000 });
    const listed = (await models.count()) ? await models.innerText() : '';
    keep({ listed });
    expect.soft(listed).toContain('DeepSeek V4 Pro');
    expect.soft(listed).toContain('DeepSeek V4 Flash');
    await stepShot(page, '01-qwen-code-panel');

    // 2. Its name on the card.
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    const card = page.getByText('Qwen Worker', { exact: true }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    const text = await page.locator('main').innerText();
    keep({ agentsPage: text.slice(0, 2000), pageErrors });
    expect.soft(text, 'the card says Qwen Code').toContain('Qwen Code');
    expect.soft(text, 'never the raw id').not.toContain('qwen-code');
    await stepShot(page, '02-qwen-code-card');
    expect.soft(pageErrors, 'no page error').toEqual([]);
  } finally {
    await app.close();
    removeHome(home);
  }
});
