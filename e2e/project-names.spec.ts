import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, seedSandbox, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A project is named by its folder wherever the app names it, and the Code
 * panel shows a project's folders, on Windows as on macOS and Linux.
 *
 * Every renderer site took `projectPath.split('/').pop()`. A Windows path has
 * no `/`, so the Agents page's project headers, the Kanban cards and the chat
 * rooms read `C:\Users\...\projects\tars` where macOS reads `tars`. The Code
 * panel's tree is built on `/` from the relative paths the main process
 * lists, which were `src\app\page.tsx` on Windows: one flat row per file,
 * named by its whole path, and no folder at all.
 *
 * The sandbox is the shared seed (seedSandbox, chat rooms included), so every
 * project path is the platform's own: `...\projects\tars` on Windows. The
 * project holds a small tree for the Code panel.
 *
 * The chat room titles come from the main process (bus-store.ts listRooms),
 * which names a room by its folder on Windows since win/p3-followups; that
 * test is green once that branch is in.
 *
 * Not driven here: the Kanban card (components/KanbanBoard), which no route
 * mounts since /kanban became the Hermes board, and which names its project
 * through the same pathName as every site here.
 *
 * Artefacts in each test's output folder: agents.png, orchestrator-window.png,
 * code-panel.png, chat.png and values.json.
 * Reproduce: `E2E_PORT_OFFSET=80 npx playwright test e2e/project-names.spec.ts`
 */

let app: ElectronApplication;
let page: Page;
let home: string;
let project: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  // Through realpath on Windows only, for its 8.3 names (RUNNER~1); on macOS
  // the app reports /var/..., as os.tmpdir() gives it, not /private/var/...
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-project-names-'));
  home = process.platform === 'win32' ? fs.realpathSync(made) : made;
  seedSandbox(home, { chatRooms: true });
  project = path.join(home, 'projects', 'tars');
  for (const [rel, text] of [
    ['src/app/page.tsx', 'export default function Page() { return null; }\n'],
    ['src/lib/util.ts', 'export const one = 1;\n'],
    ['README.md', '# tars\n'],
  ]) {
    const file = path.join(project, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31470), DOROTHY_E2E: '1' },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

test('names each project by its folder on Agents, and the Code panel shows folders', async () => {
  // Several pages compiled cold by next dev on a busy machine.
  test.setTimeout(300_000);
  recordValues({ platform: process.platform, home, project });

  // Agents: one header per project, the folder's name.
  await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
  const main = page.locator('main');
  await expect(main.locator('h2', { hasText: /^tars$/ })).toBeVisible({ timeout: 90_000 });
  // The launch splash (components/Splash.tsx) gone, so the photograph shows the page.
  await expect(page.locator('.fixed.inset-0.z-\\[200\\]')).toHaveCount(0, { timeout: 60_000 });
  const headers = (await main.locator('h2').allTextContents()).map(t => t.trim());
  recordValues({ agentsHeaders: headers });
  await stepShot(page, 'agents');
  expect(headers).toEqual(expect.arrayContaining(['tars', '1212-capital', 'atlas', 'mercury', 'orion']));
  expect(headers.filter(h => h.includes(home))).toEqual([]);

  // Code panel: what the main process lists, then the tree the window draws.
  const listed = await page.evaluate(async (root) => (await window.electronAPI!.project.listFiles(root, 3)), project);
  recordValues({ listFiles: listed });
  expect(listed.files).toEqual(['README.md', 'src/app/page.tsx', 'src/lib/util.ts']);

  // The Orchestrator's window lists the projects by their last two folders.
  await main.getByText('Orchestrator', { exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await stepShot(page, 'orchestrator-window');
  await dialog.getByRole('button', { name: 'close', exact: true }).click();
  await expect(dialog).toBeHidden();

  // A worker's window has the Code panel, under Memory. QA works in tars itself, not a worktree.
  await main.getByText('QA', { exact: true }).first().click();
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByLabel('Agent rail').getByRole('radio', { name: 'Memory' }).click();
  const tree = dialog.getByText('src', { exact: true });
  await expect(tree).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText('README.md', { exact: true })).toBeVisible();
  await tree.click();
  await expect(dialog.getByText('app', { exact: true })).toBeVisible();
  await expect(dialog.getByText('lib', { exact: true })).toBeVisible();
  await stepShot(page, 'code-panel');
  recordValues({ codePanelFolders: ['src', 'app', 'lib'] });
  await dialog.getByRole('button', { name: 'close', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('names each chat room by its folder', async () => {
  test.setTimeout(240_000);
  await page.goto(`${DEV_URL}/chat`, { waitUntil: 'domcontentloaded' });
  const main = page.locator('main');
  const names = ['atlas', 'mercury', 'orion', '1212-capital'];
  // The list is loaded once orion's room is listed, under either name.
  const orion = path.join(home, 'projects', 'orion');
  await expect.poll(async () => (await main.getByText('orion', { exact: true }).count())
    + (await main.getByText(orion, { exact: true }).count()), { timeout: 90_000 }).toBeGreaterThan(0);
  const shown = Object.fromEntries(await Promise.all(names.map(async n => [n, await main.getByText(n, { exact: true }).count()])));
  const wholePaths = await Promise.all(names.map(async n => main.getByText(path.join(home, 'projects', n), { exact: true }).count()));
  recordValues({ chatNamesShown: shown, chatWholePathsShown: wholePaths });
  await stepShot(page, 'chat');
  for (const n of names) expect(shown[n], n).toBeGreaterThan(0);
  expect(wholePaths).toEqual([0, 0, 0, 0]);
});
