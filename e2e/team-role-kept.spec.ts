import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A team deployed from New team keeps each member's role as its role, the team's brief apart (QA's fresh-install B2,
 * the Audit's M1 on PR 581; frame `Overlay · New team (one screen)`, its brief's note).
 *
 * A project and a team of two whose members carry their roles (`savedPrompt` of the team template), and no
 * orchestrator. New team, with a brief and Start on deploy off, deploys them. Since 2.0.7 (#580 and #584) the brief is
 * the orchestrator's first task, typed once at its first start; a team with no orchestrator gives it to every member as
 * its first task (`firstTask` in agents.json), never as its role. The deploy asks Claude Code whether it is signed in:
 * the claude here is a stand-in at `cliPaths.claude` that answers `auth status` signed in.
 *
 * How it can fail, written before the change (and adapted to the 2.0.7 train, the Audit's M1 on #590):
 * 1. a member's role becomes the brief and its role run together, which main puts under "## Your role" at every
 *    session (main wrote the brief over the role when the team was created idle);
 * 2. a member's role is lost;
 * 3. the brief is lost: a member of a team with no orchestrator does not keep it as its first task;
 * 4. New team does not say that the brief is a first task, never kept as a role, and every member's with no
 *    orchestrator;
 * 5. an uncaught error in the page.
 * Once with the classic shell and once with the new interface (New team from the Agents page, or its dialog).
 * Red on main (58f2863b4): each role is the brief and the role. Red on a mutant of the train that saves the brief and
 * the role together as the role (team-deploy.ts).
 * The artefact: values.json (each member's saved role and first task), screenshots.
 */

const BRIEF = 'Ship the login page this week.';
const ROLES = { Planner: 'You plan the work and hand it out.', Builder: 'You build what the planner hands you.' };

/** Claude Code as the deploy asks it: its version, and signed in. Nothing here starts it as an agent. */
function signedInClaude(home: string): string {
  return writeNodeCli(path.join(home, 'claude-signed-in.cjs'), [
    'const args = process.argv.slice(2);',
    "if (args.includes('--version')) { console.log('2.1.321 (Claude Code)'); process.exit(0); }",
    "if (args[0] === 'auth' && args[1] === 'status') {",
    "  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'new.user@example.com', subscriptionType: 'max' }));",
    '  process.exit(0);',
    '}',
    'process.stdin.resume();',
    '',
  ].join('\n'));
}

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
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, cliPaths: { claude: signedInClaude(home) },
    }));
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
      await modal.getByPlaceholder('What should this team ship? The orchestrator starts on it and splits the work.').fill(BRIEF);

      // 4. The brief is a first task, never a role, and every member's with no orchestrator: said under it. Soft, so
      // the run still reaches the roles (1 to 3).
      seen.briefNote = await modal.getByText('never kept as its role', { exact: false }).count();
      expect.soft(seen.briefNote, 'the brief says it is never kept as a role').toBe(1);
      seen.leaderlessNote = await modal.getByText('A team with no orchestrator: every member gets it.', { exact: false }).count();
      expect.soft(seen.leaderlessNote, 'the brief says every member gets it with no orchestrator').toBe(1);
      await modal.getByRole('button', { name: /skills per role/ }).click();
      const start = modal.getByText('Start on deploy', { exact: true }).locator('xpath=../..').getByRole('switch');
      await start.click();
      await expect(start).toHaveAttribute('aria-checked', 'false');
      await stepShot(page, `${tag}1-created-idle`);
      await modal.getByRole('button', { name: 'Deploy 2 agents', exact: true }).click();
      await expect(modal).toHaveCount(0, { timeout: 60_000 });

      // 1 to 3. Each member's role is its role, and the brief its first task: both as main keeps them on disk.
      // agents.json as main writes it: { version, savedAt, agents } (core/agent-manager.ts saveAgents).
      type Stored = { name?: string; savedPrompt?: string; firstTask?: { text?: string } };
      const stored = (): Stored[] => {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')) as Stored[] | { agents?: Stored[] };
        return Array.isArray(raw) ? raw : raw.agents ?? [];
      };
      await expect.poll(() => stored().length, { timeout: 30_000, message: 'both members saved' }).toBe(2);
      const made = stored();
      seen.members = made.map(a => ({ name: a.name, savedPrompt: a.savedPrompt ?? null, firstTask: a.firstTask?.text ?? null }));
      for (const [name, role] of Object.entries(ROLES)) {
        const agent = made.find(a => (a.name ?? '').includes(name));
        expect(agent, `${name} was made`).toBeTruthy();
        expect.soft(agent!.savedPrompt, `${name}'s role is its role alone`).toBe(role);
        expect.soft(agent!.firstTask?.text, `${name} keeps the brief as its first task`).toBe(BRIEF);
      }
      await stepShot(page, `${tag}2-deployed`);

      // 5.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => {});
      removeHome(home);
    }
  });
}
