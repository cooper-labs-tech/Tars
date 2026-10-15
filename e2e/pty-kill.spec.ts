import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, listenForErrors, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Twenty terminals are ended through the app's own kill sites, in the real
 * app, and none of it raises an error.
 *
 * node-pty 1.1 ends a Windows terminal by forking a helper that attaches to
 * the shell's console to list what runs on it. When the shell has no console
 * left the helper throws `AttachConsole failed`, printed on the app's stderr
 * (openai/codex#25272 shows it as an error dialog in an Electron app): every
 * kill of a terminal whose shell has exited, and, as node-pty closes the
 * pseudo console before the helper has started, most kills of a running one.
 * electron/core/pty-kill.ts ends a terminal without it; this spec proves each
 * place the app ends a terminal goes through it, where
 * __tests__/electron/core/pty-kill.test.ts proves the helper alone.
 *
 * How it fails, written before the call sites were wired (2026-09-25):
 * 1. One kill site still calls node-pty's own kill(): the app's stderr shows
 *    `AttachConsole failed` (run on the unwired build, it does: the negative
 *    witness recorded in values.json).
 * 2. A kill throws or rejects in the main process: an uncaught exception or
 *    an unhandled rejection is recorded there.
 * 3. A terminal said killed is still running once the kill has had its time.
 * 4. A list helper is left running under the app.
 * 5. The exited cases prove nothing because the app had already dropped the
 *    terminal (onExit ran first) or its shell had not exited yet: on win32
 *    each one is checked to be exited and still held at the moment of the kill.
 * 6. The quit, which ends every terminal left (killAllPty), prints the error.
 *
 * The kill sites, eleven alive and nine whose shell has just exited (node-pty
 * reports the exit a second after it, FLUSH_DATA_INTERVAL, the window in
 * which a person closing a finished terminal reaches the kill):
 *   pty:kill x4, shell:killPty x4, agent:stop x2, agent:remove x2,
 *   agent:update (a new CLI path) x2, POST /api/agents/:id/stop x2,
 *   killStalePty x2, and killAllPty at quit x2 (alive).
 * The IPC handlers are called as ipcMain registered them, from the main
 * process: shell:*Pty has no preload entry, and the exited cases need the
 * kill to follow the exit within the same second.
 */

const onWindows = process.platform === 'win32';

type Case = { site: string; state: 'alive' | 'exited'; pid: number; heldAtKill: boolean; exitedAtKill: boolean; answer: unknown };

test('twenty terminals ended through every kill site raise no AttachConsole failure and leave nothing running', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-pty-kill-'));
  const dataDir = path.join(home, '.dorothy');
  const project = path.join(home, 'projects', 'kill-sites');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const port = apiPort(31471);
  fs.writeFileSync(path.join(dataDir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dataDir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({ ollamaBaseUrl: 'http://127.0.0.1:9', autoStartAgentsOnLaunch: false }, null, 2));

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  let stderr = '';
  app.process().stderr?.on('data', chunk => { stderr += String(chunk); });
  const appPid = app.process().pid!;
  const errors: string[] = [];
  const values: Record<string, unknown> = { platform: process.platform };
  const dist = path.resolve('electron', 'dist');
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await page.waitForLoadState('domcontentloaded');
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(() => !!(window as unknown as { electronAPI?: { agent?: unknown } }).electronAPI?.agent), { timeout: 60_000 }).toBe(true);

    // The main-process side of the spec: what it records, and how it calls a kill site.
    await app.evaluate(({ ipcMain }, { dist, port }) => {
      const req = process.mainModule!.require;
      const g = globalThis as Record<string, unknown>;
      const uncaught: string[] = [];
      process.on('uncaughtException', err => uncaught.push(`uncaught: ${String(err)}`));
      process.on('unhandledRejection', err => uncaught.push(`unhandled rejection: ${String(err)}`));
      const { ptyProcesses, quickPtyProcesses } = req(`${dist}/core/pty-manager.js`);
      const manager = req(`${dist}/core/agent-manager.js`);
      const { internalToken } = req(`${dist}/core/agent-tokens.js`);
      type Pty = { pid: number; write(data: string): void; _agent?: { exitCode?: number } };
      // Where ipcMain.handle keeps each handler, as it registered it.
      const handlers = (ipcMain as unknown as { _invokeHandlers?: unknown })._invokeHandlers as Map<string, (event: unknown, ...args: unknown[]) => unknown>;
      if (!(handlers instanceof Map)) {
        throw new Error('ipcMain._invokeHandlers is not a Map in this Electron: the spec calls the kill sites through it and must be updated to how this version keeps its ipcMain.handle handlers');
      }
      /** An ipcMain.handle handler, called as Electron's invoke calls it: awaited, with the event first. */
      const invoke = async (channel: string, ...args: unknown[]) => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`no handler for ${channel}`);
        return await handler({ sender: null, senderFrame: null }, ...args);
      };
      const find = (id: string): Pty | undefined => ptyProcesses.get(id) ?? quickPtyProcesses.get(id);
      const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
      const exited = (pty: Pty) => pty._agent?.exitCode !== undefined || gone(pty.pid);
      const kills: Record<string, (id: string) => Promise<unknown>> = {
        'pty:kill': id => invoke('pty:kill', { id }),
        'shell:killPty': id => invoke('shell:killPty', { ptyId: id }),
        'agent:stop': id => invoke('agent:stop', id),
        'agent:remove': id => invoke('agent:remove', id),
        'agent:update': id => invoke('agent:update', { id, cliPath: `${process.execPath}.other` }),
        'api stop': id => fetch(`http://127.0.0.1:${port}/api/agents/${id}/stop`, {
          method: 'POST', headers: { Authorization: `Bearer ${internalToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'the kill sites spec' }),
        }).then(r => r.status),
        killStalePty: async id => {
          const agent = manager.agents.get(id);
          agent.ptyCwd = `${agent.projectPath}-moved`;
          return manager.killStalePty(agent);
        },
      };
      g.__ptyKillSpec = {
        uncaught,
        invoke,
        /** The terminal a site holds: a pty id, or an agent's. */
        ptyOf: (site: string, key: string) => (['pty:kill', 'shell:killPty'].includes(site) ? key : manager.agents.get(key)?.ptyId),
        /** Ends one terminal through one site, alive or just after its shell exited. */
        async kill(site: string, key: string, state: 'alive' | 'exited') {
          const ptyId = (g.__ptyKillSpec as { ptyOf: (s: string, k: string) => string }).ptyOf(site, key);
          const pty = find(ptyId);
          if (!pty) throw new Error(`${site}: no terminal ${ptyId}`);
          if (state === 'exited') {
            pty.write('exit\r');
            const until = Date.now() + 20_000;
            while (!exited(pty) && Date.now() < until) await new Promise(r => setTimeout(r, 10));
          }
          const heldAtKill = find(ptyId) === pty;
          const exitedAtKill = exited(pty);
          const answer = await kills[site](key);
          return { site, state, pid: pty.pid, heldAtKill, exitedAtKill, answer };
        },
        alive: (pids: number[]) => pids.filter(pid => !gone(pid)),
        pidsOf: (ids: string[]) => ids.map(id => find(id)?.pid),
      };
    }, { dist, port });

    const main = <T>(fn: string, ...args: unknown[]) => app.evaluate((_electron, { fn, args }) => {
      const spec = (globalThis as Record<string, Record<string, (...a: unknown[]) => unknown>>).__ptyKillSpec;
      return spec[fn](...args);
    }, { fn, args }) as Promise<T>;

    // ── The terminals ────────────────────────────────────────────────────
    const ptyIds: string[] = [];
    for (let i = 0; i < 6; i++) ptyIds.push(((await main<{ id: string }>('invoke', 'pty:create', { cwd: project, cols: 80, rows: 24 }))).id);
    const quickIds: string[] = [];
    for (let i = 0; i < 4; i++) quickIds.push(await main<string>('invoke', 'shell:startPty', { cwd: project, cols: 80, rows: 24 }));
    const agentIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const agent = await main<{ id: string; ptyId?: string }>('invoke', 'agent:create', {
        projectPath: project, skills: [], name: `Kill Site ${i + 1}`, permissionMode: 'normal',
      });
      expect(agent.ptyId, `agent:create opened no terminal for agent ${i + 1}`).toBeTruthy();
      agentIds.push(agent.id);
    }
    // Every shell up and at its prompt before anything is ended: an exit typed
    // too early is still read, but the alive cases must be alive.
    await new Promise(resolve => setTimeout(resolve, onWindows ? 6_000 : 2_000));

    const plan: [site: string, key: string, state: 'alive' | 'exited'][] = [
      ['pty:kill', ptyIds[0], 'alive'], ['pty:kill', ptyIds[1], 'alive'], ['pty:kill', ptyIds[2], 'exited'], ['pty:kill', ptyIds[3], 'exited'],
      ['shell:killPty', quickIds[0], 'alive'], ['shell:killPty', quickIds[1], 'alive'], ['shell:killPty', quickIds[2], 'exited'], ['shell:killPty', quickIds[3], 'exited'],
      ['agent:stop', agentIds[0], 'alive'], ['agent:stop', agentIds[1], 'exited'],
      ['agent:remove', agentIds[2], 'alive'], ['agent:remove', agentIds[3], 'exited'],
      ['agent:update', agentIds[4], 'alive'], ['agent:update', agentIds[5], 'exited'],
      ['api stop', agentIds[6], 'alive'], ['api stop', agentIds[7], 'exited'],
      ['killStalePty', agentIds[8], 'alive'], ['killStalePty', agentIds[9], 'exited'],
    ];
    const cases: Case[] = [];
    for (const [site, key, state] of plan) cases.push(await main<Case>('kill', site, key, state));
    values.cases = cases;

    // Past node-pty's own five seconds, and the helper's.
    await new Promise(resolve => setTimeout(resolve, 7_000));
    const alive = await main<number[]>('alive', cases.map(c => c.pid));
    const uncaught = await app.evaluate(() => (globalThis as unknown as { __ptyKillSpec: { uncaught: string[] } }).__ptyKillSpec.uncaught);
    const helpers = listHelpersUnder(appPid);
    values.afterKills = { alive, uncaught, helpers, attachConsoleFailures: (stderr.match(/AttachConsole failed/g) ?? []).length };

    // The two left for the quit (killAllPty), alive.
    const atQuit = (await main<(number | undefined)[]>('pidsOf', ptyIds.slice(4))).filter((pid): pid is number => typeof pid === 'number');
    values.atQuit = atQuit;

    if (onWindows) {
      for (const c of cases.filter(c => c.state === 'exited')) {
        expect(c, `${c.site}: the exited case was not exited and still held when killed`).toMatchObject({ heldAtKill: true, exitedAtKill: true });
      }
    }
    for (const c of cases.filter(c => c.state === 'alive')) {
      expect(c, `${c.site}: the alive case was not held, or already exited, when killed`).toMatchObject({ heldAtKill: true, exitedAtKill: false });
    }
    expect(atQuit, 'the two terminals left for the quit').toHaveLength(2);
    expect(stderr, 'a kill site printed node-pty\'s AttachConsole failure').not.toMatch(/AttachConsole failed/);
    expect(uncaught, 'a kill threw in the main process').toEqual([]);
    expect(alive, 'a terminal outlived its kill').toEqual([]);
    expect(helpers, 'a list helper was left running').toEqual([]);
    expect(errors, 'the page reported errors').toEqual([]);

    // ── The quit ends what is left (killAllPty) ─────────────────────────
    await app.close();
    await new Promise(resolve => setTimeout(resolve, 7_000));
    const survivors = atQuit.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    values.afterQuit = { survivors, attachConsoleFailures: (stderr.match(/AttachConsole failed/g) ?? []).length };
    expect(stderr, 'the quit printed node-pty\'s AttachConsole failure').not.toMatch(/AttachConsole failed/);
    expect(survivors, 'a terminal outlived the quit').toEqual([]);
  } finally {
    values.stderrTail = stderr.split(/\r?\n/).filter(line => /AttachConsole|Error/.test(line)).slice(-10);
    recordValues(values);
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});

/** node-pty's console list helpers running under the app (win32; none elsewhere). */
function listHelpersUnder(appPid: number): string[] {
  if (!onWindows) return [];
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${appPid} -and $_.CommandLine -like '*conpty_console_list_agent*' } | ForEach-Object { "$($_.ProcessId)" }`;
  const out = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
