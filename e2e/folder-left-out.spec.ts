import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { writeFakeClis } from './fake-clis.mjs';

/**
 * An agent saved with a folder Tars no longer hands is told so in its own terminal, before its CLI starts (27/11, the
 * Audit's M1 on #666).
 *
 * A secondary folder where credentials are kept (here the sandbox's ~/.ssh), saved before the rule, is left off the
 * launch line. Until this, the only trace was a line in the main process's log: the window still showed the folder as
 * the agent's, and the CLI simply did not have it.
 *
 * The real chain: the real app in a sandbox home, one claude agent saved with ~/.ssh as its secondary folder, the
 * stand-in claude (e2e/fake-clis.mjs, which logs the line it was started with), started from the window as a user
 * starts it (agent.start: its shell, then its line typed there). Asserted: the agent's terminal, as Tars keeps it
 * (the mirror every panel replays), shows one [Tars] line naming the folder and why, before the CLI's line; and the
 * CLI was not handed the folder.
 *
 * The artefact: values.json (the terminal's lines, the line the CLI was started with) and the screenshot.
 */

test('an agent saved with a folder Tars no longer hands is told so in its terminal, before its CLI starts', async () => {
  test.setTimeout(150_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-folder-left-out-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const ssh = path.join(home, '.ssh');
  for (const d of [project, dir, ssh]) fs.mkdirSync(d, { recursive: true });
  const fakes = writeFakeClis(home, ['claude']) as Record<string, string>;
  const AGENT = 'x-left-out';
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: AGENT, name: 'Keys', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project,
    secondaryProjectPath: ssh, skills: [], permissionMode: 'bypass', cliPath: fakes.claude,
    createdAt: '2026-11-27T08:00:00.000Z', lastActivity: '2026-11-27T08:00:00.000Z',
  }]));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude: fakes.claude } }));
  const LOG = path.join(home, 'fake-cli.jsonl');
  const launches = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
    .filter((e: { launch?: boolean; argv?: string[] }) => e.argv && !e.registration && !e.command) as Array<{ argv: string[] }>;

  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = { home, folder: ssh };
  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31516), DOROTHY_E2E: '1' },
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, null, { timeout: 120_000 });
    await page.evaluate((id) => (window as unknown as {
      electronAPI: { agent: { start: (o: { id: string; prompt: string }) => Promise<unknown> } };
    }).electronAPI.agent.start({ id, prompt: 'LEFT OUT' }), AGENT);

    // The terminal as Tars keeps it, the mirror a panel replays.
    const terminal = () => app!.evaluate((_e, { dist, id }) => {
      const r = process.mainModule!.require;
      const agent = r(`${dist}/core/agent-manager.js`).agents.get(id);
      const pty = agent?.ptyId ? r(`${dist}/core/pty-manager.js`).ptyProcesses.get(agent.ptyId) : undefined;
      return (r(`${dist}/core/terminal-mirror.js`).terminalText(pty) ?? []) as string[];
    }, { dist, id: AGENT });
    await expect.poll(async () => launches().length, { timeout: 60_000, message: 'the stand-in claude never started' }).toBeGreaterThan(0);
    let lines: string[] = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      lines = (await terminal()).map(l => l.trimEnd()).filter(Boolean);
      if (lines.some(l => l.includes(fakes.claude))) break;
      await page.waitForTimeout(250);
    }
    // Rows joined: a long line wraps over several of the terminal's rows.
    const text = lines.join('');
    const said = text.indexOf('[Tars]');
    const typed = text.indexOf(fakes.claude);
    const notice = said >= 0 ? text.slice(said, typed > said ? typed : undefined) : '';
    const argv = launches()[0].argv;
    Object.assign(values, { terminal: lines, notice, said, typed, argv, handedTheFolder: argv.includes(ssh) });
    recordValues(values);
    await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2_000);
    await stepShot(page, 'terminal');

    expect(said, 'no [Tars] line in the agent\'s terminal').toBeGreaterThanOrEqual(0);
    expect(notice).toContain(ssh);
    expect(notice).toMatch(/credentials/);
    expect(typed, 'the CLI\'s line is not in the terminal').toBeGreaterThanOrEqual(0);
    expect(said, 'the line came after the CLI\'s line').toBeLessThan(typed);
    expect(argv, 'the CLI was handed the folder').not.toContain(ssh);
  } finally {
    await app?.close();
    await removeHome(home);
  }
});
