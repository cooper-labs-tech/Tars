import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Stopping an agent ends it, and says who stopped it and why
 * (PLAN-1.9.2.md item A), in the real app.
 *
 * On 28/09 two frozen CLIs survived stop_agent, reparented to launchd, and the
 * stopped agents then read `idle`, like ones never started. Here the agent's
 * CLI is a stand-in deaf to SIGHUP and SIGTERM, with a child that is too.
 * Another agent of the project stops it through the API with its own token,
 * as stop_agent does, and a reason; then the stand-in and its child must be
 * gone, the agent `stopped` with who and why, a stop without a reason
 * refused, and a new start must clear it.
 *
 * The artefact: values.json with the stop as the window read it, the timings,
 * and the page errors the window had, if any (the renderer learns `stopped`
 * in the Frontend's part).
 */

type Agent = { id: string; status: string; cliRunning?: boolean; stoppedBy?: string; stoppedAt?: string; stopReason?: string };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]> } } };

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test.skip(process.platform === 'win32', 'a stop or quit ends the whole tree of a CLI deaf to the hangup through ps and process groups, which Windows has neither of: there the ConPTY console is ended through killPty (pty-kill.spec.ts, quit-time.win32.spec.ts) and the rest of the tree is not ended there yet; this runs on macOS and Linux');

test('stopping an agent ends its CLI deaf to the hangup, and records who stopped it and why', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-stop-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
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
  const agent = (id: string, name: string) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cli,
    createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-01T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('s1', 'Frozen Worker'), agent('o1', 'Project Lead')], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const port = apiPort(31473);
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
    const stop = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/agents/s1/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': 'o1' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).then(async r => ({ status: r.status, body: await r.json() as Record<string, unknown> }));

    const refused = await stop({});
    const stillAlive = deaf.every(alive);
    const began = Date.now();
    const stopped = await stop({ reason: 'frozen on a file read for 40 minutes' });
    const answeredMs = Date.now() - began;
    let goneMs: number | null = null;
    for (const until = Date.now() + 5_000; Date.now() < until; await new Promise(r => setTimeout(r, 50))) {
      if (!deaf.some(alive)) { goneMs = Date.now() - began; break; }
    }
    const seen = (await list()).find(a => a.id === 's1');

    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 's1', prompt: '' }));
    await expect.poll(async () => (await list()).find(a => a.id === 's1')?.status, { timeout: 30_000 }).not.toBe('stopped');
    const restarted = (await list()).find(a => a.id === 's1');

    recordValues({ refused, stillAliveAfterRefusal: stillAlive, stopped, answeredMs, goneMs, seen, restarted, pageErrors });

    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toMatch(/reason/i);
    expect(stillAlive, 'a stop with no reason stopped the agent all the same').toBe(true);
    expect(stopped.status).toBe(200);
    expect(goneMs, 'the CLI deaf to the hangup, or its child, outlived the stop').not.toBeNull();
    expect(seen).toMatchObject({ status: 'stopped', stoppedBy: 'Project Lead', stopReason: 'frozen on a file read for 40 minutes' });
    expect(Date.parse(seen!.stoppedAt!)).toBeGreaterThan(began - 1_000);
    expect(restarted?.stoppedBy).toBeUndefined();
    expect(restarted?.stopReason).toBeUndefined();
  } finally {
    for (const pid of readPids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await app.close().catch(() => { /* gone */ });
  }
});
