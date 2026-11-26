import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Review page lists every repository of every project, and searches them all (2.0.4, the window's part of
 * #472). Frames: `Review · projects and their repositories` (its light copy, the narrowest window), `· search`,
 * `· a folder with no git` (and its light copy), `· states` (and its light copy).
 *
 * The real app on a sandbox HOME with two projects added in Tars: meridian, holding three repositories at three
 * depths, two with a change; field-notes, with no git. Finder is stood in for in the main process. Asserted:
 * 1. meridian lists its three repositories under MERIDIAN · 3 REPOSITORIES, each with its branch, and says which
 *    changed, 2 in all.
 * 2. field-notes says once that it has no git, and picked, explains it with its folder to show.
 * 3. A repository picked: its title, its branch against main and how far ahead, its files; a file picked, its patch.
 * 4. Search: a changed file of any repository, picked, opens that repository and that file; a word found nowhere says
 *    so, naming how many repositories and projects were searched.
 * A project added by hand whose folder is gone, said once with its removal asking once, is drawn (`· states`) and
 * waits for 2.0.5, the orchestrator's decision of 19/10: the window is not told of such a project, and the removal
 * of a project known only from its agents' paths is not decided yet.
 * Red on 1953bd6f (#472's head, the page before this): no repository of meridian in the list.
 * The artefact: values.json (the rows read, what Tars would have opened), the screenshots, and with
 * E2E_TRACE=on the app's trace.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
function repo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

async function standInForFinder(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __e2eOpened: string[] };
    g.__e2eOpened = [];
    shell.openPath = (async (p: string) => { g.__e2eOpened.push(p); return ''; }) as typeof shell.openPath;
    shell.showItemInFolder = ((p: string) => { g.__e2eOpened.push(p); }) as typeof shell.showItemInFolder;
  });
}
const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __e2eOpened: string[] }).__e2eOpened);

const repositories = (page: Page) => page.getByRole('navigation', { name: 'Repositories' });
const repoRow = (page: Page, name: string) => repositories(page).getByRole('button', { name: new RegExp(`^${name}\\b`) });

const shell = ' (new interface)';

test(`review lists every repository of every project, says a folder with no git or gone, and searches them all${shell}`, async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-review-window-ni-`));
  const dir = path.join(home, '.tars');
  const meridian = path.join(home, 'projects', 'meridian');
  const fieldNotes = path.join(home, 'projects', 'field-notes');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(fieldNotes, { recursive: true });
  fs.writeFileSync(path.join(fieldNotes, 'notes.txt'), 'no git here');
  const contracts = repo(path.join(meridian, 'contracts'));
  const sdk = repo(path.join(meridian, 'sdk-js'));
  repo(path.join(meridian, 'services', 'a', 'b', 'indexer'));
  fs.writeFileSync(path.join(contracts, 'README.md'), '# r\nchanged\n');
  git(sdk, 'checkout', '-q', '-b', 'feat/indexer');
  fs.mkdirSync(path.join(sdk, 'src', 'indexer'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'src', 'indexer', 'client.ts'), 'export {};\n');
  git(sdk, 'add', '-A');
  git(sdk, 'commit', '-q', '-m', 'client');
  fs.writeFileSync(path.join(sdk, 'src', 'indexer', 'client.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([meridian, fieldNotes]));
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31562), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  try {
    await standInForFinder(app);
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/review`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(1, { timeout: 30_000 });

    // 1. meridian's repositories, each with its branch, 2 changed.
    const list = repositories(page);
    await expect(list).toContainText('MERIDIAN · 3 REPOSITORIES', { timeout: 60_000 });
    await expect(list).toContainText('2 changed');
    await expect(repoRow(page, 'contracts')).toContainText('main');
    await expect(repoRow(page, 'contracts')).toContainText('1 changed');
    await expect(repoRow(page, 'sdk-js')).toContainText('feat/indexer');
    await expect(repoRow(page, 'services/a/b/indexer')).toContainText('clean');
    keep({ rows: await list.getByRole('button').allInnerTexts() });
    await stepShot(page, '01-repositories');

    // 2. field-notes: no git, said once, explained when picked.
    await expect(list).toContainText('No git here: not a repository, and none inside.');
    await list.getByRole('button', { name: /No git here/ }).click();
    await expect(page.getByRole('heading', { name: 'field-notes is not under git' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'show folder', exact: true }).click();
    await expect.poll(async () => (await opened(app)).at(-1) ?? '', { timeout: 10_000 }).toBe(fieldNotes);
    await stepShot(page, '02-no-git');

    // 3. A repository and a file.
    await repoRow(page, 'sdk-js').click();
    const files = page.getByRole('region', { name: 'Changed files' });
    await expect(files).toContainText('meridian / sdk-js', { timeout: 15_000 });
    await expect(files).toContainText('feat/indexer vs main · 1 commit ahead');
    await files.getByRole('button', { name: /src\/indexer\/client\.ts/ }).click();
    await expect(page.getByText('+export const a = 1;', { exact: true })).toBeVisible({ timeout: 15_000 });
    await stepShot(page, '03-repository-and-file');

    // 4. Search: a changed file anywhere, picked; then a word found nowhere.
    const search = page.getByRole('searchbox', { name: 'Search every repository and changed file' });
    await search.fill('client');
    await expect(list).toContainText('RESULTS · EVERY PROJECT, NO LIMIT', { timeout: 15_000 });
    await list.getByRole('button', { name: /sdk-js\/src\/indexer\/client\.ts/ }).click();
    await expect(files).toContainText('meridian / sdk-js', { timeout: 15_000 });
    await expect(page.getByText('+export const a = 1;', { exact: true })).toBeVisible({ timeout: 15_000 });
    await stepShot(page, '04-search');
    await search.fill('fetchTicker');
    await expect(list).toContainText('Nothing named fetchTicker in the 3 repositories of your 2 projects, nor in their changed files.', { timeout: 15_000 });
    await stepShot(page, '05-search-nothing');

    keep({ opened: await opened(app), pageErrors: errors });
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await app.close().catch(() => { /* gone */ });
    await removeHome(home);
  }
});
