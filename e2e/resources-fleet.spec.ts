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
 *    when another agent of it was read (the Audit's M1 on PR 548); or an agent started after the view opened stays
 *    unread, the view reading the fleet once (the QA's F6 on the 2.0.5 train); or a project's worktrees read 0 B
 *    before any measure;
 * 4. an agent with no terminal shows a figure for its memory, 0 among them: it is said not read;
 * 5. choosing an agent does not show its detail, its tree and its disk, or shows another agent's;
 * 6. a command line in the tree shows a secret: the agent's own token, from its environment, or a password after a
 *    flag (--password <value>, the Audit's Low on PR 548), which PR 546 masks as [redacted];
 * 7. "measure the disk again" does not measure: the worktree's size stays unmeasured, or the time does not move;
 * 8. an uncaught error in the page;
 * 9. what outlived an agent's session (its record's leftRunning, services/born-watch.ts) is not said on its row, nor in a
 *    notice with since when and what, or "show them" does not list each process with its pid and masked command and each
 *    container, or a secret in such a command shows (frame `· agents and projects · states`, pane `what outlived a
 *    session · alert`). Seeded on Meridian Writer, which has no terminal: macOS and Linux record it, Windows never.
 *
 * The artefact: the table as read, the detail, and the measured sizes, in values.json; a screenshot of each step.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const PASSWORD = 'e2e-flag-secret-4815162342';
const OUTLIVED_SECRET = 'e2e-outlived-secret-2718281828';
const OUTLIVED_SINCE = '2026-10-28T08:10:00.000Z';

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
        // A child with a password after a flag, as a script an agent runs might take one.
        "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--password', " + JSON.stringify(PASSWORD) + "], { stdio: 'ignore' });",
        "process.stdout.write('stand-in ready\\r\\n');", 'setInterval(() => {}, 1000);', 'process.stdin.resume();', ''].join('\n')) }),
      agent('a-harbor-2', 'Harbor Reviewer', harbor),
      // 9. What its ended session left running, as born-watch records it (one line each, `pid <n>: <command>`).
      agent('a-meridian', 'Meridian Writer', meridian, { leftRunning: {
        pids: [48211, 48230],
        commands: ['pid 48211: node /x/meridian/node_modules/.bin/next dev --port 3100', `pid 48230: node scripts/seed.mjs --password ${OUTLIVED_SECRET}`],
        containers: ['postgres (3f2a9c1b07e4)'],
        since: OUTLIVED_SINCE,
      } }),
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
      // Before any disk measure, harbor's worktrees are not measured, never 0 B (the QA's F6 on the 2.0.5 train).
      expect(String(seen.harborRow)).not.toMatch(/\b0 B\b/);
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
      for (const c of commands) expect(c).not.toMatch(/CLAUDE_MGR_API_TOKEN=(?!\*|•|\[redacted\])\S/);
      // The child's password, after its flag: masked, never shown.
      await expect(detail.locator('[data-command]').filter({ hasText: '--password' })).toHaveCount(1, { timeout: 60_000 });
      const withFlag = await detail.locator('[data-command]').filter({ hasText: '--password' }).innerText();
      seen.passwordLine = withFlag;
      expect(withFlag).toContain('[redacted]');
      expect(await detail.innerText()).not.toContain(PASSWORD);

      // 7. Measured on demand: the worktree's 3 MB, and the time it was measured.
      await view.getByRole('button', { name: /measure the disk/ }).click();
      await expect(view.getByRole('region', { name: 'Fleet' })).toContainText(/disk measured \d\d:\d\d/, { timeout: 60_000 });
      const builder = view.locator('[data-agent-row="Harbor Builder"]');
      await expect(builder).toContainText(/\b3 MB\b/, { timeout: 60_000 });
      seen.builderRow = (await builder.innerText()).replace(/\s+/g, ' ');
      await stepShot(page, `${tag}2-detail-measured`);

      // 9. What outlived Meridian Writer's session: its row, the notice, and each item once shown.
      const writer = view.locator('[data-agent-row="Meridian Writer"]');
      await expect(writer.locator('[data-outlived-note]')).toHaveText('3 outlived its session');
      const at = new Date(OUTLIVED_SINCE);
      const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
      const outlived = view.locator('[data-outlived="Meridian Writer"]');
      await expect(outlived).toContainText(`Meridian Writer's session ended at ${hhmm} and 3 of what it started run on: next dev, node, the container postgres.`);
      await expect(outlived).toContainText('Tars ends them on a stop of the agent; it does not end them by itself.');
      await expect(view.locator('[data-outlived]')).toHaveCount(1);
      await outlived.getByRole('button', { name: 'show them' }).click();
      const list = outlived.getByRole('list', { name: 'What outlived its session' });
      await expect(list.getByRole('listitem')).toHaveCount(3);
      const items = (await list.getByRole('listitem').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
      seen.outlived = { notice: (await outlived.getByRole('status').innerText()).replace(/\s+/g, ' '), items };
      expect(items[0]).toContain('pid 48211');
      expect(items[1]).toContain('pid 48230');
      expect(items[1]).toContain('[redacted]');
      expect(items[2]).toContain('postgres (3f2a9c1b07e4)');
      expect(await outlived.innerText()).not.toContain(OUTLIVED_SECRET);
      await expect(outlived.getByRole('button', { name: 'hide them' })).toBeVisible();
      await stepShot(page, `${tag}3-outlived`);

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
