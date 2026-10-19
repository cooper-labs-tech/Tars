import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, seedSandbox, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Review page's own side of JeanBrasse's "the Review page only half works"
 * (01/10), from the Audit's DIAG-REVIEW.md, in the real app on throwaway git
 * repositories in the sandbox. Frames: Review · dark, Review · light and
 * Review · states. In order:
 * - a project added in Tars that no agent works in is listed under its name,
 *   saying no agent, and its changes can be read;
 * - the page reads a tree's files without their patches (#247's listOnly): with
 *   no file picked, no git builds the tree's whole patch and the panel asks
 *   for a file; a picked file's patch past 4000 lines says where it stops, and
 *   a short one shows whole;
 * - Refresh reads the list again: a project added since shows;
 * - a file whose patch main can no longer read says why, where the page said
 *   there was no textual change;
 * - an agent's window, whose Code panel marks the files the agent changed,
 *   reads that list without the patches too.
 * Every git the app runs goes through a wrapper first on its PATH, which
 * writes down the folder and the arguments: a whole patch is a `diff` that is
 * neither a list (`--numstat`, `--name-status`) nor one file's (`--`).
 * A late answer for a tree or a file no longer picked is the page test's
 * (__tests__/components/review-page.test.tsx): its timing is not reproducible
 * here.
 */

let app: ElectronApplication;
let page: Page;
let home: string;
let gitLog: string;
const errors: string[] = [];

/** The git commands the app ran in `dir` since the log was last cleared, as argument lines. */
function ranIn(dir: string): string[] {
  const real = fs.realpathSync(dir);
  return fs.readFileSync(gitLog, 'utf8').split('\n').filter(Boolean)
    .filter(line => line.startsWith(`${real}|`))
    // Through utils/safe-git.ts: --no-optional-locks and its -c overrides first, and a look at the filters before a content read.
    .map(line => line.slice(real.length + 1).replace(/^--no-optional-locks /, '').replace(/^(-c \S+ )+/, ''))
    .filter(line => !/^config -z --name-only --get-regexp/.test(line));
}
const wholePatches = (lines: string[]) => lines.filter(l => /^diff\b/.test(l) && !/--(numstat|name-status)\b/.test(l) && !/ -- /.test(l));
const lists = (lines: string[]) => lines.filter(l => /^diff\b.*--numstat/.test(l));

/** A git repository with one commit of `files`, then `changes` written over it, uncommitted. */
function repo(dir: string, files: Record<string, string>, changes: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  for (const [file, text] of Object.entries(changes)) fs.writeFileSync(path.join(dir, file), text);
}

/** Adds a project as Settings or the Projects page would: a path in projects.json. */
function addProject(dir: string): void {
  const file = path.join(home, '.dorothy', 'projects.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
  fs.writeFileSync(file, JSON.stringify([...list, dir], null, 2));
}

const lines = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}`).join('\n') + '\n';

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-review-'));
  seedSandbox(home);
  const docs = path.join(home, 'projects', 'docs');
  repo(docs, { 'big.txt': lines(5000, 'old'), 'notes.md': 'notes\n' }, { 'big.txt': lines(5000, 'new'), 'notes.md': 'notes\na new line\n' });
  addProject(docs);
  // An agent at work in a repository of its own, for its window's Code panel.
  const code = path.join(home, 'projects', 'code');
  repo(code, { 'main.ts': lines(3000, 'old') }, { 'main.ts': lines(3000, 'new') });
  const agentsFile = path.join(home, '.dorothy', 'agents.json');
  const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8')) as Array<Record<string, unknown>>;
  agents.push({
    id: 'coder', name: 'Code Reader', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: code, skills: [], cliPath: path.join(home, 'bin', 'fake-cli.cjs'),
    createdAt: '2026-10-05T08:00:00.000Z', lastActivity: '2026-10-05T08:00:00.000Z',
  });
  fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
  // Every git the app runs, written down with the folder it ran in.
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const wrapper = path.join(home, 'git-wrapper');
  fs.mkdirSync(wrapper, { recursive: true });
  gitLog = path.join(home, 'git.log');
  fs.writeFileSync(gitLog, '');
  fs.writeFileSync(path.join(wrapper, 'git'), `#!/bin/sh\necho "$(pwd -P)|$*" >> "${gitLog}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  app = await launchSandboxed(electron, home, {
    env: {
      NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31482), DOROTHY_E2E: '1',
      PATH: `${wrapper}:${process.env.PATH}`,
    },
  });
  page = await app.firstWindow();
  listenForErrors(page, errors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async () => {
  await app?.close();
  await removeHome(home);
});

