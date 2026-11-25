import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The release gate the orchestrator hands, and a worktree per task, through the real app (2.0.7, W6 of the
 * fresh-install report and the Audit's L4 on #579; the Audit's L4 on #585 asked for this spec).
 *
 * A fresh sandbox: a git project, its orchestrator and two workers, QA and a developer, each a stand-in CLI that talks
 * to Tars's API with its own token as Tars hands it. Started with "DO-GATE", the orchestrator's stand-in hands QA a
 * task with `gate: true` and the developer one without (run-task, as delegate_task does). Each worker's stand-in, once
 * Tars types its task in, asks the heavy-run slot for `gate`; QA's also asks for a worktree (worktree_new's route).
 *
 * Asserted, with the classic shell and with the new interface:
 * 1. both tasks reach their terminals;
 * 2. QA's ask keeps `gate`; the developer's is given `normal`, clamped;
 * 3. QA's worktree is made in the project's .worktrees, on its branch, and git status of the project stays clean.
 * Red on #579's head 7901505f2: no /api/worktrees, and any task an orchestrator handed let its worker take `gate`.
 * The artefact: values.json (each call and its answer).
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } };
type Entry = { me: string; what: string; status?: number; body?: Record<string, unknown> };

for (const newInterface of [false, true]) {
  test(`a gate the orchestrator hands goes first in the slot, a plain task does not, and a task gets its worktree${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-wt-gate-${newInterface ? 'ni' : 'classic'}-`)));
    const project = path.join(home, 'projects', 'shop');
    const dir = path.join(home, '.tars');
    for (const d of [project, dir, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
    git(project, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(project, 'README.md'), 'shop\n');
    git(project, 'add', '.');
    git(project, 'commit', '-q', '-m', 'init');

    const log = path.join(home, 'calls.jsonl');
    const cli = writeNodeCli(path.join(home, 'stand-in.cjs'), [
      "const fs = require('fs');",
      "if (process.argv.includes('--version')) { console.log('2.1.321 (Claude Code)'); process.exit(0); }",
      'const me = process.env.CLAUDE_AGENT_ID;',
      `const log = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ me, ...o }) + '\\n');`,
      "const api = (p, method, body) => fetch(process.env.CLAUDE_MGR_API_URL + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN }, ...(body ? { body: JSON.stringify(body) } : {}) })",
      '  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }), (e) => ({ status: 0, body: { error: String(e) } }));',
      "const session = require('crypto').randomUUID();",
      "api('/api/hooks/status', 'POST', { agent_id: me, session_id: session, status: 'idle', source: 'startup' }).then(() => log({ what: 'ready' }));",
      "if (process.argv.join(' ').includes('DO-GATE')) {",
      "  api('/api/agents/qa/run-task', 'POST', { task: 'GATE-TASK run the gate', gate: true, answer: 'started' }).then((a) => log({ what: 'hand-gate', ...a }));",
      "  api('/api/agents/dev/run-task', 'POST', { task: 'PLAIN-TASK build it', answer: 'started' }).then((a) => log({ what: 'hand-plain', ...a }));",
      '}',
      "let seen = '';",
      "let done = false;",
      "process.stdin.on('data', (b) => {",
      "  seen += b.toString('utf8');",
      "  if (done || !/GATE-TASK|PLAIN-TASK/.test(seen)) return;",
      '  done = true;',
      "  api('/api/heavy-slot/ask', 'POST', { pid: process.pid, priority: 'gate', label: 'e2e gate' }).then((a) => log({ what: 'slot', ...a }));",
      "  if (seen.includes('GATE-TASK')) api('/api/worktrees', 'POST', { branch: 'feat/e2e-gate' }).then((a) => log({ what: 'worktree', ...a }));",
      '});',
      "process.stdout.write('stand-in ready\\r\\n');",
      'process.stdin.resume();',
      '',
    ].join('\n'));
    const agent = (id: string, name: string, role: string) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, orchestratorMode: role === 'orchestrator', permissionMode: 'bypass',
      projectPath: project, skills: [], cliPath: cli, createdAt: '2026-11-10T08:00:00.000Z', lastActivity: '2026-11-10T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Shop Lead', 'orchestrator'), agent('qa', 'Shop QA', 'worker'), agent('dev', 'Shop Dev', 'worker')], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31599 + (newInterface ? 1 : 0)), DOROTHY_E2E: '1' },
    });
    const values: Record<string, unknown> = { newInterface, home };
    const errors: string[] = [];
    const entries = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Entry[];
    const find = (me: string, what: string) => entries().find(e => e.me === me && e.what === what);
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, undefined, { timeout: 60_000 });
      for (const id of ['qa', 'dev']) await page.evaluate((agentId) => (window as unknown as Api).electronAPI.agent.start({ id: agentId, prompt: '' }), id);
      await expect.poll(() => ['qa', 'dev'].every(id => find(id, 'ready')), { timeout: 60_000, message: 'the workers are up' }).toBe(true);
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'lead', prompt: 'DO-GATE' }));

      // 1.
      await expect.poll(() => !!find('qa', 'slot') && !!find('dev', 'slot'), { timeout: 60_000, message: 'both tasks reached their terminals and asked the slot' }).toBe(true);
      await expect.poll(() => !!find('qa', 'worktree'), { timeout: 30_000, message: 'QA asked for its worktree' }).toBe(true);
      values.calls = entries();
      recordValues(values);
      expect(find('lead', 'hand-gate')?.status, JSON.stringify(find('lead', 'hand-gate'))).toBe(200);
      // 2.
      const ticket = (me: string) => (find(me, 'slot')?.body as { ticket?: { priority?: string; clamped?: boolean } } | undefined)?.ticket;
      expect(ticket('qa'), JSON.stringify(find('qa', 'slot'))).toMatchObject({ priority: 'gate' });
      expect(ticket('qa')?.clamped).toBeUndefined();
      expect(ticket('dev'), JSON.stringify(find('dev', 'slot'))).toMatchObject({ priority: 'normal', clamped: true });
      // 3.
      const made = find('qa', 'worktree')!;
      expect(made.status, JSON.stringify(made)).toBe(200);
      expect(fs.realpathSync(String(made.body?.path))).toBe(fs.realpathSync(path.join(project, '.worktrees', 'feat', 'e2e-gate')));
      expect(git(String(made.body?.path), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/e2e-gate');
      expect(git(project, 'status', '--porcelain')).toBe('');
      expect(errors).toEqual([]);
    } finally {
      recordValues(values);
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
