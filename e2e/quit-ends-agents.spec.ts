import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Quitting Tars ends an agent's CLI that ignores the hangup, starts nothing
 * while it does, and leaves the agent as it was (PR #235 and the Audit's gate).
 *
 * The CLI is a stand-in that traps SIGHUP and SIGTERM, with a child that
 * inherits both: the CLI a terminal's hangup does not end. On main, one like
 * it outlived 9 quits of 9. The quit waits for it over its grace, and in that
 * grace, while the API still answers, another agent's /start arrives: on the
 * old build it answered 200 and started a CLI nothing ended; a stubborn one
 * held the app for ten minutes.
 *
 * What it checks, from the app's side and the machine's:
 * - the /start mid-quit is refused (503, quitting) and starts no CLI;
 * - the stand-ins are gone within 5 s of the quit (a grace of 1.5 s, then
 *   SIGKILL), and the quit goes through (will-quit) on its own;
 * - no process the stand-ins started is left;
 * - the agent whose terminal the quit ended is not saved `error` or `completed`.
 *
 * A hang is detected, not waited out: stand-ins alive 8 s into the quit are
 * killed by pid, which frees the app, and the spec fails.
 */

type Api = {
  electronAPI: {
    agent: {
      start(p: { id: string; prompt: string }): Promise<unknown>;
      list(): Promise<Array<{ id: string; cliRunning?: boolean }>>;
    };
  };
};

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test.skip(process.platform === 'win32', 'a stop or quit ends the whole tree of a CLI deaf to the hangup through ps and process groups, which Windows has neither of: there the ConPTY console is ended through killPty (pty-kill.spec.ts, quit-time.win32.spec.ts) and the rest of the tree is not ended there yet; this runs on macOS and Linux');

test('quitting ends a CLI deaf to the hangup, refuses a /start mid-quit, and exits', async () => {
  // The first page compiles under next dev: 43 s cold at a load of 195 (playwright.config.ts).
  test.setTimeout(240_000);
  const t0 = Date.now();
  const step = (what: string) => console.log(`[quit-e2e] +${Date.now() - t0} ms ${what}`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-quit-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const pidsFile = path.join(home, 'cli-pids');
  // Deaf to SIGHUP and SIGTERM, and so is its child: a shell that ignores
  // both and execs sleep, which inherits them ignored. Node, not a bash
  // script: a CLI named like the terminal's shell reads as the shell's prompt.
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
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('q1', 'Deaf One'), agent('q2', 'Started Late')], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const port = apiPort(31476);
  const dist = path.resolve('electron', 'dist');

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  const appProcess = app.process();
  let exitedAt: number | null = null;
  appProcess.once('exit', () => { exitedAt = Date.now(); });
  const readPids = () => (fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map(Number) : []);
  let hangFreed = false;
  try {
    step('launched');
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'q1', prompt: '' }));
    await expect.poll(
      () => page.evaluate(async () => (await (window as unknown as Api).electronAPI.agent.list()).find(a => a.id === 'q1')?.cliRunning ?? false),
      { timeout: 30_000, message: 'the stand-in holds its terminal' },
    ).toBe(true);
    await expect.poll(() => readPids().length, { timeout: 10_000 }).toBe(2);
    step('stand-in running');
    const deafPids = readPids();
    // The fixture is what it says: a hangup does not end it.
    process.kill(deafPids[0], 'SIGHUP');
    await new Promise(r => setTimeout(r, 300));
    expect(deafPids.every(alive), 'the stand-in is not deaf to SIGHUP').toBe(true);

    // q2's own token, as its CLI would present it: /start needs a caller with an identity.
    const token = await app.evaluate((_electron, { dist }) => {
      const req = process.mainModule!.require;
      return req(`${dist}/core/agent-tokens.js`).mintAgentToken('q2') as string;
    }, { dist });

    // will-quit fires once before-quit has let the quit through: the
    // terminals ended and their exits delivered. The process itself then
    // lingers for seconds to a minute under next dev, on main as on this
    // branch (Electron 43 and 44 alike), which this spec does not wait out.
    await app.evaluate(({ app: running }) => {
      const g = globalThis as { __quitStage?: string };
      running.once('will-quit', () => { g.__quitStage = 'will-quit'; });
    });
    step('token minted, quitting');
    const quitAt = Date.now();
    await app.evaluate(({ app: running }) => { setTimeout(() => running.quit(), 0); });
    await new Promise(r => setTimeout(r, 200));
    const midQuit = await fetch(`http://127.0.0.1:${port}/api/agents/q2/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': 'q2' },
      body: JSON.stringify({ prompt: 'work' }),
      signal: AbortSignal.timeout(10_000),
    }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) as { quitting?: boolean; error?: string } | null }))
      .catch((e: Error) => ({ status: 0, body: { error: e.message } as { quitting?: boolean; error?: string } }));

    step(`/start mid-quit answered ${midQuit.status}`);
    // When the quit has ended them: its grace is 1.5 s, then SIGKILL.
    let endedAt: number | null = null;
    for (const until = Date.now() + 8_000; Date.now() < until; await new Promise(r => setTimeout(r, 50))) {
      if (!readPids().some(alive)) { endedAt = Date.now(); break; }
    }
    step(endedAt ? 'stand-ins ended' : 'stand-ins still alive after 8 s');
    // A CLI the quit did not end holds it (node-pty's waitpid): freed here by pid, and failed.
    if (endedAt === null) {
      hangFreed = true;
      for (const pid of readPids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    let quitThroughAt: number | null = null;
    for (const until = Date.now() + 15_000; Date.now() < until; await new Promise(r => setTimeout(r, 100))) {
      if (exitedAt !== null) { quitThroughAt = exitedAt; break; }
      const stage = await app.evaluate(() => (globalThis as { __quitStage?: string }).__quitStage).catch(() => 'gone');
      if (stage) { quitThroughAt = Date.now(); break; }
    }
    step(quitThroughAt ? 'the quit went through' : 'the quit was still held after 15 s');
    const allPids = readPids();
    const left = allPids.filter(alive);
    const saved = (JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')) as { agents: Array<{ id: string; status: string }> })
      .agents.find(a => a.id === 'q1');

    recordValues({
      midQuitStart: midQuit,
      standInsEndedMs: endedAt === null ? null : endedAt - quitAt,
      quitThroughMs: quitThroughAt === null ? null : quitThroughAt - quitAt,
      cliPidsStarted: allPids,
      cliPidsLeft: left,
      hangFreedByTheSpec: hangFreed,
      q1SavedStatus: saved?.status,
    });

    expect(hangFreed, 'the stand-ins outlived the quit: the spec had to kill them').toBe(false);
    expect(quitThroughAt, 'before-quit still held the quit 15 s in').not.toBeNull();
    expect(midQuit.status, `a /start mid-quit: ${JSON.stringify(midQuit.body)}`).toBe(503);
    expect(midQuit.body?.quitting).toBe(true);
    expect(allPids, 'the refused /start started a CLI all the same').toHaveLength(2);
    expect(left, 'a process the stand-in started outlived the quit').toEqual([]);
    expect(endedAt, 'the stand-ins were still alive 8 s into the quit').not.toBeNull();
    expect(endedAt! - quitAt, 'the stand-ins outlived the grace and its SIGKILL').toBeLessThan(5_000);
    expect(saved?.status, 'the agent whose terminal the quit ended was saved as finished').not.toMatch(/^(error|completed)$/);
  } finally {
    for (const pid of readPids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    // Past will-quit everything is saved; its lingering teardown is not waited for.
    if (exitedAt === null) { try { appProcess.kill('SIGKILL'); } catch { /* gone */ } }
  }
});
