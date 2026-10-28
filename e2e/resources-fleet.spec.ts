import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Resources · agents and projects, on its backend (lot 3, item D, the Database Engineer's `resources` channel, PR 546; frames
 * `Resources (2.0.5) · agents and projects` and `· states`). Red without that backend (PR 539's head).
 *
 * How it can fail, written before its backend:
 * 1. the view says it cannot read the fleet although the channel is there;
 * 2. a project or an agent of the fleet is missing, or an agent shows under another project;
 * 3. a project's agent count is not its agents'; or one agent with no terminal makes its project's memory unread,
 *    when another agent of it was read (the Audit's M1 on PR 548);
 * 4. an agent with no terminal shows a figure for its memory, 0 among them: it is said not read;
 * 5. choosing an agent does not show its detail, its tree and its disk, or shows another agent's;
 * 6. a command line in the tree shows a secret (the agent's own token, from its environment);
 * 7. "measure the disk again" does not measure: the worktree's size stays unmeasured, or the time does not move;
 * 8. an uncaught error in the page.
 *
 * The artefact: the table as read, the detail, and the measured sizes, in values.json; a screenshot of each step.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

for (const newInterface of [false, true]) {
  test(`resources, agents and projects: each project's agents, an agent's tree and disk, the disk measured on demand${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-resources-fleet-'));
    const dir = path.join(home, '.tars');
    const harbor = path.join(home, 'projects', 'harbor');
    const meridian = path.join(home, 'projects', 'meridian');
    const worktree = path.join(harbor, '.worktrees', 'feature-a');
    for (const f of [dir, harbor, meridian, worktree]) fs.mkdirSync(f, { recursive: true });
    // A worktree of 3 MB, which the disk measure must find.
    fs.writeFileSync(path.join(worktree, 'blob.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
    const agent = (id: string, name: string, projectPath: string, extra: Record<string, unknown> = {}) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath, skills: [],
      createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z', ...extra,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      // Builder runs: a stand-in CLI that stays, so its tree has memory to read.
      agent('a-harbor-1', 'Harbor Builder', harbor, { worktreePath: worktree, branchName: 'feature-a', cliPath: writeNodeCli(path.join(home, 'cli-builder.cjs'), [
        "process.stdout.write('stand-in ready\\r\\n');", 'setInterval(() => {}, 1000);', 'process.stdin.resume();', ''].join('\n')) }),
      agent('a-harbor-2', 'Harbor Reviewer', harbor),
      agent('a-meridian', 'Meridian Writer', meridian),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([harbor, meridian]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new-' : '';
    const errors: string[] = [];

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31560 : 31559), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.setViewportSize({ width: 1440, height: 900 });
      let where;
      if (!newInterface) {
        await page.goto(`${DEV_URL}/resources?view=agents`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 90_000 });
        where = page.locator('main');
      } else {
        await page.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
        const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
        await expect(sidebar.getByRole('navigation', { name: 'Main menu' })).toBeVisible({ timeout: 90_000 });
        await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
        await sidebar.getByRole('button', { name: 'More' }).click();
        await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Resources' }).click();
        where = page.getByRole('dialog', { name: 'Resources' });
        await where.getByRole('radiogroup', { name: 'Resources view' }).getByRole('radio', { name: 'Agents and projects' }).click();
      }
      const view = where.getByRole('region', { name: 'Agents and projects' });
      await page.evaluate(() => window.electronAPI!.agent!.start({ id: 'a-harbor-1', prompt: '' } as never));
      // 1. Read, not "cannot read".
      await expect(view.locator('[data-project-row]').first()).toBeVisible({ timeout: 60_000 });
      await expect(view.getByRole('alert')).toHaveCount(0);

      // 2, 3. Each project and its agents.
      const projects = await view.locator('[data-project-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-project-row')));
      const rows = await view.locator('[data-agent-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-agent-row')));
      seen.projects = projects;
      seen.agents = rows;
      expect(new Set(projects)).toEqual(new Set(['harbor', 'meridian']));
      expect(new Set(rows)).toEqual(new Set(['Harbor Builder', 'Harbor Reviewer', 'Meridian Writer']));
      await expect(view.locator('[data-project-row="harbor"]')).toContainText('2 agents');
      await expect(view.locator('[data-project-row="meridian"]')).toContainText('1 agent');
      // 3. Builder read, Reviewer not: harbor's memory is Builder's, never "not read".
      const harborRow = view.locator('[data-project-row="harbor"]');
      await expect(harborRow).toContainText(/\d+(\.\d)? (MB|GB)/, { timeout: 60_000 });
      seen.harborRow = (await harborRow.innerText()).replace(/\s+/g, ' ');
      await expect(view.locator('[data-agent-row="Harbor Builder"]')).toContainText(/\d+(\.\d)? (MB|GB)/);
      await expect(where.locator('[data-resource-card="AGENTS HOLD"] [data-value]')).toHaveText(/(MB|GB)$/);
      await expect(where.locator('[data-resource-card="AGENTS HOLD"]')).toContainText('not read');
      await stepShot(page, `${tag}1-table`);

      // 4. An agent with no terminal: its memory is not read, never 0.
      const reviewer = view.locator('[data-agent-row="Harbor Reviewer"]');
      seen.reviewerRow = (await reviewer.innerText()).replace(/\s+/g, ' ');
      await expect(reviewer).toContainText('not read');

      // 5, 6. The detail of the agent chosen, and no secret in it.
      await view.locator('[data-agent-row="Harbor Builder"]').click();
      const detail = view.getByRole('region', { name: 'Agent Harbor Builder' });
      await expect(detail).toBeVisible();
      await expect(detail).toContainText('Its tree');
      await expect(detail).toContainText('feature-a');
      const commands = await detail.locator('[data-command]').allInnerTexts();
      seen.commands = commands;
      for (const c of commands) expect(c).not.toMatch(/CLAUDE_MGR_API_TOKEN=(?!\*|•)\S/);

      // 7. Measured on demand: the worktree's 3 MB, and the time it was measured.
      await view.getByRole('button', { name: /measure the disk/ }).click();
      await expect(view.getByRole('region', { name: 'Fleet' })).toContainText(/disk measured \d\d:\d\d/, { timeout: 60_000 });
      const builder = view.locator('[data-agent-row="Harbor Builder"]');
      await expect(builder).toContainText(/\b3 MB\b/, { timeout: 60_000 });
      seen.builderRow = (await builder.innerText()).replace(/\s+/g, ' ');
      await stepShot(page, `${tag}2-detail-measured`);

      // 8.
      seen.errors = errors;
      expect(errors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close().catch(() => {});
      removeHome(home);
    }
  });
}
