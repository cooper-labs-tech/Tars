import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent's role is not the prompt it is started with (2.0.7, B2 of the fresh-install report of 10/11: an agent's
 * role, "## Your role" at each session start, was replaced by whatever it was last started with, and 12 agents of the
 * owner's machine had a restart notice for a role).
 *
 * In the real app, in a fresh sandbox, a claude agent whose role the role editor set is started from the window with a
 * first task, stopped, then started again with Restart's words. Its CLI is a stand-in that, at each start, fetches its
 * identity as session-start.sh does, with its own token.
 *
 * Asserted, with the classic shell and with the new interface:
 * 1. the first start's identity says "## Your role" and the role, not the task;
 * 2. the restart's identity says the same, not "Continue working on the previous task";
 * 3. agents.json keeps the role.
 * Red on main 58f2863b4: the identity's role is the task, then the restart's words, and agents.json says the same.
 * The artefact: values.json (each start's identity, agents.json's role).
 */

const ROLE = 'You review every pull request for security defects, and report findings only.';
const TASK = 'Review the login change.';
const RESTART = 'Continue working on the previous task';
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; stop(id: string, reason?: string): Promise<{ success: boolean }> } } };

/** The role an identity carries: the lines after "## Your role", up to the next heading. */
const roleOf = (identity: string) => /## Your role\n([\s\S]*?)\n\n## /.exec(identity)?.[1] ?? null;

for (const newInterface of [false, true]) {
  test(`an agent's role is kept through a first task and a restart${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-role-kept-${newInterface ? 'ni' : 'classic'}-`)));
    const project = path.join(home, 'projects', 'shop');
    const dir = path.join(home, '.tars');
    for (const d of [project, dir, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
    const seen = path.join(home, 'identities.jsonl');
    const cli = writeNodeCli(path.join(home, 'stand-in-claude.cjs'), [
      "const fs = require('fs');",
      "if (process.argv.includes('--version')) { console.log('2.1.321 (Claude Code)'); process.exit(0); }",
      "fetch(process.env.CLAUDE_MGR_API_URL + '/api/agents/' + process.env.CLAUDE_AGENT_ID + '/bootstrap', {",
      "  headers: { Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },",
      '}).then(r => r.json()).catch(() => ({})).then(b => {',
      `  fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), identity: b.context ?? null }) + '\\n');`,
      '});',
      "process.stdout.write('stand-in ready\\n');",
      'process.stdin.resume();',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
      id: 'rev', name: 'Reviewer', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'auto',
      projectPath: project, skills: [], cliPath: cli, savedPrompt: ROLE, createdAt: '2026-11-10T08:00:00.000Z', lastActivity: '2026-11-10T08:00:00.000Z',
    }], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31595 + (newInterface ? 1 : 0)), DOROTHY_E2E: '1' },
    });
    const values: Record<string, unknown> = { newInterface, home };
    const errors: string[] = [];
    const starts = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<{ argv: string[]; identity: string | null }>;
    const savedRole = () => {
      const file = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8'));
      const list = (Array.isArray(file) ? file : file.agents) as Array<{ id: string; savedPrompt?: string }>;
      return list.find(a => a.id === 'rev')?.savedPrompt ?? null;
    };
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, undefined, { timeout: 60_000 });

      await page.evaluate(([id, prompt]) => (window as unknown as Api).electronAPI.agent.start({ id, prompt }), ['rev', TASK] as const);
      await expect.poll(() => starts().length, { timeout: 60_000, message: 'the first start fetched its identity' }).toBe(1);
      values.first = starts()[0].identity;
      recordValues(values);
      // 1.
      expect(starts()[0].argv.join(' '), 'the task did not reach the CLI').toContain(TASK);
      expect(roleOf(starts()[0].identity ?? '')).toBe(ROLE);

      await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.stop(id, 'the e2e restarts it'), 'rev');
      await page.evaluate(([id, prompt]) => (window as unknown as Api).electronAPI.agent.start({ id, prompt }), ['rev', RESTART] as const);
      await expect.poll(() => starts().length, { timeout: 60_000, message: 'the restart fetched its identity' }).toBe(2);
      values.restart = starts()[1].identity;
      // 2.
      expect(roleOf(starts()[1].identity ?? '')).toBe(ROLE);
      // 3.
      await expect.poll(savedRole, { timeout: 15_000, message: 'agents.json keeps the role' }).toBe(ROLE);
      values.savedRole = savedRole();
      recordValues(values);
      expect(errors).toEqual([]);
    } finally {
      recordValues(values);
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