test('review: a project with no agent, the files without their patches, a patch cut short, refresh, a patch that cannot be read, and the code panel', async () => {
  test.setTimeout(180_000);
  await page.goto(`${DEV_URL}/review`, { waitUntil: 'domcontentloaded' });

  // The project no agent works in, under its name.
  await expect(page.getByText('DOCS', { exact: true })).toBeVisible({ timeout: 60_000 });
  const docsRow = page.getByRole('button').filter({ hasText: 'no agent' }).filter({ hasText: 'docs' });
  await expect(docsRow).toHaveCount(1);
  await docsRow.click();
  await expect(page.getByRole('button').filter({ hasText: 'big.txt' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button').filter({ hasText: 'notes.md' })).toBeVisible();

  // The files without their patches: no git built the tree's whole patch,
  // and the panel asks for a file.
  const docs = path.join(home, 'projects', 'docs');
  await expect(page.getByText('Pick a file to read its patch.', { exact: true })).toBeVisible();
  await expect(page.getByText(/lines shown\./)).toHaveCount(0);
  const docsRuns = ranIn(docs);
  expect(lists(docsRuns).length, docsRuns.join('\n')).toBeGreaterThan(0);
  expect(wholePatches(docsRuns), docsRuns.join('\n')).toEqual([]);
  await stepShot(page, '01-no-agent-project-files-alone');

  // A picked file's patch, past 4000 lines, says where it stops.
  await page.getByRole('button').filter({ hasText: 'big.txt' }).click();
  const fileCut = page.getByText(/^4000 of \d+ lines shown\.$/);
  await expect(fileCut).toBeVisible({ timeout: 30_000 });
  const fileNote = await fileCut.textContent();
  await stepShot(page, '01b-a-file-patch-cut');

  // A file's own patch, short: no note.
  await page.getByRole('button').filter({ hasText: 'notes.md' }).click();
  // The first match: main's patch for this file holds the hunk twice today, a
  // backend matter (DIAG-REVIEW.md, the two passes), not this page's.
  await expect(page.getByText('+a new line', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  const fileHunks = await page.getByText('+a new line', { exact: true }).count();
  await expect(page.getByText(/lines shown\./)).toHaveCount(0);
  await stepShot(page, '02-a-file-patch');

  // Refresh reads the list again: a project added since shows.
  const more = path.join(home, 'projects', 'more');
  repo(more, { 'a.txt': 'a\n' }, { 'a.txt': 'a\nb\n' });
  addProject(more);
  await expect(page.getByText('MORE', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('MORE', { exact: true })).toBeVisible({ timeout: 30_000 });
  // The same click reads the open tree again. Wait for that read too: the
  // rename below landed in the middle of it at a load average of about 60
  // (2026-10-05), the read came back empty and big.txt was gone.
  await expect(page.getByText('Still reading the working tree…')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('button').filter({ hasText: 'big.txt' })).toBeVisible();
  await stepShot(page, '03-refresh-reads-the-list');

  // A file whose patch main can no longer read says why.
  fs.renameSync(path.join(home, 'projects', 'docs', '.git'), path.join(home, 'projects', 'docs', '.git-gone'));
  await page.getByRole('button').filter({ hasText: 'big.txt' }).click();
  const failed = page.getByText(/^Could not read this file's patch: /);
  await expect(failed).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('No textual change to show for this file.')).toHaveCount(0);
  const failedText = await failed.textContent();
  await stepShot(page, '04-a-patch-that-cannot-be-read');

  // An agent's window: its Code panel marks the files the agent changed, read
  // without their patches. The page read this tree's list on load (it comes
  // first), so main may answer the panel from what it kept: what shows the
  // panel asked is review:diff's own check of the tree, `status -z`.
  const code = path.join(home, 'projects', 'code');
  await page.locator('aside').getByRole('link', { name: 'Agents', exact: true }).click();
  const card = page.locator('div').filter({ has: page.getByText('Code Reader', { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'open', exact: true }) }).last();
  fs.writeFileSync(gitLog, '');
  await card.getByRole('button', { name: 'open', exact: true }).click();
  // safe-git puts --ignore-submodules=all right after the subcommand.
  const asked = () => ranIn(code).filter(l => /^status (--ignore-submodules=all )?--porcelain=v1 -z/.test(l)).length;
  await expect.poll(asked, { timeout: 30_000, message: 'the code panel asked review:diff for the tree' }).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  const codeRuns = ranIn(code);
  expect(wholePatches(codeRuns), codeRuns.join('\n')).toEqual([]);
  await stepShot(page, '05-agent-window-code-panel');

  expect(errors, errors.join('\n')).toEqual([]);
  recordValues({ docsRuns, fileNote, failedText, fileHunks, codeRuns, pageErrors: errors });
});
