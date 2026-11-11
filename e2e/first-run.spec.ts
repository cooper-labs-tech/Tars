import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A new user's first run (2.0.7; QA's fresh-install report, B3, B4, H1, M1; frames `First run (2.0.7)` and
 * `First run (2.0.7) · states`).
 *
 * A fresh home: no agent, no project, and a Claude Code (a stand-in, at `cliPaths.claude`) that answers
 * `claude auth status` signed out, as the real one does in an empty HOME, until its `claude auth login` has run.
 * The folder picker of the main process is stubbed to answer a plain folder, not a git repository.
 *
 * How it can fail, written before the window's change:
 * 1. nothing leads the new user: the empty chats page (new interface) or the empty Dashboard (classic) shows no
 *    first run;
 * 2. a signed-out Claude reads ready, in the first run or in the New agent dialog;
 * 3. Sign in does not open Claude Code's own sign-in for account 1, or the step does not read signed in after it;
 * 4. adding a folder does not say it is not a git repository, nor what else it lacks for pull requests (PR 584's
 *    readiness, in its order), nor lead to its team;
 * 5. New team on that folder asks for a repository the team does not need (since PR 585 no member has a worktree of
 *    its own: each piece of work gets one from worktree_new), or still says every member gets the brief when main
 *    gives it to the orchestrator alone, as its first task;
 * 6. the deploy does not make every member, or makes one with a worktree;
 * 7. a new agent still starts in normal, where it asks before every edit and command;
 * 8. the first run stays once the team is deployed;
 * 9. an uncaught error in the page;
 * 10. a folder Claude Code has seen, never added to Tars, is taken as the project, which main's channels refuse as not
 *     one of Tars's projects (the Audit's M1 on PR 580);
 * 11. New team from the first run offers One agent, whose path drops the task typed (the Audit's M2 on PR 580).
 * Once with the new interface and once with the classic shell; the New agent dialog (2, 7) from the Agents page of
 * the classic shell.
 * Red on main (58f2863b4) with the frames: no first run.
 * The artefact: values.json (each step's line, the dialog's lines, the agents made), screenshots.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const EMAIL = 'new.user@example.com';

function claude(home: string): string {
  const marker = path.join(home, 'claude-signed-in');
  return writeNodeCli(path.join(home, 'claude-stand-in.cjs'), [
    "const fs = require('fs');",
    `const MARKER = ${JSON.stringify(marker)};`,
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('2.1.321 (Claude Code)'); process.exit(0); }",
    "if (args[0] === 'auth' && args[1] === 'status') {",
    "  const inn = fs.existsSync(MARKER);",
    `  console.log(JSON.stringify(inn ? { loggedIn: true, authMethod: 'claude.ai', email: ${JSON.stringify(EMAIL)}, subscriptionType: 'max' } : { loggedIn: false, authMethod: 'none' }));`,
    "  process.exit(inn ? 0 : 1);",
    "}",
    "if (args[0] === 'auth' && args[1] === 'login') {",
    "  process.stdout.write('Opening the browser to sign in...\\r\\n');",
    "  setTimeout(() => { fs.writeFileSync(MARKER, '1'); process.stdout.write('Login successful.\\r\\n'); process.exit(0); }, 800);",
    "  return;",
    "}",
    "if (args[0] === 'auth' && args[1] === 'logout') { try { fs.unlinkSync(MARKER); } catch {} process.exit(0); }",
    "process.stdout.write('stand-in ready\\r\\n');",
    "process.stdin.resume();",
    '',
  ].join('\n'));
}

