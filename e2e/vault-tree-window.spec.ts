import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Vault shows every folder of a project's folder as a tree, in the window (2.0.5, the owner's request of 28/10;
 * frames `Vault (2.0.5) · project folders as a tree` and `· project folder tree · states` of #526), on the listing of
 * #530 (vault.projectPlace).
 *
 * A project's folder as agents leave it: a nested report, a worktree with its .git and node_modules, a link to a folder
 * outside and a hard link to a file outside, an empty folder, and 230 briefs in one folder. Once in the classic shell
 * and once with the new interface:
 * 1. the tree lists the project's folders, every one, with their counts;
 * 2. a folder chosen in the tree lists its folders then its files, under breadcrumbs; a folder chosen in the list opens
 *    in the tree; a nested file opens in the file panel;
 * 3. a worktree's .git and node_modules are named in the tree and the list, "not opened", and cannot be opened;
 * 4. a link and a hard link are said as such, and choosing one reads nothing of outside;
 * 5. an empty folder says so;
 * 6. 230 files: 200 listed, "30 more", then all 230 once asked.
 * Red on #530's head (6a868cdc): the window shows reports and tools only.
 *
 * The artefact: what the tree and the list showed at each step, in values.json, and a screenshot of each.
 */

const OUTSIDE = 'E2E OUTSIDE SECRET';

