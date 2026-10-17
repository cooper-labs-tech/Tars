import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Stopping an agent ends what its CLI was starting at that very moment too (the follow-up of the QA's B1 on #358).
 *
 * A stop ends the terminal's tree as the quit does (endTerminalTree, core/pty-manager.ts): read from ps once, before
 * the hangup; the groups that read found are watched, and SIGKILLed once the grace is over. Here the agent's CLI,
 * once told to, starts a detached command every 5 ms, each in a group of its own, as a tool's commands are, until it
 * is ended, and the stop is asked for at once. A command started during the stop's read of ps is in no read; the CLI
 * dies at the hangup its shell relays; the command goes to launchd, with nothing tying it to the agent any more.
 * Each command runs a link to sleep named after the run, so ps finds every one, whatever its parent now.
 *
 * How it fails, written before the code (2026-10-15):
 * 1. A command the CLI started during the stop's read outlives the stop.
 * 2. Over-correction: the stop is not answered, or the agent is not `stopped` with who stopped it and why.
 * The artefact: values.json (the commands seen before the stop, those left after it, how long the stop took).
 * POSIX only, as every stand-in CLI of the suite: on Windows a terminal's tree is #358's taskkill.
 */

type Agent = { id: string; status: string; cliRunning?: boolean; ptyId?: string; stoppedBy?: string; stopReason?: string };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]> } } };

/** The pids of every process whose command line names `marker`, whatever its parent. */
const naming = (marker: string): number[] => execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' })
  .split('\n').filter(line => line.includes(marker)).map(line => Number(line.trim().split(/\s+/)[0]));

test('stopping an agent ends what its CLI was starting during the stop', async () => {
  test.skip(process.platform === 'win32', 'a POSIX stand-in, as every other: a Windows terminal\'s tree is #358\'s taskkill');
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-late-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  // The commands' program: sleep, under a name no other process has.
  const marker = path.join(home, `late-command-${process.pid}`);
  fs.symlinkSync(execFileSync('which', ['sleep'], { encoding: 'utf8' }).trim(), marker);
  const cli = path.join(home, 'forking-cli.cjs');
  fs.writeFileSync(cli, [
    `#!${process.execPath}`,
    "const { spawn } = require('child_process');",
    'let forking = false;',
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', text => {",
    "  if (forking || !text.includes('FORK')) return;",
    '  forking = true;',
    `  setInterval(() => spawn(${JSON.stringify(marker)}, ['300'], { detached: true, stdio: 'ignore' }).unref(), 5);`,
    '});',
    "process.stdout.write('stand-in ready\\n');",
    'process.stdin.resume();',
    '',
  ].join('\n'), { mode: 0o755 });
  const agent = (id: string, name: string) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cli,
    createdAt: '2026-10-15T08:00:00.000Z', lastActivity: '2026-10-15T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('s1', 'Forking Worker'), agent('o1', 'Project Lead')], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const port = apiPort(31434);
  const dist = path.resolve('electron', 'dist');

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 's1', prompt: '' }));
    await expect.poll(async () => (await list()).find(a => a.id === 's1')?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);

    const token = await app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      return req(`${dist}/core/agent-tokens.js`).mintAgentToken('o1') as string;
    }, { dist });
    // FORK typed into the CLI's terminal, then the stop asked for while it starts its commands.
    const ptyId = (await list()).find(a => a.id === 's1')!.ptyId!;
    await app.evaluate((_e, { dist, ptyId }) => {
      const req = process.mainModule!.require;
      (req(`${dist}/core/pty-manager.js`).ptyProcesses as Map<string, { write(d: string): void }>).get(ptyId)!.write('FORK\r');
    }, { dist, ptyId });
    await expect.poll(() => naming(marker).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const began = Date.now();
    const stopped = await fetch(`http://127.0.0.1:${port}/api/agents/s1/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': 'o1' },
      body: JSON.stringify({ reason: 'the probe of a stop during a fork' }),
      signal: AbortSignal.timeout(30_000),
    }).then(async r => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
    const answeredMs = Date.now() - began;
    const seenAtStop = naming(marker).length;
    // What is still there 5 s after the stop's answer, past its 1.5 s grace and its SIGKILL.
    let left = naming(marker);
    for (const until = Date.now() + 5_000; Date.now() < until && left.length; await new Promise(r => setTimeout(r, 100))) left = naming(marker);
    const seen = (await list()).find(a => a.id === 's1');

    recordValues({ stopped, answeredMs, seenAtStop, left: left.length, leftPids: left, seen: { status: seen?.status, stoppedBy: seen?.stoppedBy, stopReason: seen?.stopReason } });

    expect(stopped.status).toBe(200);
    expect(seen).toMatchObject({ status: 'stopped', stoppedBy: 'Project Lead', stopReason: 'the probe of a stop during a fork' });
    expect(left, '1. commands the CLI started during the stop outlived it').toEqual([]);
  } finally {
    for (const pid of naming(marker)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await app.close().catch(() => { /* gone */ });
    await removeHome(home);
  }
});