for (const newInterface of [true, false]) {
  test(`a new user is led from signing in to a deployed team${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-first-run-'));
    const project = path.join(home, 'projects', 'harbor');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'README.md'), '# harbor\n');
    // 10. A folder Claude Code has seen (its transcripts' folder), never added to Tars.
    const seenFolder = path.join(home, 'projects', 'oldwork');
    fs.mkdirSync(seenFolder, { recursive: true });
    const seenReal = fs.realpathSync(seenFolder);
    const transcripts = path.join(home, '.claude', 'projects', seenReal.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(transcripts, { recursive: true });
    fs.writeFileSync(path.join(transcripts, '00000000-0000-4000-8000-000000000001.jsonl'), '');
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
    fs.writeFileSync(path.join(dir, 'projects.json'), '[]');
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, cliPaths: { claude: claude(home) },
    }));
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new-' : 'classic-';
    const errors: string[] = [];

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31592 : 31593), DOROTHY_E2E: '1' },
    });
    try {
      // The folder picker answers the plain folder.
      await app.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as never;
      }, project);
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await page.setViewportSize({ width: 1440, height: 900 });

      if (!newInterface) {
        // 2, 7. New agent: Claude signed out, not ready; a new agent in auto.
        await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 90_000 });
        await page.getByRole('button', { name: '+ Agent' }).click();
        const modal = page.getByRole('dialog');
        await expect(modal.locator('[data-provider-state="claude"]')).toHaveText(/signed out/, { timeout: 30_000 });
        seen.newAgentProvider = await modal.locator('[data-provider-state="claude"]').innerText();
        await expect(modal.getByText(/· auto/).first()).toBeVisible();
        seen.newAgentOptions = (await modal.getByText(/· auto/).first().innerText()).trim();
        await stepShot(page, `${tag}0-new-agent-signed-out`);
        await page.keyboard.press('Escape');
        await expect(modal).toHaveCount(0);
      }

      // 1. The first run, where a new user lands.
      await page.goto(newInterface ? `${DEV_URL}/chats` : `${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 90_000 });
      const panel = page.getByRole('region', { name: 'First run' });
      await expect(panel).toBeVisible({ timeout: 60_000 });
      await expect(panel).toContainText('Set up your first project');
      const step = (name: string) => panel.locator(`[data-first-run-step="${name}"]`);

      // 2, 3. Signed out, then signed in through Claude Code's own sign-in.
      await expect(step('claude')).toContainText('signed out', { timeout: 30_000 });
      await stepShot(page, `${tag}1-signed-out`);
      await step('claude').getByRole('button', { name: 'Sign in' }).click();
      const signIn = page.getByRole('dialog');
      await expect(signIn.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 60_000 });
      await signIn.getByRole('button', { name: 'Done' }).click();
      await expect(step('claude')).toContainText(`signed in · ${EMAIL}`, { timeout: 30_000 });
      seen.claude = (await step('claude').innerText()).replace(/\s+/g, ' ');

      // 10. The folder Claude Code has seen is listed, and still the step asks for a folder of Tars's own.
      const listed = await page.evaluate(() => window.electronAPI!.fs!.listProjects());
      expect(listed.map(p => ({ path: p.path, custom: !!p.custom }))).toContainEqual({ path: seenReal, custom: false });
      await expect(step('project').getByRole('button', { name: 'Add a folder' })).toBeVisible();
      await expect(step('project')).not.toContainText('oldwork');
      seen.seenNotAdded = (await step('project').innerText()).replace(/\s+/g, ' ');

      // 4. A plain folder, said so.
      await step('project').getByRole('button', { name: 'Add a folder' }).click();
      await expect(step('project')).toContainText('harbor', { timeout: 30_000 });
      // What it lacks for pull requests, in main's order (PR 584's readiness): the repository first, then a remote.
      await expect(step('project').locator('[data-lack]').first()).toHaveText(/Not a git repository\./, { timeout: 30_000 });
      await expect(step('project').locator('[data-lack="remote"]')).toContainText('No remote');
      seen.lacks = await step('project').locator('[data-lack]').allInnerTexts();
      seen.project = (await step('project').innerText()).replace(/\s+/g, ' ');
      await stepShot(page, `${tag}2-folder-added`);

      // 5, 6. New team on it: deployed as it is, every member made, none with a worktree (PR 585's team).
      await step('team').getByRole('button', { name: 'Deploy the team' }).click();
      const teamDialog = page.getByRole('dialog');
      // 11. The team alone: no switch to One agent.
      await expect(teamDialog.getByRole('heading', { name: 'New team' })).toBeVisible({ timeout: 30_000 });
      await expect(teamDialog.getByRole('radio', { name: 'One agent' })).toHaveCount(0);
      // 5b. The brief is the orchestrator's first task (PR 584's teams.deploy), not a brief every member gets.
      await expect(teamDialog).toContainText('The orchestrator\'s first task');
      await expect(teamDialog).toContainText('never kept as its role');
      await expect(teamDialog).not.toContainText('The brief they all get');
      await expect(teamDialog.locator('[data-plain-folder]')).toHaveCount(0);
      await stepShot(page, `${tag}3-new-team`);
      const deploy = teamDialog.getByRole('button', { name: /^Deploy \d+ agents?$/ });
      seen.deployLabel = await deploy.innerText();
      const count = Number(/\d+/.exec(String(seen.deployLabel))![0]);
      await deploy.click();
      await expect(teamDialog).toHaveCount(0, { timeout: 120_000 });
      const made = await page.evaluate(() => window.electronAPI!.agent!.list());
      seen.agents = made.map(a => ({ name: a.name, role: a.role, worktree: a.worktreePath ?? null, permissionMode: a.permissionMode }));
      expect(made).toHaveLength(count);
      expect(made.filter(a => a.worktreePath)).toEqual([]);

      // 8. The first run goes once the team is there.
      await expect(panel).toHaveCount(0, { timeout: 30_000 });
      await stepShot(page, `${tag}4-team-deployed`);

      // 9.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => {});
      removeHome(home);
    }
  });

  /**
   * The Kanban page with no Hermes set up at all (2.0.7, H3; frame `First run (2.0.7) · states`, its row `Kanban,
   * with no Hermes gateway`). How it can fail: 10. main's not-configured answer is shown as a failure, a warning and
   * Retry; 11. the page does not say the rest of Tars works without it, nor lead to Settings, Hermes; 12. an uncaught
   * error in the page. Red before the window's change (376461c19): the warning.
   */
  test(`the kanban page without hermes says the rest of tars works${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-no-hermes-'));
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, cliPaths: { claude: claude(home) },
    }));
    const seen: Record<string, unknown> = { newInterface };
    const errors: string[] = [];
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31589 : 31590), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/kanban`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 90_000 });
      // 10, 11.
      const absent = page.locator('[data-hermes-absent]');
      await expect(absent).toContainText('Without it, the rest of Tars works', { timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
      seen.kanban = (await absent.innerText()).replace(/\s+/g, ' ');
      await stepShot(page, `${newInterface ? 'new-' : 'classic-'}5-kanban-without-hermes`);
      await absent.getByRole('link', { name: 'Open Hermes settings' }).click();
      await expect(page).toHaveURL(/\/settings\/?\?section=hermes/, { timeout: 30_000 });
      // 12.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => {});
      removeHome(home);
    }
  });
}
