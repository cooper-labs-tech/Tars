import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Memory page says when a project's MEMORY.md is close to or past what Claude Code reads of it, in the words Tars
 * writes (2.0.6, option c; PR 558's guard.notice; frame `Brain · Projects · MEMORY.md past what Claude Code reads
 * (2.0.6) · states`, redrawn by #559).
 *
 * How it can fail, written before the window's change:
 * 1. a project whose MEMORY.md is past a limit (here 150 lines of 200 characters: past 24.4 KB) shows nothing on its
 *    row, or words other than guard.notice, or not the notice whole in the row's title;
 * 2. a project close to a limit (185 short lines: past 180) shows nothing, or the same tone as a cut one;
 * 3. a project well under both limits shows a notice;
 * 4. the open MEMORY.md of the cut project does not carry the notice whole above it;
 * 5. an uncaught error in the page.
 * Once with the classic shell and once with the new interface (Brain from More). The artefact: values.json (the
 * guards main gives, the lines read), screenshots.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

const lines = (count: number, width: number) =>
  Array.from({ length: count }, (_, i) => `- L${String(i + 1).padStart(3, '0')} memory entry `.padEnd(width, 'y')).join('\n') + '\n';

for (const newInterface of [false, true]) {
  test(`the Memory page shows guard.notice where MEMORY.md is close to or past what Claude Code reads${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-memory-window-')));
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    const seed = (name: string, text: string) => {
      const project = path.join(home, 'projects', name);
      fs.mkdirSync(project, { recursive: true });
      const memoryDir = path.join(home, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), text);
      return project;
    };
    const projects = [seed('harbor', lines(150, 200)), seed('meridian', lines(185, 24)), seed('quay', lines(10, 24))];
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const seen: Record<string, unknown> = { newInterface };
    const errors: string[] = [];
    const tag = newInterface ? 'new-' : '';

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31584 : 31583), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.setViewportSize({ width: 1440, height: 900 });
      let where;
      if (!newInterface) {
        await page.goto(`${DEV_URL}/memory`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 90_000 });
        where = page.locator('main');
      } else {
        await page.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
        const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
        await expect(sidebar.getByRole('navigation', { name: 'Main menu' })).toBeVisible({ timeout: 90_000 });
        await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
        await sidebar.getByRole('button', { name: 'More' }).click();
        await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Brain' }).click();
        where = page.getByRole('dialog', { name: 'Brain' });
      }

      // The guards main gives the window: what the rows must say, word for word.
      type Row = { projectName: string; guard?: { state: string; notice: string | null } };
      const rows = await page.evaluate(async (paths) =>
        ((await (window.electronAPI as unknown as { memory: { listProjects(p: string[]): Promise<{ projects: Row[] }> } }).memory.listProjects(paths)).projects)
          .map((r) => ({ projectName: r.projectName, guard: r.guard })), projects);
      seen.guards = rows;
      const guardOf = (name: string) => rows.find((r) => r.projectName === name)?.guard;
      expect(guardOf('harbor')?.state).toBe('cut');
      expect(guardOf('meridian')?.state).toBe('near');
      const cut = guardOf('harbor')!.notice!;
      const near = guardOf('meridian')!.notice!;

      // 1. Past a limit: the row carries the notice, whole in its title, in the error tone.
      const harbor = where.locator('[data-memory-row="harbor"]');
      await expect(harbor).toBeVisible({ timeout: 60_000 });
      const harborLine = harbor.locator('[data-memory-notice]');
      await expect(harborLine).toHaveAttribute('title', cut);
      await expect(harborLine).toHaveAttribute('data-memory-notice', 'cut');
      expect((await harborLine.innerText()).trim()).toBe(cut);
      // 2. Close to a limit: the same, in the waiting tone.
      const meridianLine = where.locator('[data-memory-row="meridian"] [data-memory-notice]');
      await expect(meridianLine).toHaveAttribute('title', near);
      await expect(meridianLine).toHaveAttribute('data-memory-notice', 'near');
      // 3. Well under: nothing.
      await expect(where.locator('[data-memory-row="quay"] [data-memory-notice]')).toHaveCount(0);
      seen.rows = { harbor: (await harbor.innerText()).replace(/\s+/g, ' '), meridian: await meridianLine.getAttribute('title') };
      await stepShot(page, `${tag}1-rows`);

      // 4. The cut project open on its MEMORY.md: the notice whole above it.
      await harbor.click();
      await where.getByRole('button', { name: /MEMORY\.md/ }).first().click();
      const fileNotice = where.locator('[data-memory-file-notice]');
      await expect(fileNotice).toBeVisible({ timeout: 30_000 });
      seen.fileNotice = (await fileNotice.innerText()).trim();
      expect(seen.fileNotice).toBe(cut);
      await stepShot(page, `${tag}2-file`);

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
