import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A new project gets the team's workflow from the window (2.0.7, W3, W5 and W7 of the fresh-install report; PR 586's
 * electronAPI.projectSetup; frame `First run (2.0.7) · states`, its rows `what a project is offered`, `after yes, and
 * what is not offered`, `see it` and `a project's panel, its team there`).
 *
 * How it can fail, written before the window's change:
 * 1. the first run says nothing of the CI workflow or the CLAUDE.md a ready project is offered;
 * 2. see it does not show what the yes would write;
 * 3. the CI's yes does not commit it on chore/ci, or touches the checkout (off main, or dirty), or the window does
 *    not say where it went and that nothing was pushed;
 * 4. the CLAUDE.md's yes does not write it, or the window does not say so;
 * 5. a project added on the Projects page does not open its panel with its offers, nor say why a CI is not offered
 *    (no remote);
 * 6. a project's panel offers no single permission level for its team, or applying it changes a chat's runner, or
 *    misses an agent, or does not say how many took it;
 * 7. an uncaught error in the page;
 * 8. the committed CI's line promises a delivery nobody asks for, instead of telling the user to ask the orchestrator
 *    (the Audit's L3 on PR 587);
 * 9. a folder Claude Code has seen, never added to Tars, shows main's refusal with no way on (the Audit's L1 on PR 587),
 *    where the panel offers to add it to Tars and then its offers.
 * Once with the new interface and once with the classic shell.
 * Red on 71a90a4c3 (the frames, PR 586's channels and the first run, no window change): no offer is shown.
 * The artefact: values.json (each line read, git's state, each agent's mode), screenshots.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).trim();

function nodeProject(at: string, origin: string | null): void {
  fs.mkdirSync(at, { recursive: true });
  git(at, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(at, 'package.json'), JSON.stringify({ name: path.basename(at), scripts: { lint: 'eslint .', test: 'vitest run' } }));
  fs.writeFileSync(path.join(at, 'package-lock.json'), '{}');
  git(at, 'add', '.');
  git(at, 'commit', '-q', '-m', 'init');
  if (origin) git(at, 'remote', 'add', 'origin', origin);
}

function seed(home: string, newInterface: boolean, agents: unknown[], projects: string[]): void {
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents, null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
}