for (const newInterface of [false, true]) {
  test(`the vault shows a project's folder as a tree, its heavy folders, links, empty folder and more than 200 files${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-vault-tree-window-'));
    const dir = path.join(home, '.tars');
    const project = path.join(home, 'projects', 'harbor');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new' : 'old';
    const put = (file: string, text: string, mtimeSec?: number) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      if (mtimeSec !== undefined) fs.utimesSync(file, mtimeSec, mtimeSec);
    };

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31556 : 31555), DOROTHY_E2E: '1' },
    });
    try {
      const folder = await app.evaluate((_e, { dist, project }) => process.mainModule!.require(`${dist}/utils/project-files.js`).ensureProjectFiles(project).dir as string,
        { dist: path.resolve('electron', 'dist'), project });
      put(path.join(folder, 'reports', 'release.md'), '# Release\n');
      put(path.join(folder, 'reports', 'overnight', 'summary.md'), '# Overnight summary\n\nThe nested report.\n');
      put(path.join(folder, 'reports', 'overnight', 'wt', 'w1', 'notes.md'), 'worktree notes');
      put(path.join(folder, 'reports', 'overnight', 'wt', 'w1', '.git', 'HEAD'), 'ref: refs/heads/main');
      put(path.join(folder, 'reports', 'overnight', 'wt', 'w1', 'node_modules', 'pkg', 'index.js'), 'module.exports = 1');
      put(path.join(folder, 'docs', 'a.md'), '# A');
      fs.mkdirSync(path.join(folder, 'plans'), { recursive: true });
      for (let i = 0; i < 230; i++) put(path.join(folder, 'briefs', 'many', `b${String(i).padStart(3, '0')}.md`), 'b', 1_700_000_000 + i);
      const outside = path.join(home, 'outside');
      put(path.join(outside, 'secret.md'), OUTSIDE);
      fs.mkdirSync(path.join(folder, 'reports', 'links'), { recursive: true });
      fs.symlinkSync(outside, path.join(folder, 'reports', 'links', 'to-outside'));
      fs.linkSync(path.join(outside, 'secret.md'), path.join(folder, 'reports', 'links', 'hard.md'));

      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/vault`, { waitUntil: 'domcontentloaded' });
      const tree = page.getByRole('navigation', { name: 'Project folders' });
      const files = page.getByRole('region', { name: 'Files' });
      const file = page.getByRole('region', { name: 'File', exact: true });
      const treeFolder = (p: string) => tree.locator(`[data-tree-folder="${p}"]`);
      const listFolder = (name: string) => files.locator(`[data-folder-name="${name}"]`);
      const listFile = (name: string) => files.locator(`[data-file-name="${name}"]`);
      const crumbs = () => files.getByRole('navigation', { name: 'Folder path' }).innerText();

      // 1. The project's folders, every one, with their counts.
      await tree.getByRole('button', { name: /^harbor/ }).click({ timeout: 60_000 });
      await expect(treeFolder('reports')).toBeVisible({ timeout: 15_000 });
      const top = await tree.locator('[data-tree-folder]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tree-folder')));
      seen.top = top;
      for (const name of ['briefs', 'docs', 'plans', 'reports', 'tools']) expect(top, `the tree lists ${name}`).toContain(name);
      await stepShot(page, `${tag}-01-tree`);

      // 2. reports from the tree: its folders then its files, under breadcrumbs; overnight from the list; a nested file.
      await treeFolder('reports').click();
      await expect(listFolder('overnight')).toBeVisible({ timeout: 15_000 });
      expect((await crumbs()).replace(/\s+/g, ' ')).toBe('harbor › reports');
      const order = await files.locator('[data-folder-name], [data-file-name]').evaluateAll((els) => els.map((e) => e.getAttribute('data-folder-name') ?? `file:${e.getAttribute('data-file-name')}`));
      seen.reports = order;
      expect(order.indexOf('file:release.md'), 'folders before files').toBeGreaterThan(order.indexOf('overnight'));
      await listFolder('overnight').click();
      await expect(treeFolder('reports/overnight/wt')).toBeVisible({ timeout: 15_000 });
      expect((await crumbs()).replace(/\s+/g, ' ')).toBe('harbor › reports › overnight');
      await listFile('summary.md').click();
      await expect(file).toContainText('The nested report.', { timeout: 15_000 });
      await stepShot(page, `${tag}-02-nested-file`);

      // 3. A worktree: .git and node_modules named, not opened, in the tree and the list.
      await treeFolder('reports/overnight/wt').click();
      await treeFolder('reports/overnight/wt/w1').click({ timeout: 15_000 });
      for (const heavy of ['.git', 'node_modules']) {
        await expect(treeFolder(`reports/overnight/wt/w1/${heavy}`)).toContainText('not opened', { timeout: 15_000 });
        await expect(listFolder(heavy)).toBeDisabled();
        await expect(listFolder(heavy)).toContainText('not opened');
      }
      seen.worktree = await files.locator('[data-folder-name], [data-file-name]').evaluateAll((els) => els.map((e) => e.textContent));
      await stepShot(page, `${tag}-03-heavy`);

      // 4. Links: said, never followed nor read.
      await files.getByRole('button', { name: 'harbor', exact: true }).click();
      await treeFolder('reports').click();
      await listFolder('links').click();
      await expect(listFile('to-outside')).toContainText('link · not followed', { timeout: 15_000 });
      await expect(listFile('hard.md')).toContainText('hard link · not read');
      await listFile('to-outside').click();
      await expect(file).toContainText('is a link');
      await expect(file).toContainText('The Vault does not follow links.');
      await listFile('hard.md').click();
      await expect(file).toContainText('a hard link. The Vault does not read it.');
      expect(await page.locator('body').innerText(), 'nothing of outside is shown').not.toContain(OUTSIDE);
      await stepShot(page, `${tag}-04-links`);

      // 5. An empty folder.
      await treeFolder('plans').click();
      await expect(files).toContainText('This folder is empty.', { timeout: 15_000 });

      // 6. 230 files: 200, "30 more", then all.
      await treeFolder('briefs').click();
      await listFolder('many').click();
      await expect(files.locator('[data-file-name]')).toHaveCount(200, { timeout: 15_000 });
      await expect(files).toContainText('30 more');
      await expect(files).toContainText('0 FOLDERS · 230 FILES');
      await stepShot(page, `${tag}-05-more`);
      await files.getByRole('button', { name: 'show 30 more', exact: true }).click();
      await expect(files.locator('[data-file-name]')).toHaveCount(230, { timeout: 15_000 });
      await expect(files).not.toContainText('30 more');
      seen.many = { first: await listFile('b229.md').isVisible(), count: await files.locator('[data-file-name]').count() };
      recordValues(seen);
    } finally {
      recordValues(seen);
      await app.close();
      await removeHome(home);
    }
  });
}
