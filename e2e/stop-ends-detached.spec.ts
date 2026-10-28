import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, execFileSync } from 'child_process';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A stop ends what the agent started outside its terminal (2.0.5, core/born-processes.ts): the owner's lot 2 of
 * 28/10, after 1212-Capital's Playwright run and Next servers outlived stop_agent.
 *
 * In the real app, in a sandbox, with a stand-in CLI that starts two children detached the way a dev server or a
 * test runner is left behind (`nohup npm run dev &` from a tool's own shell): each through a launcher that exits
 * at once, so the child is launchd's or init's long before any stop, and in a session of its own (setsid), so that
 * neither the terminal's tree nor its session reaches it; one of them ignores SIGTERM. (A child still under the
 * CLI at the stop is the tree's already: the first version of this spec was green on main for that reason.) A third process, started by this spec, carries the
 * same agent id with another Tars's address, as the sandbox's copy of agents.json or another e2e run would.
 *
 * Asserted, with the classic shell and with the new interface:
 * 1. both children run while the agent does;
 * 2. stopped from the window, the agent is `stopped`, and both children are gone within the grace (the deaf one by
 *    SIGKILL);
 * 3. the other Tars's process runs on.
 * Red on main (dc623b59): both children outlive the stop.
 * Not on Windows: there the environment of another process is not read (unknown), and nothing is claimed.
 * The artefact: values.json (the pids, what was alive before and after the stop, and when).
 */

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; stop(id: string): Promise<unknown>; get(id: string): Promise<{ status: string } | null> } } };

test.skip(process.platform === 'win32', 'the environment of another process is read on macOS and Linux only');

for (const newInterface of [false, true]) {
  test(`a stop ends what the agent started detached, and nothing of another Tars${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-stop-detached-${newInterface ? 'ni' : 'classic'}-`));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
    const pidsFile = path.join(home, 'detached.pids');
    // In Node, not bash: a bash stand-in is named like the shell, and the app would never see a CLI running.
    const cli = writeNodeCli(path.join(home, 'stand-in-cli.cjs'), [
      "const { execFileSync } = require('child_process');",
      // The launcher starts the child detached, prints its pid and exits: the child is reparented at once.
      "const launcher = (deaf) => `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify((deaf ? \"process.on('SIGTERM', () => {});\" : '') + 'setInterval(() => {}, 1 << 30)')}], { detached: true, stdio: 'ignore' }); c.unref(); process.stdout.write(String(c.pid));`;",
      "const keep = (deaf) => Number(execFileSync(process.execPath, ['-e', launcher(deaf)]).toString());",
      `require('fs').writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify([keep(false), keep(true)]));`,
      "process.stdout.write('stand-in ready\\n');",
      'process.stdin.resume();',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
      id: 'x-detached', name: 'Detached Worker', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
      projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
    }]));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const port = apiPort(31520 + (newInterface ? 1 : 0));
    // Another Tars's process of an agent with the same id: never this Tars's to end.
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
      detached: true, stdio: 'ignore',
      env: { PATH: process.env.PATH ?? '', CLAUDE_AGENT_ID: 'x-detached', CLAUDE_MGR_API_URL: `http://127.0.0.1:${Number(port) + 1000}` },
    });
    stranger.unref();
    const values: Record<string, unknown> = { newInterface, home, stranger: stranger.pid };
    const errors: string[] = [];
    let children: number[] = [];
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, undefined, { timeout: 60_000 });
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'x-detached', prompt: 'go' }));

      // 1.
      await expect.poll(() => fs.existsSync(pidsFile), { timeout: 60_000 }).toBe(true);
      children = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
      values.children = children;
      values.aliveBefore = children.map(alive);
      expect(values.aliveBefore).toEqual([true, true]);
      // Reparented already: nothing of the terminal's tree leads to them (macOS: launchd, Linux: init or a subreaper).
      values.parents = children.map(pid => { try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)]).toString().trim()); } catch { return null; } });

      // 2.
      const stoppedAt = Date.now();
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.stop('x-detached'));
      await expect.poll(() => page.evaluate(async () => (await (window as unknown as Api).electronAPI.agent.get('x-detached'))?.status), { timeout: 15_000 }).toBe('stopped');
      const gone = await expect.poll(() => children.map(alive), { timeout: 20_000 }).toEqual([false, false]).then(() => true, () => false);
      values.aliveAfter = children.map(alive);
      values.goneWithinMs = Date.now() - stoppedAt;
      // 3.
      values.strangerAlive = alive(stranger.pid!);
      recordValues(values);
      expect(gone, 'what the agent started detached outlived the stop').toBe(true);
      expect(values.strangerAlive, 'another Tars\'s process was ended').toBe(true);
      expect(errors).toEqual([]);
    } finally {
      recordValues(values);
      await app.close().catch(() => undefined);
      for (const pid of [...children, stranger.pid!]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      await removeHome(home);
    }
  });
}
