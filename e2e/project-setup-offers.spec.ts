import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * What a project is offered so that the owner's workflow runs there with nothing set up by hand (2.0.7, W3, W5 and W7
 * of the fresh-install report), through the window's own channels (electronAPI.projectSetup).
 *
 * A fresh sandbox: a Node project with a GitHub origin (never reached), lint and test scripts, no CI, no CLAUDE.md,
 * and a team of three, two in `normal`, one a chat's runner of the project.
 *
 * Asserted, with the classic shell and with the new interface:
 * 1. the offer: a CI workflow running `npm ci`, `npm run lint` and `npm run test` on pull requests to main, and a
 *    CLAUDE.md naming those checks and the team's areas;
 * 2. CLAUDE.md written on the owner's yes, at the project's root, and refused the second time;
 * 3. the CI committed on chore/ci in a worktree, the project's checkout still on main and clean, nothing pushed;
 * 4. the whole team's permission level: the call sets the lead and the developer, never the chat's runner (a chat
 *    in chats.json names it), which then follows its orchestrator as every runner does (chat-runners.ts
 *    syncWithLead): all three in bypass in agents.json. A runner no chat names is a worker from Tars's start on
 *    (chat-runners.ts), which is why the chat is seeded.
 * Red on #585's head 4c1da79fd: no projectSetup channel.
 * The artefact: values.json (the offer, what was written, each agent's mode).
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
type Setup = { projectSetup: {
  offer(p: string): Promise<{ success: boolean; ci: { state: string; content?: string; checks?: string[] }; claudeMd: { state: string; content?: string } }>;
  writeCi(p: string): Promise<{ success: boolean; branch?: string; code?: string }>;
  writeClaudeMd(p: string): Promise<{ success: boolean; path?: string; code?: string }>;
  setTeamPermissionMode(p: string, mode: string): Promise<{ success: boolean; agents?: Array<{ id: string; success: boolean }> }>;
} };

for (const newInterface of [false, true]) {
  test(`a project is offered its CI and CLAUDE.md, written on a yes, and its team takes one permission level${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-setup-${newInterface ? 'ni' : 'classic'}-`)));
    const project = path.join(home, 'projects', 'shop');
    const dir = path.join(home, '.tars');
    for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
    git(project, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'shop', scripts: { lint: 'eslint .', test: 'vitest run' } }));
    fs.writeFileSync(path.join(project, 'package-lock.json'), '{}');
    git(project, 'add', '.');
    git(project, 'commit', '-q', '-m', 'init');
    git(project, 'remote', 'add', 'origin', 'git@github.com:someone/shop.git');
    const agent = (id: string, name: string, extra: Record<string, unknown>) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'normal',
      projectPath: project, skills: [], createdAt: '2026-11-10T08:00:00.000Z', lastActivity: '2026-11-10T08:00:00.000Z', ...extra,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent('lead', 'Shop Lead', { role: 'orchestrator', orchestratorMode: true }),
      agent('fe', 'Frontend Engineer', { savedPrompt: 'You are the frontend developer. You own the UI: components and pages.' }),
      agent('chat', 'Shop chat', { kind: 'chat', chatId: 'c0ffee00-0000-4000-8000-0000000000a1', teamOrchestratorId: 'lead', permissionMode: 'auto' }),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    // A chat names the runner, as Tars writes chats.json: without it, the runner is a worker from the start.
    const at = '2026-11-10T08:00:00.000Z';
    const chatRecord = (id: string, number: number, title: string, runnerId: string, inbox: boolean) => ({
      id, projectPath: project, number, title, titleSource: 'user', runnerId, sessionIds: [], pinned: false,
      snoozedUntil: null, settledAt: null, inbox, createdAt: at, updatedAt: at, lastActivityAt: at,
    });
    fs.writeFileSync(path.join(dir, 'chats.json'), JSON.stringify({ version: 1, numbers: { [project]: 2 }, chats: [
      chatRecord('c0ffee00-0000-4000-8000-0000000000a0', 1, 'Main', 'lead', true), chatRecord('c0ffee00-0000-4000-8000-0000000000a1', 2, 'Side', 'chat', false),
    ] }, null, 2));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31597 + (newInterface ? 1 : 0)), DOROTHY_E2E: '1' },
    });
    const values: Record<string, unknown> = { newInterface, home };
    const errors: string[] = [];
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: { projectSetup?: unknown } }).electronAPI?.projectSetup, undefined, { timeout: 60_000 });
      const api = <K extends keyof Setup['projectSetup']>(fn: K, ...args: Parameters<Setup['projectSetup'][K]>) =>
        page.evaluate(([f, a]) => ((window as unknown as { electronAPI: Setup }).electronAPI.projectSetup[f as K] as (...x: unknown[]) => unknown)(...(a as unknown[])), [fn, args] as const) as ReturnType<Setup['projectSetup'][K]>;

      // 1.
      const offer = await api('offer', project);
      values.offer = offer;
      recordValues(values);
      expect(offer.ci.state).toBe('offer');
      expect(offer.ci.checks).toEqual(['npm ci', 'npm run lint', 'npm run test']);
      expect(offer.ci.content).toMatch(/pull_request:\n {4}branches: \[main\]/);
      expect(offer.claudeMd.state).toBe('offer');
      for (const word of ['npm run lint', 'Frontend Engineer', 'You own the UI']) expect(offer.claudeMd.content).toContain(word);
      // 2.
      expect(await api('writeClaudeMd', project)).toMatchObject({ success: true, path: path.join(project, 'CLAUDE.md') });
      expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toBe(offer.claudeMd.content);
      expect(await api('writeClaudeMd', project)).toMatchObject({ success: false, code: 'exists' });
      // 3.
      const ci = await api('writeCi', project);
      values.ci = ci;
      expect(ci).toMatchObject({ success: true, branch: 'chore/ci' });
      expect(git(project, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
      expect(git(project, 'status', '--porcelain', '--untracked-files=no')).toBe('');
      // The helper trims what git prints, the file's last newline with it.
      expect(git(project, 'show', 'chore/ci:.github/workflows/ci.yml')).toBe(offer.ci.content?.trimEnd());
      expect(git(project, 'for-each-ref', '--format=%(upstream)', 'refs/heads/chore/ci')).toBe('');
      // 4.
      const team = await api('setTeamPermissionMode', project, 'bypass');
      values.team = team;
      expect(team.success, JSON.stringify(team)).toBe(true);
      expect(team.agents?.map(a => a.id).sort(), 'set directly: the project\'s agents, never the runner').toEqual(['fe', 'lead']);
      type Saved = { id: string; permissionMode: string };
      const modes = () => {
        const file = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')) as Saved[] | { agents: Saved[] };
        return Object.fromEntries((Array.isArray(file) ? file : file.agents).map(a => [a.id, a.permissionMode]));
      };
      await expect.poll(() => modes(), { timeout: 15_000 }).toEqual({ lead: 'bypass', fe: 'bypass', chat: 'bypass' });
      values.modes = modes();
      recordValues(values);
      expect(errors).toEqual([]);
    } finally {
      recordValues(values);
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
