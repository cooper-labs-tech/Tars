import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A project the window's project rule refuses is said so in the window, in main's own words (2.0.7, #648).
 *
 * Since 99bdbcbbd main lists a project Tars already holds under such a folder with `refused: <reason>`, answers the
 * Code panel's channels with that reason, and refuses a new one with it (e2e/window-vault-and-search.spec.ts, step 7,
 * drives those answers). Nothing in the window drew them: the project's card looked like any other, the Code panel
 * showed an empty tree, and an add refused by main left no word.
 *
 * The real app on a sandbox HOME: a project held under ~/.cargo (a dot folder of the home), an agent on it, and a plain
 * project. Main's own answers are read through the window's calls, then the window is read. Asserted:
 * 1. the Projects page: the held project's card shows main's reason word for word ([data-project-refused]), the plain
 *    one shows none;
 * 2. the agent's window, Memory: the Code panel shows main's reason word for word ([data-code-panel-refused]);
 * 3. the Projects page, + Project on ~/.azure/work (main's folder dialog answers with it): main's refusal shows where
 *    the add was made ([data-project-add-refused]), word for word.
 * 4. Review (since bbdd335bb main refuses its channels the same way): the held project says main's reason in the list
 *    of projects ([data-review-project-refused]), and an untracked .env in the plain project's repository, picked among
 *    its changed files, says main's own sentence in the patch's place ([data-review-file-error]), word for word.
 * Red on 99bdbcbbd: none of the first three lines existed. Red on bbdd335bb: neither of Review's.
 * The artefact: values.json (main's answers, the lines shown) and refused-<n>.png.
 */

type Api = { electronAPI: {
  fs: {
    listProjects(): Promise<Array<{ path: string; refused?: string }>>;
    addCustomProject(p: string): Promise<{ success: boolean; error?: string }>;
  };
  project: { listFiles(root: string, depth?: number): Promise<{ success: boolean; error?: string }> };
} };

type ReviewApi = { electronAPI: { review: { file(repo: string, file: string): Promise<{ success: boolean; error?: string }> } } };

test('a project the window\'s rule refuses is said so on the Projects page, in the Code panel, and where an add is made', async () => {
  test.setTimeout(120_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-refused-project-'));
  const dir = path.join(home, '.tars');
  const plain = path.join(home, 'projects', 'demo');
  const held = path.join(home, '.cargo', 'mine');
  const azure = path.join(home, '.azure', 'work');
  for (const d of [dir, plain, held, azure]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(held, 'lib.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(plain, 'index.ts'), 'export const y = 2;\n');
  // The plain project is a repository with one commit, and a file named like a credential beside it, not committed.
  const git = (...args: string[]) => execFileSync('git', args, { cwd: plain, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  git('add', 'index.ts');
  git('commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(plain, '.env'), 'FAKE_SETTING=stand-in-of-the-e2e\n');
  const at = { status: 'idle', role: 'worker', skills: [], permissionMode: 'normal', provider: 'claude', character: 'robot', createdAt: '2026-11-26T08:00:00.000Z', lastActivity: '2026-11-26T08:00:00.000Z' };
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{ id: 'held-agent', name: 'Held Agent', projectPath: held, ...at }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([plain, held]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31953), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/projects`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const shot = (n: number) => page.screenshot({ path: test.info().outputPath(`refused-${n}.png`) });
    const text = async (sel: string) => (await page.locator(sel).first().textContent({ timeout: 1_000 }).catch(() => null)) ?? null;

    // Main's own answers.
    const listed = await page.evaluate(() => (window as unknown as Api).electronAPI.fs.listProjects());
    const heldReason = listed.find((p) => p.path === held)?.refused ?? null;
    const files = await page.evaluate((r) => (window as unknown as Api).electronAPI.project.listFiles(r, 3), held);
    const addAnswer = await page.evaluate((p) => (window as unknown as Api).electronAPI.fs.addCustomProject(p), azure);
    keep({ heldReason, files, addAnswer });
    expect(heldReason, 'main lists the held project as refused').toBeTruthy();

    // 1. The Projects page.
    const heldCard = page.locator(`[data-project-card="${held}"]`);
    await expect.soft(heldCard.locator('[data-project-refused]'), 'the held project says why').toBeVisible({ timeout: 15_000 });
    const cardShown = (await heldCard.locator('[data-project-refused]').textContent({ timeout: 1_000 }).catch(() => null)) ?? null;
    const plainLines = await page.locator(`[data-project-card="${plain}"] [data-project-refused]`).count();
    await shot(1);

    // 3. + Project on ~/.azure/work.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, azure);
    await page.getByRole('button', { name: '+ Project' }).first().click();
    await expect.soft(page.locator('[data-project-add-refused]'), 'the add refused, said where it was made').toBeVisible({ timeout: 10_000 });
    const addShown = await text('[data-project-add-refused]');
    await shot(3);

    // 2. The agent's window, Memory: the Code panel.
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-agent-card="held-agent"]').click({ position: { x: 24, y: 14 } });
    await page.getByRole('radiogroup', { name: 'Agent rail' }).getByRole('radio', { name: /Memory/ }).click();
    await expect.soft(page.locator('[data-code-panel-refused]'), 'the Code panel says why').toBeVisible({ timeout: 10_000 });
    const codeShown = await text('[data-code-panel-refused]');
    await shot(2);

    // 4. Review: the held project says main's reason and is not scanned; the plain one's .env says main's sentence.
    // The repository as Tars lists it and as the page asks for it. Its real path is another spelling under a temp folder
    // reached through a link (macOS's /var/folders), which no project names: main refuses it before it judges the file.
    const fileAnswer = await page.evaluate((r) => (window as unknown as ReviewApi).electronAPI.review.file(r, '.env'), plain);
    await page.goto(`${DEV_URL}/review`, { waitUntil: 'domcontentloaded' });
    await expect.soft(page.locator('[data-review-project-refused]'), 'Review says why the held project is not read').toBeVisible({ timeout: 15_000 });
    const reviewShown = await text('[data-review-project-refused]');
    const envButton = page.getByRole('button', { name: /^\.env\b/ }).first();
    await expect.soft(envButton, 'the .env listed among the changed files').toBeVisible({ timeout: 15_000 });
    await envButton.click({ timeout: 5_000 }).catch(() => undefined);
    await expect.soft(page.locator('[data-review-file-error]'), 'the .env says why it is not shown').toBeVisible({ timeout: 10_000 });
    const fileShown = await text('[data-review-file-error]');
    await shot(4);

    keep({ cardShown, plainLines, addShown, codeShown, reviewShown, fileAnswer, fileShown, errors });
    expect.soft(reviewShown, 'Review: main\'s reason, word for word').toBe(heldReason);
    expect.soft(fileAnswer.success, 'main does not show the .env').toBe(false);
    expect.soft(fileShown, 'Review: main\'s sentence for the .env, word for word').toBe(fileAnswer.error ?? '(no answer)');
    expect.soft(cardShown, 'the card: main\'s reason, word for word').toBe(heldReason);
    expect.soft(plainLines, 'the plain project says nothing').toBe(0);
    expect.soft(files.success, 'main reads no file of the held project').toBe(false);
    expect.soft(codeShown, 'the Code panel: main\'s reason, word for word').toBe(files.error ?? '(no answer)');
    expect.soft(addAnswer.success, 'main refuses the add').toBe(false);
    expect.soft(addShown ?? '', 'the add: main\'s reason, word for word').toContain(addAnswer.error ?? '(no answer)');
    expect.soft(errors).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    await removeHome(home);
  }
});
