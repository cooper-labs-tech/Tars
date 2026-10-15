import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The folders no agent owns (Noah's choice 16; the frames merged in #315), in
 * the real app: a sandbox HOME whose project holds a live worktree git knows
 * (nested as a branch name nests it), an agent's worktree, a worktree git
 * forgot, a folder with no .git, and one a real process works in.
 *
 * Asserted, through window.electronAPI.system: the disk (home's, 30 GB
 * floor); the list (the three orphans, each with its reason, size and last
 * change, and the totals); the removal (the two idle ones gone, the busy one
 * kept as in use, the live and the agent's worktrees untouched, a progress
 * event per folder). The artefact: values.json with each answer.
 */

type Api = { electronAPI: { system: {
  disk(): Promise<{ freeBytes: number; totalBytes: number; floorBytes: number } | null>;
  orphanFolders(): Promise<{ folders: Array<Record<string, unknown>>; count: number; totalBytes: number }>;
  removeOrphanFolders(paths: string[]): Promise<{ removed: number; freedBytes: number; kept: Array<Record<string, unknown>> }>;
  onOrphanRemovalProgress(cb: (p: Record<string, unknown>) => void): () => void;
} } };

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('the folders no agent owns are listed, and removed when asked, but the one a process works in', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-orphans-'));
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
  fs.mkdirSync(wt('feat-relay-retry', 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(wt('feat-relay-retry', '.git'), `gitdir: ${path.join(project, '.git', 'worktrees', 'feat-relay-retry')}\n`);
  fs.writeFileSync(wt('feat-relay-retry', 'node_modules', 'x', 'index.js'), Buffer.alloc(200_000, 120));
  fs.mkdirSync(wt('agent-7f3c1a'), { recursive: true });
  fs.writeFileSync(wt('agent-7f3c1a', 'notes.md'), Buffer.alloc(50_000, 120));
  fs.mkdirSync(wt('busy'), { recursive: true });
  fs.writeFileSync(wt('busy', 'x.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'a1', name: 'Agent', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, worktreePath: wt('agent-wt'), branchName: 'agent-wt', skills: [],
    createdAt: '2026-10-06T08:00:00.000Z', lastActivity: '2026-10-06T08:00:00.000Z',
  }]));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  // A process working in one of them: node on Windows, which has no sleep of its own.
  const busy = process.platform === 'win32'
    ? spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { cwd: wt('busy'), stdio: 'ignore' })
    : spawn('sleep', ['120'], { cwd: wt('busy'), stdio: 'ignore' });

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31459), DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);

    const disk = await page.evaluate(() => (window as unknown as Api).electronAPI.system.disk());
    const listing = await page.evaluate(() => (window as unknown as Api).electronAPI.system.orphanFolders());
    // The rows shown, as the window passes them once the person confirms.
    const shown = listing.folders.map(f => f.path as string);
    const { report, steps } = await page.evaluate(async (paths) => {
      const api = (window as unknown as Api).electronAPI.system;
      const seen: Array<Record<string, unknown>> = [];
      const off = api.onOrphanRemovalProgress(p => seen.push(p));
      const answer = await api.removeOrphanFolders(paths);
      await new Promise(r => setTimeout(r, 200));
      off();
      return { report: answer, steps: seen };
    }, shown);
    const after = {
      relay: fs.existsSync(wt('feat-relay-retry')), noGit: fs.existsSync(wt('agent-7f3c1a')), busy: fs.existsSync(wt('busy')),
      live: git(wt('feat', 'live'), 'rev-parse', '--abbrev-ref', 'HEAD'), agent: fs.existsSync(wt('agent-wt', 'a.txt')),
    };
    recordValues({ disk, listing, report, steps, after, pageErrors });

    const s = fs.statfsSync(home);
    expect(disk).toMatchObject({ totalBytes: s.blocks * s.bsize, floorBytes: 30 * 1024 ** 3 });
    const byName = Object.fromEntries(listing.folders.map(f => [f.name as string, f]));
    expect(Object.keys(byName).sort()).toEqual(['agent-7f3c1a', 'busy', 'feat-relay-retry']);
    expect(byName['feat-relay-retry']).toMatchObject({ reason: 'git-forgot', project });
    expect(byName['agent-7f3c1a']).toMatchObject({ reason: 'no-git' });
    expect(byName['feat-relay-retry'].sizeBytes as number).toBeGreaterThanOrEqual(200_000);
    expect(typeof byName['agent-7f3c1a'].lastChangedAt).toBe('string');
    expect(listing.totalBytes).toBe(listing.folders.reduce((sum, f) => sum + (f.sizeBytes as number), 0));

    expect(steps.map(st => [st.done, st.total])).toEqual([[1, 3], [2, 3], [3, 3]]);
    if (process.platform === 'win32') {
      // Windows has neither lsof nor /proc to read which process works in a
      // folder (processCwds, orphan-folders.ts): nothing is removed, and each
      // is kept as of unknown use.
      expect(report).toEqual({ removed: 0, freedBytes: 0, kept: shown.map(p => expect.objectContaining({ path: p, reason: 'unknown-use' })) });
      expect(after).toEqual({ relay: true, noGit: true, busy: true, live: 'feat/live', agent: true });
    } else {
      expect(report.removed).toBe(2);
      expect(report.kept).toEqual([expect.objectContaining({ path: wt('busy'), reason: 'in-use', detail: expect.stringContaining(`(${busy.pid})`) })]);
      expect(after).toEqual({ relay: false, noGit: false, busy: true, live: 'feat/live', agent: true });
    }
    expect(pageErrors).toEqual([]);
  } finally {
    if (busy.pid) { try { process.kill(busy.pid, 'SIGKILL'); } catch { /* gone */ } }
    await app.close().catch(() => { /* gone */ });
  }
});
