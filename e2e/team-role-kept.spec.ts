import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A team deployed from New team keeps each member's role as its role, the team's brief apart (QA's fresh-install B2,
 * the Audit's M1 on PR 581; frame `Overlay · New team (one screen)`, its brief's note).
 *
 * A project and a team of two whose members carry their roles (`savedPrompt` of the team template). New team, with a
 * brief and Start on deploy off, deploys them.
 *
 * How it can fail, written before the change:
 * 1. a member's role becomes the brief and its role run together, which main puts under "## Your role" at every
 *    session (main writes the brief over the role when the team is created idle);
 * 2. a member's role is lost;
 * 3. New team does not say that a team created idle gets no brief;
 * 4. an uncaught error in the page.
 * Start on deploy on is left to Tars-Backend's B2 change: until main stops writing a start's prompt into the role, a
 * started member's role is the brief and its role whatever the window does.
 * Once with the classic shell and once with the new interface (New team from the Agents page, or its dialog).
 * Red on main (58f2863b4): each role is the brief and the role.
 * The artefact: values.json (each member's saved role), screenshots.
 */

const BRIEF = 'Ship the login page this week.';
const ROLES = { Planner: 'You plan the work and hand it out.', Builder: 'You build what the planner hands you.' };

for (const newInterface of [false, true]) {
  test(`a team created idle keeps each member's role, without the brief${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-team-role-'));
    const project = path.join(home, 'projects', 'harbor');
    fs.mkdirSync(project, { recursive: true });
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const at = '2026-11-10T08:00:00.000Z';
    fs.writeFileSync(path.join(dir, 'team-templates.json'), JSON.stringify({ user: [{
      id: 'two', name: 'Two with roles', description: '', icon: '', createdAt: at, updatedAt: at,
      members: Object.entries(ROLES).map(([name, savedPrompt]) => ({ name, character: 'robot', provider: 'claude', permissionMode: 'auto', skills: [], savedPrompt })),
    }] }));
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new-' : '';
    const errors: string[] = [];

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31601 : 31600), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await page.setViewportSize({ width: 1440, height: 900 });
      if (!newInterface) {
        await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      } else {
        await page.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
        const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
        await expect(sidebar.getByRole('navigation', { name: 'Main menu' })).toBeVisible({ timeout: 90_000 });
        await sidebar.getByRole('button', { name: 'More' }).click();
        await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Agents' }).click();
      }
      await page.getByRole('button', { name: '+ Team', exact: true }).click({ timeout: 90_000 });
      const modal = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New team', exact: true }) });
      await modal.getByRole('button', { name: 'Start from', exact: true }).click();
      await page.getByRole('option').filter({ hasText: 'Two with roles' }).first().click();
      await modal.getByRole('button', { name: 'Project', exact: true }).click();
      await page.getByRole('option').filter({ hasText: 'projects/harbor' }).first().click();
      await modal.getByPlaceholder('What is this team shipping? Shared context every member starts with.').fill(BRIEF);

      // 3. Created idle, the brief is not kept: said under it. Soft, so the run still reaches the roles (1, 2).
      seen.briefNote = await modal.getByText('Created idle, without start on deploy, nobody gets the brief: it is not kept.', { exact: false }).count();
      expect.soft(seen.briefNote, 'the brief says it is not kept when the team is created idle').toBe(1);
      await modal.getByRole('button', { name: /skills per role/ }).click();
      const start = modal.getByText('Start on deploy', { exact: true }).locator('xpath=../..').getByRole('switch');
      await start.click();
      await expect(start).toHaveAttribute('aria-checked', 'false');
      await stepShot(page, `${tag}1-created-idle`);
      await modal.getByRole('button', { name: 'Deploy 2 agents', exact: true }).click();
      await expect(modal).toHaveCount(0, { timeout: 60_000 });

      // 1, 2. Each member's role is its role, the brief apart.
      const made = await page.evaluate(() => window.electronAPI!.agent!.list());
      seen.roles = Object.fromEntries(made.map(a => [a.name, a.savedPrompt ?? null]));
      for (const [name, role] of Object.entries(ROLES)) {
        const agent = made.find(a => (a.name ?? '').includes(name));
        expect(agent, `${name} was made`).toBeTruthy();
        expect(agent!.savedPrompt).toBe(role);
      }
      await stepShot(page, `${tag}2-deployed`);

      // 4.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => {});
      removeHome(home);
    }
  });
}
