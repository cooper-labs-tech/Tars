import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import { launchSandboxed, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The folders no agent owns, in Settings, System, as a person meets them
 * (#334's contract, the frames of #315: `Settings · System · folders no agent
 * owns` and its states).
 *
 * The real app, a sandbox HOME whose project holds a worktree git knows, an
 * agent's worktree, a worktree git forgot, a folder with no .git, and one a
 * real process works in, and a second project, api-server, whose git cannot
 * list its worktrees. The person reads the list (the three, each with why,
 * its size and when it last changed), the line under it naming api-server as
 * the rows name a project, without git's reason, and the disk above it;
 * remove asks first and removes nothing; cancel takes the question away.
 * A folder then appears under .worktrees, after the list was read. Remove
 * again, then remove in the question, which names three: the end says two
 * were removed and one kept, which stays listed as in use, the process named
 * in its title. The late folder, which no confirm named, is not removed: it
 * stays on the disk, and the list read again shows it, with remove 2
 * folders. The two idle folders are gone from the disk, the busy one, the
 * live worktree and the agent's are not. Once the process is gone, the last
 * two go too, and read again the row says none in the projects git could
 * read, never that every folder is known, still naming api-server, whose
 * folder was never offered and is still there.
 *
 * The second test: a folder that cannot be removed, holding a read-only
 * folder, and one removed by hand once the list was read. The end says the
 * one is kept and its row says why, and the other was no longer a folder no
 * agent owns: it has no row left to say so. The kept one's row reads not
 * removed, and its title says why in plain words, then the error's code
 * (not empty on macOS, permission denied on Linux: which code and which path
 * Node names differ), never with an absolute path, the home being in it.
 *
 * The artefact: a screenshot per state and values.json with what each one read.
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('the folders no agent owns are listed, asked about first, kept on cancel, and removed but the one in use and one no confirm named, which the list keeps; a project git could not list is named, never read as having none', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-orphans-ui-'));
  const project = path.join(fs.realpathSync(home), 'projects', 'tars-hermes');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 't@t.example');
  git(project, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'init');
  const wt = (...p: string[]) => path.join(project, '.worktrees', ...p);
  git(project, 'worktree', 'add', '-q', wt('feat', 'live'), '-b', 'feat/live');
  git(project, 'worktree', 'add', '-q', wt('agent-wt'), '-b', 'agent-wt');
  // Git forgot it: its .git names a gitdir that is gone.
  fs.mkdirSync(wt('feat-relay-retry', 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(wt('feat-relay-retry', '.git'), `gitdir: ${path.join(project, '.git', 'worktrees', 'feat-relay-retry')}\n`);
  fs.writeFileSync(wt('feat-relay-retry', 'node_modules', 'x', 'index.js'), Buffer.alloc(200_000, 120));
  // No .git at all.
  fs.mkdirSync(wt('agent-7f3c1a'), { recursive: true });
  fs.writeFileSync(wt('agent-7f3c1a', 'notes.md'), Buffer.alloc(50_000, 120));
  // A process works in this one.
  fs.mkdirSync(wt('busy'), { recursive: true });
  fs.writeFileSync(wt('busy', 'x.txt'), 'x');
  // A project git cannot list: its .git names a gitdir that is gone.
  const unread = path.join(fs.realpathSync(home), 'projects', 'api-server');
  const stale = path.join(unread, '.worktrees', 'stale-branch');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'x.txt'), 'x');
  fs.writeFileSync(path.join(unread, '.git'), `gitdir: ${path.join(unread, '.git-gone')}\n`);
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'a1', name: 'Agent', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, worktreePath: wt('agent-wt'), branchName: 'agent-wt', skills: [],
    createdAt: '2026-10-06T08:00:00.000Z', lastActivity: '2026-10-06T08:00:00.000Z',
  }]));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project, unread]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  // node on Windows, which has no sleep of its own.
  const busy = process.platform === 'win32'
    ? spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { cwd: wt('busy'), stdio: 'ignore' })
    : spawn('sleep', ['300'], { cwd: wt('busy'), stdio: 'ignore' });
  const onDisk = () => ({ relay: fs.existsSync(wt('feat-relay-retry')), noGit: fs.existsSync(wt('agent-7f3c1a')), busy: fs.existsSync(wt('busy')), stale: fs.existsSync(stale), late: fs.existsSync(wt('late-orphan')) });

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31460), DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  const seen: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/settings?section=system`, { waitUntil: 'domcontentloaded' });

    // The list, and the disk above it.
    const block = page.locator('[data-orphan-folders]');
    await expect(block).toContainText('Folders no agent owns', { timeout: 90_000 });
    await expect(block).toContainText('3 folders,', { timeout: 60_000 });
    const rows = block.locator('[data-orphan-row]');
    await expect(rows).toHaveCount(3);
    seen.list = (await rows.allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
    const byName = (name: string) => rows.filter({ hasText: `tars-hermes/.worktrees/${name}` });
    await expect(byName('feat-relay-retry')).toContainText('git forgot it');
    // The size main measures is what the folder takes on the disk, blocks and all.
    await expect(byName('feat-relay-retry')).toContainText(/\d+ KB/);
    await expect(byName('agent-7f3c1a')).toContainText('no .git');
    await expect(byName('busy')).toContainText('no .git');
    await expect(block).not.toContainText(project);
    // The project git could not list, named as the rows name a project, never
    // by its path, and without git's reason, which stays in main's log.
    const unreadLine = block.locator('[data-orphan-unread]');
    const UNREAD = 'Git could not list the worktrees of api-server, so Tars cannot say which of its folders no agent owns.';
    await expect(unreadLine).toHaveText(UNREAD);
    await expect(block).not.toContainText(unread);
    await expect(block).not.toContainText('not a git repository');
    seen.unread = await unreadLine.innerText();
    const disk = page.locator('[data-settings-row]', { hasText: 'Disk' });
    await expect(disk).toContainText(/\d+ GB free of \d+ GB on the startup disk\. Tars warns below 30 GB\./);
    seen.disk = (await disk.innerText()).replace(/\s+/g, ' ');
    seen.listHint = (await block.locator('[data-settings-hint]').first().innerText()).replace(/\s+/g, ' ');
    await stepShot(page, '01-list');

    // Remove asks first, and removes nothing yet.
    await block.getByRole('button', { name: 'remove 3 folders', exact: true }).click();
    const confirm = block.locator('[data-orphan-confirm]');
    await expect(confirm).toContainText('Remove these 3 folders,');
    await expect(confirm).toContainText('for good?');
    seen.asks = (await confirm.innerText()).replace(/\s+/g, ' ');
    expect(onDisk(), 'asking removes nothing').toEqual({ relay: true, noGit: true, busy: true, stale: true, late: false });
    await stepShot(page, '02-asks-first');

    // Cancel takes the question away.
    await confirm.getByRole('button', { name: 'cancel', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    expect(onDisk(), 'cancel removes nothing').toEqual({ relay: true, noGit: true, busy: true, stale: true, late: false });
    await expect(rows).toHaveCount(3);

    // A folder appears after the list was read: no confirm names it.
    fs.mkdirSync(wt('late-orphan'), { recursive: true });
    fs.writeFileSync(wt('late-orphan', 'notes.md'), Buffer.alloc(100_000, 120));

    // Remove, then remove in the question, which names the three it shows.
    await block.getByRole('button', { name: 'remove 3 folders', exact: true }).click();
    await expect(confirm).toContainText('Remove these 3 folders,');
    await confirm.getByRole('button', { name: 'remove 3 folders', exact: true }).click();
    if (process.platform === 'win32') {
      // Windows has neither lsof nor /proc to read which process works in a
      // folder (processCwds, orphan-folders.ts): nothing is removed, each is
      // kept as of unknown use, and the row says so.
      // The late folder is listed, as everywhere.
      await expect(block).toContainText('None was removed: Tars could not read which processes work in them, so all 3 were kept.', { timeout: 60_000 });
      await expect(rows).toHaveCount(4);
      for (const name of ['feat-relay-retry', 'agent-7f3c1a', 'busy']) await expect(byName(name).locator('[data-orphan-why]')).toHaveText('use unknown');
      await expect(byName('late-orphan')).toContainText('no .git');
      await expect(unreadLine).toHaveText(UNREAD);
      seen.done = (await block.locator('[data-settings-hint]').first().innerText()).replace(/\s+/g, ' ');
      seen.kept = (await rows.allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
      await stepShot(page, '03-windows-none-removed');
      const after = { ...onDisk(), live: git(wt('feat', 'live'), 'rev-parse', '--abbrev-ref', 'HEAD'), agent: fs.existsSync(wt('agent-wt', 'a.txt')) };
      recordValues({ ...seen, after, pageErrors });
      expect(after).toEqual({ relay: true, noGit: true, busy: true, stale: true, late: true, live: 'feat/live', agent: true });
      expect(pageErrors).toEqual([]);
      return;
    }
    await expect(block).toContainText('Removed 2 folders:', { timeout: 60_000 });
    await expect(block).toContainText('One was kept: a process works in it.');
    // Read again: the busy one kept, and the late one, never confirmed, listed.
    await expect(rows).toHaveCount(2);
    await expect(byName('busy')).toContainText('in use');
    // Which process, in the title of its why, as main names it.
    await expect(byName('busy').locator('[data-orphan-why]')).toHaveAttribute('title', new RegExp(`\\(${busy.pid}\\)`));
    await expect(byName('late-orphan')).toContainText('no .git');
    await expect(block.getByRole('button', { name: 'remove 2 folders', exact: true })).toBeEnabled();
    await expect(unreadLine).toHaveText(UNREAD);
    seen.done = (await block.locator('[data-settings-hint]').first().innerText()).replace(/\s+/g, ' ');
    seen.kept = (await rows.allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
    await stepShot(page, '03-done-one-kept');

    const afterFirst = { ...onDisk(), live: git(wt('feat', 'live'), 'rev-parse', '--abbrev-ref', 'HEAD'), agent: fs.existsSync(wt('agent-wt', 'a.txt')) };
    expect(afterFirst).toEqual({ relay: false, noGit: false, busy: true, stale: true, late: true, live: 'feat/live', agent: true });

    // Once nothing works in it, the last two go too, the late one confirmed
    // now; read again, the row says none in the projects git could read,
    // never that every folder is known, and still names api-server, whose
    // folder was never offered.
    const gone = new Promise(resolve => busy.once('exit', resolve));
    process.kill(busy.pid!, 'SIGKILL');
    await gone;
    await block.getByRole('button', { name: 'remove 2 folders', exact: true }).click();
    await expect(confirm).toContainText('Remove these 2 folders,');
    await confirm.getByRole('button', { name: 'remove 2 folders', exact: true }).click();
    await expect(block).toContainText('Removed 2 folders:', { timeout: 60_000 });
    await expect(rows).toHaveCount(0);
    await page.goto(`${DEV_URL}/settings?section=system`, { waitUntil: 'domcontentloaded' });
    await expect(block.locator('[data-settings-hint]').first()).toHaveText('None in the projects git could read.', { timeout: 90_000 });
    await expect(block).not.toContainText('belongs to a worktree git knows');
    await expect(unreadLine).toHaveText(UNREAD);
    await expect(block.getByRole('button', { name: /^remove/ })).toHaveCount(0);
    seen.none = (await block.innerText()).replace(/\s+/g, ' ');
    await stepShot(page, '04-none-api-server-unread');

    const after = { ...onDisk(), live: git(wt('feat', 'live'), 'rev-parse', '--abbrev-ref', 'HEAD'), agent: fs.existsSync(wt('agent-wt', 'a.txt')) };
    recordValues({ ...seen, afterFirst, after, pageErrors });
    expect(after).toEqual({ relay: false, noGit: false, busy: false, stale: true, late: false, live: 'feat/live', agent: true });
    expect(pageErrors).toEqual([]);
  } finally {
    if (busy.pid) { try { process.kill(busy.pid, 'SIGKILL'); } catch { /* gone */ } }
    await app.close().catch(() => { /* gone */ });
    await removeHome(home);
  }
});

test('a folder that could not be removed says why in its title, never with its path, and one gone meanwhile is said in the end', async () => {
  test.skip(process.getuid?.() === 0, 'root removes a read-only folder, so nothing is kept to read');
  test.skip(process.platform === 'win32', 'Windows removes no folder no agent owns: it cannot read which process works in one (no lsof nor /proc, orphan-folders.ts), so none can fail to go; the first test reads what it says instead');
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-orphans-stuck-'));
  const realHome = fs.realpathSync(home);
  const project = path.join(realHome, 'projects', 'tars-hermes');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  // No .git, and a folder in it whose mode forbids removing what it holds.
  const stuck = path.join(project, '.worktrees', 'stuck');
  const locked = path.join(stuck, 'locked');
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(locked, 'f'), 'x');
  fs.chmodSync(locked, 0o555);
  // Listed, then removed by hand before the confirm.
  const meanwhile = path.join(project, '.worktrees', 'gone-meanwhile');
  fs.mkdirSync(meanwhile, { recursive: true });
  fs.writeFileSync(path.join(meanwhile, 'x.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31460), DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/settings?section=system`, { waitUntil: 'domcontentloaded' });
    const block = page.locator('[data-orphan-folders]');
    const rows = block.locator('[data-orphan-row]');
    await expect(rows).toHaveCount(2, { timeout: 90_000 });
    fs.rmSync(meanwhile, { recursive: true, force: true });
    await block.getByRole('button', { name: 'remove 2 folders', exact: true }).click();
    await block.locator('[data-orphan-confirm]').getByRole('button', { name: 'remove 2 folders', exact: true }).click();
    await expect(block.locator('[data-settings-hint]').first()).toHaveText('None was removed. One was kept: its row says why. One was no longer a folder no agent owns.', { timeout: 60_000 });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('tars-hermes/.worktrees/stuck');
    const why = rows.first().locator('[data-orphan-why]');
    await expect(why).toHaveText('not removed');
    const title = (await why.getAttribute('title')) ?? '';
    await stepShot(page, '05-not-removed');
    recordValues({ title, block: (await block.innerText()).replace(/\s+/g, ' '), stuck: fs.existsSync(stuck), pageErrors });
    // Why, in plain words, then the error's code as main sent it.
    expect(title).toMatch(/^(not empty|permission denied)\b/);
    expect(title).toMatch(/\(E[A-Z]+\)$/);
    // Never an absolute path, here or anywhere else in the block: the home is in it.
    expect(title).not.toMatch(/(^|[\s'"(:])\//);
    for (const p of [home, realHome]) await expect(block).not.toContainText(p);
    expect(fs.existsSync(stuck)).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    fs.chmodSync(locked, 0o755);
    await app.close().catch(() => { /* gone */ });
    await removeHome(home);
  }
});
