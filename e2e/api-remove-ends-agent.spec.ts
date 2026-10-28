import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Deleting an agent through the API (`remove_agent`, DELETE /api/agents/:id) ends what it runs, as a stop and the
 * window's delete do (the Audit's L4 on #523, 28/10).
 *
 * The route killed the terminal with a hangup and dropped the agent: a CLI deaf to the hangup, and its child, ran on,
 * and once the agent had left the fleet nothing ever named them again. The window's delete (removeAgent) is the one
 * removal path; the API now goes through it, and it ends the terminal's whole tree as a stop does (endTerminalTree).
 *
 * Here the agent's CLI is a stand-in deaf to SIGHUP and SIGTERM, with a child that is too. The project's orchestrator
 * deletes it through the API with its own token. Then the stand-in and its child must be gone, and the agent gone from
 * the fleet. Red on main dc623b59: the deaf CLI and its child outlive the delete.
 *
 * The artefact: values.json with the answer, the timings and the fleet after, and the page errors, if any.
 */

type Agent = { id: string; cliRunning?: boolean };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]> } } };

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test.skip(process.platform === 'win32', 'the whole tree of a CLI deaf to the hangup is ended through ps and process groups, which Windows has neither of (the ConPTY console is ended through killPty there); this runs on macOS and Linux');

test('deleting an agent through the api ends its cli deaf to the hangup, and its child', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-api-remove-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const pidsFile = path.join(home, 'cli-pids');
  const cli = path.join(home, 'deaf-cli.cjs');
  fs.writeFileSync(cli, [
    `#!${process.execPath}`,
    "process.on('SIGHUP', () => {}); process.on('SIGTERM', () => {});",
    "const { spawn } = require('child_process');",
    `const child = spawn('/bin/sh', ['-c', 'trap "" HUP TERM; exec sleep 300'], { stdio: 'ignore' });`,
    `require('fs').appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n' + child.pid + '\\n');`,
    "process.stdout.write('stand-in ready\\n');",
    'process.stdin.resume();',
    '',
  ].join('\n'), { mode: 0o755 });
  // The lead is the project's orchestrator: only Tars, the window and an orchestrator remove another agent.
  const agent = (id: string, name: string, role = 'worker') => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role,
    projectPath: project, skills: [], cliPath: cli,
    createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-01T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('s1', 'Frozen Worker'), agent('o1', 'Project Lead', 'orchestrator')], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const port = apiPort(31345);
  const dist = path.resolve('electron', 'dist');
  const readPids = () => (fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map(Number) : []);

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
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 's1', prompt: '' }));
    await expect.poll(async () => (await list()).find(a => a.id === 's1')?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
    await expect.poll(() => readPids().length, { timeout: 10_000 }).toBe(2);
    const deaf = readPids();

    const token = await app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      return req(`${dist}/core/agent-tokens.js`).mintAgentToken('o1') as string;
    }, { dist });
    const began = Date.now();
    const removed = await fetch(`http://127.0.0.1:${port}/api/agents/s1`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': 'o1' },
      signal: AbortSignal.timeout(30_000),
    }).then(async r => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
    const answeredMs = Date.now() - began;
    let goneMs: number | null = null;
    for (const until = Date.now() + 5_000; Date.now() < until; await new Promise(r => setTimeout(r, 50))) {
      if (!deaf.some(alive)) { goneMs = Date.now() - began; break; }
    }
    const fleet = (await list()).map(a => a.id);

    recordValues({ removed, answeredMs, goneMs, fleet, pageErrors });

    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ success: true });
    expect(goneMs, 'the CLI deaf to the hangup, or its child, outlived the delete').not.toBeNull();
    expect(fleet).not.toContain('s1');
    expect(fleet).toContain('o1');
  } finally {
    for (const pid of readPids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await app.close().catch(() => { /* gone */ });
  }
});
