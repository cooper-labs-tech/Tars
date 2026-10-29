import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Tars no longer leaks a terminal per start (2.0.6, item 1; the incident of 28-29/10: the installed Tars held 510 of
 * macOS's 511 PTY masters after 78 hours, and every agent start answered 500). An agent on a stand-in CLI is started
 * and stopped twelve times through the window's own calls; the count of PTY masters the app's main process holds
 * (lsof's /dev/ptmx on macOS, /proc/<pid>/fd on Linux) is read after the first cycle and after the last.
 *
 * Asserted:
 * 1. each cycle really opened a terminal (the agent had one, then none);
 * 2. the count after twelve cycles is the count after the first: no master is left behind;
 * 3. the Resources page's data says the machine's terminals: Tars's masters as lsof counts them, none open once
 *    the agent stopped, out of the machine's limit (core/pty-pool.ts);
 * 4. a health sample (every 500 ms here) carries the same pool.
 * Red on main 54d26ef37: one more master per start (node-pty 1.1.0's macOS spawn, core/pty-spawn.ts), and no
 * terminals in either. Windows has no such pool (ConPTY): skipped there. The artefact: values.json (the count after
 * each cycle, the Resources read, the last sample's pool).
 */

const CYCLES = 12;

test.skip(process.platform === 'win32', 'ConPTY has no PTY master pool to leak');

for (const newInterface of [false, true]) {
test(`starting and stopping an agent twelve times leaves no terminal behind${newInterface ? ' (new interface)' : ''}`, async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-pty-leak-'));
  const project = path.join(home, 'projects', 'harbor');
  fs.mkdirSync(project, { recursive: true });
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  const cli = writeNodeCli(path.join(home, 'cli-stays.cjs'), [
    "if (process.argv.includes('--version')) { console.log('2.1.312 (Claude Code)'); process.exit(0); }",
    "process.stdout.write('stand-in ready\\r\\n');", 'process.stdin.resume();', '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'p1', name: 'Harbor Worker', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project,
    skills: [], cliPath: cli, createdAt: '2026-10-29T08:00:00.000Z', lastActivity: '2026-10-29T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
  const values: Record<string, unknown> = { newInterface };

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31572 : 31571), DOROTHY_E2E: '1', DOROTHY_HEALTH_EVERY_MS: '500' },
  });
  try {
    const pid = app.process().pid!;
    const masters = (): number => (process.platform === 'darwin'
      ? execFileSync('lsof', ['-p', String(pid)], { encoding: 'utf8' }).split('\n').filter(l => l.includes('/dev/ptmx')).length
      : fs.readdirSync(`/proc/${pid}/fd`).filter(fd => { try { return fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === '/dev/ptmx'; } catch { return false; } }).length);
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    type Terminals = { inUse: number; max: number; tars: number | null; open?: number; nearFull: boolean } | null;
    type Api = { electronAPI: {
      agent: { start(p: { id: string; prompt: string }): Promise<unknown>; stop(id: string): Promise<unknown>; get(id: string): Promise<{ ptyId?: string | null; status?: string } | null> };
      resources: { read(): Promise<{ terminals?: Terminals }> };
    } };
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const ptyOf = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.get('p1').then(a => a?.ptyId ?? null));
    const counts: number[] = [];
    for (let i = 0; i < CYCLES; i++) {
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'p1', prompt: '' }));
      // 1. A terminal was opened, then ended.
      await expect.poll(ptyOf, { timeout: 30_000 }).not.toBeNull();
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.stop('p1'));
      await expect.poll(ptyOf, { timeout: 30_000 }).toBeNull();
      // node-pty closes a terminal's own master a moment after its child's exit.
      await page.waitForTimeout(500);
      counts.push(masters());
    }
    values.counts = counts;
    recordValues(values);
    // 2. Flat from the first cycle on.
    expect(counts[CYCLES - 1], `masters after each cycle: ${counts.join(', ')}`).toBe(counts[0]);
    // 3. The Resources page's data: Tars's masters as lsof counts them, none open, out of the machine's limit.
    const terminals = await page.evaluate(() => (window as unknown as Api).electronAPI.resources.read().then(r => r.terminals));
    values.terminals = terminals;
    recordValues(values);
    expect(terminals).toMatchObject({ tars: masters(), open: 0, nearFull: false });
    expect(terminals!.max).toBeGreaterThan(terminals!.inUse);
    // 4. A health sample carries the pool.
    const samplesFile = path.join(dir, 'health-samples.jsonl');
    const lastPool = () => {
      const lines = fs.existsSync(samplesFile) ? fs.readFileSync(samplesFile, 'utf8').trim().split('\n').filter(Boolean) : [];
      return lines.length ? (JSON.parse(lines[lines.length - 1]).terminals ?? null) : null;
    };
    await expect.poll(lastPool, { timeout: 30_000 }).toMatchObject({ max: terminals!.max, open: 0 });
    values.sampleTerminals = lastPool();
    recordValues(values);
  } finally {
    recordValues(values);
    await app.close().catch(() => undefined);
    await removeHome(home);
  }
});
}