for (const newInterface of [true, false]) {
  const tag = newInterface ? 'new-' : 'classic-';

  test(`the first run offers a ready project its CI and CLAUDE.md, written on a yes${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-setup-window-')));
    const project = path.join(home, 'projects', 'harbor');
    nodeProject(project, 'git@github.com:someone/harbor.git');
    seed(home, newInterface, [], [project]);
    const seen: Record<string, unknown> = { newInterface };
    const errors: string[] = [];
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31585 : 31586), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(newInterface ? `${DEV_URL}/chats` : `${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 90_000 });
      const panel = page.getByRole('region', { name: 'First run' });
      await expect(panel).toBeVisible({ timeout: 60_000 });

      // 1. Offered under the folder step.
      const ci = panel.locator('[data-setup="ci"]');
      const md = panel.locator('[data-setup="claude-md"]');
      await expect(ci).toContainText('A CI workflow for GitHub: npm ci, npm run lint, npm run test on each pull request into main.', { timeout: 30_000 });
      await expect(md).toContainText('A short CLAUDE.md');
      await expect(panel).toContainText('New team, Options, Permissions');
      seen.offered = [await ci.innerText(), await md.innerText()];
      await stepShot(page, `${tag}1-offered`);

      // 2. see it.
      await ci.getByRole('button', { name: 'see it' }).click();
      const preview = panel.locator('[data-setup-preview="ci"]');
      await expect(preview).toContainText('pull_request:');
      await expect(preview).toContainText('branches: [main]');
      await stepShot(page, `${tag}2-see-it`);

      // 3. The CI's yes.
      await ci.getByRole('button', { name: 'add the CI workflow' }).click();
      await expect(ci).toContainText('Committed .github/workflows/ci.yml on chore/ci, in .worktrees/chore/ci, not pushed', { timeout: 30_000 });
      // 8.
      await expect(ci).toContainText('Ask your orchestrator to deliver it as a pull request.');
      seen.ci = await ci.innerText();
      seen.git = {
        head: git(project, 'rev-parse', '--abbrev-ref', 'HEAD'),
        status: git(project, 'status', '--porcelain', '--untracked-files=no'),
        ciBranch: git(project, 'rev-parse', '--verify', '-q', 'refs/heads/chore/ci') !== '',
        upstream: git(project, 'for-each-ref', '--format=%(upstream)', 'refs/heads/chore/ci'),
      };
      expect(seen.git).toEqual({ head: 'main', status: '', ciBranch: true, upstream: '' });

      // 4. The CLAUDE.md's yes.
      await md.getByRole('button', { name: 'write CLAUDE.md' }).click();
      await expect(md).toContainText('Wrote CLAUDE.md.', { timeout: 30_000 });
      expect(fs.existsSync(path.join(project, 'CLAUDE.md'))).toBe(true);
      seen.claudeMd = await md.innerText();
      await stepShot(page, `${tag}3-after-yes`);

      // 7.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => {});
      removeHome(home);
    }
  });

  test(`a project added or opened on the Projects page is offered its setup, and its team takes one permission level${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-setup-panel-')));
    const harbor = path.join(home, 'projects', 'harbor');
    const dock = path.join(home, 'projects', 'dock');
    nodeProject(harbor, 'git@github.com:someone/harbor.git');
    nodeProject(dock, null);
    // 9. A folder Claude Code has seen (its transcripts' folder), never added to Tars.
    const oldwork = path.join(home, 'projects', 'oldwork');
    nodeProject(oldwork, null);
    const transcripts = path.join(home, '.claude', 'projects', oldwork.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(transcripts, { recursive: true });
    fs.writeFileSync(path.join(transcripts, '00000000-0000-4000-8000-000000000002.jsonl'), '');
    const at = '2026-11-10T08:00:00.000Z';
    const agent = (id: string, name: string, extra: Record<string, unknown>) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'normal',
      projectPath: harbor, skills: [], createdAt: at, lastActivity: at, ...extra,
    });
    seed(home, newInterface, [
      agent('lead', 'Harbor Lead', { role: 'orchestrator', orchestratorMode: true }),
      agent('fe', 'Frontend Engineer', {}),
      agent('chat', 'Harbor chat', { kind: 'chat', chatId: 'c-1', teamOrchestratorId: 'lead', permissionMode: 'auto' }),
    ], [harbor]);
    const seen: Record<string, unknown> = { newInterface };
    const errors: string[] = [];
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31587 : 31588), DOROTHY_E2E: '1' },
    });
    try {
      await app.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as never;
      }, dock);
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/projects`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 90_000 });

      // 5. Added: its panel opens with its offers, and says why no CI.
      await page.getByRole('button', { name: '+ Project' }).click();
      let setup = page.locator('[data-project-setup]');
      await expect(setup).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('h2').filter({ hasText: 'dock' })).toBeVisible();
      await expect(setup.locator('[data-setup="ci"]')).toContainText('The project has no remote: QA runs its checks locally at each gate.', { timeout: 30_000 });
      await expect(setup.locator('[data-setup="ci"]').getByRole('button')).toHaveCount(0);
      await expect(setup.locator('[data-setup="claude-md"]')).toContainText('A short CLAUDE.md');
      await expect(setup.locator('[data-setup="permission"]')).toHaveCount(0);
      seen.added = (await setup.innerText()).replace(/\s+/g, ' ');
      await stepShot(page, `${tag}4-added`);
      await page.getByRole('button', { name: 'close' }).first().click();
      await expect(setup).toHaveCount(0);

      // 6. harbor's panel: one level for its team.
      await page.locator(`[data-project-card="${harbor}"]`).getByRole('button', { name: 'open' }).click();
      setup = page.locator('[data-project-setup]');
      const permission = setup.locator('[data-setup="permission"]');
      await expect(permission).toBeVisible({ timeout: 30_000 });
      await permission.getByRole('radio', { name: 'bypass' }).click();
      await permission.getByRole('button', { name: 'apply to 2 agents' }).click();
      await expect(setup.locator('[data-setup="permission-result"]')).toContainText('Set to bypass: 2 of 2 agents.', { timeout: 30_000 });
      type Saved = { id: string; permissionMode: string };
      const modes = () => {
        const file = JSON.parse(fs.readFileSync(path.join(home, '.tars', 'agents.json'), 'utf8')) as Saved[] | { agents: Saved[] };
        return Object.fromEntries((Array.isArray(file) ? file : file.agents).map(a => [a.id, a.permissionMode]));
      };
      await expect.poll(() => modes(), { timeout: 15_000 }).toEqual({ lead: 'bypass', fe: 'bypass', chat: 'auto' });
      seen.modes = modes();
      seen.panel = (await setup.innerText()).replace(/\s+/g, ' ');
      await stepShot(page, `${tag}5-team-level`);
      await page.getByRole('button', { name: 'close' }).first().click();

      // 9. The folder Claude Code has seen: add it to Tars, then its offers.
      await page.locator(`[data-project-card="${oldwork}"]`).getByRole('button', { name: 'open' }).click();
      setup = page.locator('[data-project-setup]');
      const unknown = setup.locator('[data-setup="unknown"]');
      await expect(unknown).toContainText('Tars does not know this folder yet', { timeout: 30_000 });
      await expect(setup).not.toContainText('not one of Tars');
      seen.unknown = await unknown.innerText();
      await stepShot(page, `${tag}6-not-known`);
      await unknown.getByRole('button', { name: 'add it to Tars' }).click();
      await expect(setup.locator('[data-setup="claude-md"]')).toContainText('A short CLAUDE.md', { timeout: 30_000 });
      const added = await page.evaluate(() => window.electronAPI!.fs!.listProjects());
      expect(added.find(p => p.path === oldwork)?.custom).toBe(true);
      seen.afterAdd = (await setup.innerText()).replace(/\s+/g, ' ');

      // 7.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => {});
      removeHome(home);
    }
  });
}
