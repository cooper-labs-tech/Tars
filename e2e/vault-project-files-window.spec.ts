import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Vault page reads and edits each project's reports and tools (2.0.4, the window's part of #471). Frames:
 * `Vault · project folders · a report`, `· a report, editing`, `· a tool`, `· states` (each with its light copy).
 *
 * The real app on a sandbox HOME with a project, atlas, and its folder as an agent of 2.0.3 left it: in reports/ a
 * report with a link to another report, a link out of the folder, a page and a picture from the web; a second
 * report, a log too long to edit and a picture; in tools/ a script that runs; in notes/ a note. Tars's dialogs to
 * Finder and the browser are stood in for in the main process, so the run records what Tars would have opened and
 * opens nothing. Asserted, once with the classic shell and once with the new interface:
 * 1. Projects names atlas; its reports list their folder then their files newest first, under atlas › reports and
 *    1 FOLDER · 4 FILES (2.0.5), and say where its notes moved; show notes opens reports/notes in the Vault.
 * 2. A report reads as Markdown: a link to a report of the folder opens it here, the page is a link to the browser,
 *    the picture from the web is a link and is never fetched, the link out of the folder is text.
 * 3. Edit, save: the file on disk holds what was typed. An agent writing it meanwhile: the save is refused and said,
 *    its version left on disk, and see its version shows it.
 * 4. The log too long to edit reads its first part, and cannot be edited; the picture is named and sized only.
 * 5. Tools lists the script, executable, its lines numbered.
 * 6. A report an agent writes appears in the list by itself.
 * Red on 2d3cb5b2 (#471's head, the page before this): no project in the Vault.
 * The artefact: values.json (lists, texts read, what Tars would have opened, the requests made), the screenshots, and
 * with E2E_TRACE=on the app's trace.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
type Opened = { shown: string[]; opened: string[]; external: string[]; copied: string[] };

const RELEASE = [
  '# Release 2.0.4',
  '',
  'See [the roadmap](roadmap.md) and [the slot script](../tools/slot.sh).',
  '',
  'Merged in [the pull request](https://example.com/page).',
  '',
  '![the graph](https://example.com/graph.png)',
  '',
].join('\n');

function seedProject(home: string) {
  const project = path.join(home, 'projects', 'atlas');
  fs.mkdirSync(project, { recursive: true });
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  return project;
}

/** Tars's dialogs stood in for, before anything is shown or opened: a run never opens Finder or a browser. */
async function standInForShell(app: ElectronApplication) {
  await app.evaluate(({ shell, clipboard }) => {
    const g = globalThis as unknown as { __e2eOpened: { shown: string[]; opened: string[]; external: string[]; copied: string[] } };
    g.__e2eOpened = { shown: [], opened: [], external: [], copied: [] };
    shell.showItemInFolder = ((p: string) => { g.__e2eOpened.shown.push(p); }) as typeof shell.showItemInFolder;
    shell.openPath = (async (p: string) => { g.__e2eOpened.opened.push(p); return ''; }) as typeof shell.openPath;
    shell.openExternal = (async (u: string) => { g.__e2eOpened.external.push(u); }) as typeof shell.openExternal;
    clipboard.writeText = ((t: string) => { g.__e2eOpened.copied.push(t); }) as typeof clipboard.writeText;
  });
}
const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __e2eOpened: Opened }).__e2eOpened);

const filesRegion = (page: Page) => page.getByRole('region', { name: 'Files' });
/** The file panel by its exact name: a region's name is matched as a substring, and the list's is Files. */
const fileRegion = (page: Page) => page.getByRole('region', { name: 'File', exact: true });
const projects = (page: Page) => page.getByRole('navigation', { name: 'Project folders' });
/** The caret at the end of the text, as a user who clicks after the last line puts it. */
const toTheEnd = (editor: ReturnType<Page['getByRole']>) => editor.evaluate((el) => {
  const area = el as HTMLTextAreaElement;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
});
const fileRow = (page: Page, name: string) => filesRegion(page).getByRole('button', { name: new RegExp(`^${name.replace(/\./g, '\\.')}`) });

