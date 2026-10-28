import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * What each agent and each project costs, readable (2.0.5, lot 3 item D), in the real app, once with the classic shell
 * and once with the new interface.
 *
 * A worker w whose stand-in CLI runs a child process carrying a token in its command line, in a worktree seeded with a
 * file of 2 MB; an orchestrator o whose stand-in reads list_agents and get_agent with its own token when the spec says
 * so.
 *
 * Asserted:
 * 1. the window reads w's whole tree (its terminal, its CLI, the child): its memory, CPU and processes, the child's
 *    command line masked, its status and since when; the project's totals are its agents' sums;
 * 2. the disk is not measured on a read: w's worktree reads null until the window asks, then its size, with when;
 * 3. the orchestrator's list_agents gives w's memory and status since, and get_agent its processes, masked.
 * Red on main dc623b594: there is no resources read.
 * The artefact: values.json (the window's reads before and after the measure, the orchestrator's answers).
 */

type Agent = { id: string; name: string; status: string; statusSince: number | null; memMb: number | null; cpuPct: number | null; processes: Array<{ name: string; memMb: number | null; command: string }>; worktrees: Array<{ path: string; bytes: number | null }>; tmp: { path: string; bytes: number | null } | null };
type Fleet = { readAt: number | null; diskMeasuredAt: number | null; measuring?: unknown; projects: Array<{ name: string; agents: Agent[]; totals: { memMb: number | null; cpuPct: number | null; diskBytes: number | null; processes: number } }> };
type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown> };
  resources: { read(): Promise<Fleet>; measureDisk(): Promise<{ success: boolean }> };
} };

const TOKEN = ['ghp_', 'Q'.repeat(12), 'R'.repeat(12)].join('');

for (const newInterface of [false, true]) {
  test(`each agent's and each project's memory, CPU, processes and disk, for the window and the orchestrator${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-resources-${newInterface ? 'ni' : 'classic'}-`));
    const project = path.join(home, 'projects', 'harbor');
    const worktree = path.join(project, '.worktrees', 'w');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, 'data.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
    const child = path.join(home, 'child.cjs');
    fs.writeFileSync(child, 'const keep = Buffer.alloc(32 * 1024 * 1024, 1); setInterval(() => keep.length, 1 << 30);\n');
    const worker = writeNodeCli(path.join(home, 'cli-w.cjs'), [
      "const { spawn } = require('child_process');",
      "if (process.argv.includes('--version')) { console.log('2.1.312 (Claude Code)'); process.exit(0); }",
      `const c = spawn(process.execPath, [${JSON.stringify(child)}, '--token', ${JSON.stringify(TOKEN)}], { stdio: 'ignore' });`,
      `require('fs').writeFileSync(${JSON.stringify(path.join(home, 'child.pid'))}, String(c.pid));`,
      "process.stdout.write('stand-in ready\\r\\n');",
      'process.stdin.resume();',
      '',
    ].join('\n'));
    const orchestrator = writeNodeCli(path.join(home, 'cli-o.cjs'), [
      "const fs = require('fs');",
      "if (process.argv.includes('--version')) { console.log('2.1.312 (Claude Code)'); process.exit(0); }",
      `const dir = ${JSON.stringify(home)};`,
      "const get = p => fetch(process.env.CLAUDE_MGR_API_URL + p, { headers: { Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN } }).then(r => r.json());",
      "const wait = setInterval(async () => {",
      "  if (!fs.existsSync(dir + '/ask-now')) return;",
      "  clearInterval(wait);",
      "  fs.writeFileSync(dir + '/asked.json', JSON.stringify({ list: await get('/api/agents'), one: await get('/api/agents/w') }));",
      "}, 200);",
      "process.stdout.write('stand-in ready\\r\\n');",
      'process.stdin.resume();',
      '',
    ].join('\n'));
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    const base = { character: 'robot', provider: 'claude', status: 'idle', projectPath: project, skills: [], createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z' };
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      { ...base, id: 'w', name: 'Harbor Worker', role: 'worker', worktreePath: worktree, cliPath: worker },
      { ...base, id: 'o', name: 'Harbor Lead', role: 'orchestrator', cliPath: orchestrator },
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31364 : 31363), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      const read = () => page.evaluate(() => (window as unknown as Api).electronAPI.resources.read());
      const w = (f: Fleet) => f.projects.flatMap(p => p.agents).find(a => a.id === 'w')!;
      for (const id of ['w', 'o']) await page.evaluate(i => (window as unknown as Api).electronAPI.agent.start({ id: i, prompt: '' }), id);

      // 1. The whole tree, the child's command line masked.
      await expect.poll(async () => w(await read()).processes.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
      await expect.poll(async () => w(await read()).memMb ?? 0, { timeout: 15_000 }).toBeGreaterThan(30);
      const first = await read();
      keep({ first });
      const wf = w(first);
      expect(JSON.stringify(first)).not.toContain(TOKEN);
      expect(wf.processes.find(p => p.command.includes('child.cjs'))?.command).toMatch(/--token ghp_/);
      expect(wf.statusSince).toEqual(expect.any(Number));
      const harbor = first.projects.find(p => p.name === 'harbor')!;
      expect(harbor.agents.map(a => a.id).sort()).toEqual(['o', 'w']);
      expect(harbor.totals.processes).toBe(harbor.agents.reduce((s, a) => s + a.processes.length, 0));

      // 2. The disk, only when asked.
      expect(wf.worktrees).toEqual([{ path: worktree, bytes: null }]);
      expect(first.diskMeasuredAt).toBeNull();
      expect(await page.evaluate(() => (window as unknown as Api).electronAPI.resources.measureDisk())).toEqual({ success: true });
      await expect.poll(async () => (await read()).diskMeasuredAt, { timeout: 30_000 }).not.toBeNull();
      const measured = await read();
      keep({ measured });
      expect(w(measured).worktrees[0].bytes ?? 0).toBeGreaterThanOrEqual(2 * 1024 * 1024);

      // 3. The orchestrator's list_agents and get_agent.
      fs.writeFileSync(path.join(home, 'ask-now'), '1');
      await expect.poll(() => fs.existsSync(path.join(home, 'asked.json')), { timeout: 20_000 }).toBe(true);
      const asked = JSON.parse(fs.readFileSync(path.join(home, 'asked.json'), 'utf8')) as { list: { agents: Array<Record<string, unknown>> }; one: { agent: { resources: { memMb: number | null; processes: Array<{ command: string }> } } } };
      keep({ asked });
      expect(asked.list.agents.find(a => a.id === 'w')).toMatchObject({ memMb: expect.any(Number), statusSince: expect.any(String) });
      expect(asked.one.agent.resources.memMb).toEqual(expect.any(Number));
      expect(JSON.stringify(asked)).not.toContain(TOKEN);
    } finally {
      // The child, by its own pid.
      try { const pid = Number(fs.readFileSync(path.join(home, 'child.pid'), 'utf8')); if (pid > 1) process.kill(pid); } catch { /* gone */ }
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
