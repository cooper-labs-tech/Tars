import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The agent window of a gemini agent shows the screen its CLI drew, each row
 * where its cursor moves put it.
 *
 * Since #127, agent:get hands a window the terminal's own screen: one chunk
 * that opens with RIS and places every cell with cursor sequences. The window
 * strips cursor sequences from a gemini agent's raw output, whose repaints it
 * cannot follow, and until #132 it stripped that screen too: every cell landed
 * right after the one before it, and a screen drawn in rows read as one run of
 * text.
 *
 * The CLI stands in for gemini: it draws one row, moves its cursor two rows
 * down and four columns in, draws another, and waits. Nothing it writes after
 * the window opens, so what the window shows is what it was handed.
 */

type Api = {
  electronAPI: {
    agent: {
      start(p: { id: string; prompt: string }): Promise<unknown>;
      list(): Promise<Array<{ id: string; cliRunning?: boolean }>>;
      get(id: string): Promise<{ output?: string[] } | null>;
    };
  };
};

const AGENT = { id: 'g1', name: 'Gemini Stand-in' };

test('the agent window of a gemini agent shows the rows its CLI placed with cursor moves', async () => {
  test.setTimeout(120_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-agent-window-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const cli = writeNodeCli(path.join(home, 'fake-gemini.cjs'), [
    "process.stdout.write('\\x1b[2J\\x1b[Hthe first row\\x1b[3;5Hthe third row');",
    'process.stdin.resume();',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: AGENT.id, name: AGENT.name, character: 'robot', provider: 'gemini', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cli,
    createdAt: '2026-09-23T08:00:00.000Z', lastActivity: '2026-09-23T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  // Nothing on the machine answers: Hermes and Ollama on port 9, as seedSandbox does.
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31488), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    await page.evaluate(id => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), AGENT.id);
    await expect.poll(
      () => page.evaluate(async id => (await (window as unknown as Api).electronAPI.agent.list()).find(a => a.id === id)?.cliRunning ?? false, AGENT.id),
      { timeout: 30_000, message: 'the stand-in holds its terminal' },
    ).toBe(true);

    // What the window will be handed: the screen, one chunk opening with RIS.
    const handed = await page.evaluate(async id => (await (window as unknown as Api).electronAPI.agent.get(id))?.output ?? [], AGENT.id);
    expect(handed, 'one chunk: the screen').toHaveLength(1);
    expect(handed[0].startsWith('\x1bc'), 'the screen opens with RIS').toBe(true);

    await page.getByText(AGENT.name, { exact: true }).first().click();
    await expect(page.locator('.xterm')).toHaveCount(1, { timeout: 15_000 });
    const rows = page.locator('.xterm .xterm-rows > div');
    await expect(rows.filter({ hasText: 'the third row' })).toHaveCount(1, { timeout: 15_000 });
    const lines = await rows.allInnerTexts();
    const first = lines.findIndex(line => line.includes('the first row'));
    const third = lines.findIndex(line => line.includes('the third row'));
    recordValues({ handedBytes: handed[0].length, firstRow: first, thirdRow: third, lines: lines.slice(0, 6) });
    await stepShot(page, 'agent-window');

    expect(first, 'the first row is on screen').toBeGreaterThanOrEqual(0);
    expect(lines[first].trim(), 'the first row alone on its line').toBe('the first row');
    expect(third - first, 'the third row two rows below it').toBe(2);
    expect(lines[third].replace(/ /g, ' ').startsWith('    the third row'), 'the third row four columns in').toBe(true);
  } finally {
    await app.close();
    await removeHome(home);
  }
});