for (const newInterface of [false, true]) {
  const shell = newInterface ? ' (new interface)' : '';

  test(`the vault lists, reads and edits a project's reports and tools, never over an agent's change, and fetches nothing${shell}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-vault-window-${newInterface ? 'ni' : 'classic'}-`));
    const project = seedProject(home);
    fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31560 : 31559), DOROTHY_E2E: '1' },
    });
    const errors: string[] = [];
    const requested: string[] = [];
    try {
      // The project's folder as 2.0.3 left it, its key the app's own.
      const folder = await app.evaluate((_e, { dist, project }) => process.mainModule!.require(`${dist}/utils/project-files.js`).projectFilesDir(project) as string,
        { dist: path.resolve('electron', 'dist'), project });
      for (const sub of ['reports', 'tools', 'notes']) fs.mkdirSync(path.join(folder, sub), { recursive: true });
      const at = (name: string, minutesAgo: number) => { const t = new Date(Date.now() - minutesAgo * 60_000); fs.utimesSync(name, t, t); };
      const report = (name: string) => path.join(folder, 'reports', name);
      fs.writeFileSync(report('diagram.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, ...new Array(4096).fill(0)]));
      at(report('diagram.png'), 40);
      fs.writeFileSync(report('big.log'), 'a line of the build log, long enough to be read\n'.repeat(26_000));
      at(report('big.log'), 30);
      fs.writeFileSync(report('roadmap.md'), '# Roadmap\n\nThe next release.\n');
      at(report('roadmap.md'), 20);
      fs.writeFileSync(report('release.md'), RELEASE);
      at(report('release.md'), 10);
      fs.writeFileSync(path.join(folder, 'tools', 'slot.sh'), '#!/bin/bash\necho one slot\n', { mode: 0o755 });
      fs.writeFileSync(path.join(folder, 'notes', 'next.md'), 'what the next session should know');
      await standInForShell(app);

      const page = await app.firstWindow();
      listenForErrors(page, errors);
      page.on('request', (r) => { if (/example\.com/.test(r.url())) requested.push(r.url()); });
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/vault`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 60_000 });
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });

      // 1. The project, its reports newest first, its notes said.
      await expect(projects(page).getByRole('button', { name: /^atlas/ })).toBeVisible({ timeout: 30_000 });
      await projects(page).getByRole('button', { name: /^atlas/ }).click();
      await projects(page).getByRole('button', { name: /^reports/ }).click();
      // Since 2.0.5 the list shows a folder's folders too (#530's places): reports holds its notes folder.
      await expect(filesRegion(page)).toContainText('1 FOLDER · 4 FILES', { timeout: 15_000 });
      await expect(filesRegion(page).getByRole('navigation', { name: 'Folder path' })).toHaveText(/atlas\s*›\s*reports/);
      const listed = await filesRegion(page).locator('[data-file-name]').evaluateAll((els) => els.map((e) => e.getAttribute('data-file-name')));
      keep({ listed });
      expect(listed).toEqual(['release.md', 'roadmap.md', 'big.log', 'diagram.png']);
      await expect(filesRegion(page)).toContainText('Its notes are in reports/notes since 2.0.4.');
      await stepShot(page, '01-reports');
      // show notes opens them here, in the Vault, since 2.0.5 lists every folder.
      await filesRegion(page).getByRole('button', { name: 'show notes', exact: true }).click();
      await expect(fileRow(page, 'next.md')).toBeVisible({ timeout: 15_000 });
      await projects(page).getByRole('button', { name: /^reports/ }).click();
      await expect(filesRegion(page)).toContainText('1 FOLDER · 4 FILES', { timeout: 15_000 });

      // 2. A report as Markdown: here, the browser, a picture never fetched, the way out as text.
      await fileRow(page, 'release.md').click();
      const file = fileRegion(page);
      await expect(file).toContainText('Release 2.0.4', { timeout: 15_000 });
      await expect(file.getByRole('button', { name: 'the roadmap', exact: true })).toBeVisible();
      await expect(file.locator('a[href="https://example.com/page"]')).toHaveAttribute('target', '_blank');
      await expect(file.locator('img')).toHaveCount(0);
      await expect(file).toContainText('picture from the web, not loaded:');
      await expect(file.locator('a[href="https://example.com/graph.png"]')).toHaveCount(1);
      await expect(file.locator('a, button').filter({ hasText: 'the slot script' })).toHaveCount(0);
      await expect(file).toContainText('the slot script');
      await stepShot(page, '02-report-read');
      await file.getByRole('button', { name: 'the roadmap', exact: true }).click();
      await expect(file).toContainText('The next release.', { timeout: 15_000 });

      // 3. Edit and save; then an agent writes it meanwhile.
      await fileRow(page, 'release.md').click();
      await expect(file).toContainText('Release 2.0.4', { timeout: 15_000 });
      await file.getByRole('button', { name: 'edit', exact: true }).click();
      const editor = file.getByRole('textbox', { name: 'Edit release.md' });
      await expect(editor).toHaveValue(RELEASE);
      await toTheEnd(editor);
      await editor.pressSequentially('Edited in the window.');
      await expect(file).toContainText('unsaved');
      await stepShot(page, '03-editing');
      await file.getByRole('button', { name: 'save', exact: true }).click();
      await expect.poll(() => fs.readFileSync(report('release.md'), 'utf8'), { timeout: 15_000 }).toBe(`${RELEASE}Edited in the window.`);
      await expect(editor).toHaveCount(0);
      await expect(file).toContainText('Edited in the window.');

      await file.getByRole('button', { name: 'edit', exact: true }).click();
      await toTheEnd(editor);
      await editor.pressSequentially(' Mine.');
      const agents = '# Release 2.0.4\n\nThe agent wrote this version.\n';
      fs.writeFileSync(report('release.md'), agents);
      const later = new Date(Date.now() + 2_000);
      fs.utimesSync(report('release.md'), later, later);
      await file.getByRole('button', { name: 'save', exact: true }).click();
      await expect(file.getByRole('alert')).toContainText('An agent changed this file at', { timeout: 15_000 });
      expect(fs.readFileSync(report('release.md'), 'utf8'), "the agent's version is kept").toBe(agents);
      await stepShot(page, '04-agent-changed-it');
      await file.getByRole('button', { name: 'see its version', exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(file).toContainText('The agent wrote this version.');

      // 4. Too long to edit, and not text.
      await fileRow(page, 'big.log').click();
      await expect(file).toContainText('read here up to its first 200 KB, and edited in your own editor', { timeout: 15_000 });
      await expect(file.getByRole('button', { name: 'edit', exact: true })).toBeDisabled();
      await fileRow(page, 'diagram.png').click();
      await expect(file).toContainText('Not text:', { timeout: 15_000 });
      await expect(file).toContainText('shown by its name only. Open it from its folder.');
      await stepShot(page, '05-not-text');

      // 5. Tools: the script, executable, its lines numbered.
      await projects(page).getByRole('button', { name: /^tools/ }).click();
      await expect(filesRegion(page)).toContainText('0 FOLDERS · 1 FILE', { timeout: 15_000 });
      await fileRow(page, 'slot.sh').click();
      await expect(file).toContainText('executable', { timeout: 15_000 });
      await expect(file).toContainText('echo one slot');
      await stepShot(page, '06-tool');

      // 6. A report an agent writes shows up by itself.
      await projects(page).getByRole('button', { name: /^reports/ }).click();
      await expect(filesRegion(page)).toContainText('1 FOLDER · 4 FILES', { timeout: 15_000 });
      fs.writeFileSync(report('fresh.md'), '# Fresh\n');
      await expect(fileRow(page, 'fresh.md')).toBeVisible({ timeout: 15_000 });
      await stepShot(page, '07-agent-wrote');

      keep({ opened: await opened(app), requested, pageErrors: errors });
      expect(requested, 'nothing from the web was fetched').toEqual([]);
      expect(errors, errors.join('\n')).toEqual([]);
    } finally {
      await app.close().catch(() => { /* gone */ });
      await removeHome(home);
    }
  });
}
