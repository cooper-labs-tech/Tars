import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { writeFakeClis } from './fake-clis.mjs';

/**
 * Keeping the computer awake while an agent works (services/keep-awake.ts, 2.0.5), in the real app.
 * A claude agent on the recording fake (e2e/fake-clis.mjs: its turns show through the shell hooks) runs a task.
 * Electron's own powerSaveBlocker is wrapped in the main process to record each call, then called as it is.
 *
 * Asserted, with the classic shell and with the new interface:
 * 1. keepAwake missing (the default, while-working): one 'prevent-app-suspension' blocker starts when the turn
 *    starts, and stops when the turn ends; keepAwake.state() says it while it holds (on macOS, `pmset -g
 *    assertions` shows the app holding PreventUserIdleSystemSleep during the turn, when the poll catches it).
 * 2. keepAwake 'never', saved from the window: a second turn starts no blocker.
 * 3. The state says how many agents are working: 1 while the turn holds the blocker, 0 after.
 * 4. A blocker the system refuses (powerSaveBlocker.start made to throw in the main process), with keepAwake 'always'
 *    saved from the window: the state says refused, not active.
 * Red on main (acb8d2f4): no blocker is ever started.
 * The artefact: values.json (the calls with their times, the states and the statuses read).
 */

async function recordBlocker(app: ElectronApplication) {
  await app.evaluate(({ powerSaveBlocker }) => {
    const g = globalThis as unknown as { __e2eBlocker: Array<{ call: string; arg: unknown; at: number; result?: unknown }> };
    g.__e2eBlocker = [];
    const start = powerSaveBlocker.start.bind(powerSaveBlocker);
    const stop = powerSaveBlocker.stop.bind(powerSaveBlocker);
    powerSaveBlocker.start = ((type: Parameters<typeof start>[0]) => { const id = start(type); g.__e2eBlocker.push({ call: 'start', arg: type, at: Date.now(), result: id }); return id; }) as typeof start;
    powerSaveBlocker.stop = ((id: number) => { g.__e2eBlocker.push({ call: 'stop', arg: id, at: Date.now() }); return stop(id); }) as typeof stop;
  });
}
const calls = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __e2eBlocker: Array<{ call: string; arg: unknown; at: number; result?: unknown }> }).__e2eBlocker);

for (const newInterface of [false, true]) {
  const shell = newInterface ? ' (new interface)' : '';
  test(`tars keeps the computer awake while an agent works, and not when told never${shell}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-keep-awake-${newInterface ? 'ni' : 'classic'}-`));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
    const fakes = writeFakeClis(home, ['claude']) as Record<string, string>;
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{ id: 'x-claude', name: 'Claude Agent', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project, skills: [], permissionMode: 'bypass', cliPath: fakes.claude, createdAt: '2026-10-22T08:00:00.000Z', lastActivity: '2026-10-22T08:00:00.000Z' }]));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, cliPaths: { claude: fakes.claude } }));
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31508 + (newInterface ? 1 : 0)), DOROTHY_E2E: '1' },
    });
    const values: Record<string, unknown> = { newInterface, home };
    const errors: string[] = [];
    type Api = { electronAPI: {
      agent: { start(p: { id: string; prompt: string }): Promise<unknown>; get(id: string): Promise<{ status: string; output?: string[] } | null>; sendInput(p: { id: string; input: string }): Promise<unknown> };
      keepAwake: { state(): Promise<{ mode: string; active: boolean; since?: string; working: number; refused?: true }> };
      appSettings: { save(s: Record<string, unknown>): Promise<unknown> };
    } };
    try {
      await recordBlocker(app);
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, undefined, { timeout: 60_000 });
      const appPid = app.process().pid;

      // 1. The default: while working.
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'x-claude', prompt: 'ECHO AWAKE1' }));
      const statesSeen: Array<{ status?: string; active: boolean; working: number; pmset?: boolean; at: number }> = [];
      const deadline = Date.now() + 60_000;
      let answered = false;
      while (Date.now() < deadline && !answered) {
        const [a, st] = await page.evaluate(async () => {
          const api = (window as unknown as Api).electronAPI;
          return [await api.agent.get('x-claude'), await api.keepAwake.state()] as const;
        });
        let pmset: boolean | undefined;
        if (st.active && process.platform === 'darwin') {
          try { pmset = execFileSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' }).split('\n').some((l) => l.includes(`pid ${appPid}(`) && l.includes('PreventUserIdleSystemSleep')); } catch { pmset = undefined; }
        }
        const last = statesSeen.at(-1);
        if (!last || last.status !== a?.status || last.active !== st.active || last.working !== st.working) statesSeen.push({ status: a?.status, active: st.active, working: st.working, ...(pmset !== undefined ? { pmset } : {}), at: Date.now() });
        answered = (a?.output ?? []).join('').includes('echo AWAKE1') && a?.status !== 'running';
        await page.waitForTimeout(100);
      }
      await expect.poll(async () => (await calls(app)).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
      const first = await calls(app);
      values.firstTurn = { calls: first, statesSeen, answered };
      expect(answered).toBe(true);
      expect(first.map((c) => `${c.call}:${c.call === 'start' ? c.arg : ''}`)).toEqual(['start:prevent-app-suspension', 'stop:']);
      expect(first[1].arg).toBe(first[0].result);
      const after = await page.evaluate(() => (window as unknown as Api).electronAPI.keepAwake.state());
      expect(after).toEqual({ mode: 'while-working', active: false, working: 0 });
      // 3. While it held the blocker, the state counted the one agent at work.
      expect(statesSeen.filter((s) => s.active).map((s) => s.working)).toContain(1);

      // 2. Never.
      await page.evaluate(() => (window as unknown as Api).electronAPI.appSettings.save({ keepAwake: 'never' }));
      await expect.poll(() => page.evaluate(() => (window as unknown as Api).electronAPI.keepAwake.state()), { timeout: 10_000 }).toMatchObject({ mode: 'never', active: false });
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.sendInput({ id: 'x-claude', input: 'ECHO AWAKE2\r' }));
      await expect.poll(async () => ((await page.evaluate(() => (window as unknown as Api).electronAPI.agent.get('x-claude')))?.output ?? []).join('').includes('echo AWAKE2'), { timeout: 60_000 }).toBe(true);
      await page.waitForTimeout(1000);
      const second = (await calls(app)).slice(first.length);
      values.secondTurn = { calls: second };
      expect(second).toEqual([]);

      // 4. Refused by the system.
      await app.evaluate(({ powerSaveBlocker }) => {
        powerSaveBlocker.start = (() => { throw new Error('refused by the e2e'); }) as typeof powerSaveBlocker.start;
      });
      await page.evaluate(() => (window as unknown as Api).electronAPI.appSettings.save({ keepAwake: 'always' }));
      await expect.poll(() => page.evaluate(() => (window as unknown as Api).electronAPI.keepAwake.state()), { timeout: 10_000 }).toEqual({ mode: 'always', active: false, working: 0, refused: true });
      values.refused = await page.evaluate(() => (window as unknown as Api).electronAPI.keepAwake.state());
      expect(errors).toEqual([]);
    } finally {
      recordValues(values);
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
