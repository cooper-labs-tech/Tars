import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Noah's answers of 05/10, in the real app:
 * - the window's Delete keeps an agent's uncommitted work on wip/<name>, then
 *   removes its worktree;
 * - an orchestrator that starts again an agent stopped in the window is told
 *   who stopped it and why, and the restart is kept on the agent;
 * - no agent starts on a nearly full disk, and the caller is told why.
 *
 * The agents' CLI is a stand-in that waits on its input. The free space is
 * the main process's own reader, given 500 MB through the module the app
 * loaded. The artefact: values.json with each answer and the git state read
 * after the Delete.
 */

type Agent = { id: string; status: string; cliRunning?: boolean; stoppedBy?: string; lastRestartAfterStop?: Record<string, string> };
type Api = { electronAPI: { agent: {
  start(p: { id: string; prompt: string }): Promise<unknown>;
  stop(id: string, reason?: string): Promise<unknown>;
  remove(id: string): Promise<{ success: boolean; savedTo?: string; worktreeKept?: string }>;
  list(): Promise<Agent[]>;
} } };

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('Delete keeps the work on wip/, a restart after a stop says whose stop, a full disk refuses a start', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-answers-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 't@t.example');
  git(project, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(project, 'a.txt'), 'one\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'init');
  const wt = path.join(project, '.worktrees', 'feat-x');
  git(project, 'worktree', 'add', '-q', wt, '-b', 'feat/x');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\nwork in progress\n');
  fs.writeFileSync(path.join(wt, 'notes.md'), 'not committed\n');

  // writeNodeCli: the script itself on macOS and Linux, npm's shim beside it on Windows.
  const cli = writeNodeCli(path.join(home, 'waiting-cli.cjs'), ["process.stdout.write('stand-in ready\\n');", 'process.stdin.resume();', ''].join('\n'));
  const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cli,
    createdAt: '2026-10-05T08:00:00.000Z', lastActivity: '2026-10-05T08:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('d1', 'Backend Engineer', { worktreePath: wt, branchName: 'feat/x' }),
    agent('s1', 'Night Worker'),
    agent('o1', 'Project Lead'),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const port = apiPort(31469);
  const dist = path.resolve('electron', 'dist');

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());

    // 1. The window's Delete.
    const removed = await page.evaluate(() => (window as unknown as Api).electronAPI.agent.remove('d1'));
    const afterDelete = {
      worktreeExists: fs.existsSync(wt),
      wipA: git(project, 'show', 'wip/backend-engineer:a.txt'),
      wipNotes: git(project, 'show', 'wip/backend-engineer:notes.md'),
      wipParentIsBranch: git(project, 'rev-parse', 'wip/backend-engineer~1') === git(project, 'rev-parse', 'feat/x'),
    };

    // 2. Stopped in the window, started again by the project's orchestrator.
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.stop('s1', 'paused for the night'));
    await expect.poll(async () => (await list()).find(a => a.id === 's1')?.status, { timeout: 15_000 }).toBe('stopped');
    const token = await app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      return req(`${dist}/core/agent-tokens.js`).mintAgentToken('o1') as string;
    }, { dist });
    const start = (id: string) => fetch(`http://127.0.0.1:${port}/api/agents/${id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': 'o1' },
      body: JSON.stringify({ prompt: 'carry on' }),
      signal: AbortSignal.timeout(60_000),
    }).then(async r => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
    const restarted = await start('s1');
    const restartedSeen = (await list()).find(a => a.id === 's1');

    // 3. A disk with 500 MB free.
    await app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      req(`${dist}/core/disk-space.js`).setFreeSpaceReader(() => 500 * 1024 * 1024);
    }, { dist });
    const refused = await start('o1');
    const orchSeen = (await list()).find(a => a.id === 'o1');

    recordValues({ removed, afterDelete, restarted, restartedSeen, refused, orchStatus: orchSeen?.status, pageErrors });

    expect(removed).toEqual({ success: true, savedTo: 'wip/backend-engineer' });
    expect(afterDelete).toEqual({ worktreeExists: false, wipA: 'one\nwork in progress', wipNotes: 'not committed', wipParentIsBranch: true });

    expect(restarted.status).toBe(200);
    expect(restarted.body.restartedAfterStop).toMatchObject({ stoppedBy: 'you', stopReason: 'paused for the night' });
    expect(restartedSeen?.status).not.toBe('stopped');
    expect(restartedSeen?.lastRestartAfterStop).toMatchObject({ stoppedBy: 'you', stopReason: 'paused for the night', restartedBy: 'Project Lead' });

    expect(refused.status).toBe(507);
    expect(refused.body).toMatchObject({ diskFull: true });
    expect(String(refused.body.error)).toMatch(/500 MB free/);
    expect(orchSeen?.cliRunning ?? false).toBe(false);
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close().catch(() => { /* gone */ });
  }
});
