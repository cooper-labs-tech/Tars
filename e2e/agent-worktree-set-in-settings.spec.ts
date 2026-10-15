import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent's worktree set in its settings, from the Agents page (JeanBrasse's report of 13/10: "cela
 * n'enregistre absolument rien"). Edit agent, Options, Its own worktree on, a branch, Save
 * changes; then the settings opened again.
 *
 * A sandbox HOME with two projects and an agent in each, whose CLI is a stand-in that records
 * the folder it is launched in. One project is a git repository, the other is a plain folder, as
 * many of JeanBrasse's projects are.
 * 1. In the repository: the worktree is made, the settings opened again show it on, its branch
 *    and locked, agents.json holds it, and the agent's next launch runs in it.
 * 2. In the plain folder, where git can make no worktree: the dialog does not close as if it had
 *    saved; it says why it saved nothing, and the agent is left as it was.
 *
 * The artefact: a screenshot per state, values.json (agents.json's worktree fields, the launch's
 * folder, what the dialog said, and each agent:update the main process received with what it
 * answered), launches.jsonl.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

test('an agent\'s worktree set in its settings is saved and used, and a worktree git cannot make is refused in words', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-agent-worktree-'));
  const repo = path.join(home, 'projects', 'demo');
  const plain = path.join(home, 'projects', 'notes');
  const dir = path.join(home, '.dorothy');
  for (const d of [repo, plain, dir]) fs.mkdirSync(d, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t.example');
  git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(plain, 'notes.md'), 'not in git\n');

  const launches = path.join(home, 'launches.jsonl');
  const cli = path.join(home, 'recording-cli.cjs');
  fs.writeFileSync(cli, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ id: process.env.CLAUDE_AGENT_ID, cwd: process.cwd() }) + '\\n');`,
    "process.stdout.write('ready\\n');",
    'process.stdin.resume();',
    '',
  ].join('\n'), { mode: 0o755 });
  const agent = (id: string, name: string, projectPath: string) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath, skills: [], cliPath: cli, createdAt: '2026-10-13T08:00:00.000Z', lastActivity: '2026-10-13T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('fe', 'Frontend Engineer', repo), agent('nt', 'Note Taker', plain)], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([repo, plain]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  // agents.json is { version, savedAt, agents } once the app has written it; the seed is a bare list.
  const onDisk = (id: string) => {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')) as Array<Record<string, unknown>> | { agents: Array<Record<string, unknown>> };
    return (Array.isArray(parsed) ? parsed : parsed.agents).find(a => a.id === id)!;
  };
  const real = (p: string) => fs.realpathSync(p);

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31438), DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  const seen: Record<string, unknown> = {};
  // What the dialog sends on save, as the main process receives it, and what agent:update answers.
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
    const update = handlers.get('agent:update')!;
    const g = globalThis as unknown as { agentUpdates: unknown[] };
    g.agentUpdates = [];
    handlers.set('agent:update', async (event: unknown, ...args: unknown[]) => {
      const answer = await update(event, ...args) as { success?: boolean; error?: string; agent?: { worktreePath?: string; branchName?: string } };
      g.agentUpdates.push({ sent: JSON.parse(JSON.stringify(args[0] ?? null)), answered: { success: answer?.success, error: answer?.error, worktreePath: answer?.agent?.worktreePath, branchName: answer?.agent?.branchName } });
      return answer;
    });
  });
  const updates = () => app.evaluate(() => (globalThis as unknown as { agentUpdates: unknown[] }).agentUpdates);
  try {
    const page: Page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
    const card = (id: string) => page.locator(`[data-agent-card="${id}"]`);
    // The dialog has no name of its own: it is the one titled Edit agent.
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Edit agent', exact: true }) });
    const worktreeRow = dialog.getByText('Its own worktree', { exact: true }).locator('xpath=../..');
    const openSettings = async (id: string) => {
      await card(id).getByRole('button', { name: 'edit', exact: true }).click();
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await dialog.getByRole('button', { name: 'Options' }).click();
      await expect(worktreeRow).toBeVisible();
    };
    const setWorktree = async (branch: string) => {
      // An agent with no worktree of its own offers one: its switch off, and free to turn on.
      await expect(worktreeRow.getByRole('switch'), 'an agent with no worktree has its switch off').toHaveAttribute('aria-checked', 'false');
      await expect(worktreeRow.getByRole('switch'), 'and free to turn on').toBeEnabled();
      await worktreeRow.getByRole('switch').click();
      await dialog.getByPlaceholder('feat/frontend').fill(branch);
      await dialog.getByRole('button', { name: 'Save changes' }).click();
    };
    await expect(card('fe')).toBeVisible({ timeout: 60_000 });
    // As in a Tars open for a while: the agents' list has read each folder's branch from git (its
    // first reading starts it, the next one returns it), and an agent with no worktree of its own
    // shows its project's, main, on its card. The page opened again reads the list again.
    await page.waitForTimeout(1500);
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await expect(card('fe')).toContainText('main', { timeout: 30_000 });
    await stepShot(page, '00-agents-branch-read');

    // 1. In the repository: set, saved, shown again, and used at the next launch.
    await openSettings('fe');
    await setWorktree('feat/scroll-lock');
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    seen.repoOnDisk = { worktreePath: onDisk('fe').worktreePath ?? null, branchName: onDisk('fe').branchName ?? null };
    expect(onDisk('fe').branchName, 'agents.json holds its branch').toBe('feat/scroll-lock');
    const worktreePath = String(onDisk('fe').worktreePath);
    expect(fs.existsSync(worktreePath), 'its worktree is on disk').toBe(true);
    expect(git(worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/scroll-lock');
    await openSettings('fe');
    await expect(worktreeRow.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await expect(worktreeRow.getByRole('switch')).toBeDisabled();
    await expect(dialog.getByPlaceholder('feat/frontend')).toHaveValue('feat/scroll-lock');
    await stepShot(page, '01-repo-worktree-shown-again');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await card('fe').getByRole('button', { name: 'start', exact: true }).click();
    await expect.poll(() => (fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8') : ''), { timeout: 60_000 }).toContain('"id":"fe"');
    const launch = fs.readFileSync(launches, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(l => l.id === 'fe');
    seen.launchCwd = launch.cwd;
    expect(real(launch.cwd), 'its next launch runs in its worktree').toBe(real(worktreePath));

    // 2. In a plain folder git can make no worktree in: refused in words, nothing changed.
    await openSettings('nt');
    await setWorktree('feat/notes');
    await expect(dialog, 'the dialog does not close as if it had saved').toBeVisible({ timeout: 10_000 });
    const refusal = dialog.getByRole('alert');
    await expect(refusal).toContainText('Not saved: ');
    // The reason is agent:update's own, whatever it says, and the changes made stay in the dialog.
    const answered = ((await updates()) as Array<{ answered: { success?: boolean; error?: string } }>).at(-1)!.answered;
    expect(answered.success, 'agent:update refused it').toBe(false);
    await expect(refusal).toContainText(String(answered.error));
    await expect(refusal).toContainText('Your changes are still here.');
    await expect(worktreeRow.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByPlaceholder('feat/frontend')).toHaveValue('feat/notes');
    seen.refusal = (await refusal.innerText()).replace(/\s+/g, ' ').trim();
    expect(onDisk('nt').worktreePath ?? null).toBeNull();
    await stepShot(page, '02-plain-folder-refused');

    expect(pageErrors, 'no uncaught page error').toEqual([]);
  } finally {
    // Kept red or green: what the dialog sent on each save and what agent:update answered.
    seen.agentUpdates = await updates().catch(() => null);
    recordValues(seen);
    await app.close().catch(() => {});
    if (fs.existsSync(launches)) fs.copyFileSync(launches, test.info().outputPath('launches.jsonl'));
    await removeHome(home);
  }
});
