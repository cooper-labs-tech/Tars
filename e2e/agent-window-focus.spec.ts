import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent's window gives its terminal the focus a moment after it opens, but never over the user (the Audit's
 * reading of #636 at 6022d31a1). Until this fix the terminal took the focus 350 ms after it started, whatever had it:
 * keys typed into a field of the window in that first moment went to the agent, and for a running agent to its prompt.
 * Under load it took a Playwright fill in e2e/comma-folder-refused.spec.ts, the field left empty and the agent's
 * terminal printing "(Not running: start this agent to type here.)".
 *
 * The real app on a sandbox HOME, two agents at rest. main's agent:input handler is wrapped to record what the window
 * sends the agent. Asserted:
 * 1. the window of one agent, opened and left alone: its terminal takes the focus, as before;
 * 2. the window of the other, its footer field focused at once and typed into, key by key, for longer than the
 *    terminal waits: the field holds the whole text, the focus stays in it, and nothing reaches the agent.
 * Red on main at 58f2863b4: the terminal took the focus mid-typing, the field kept the first keys only, and the rest
 * went to the agent.
 * The artefact: values.json (the field, the focus, what the agent was sent) and focus-kept.png.
 */

const TEXT = 'notes for later, typed into the field';

test('an agent window gives its terminal the focus, but never over a field the user is typing in', async () => {
  test.setTimeout(120_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-window-focus-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  const at = { status: 'idle', role: 'worker', projectPath: project, skills: [], permissionMode: 'normal', provider: 'claude', character: 'robot', createdAt: '2026-11-26T08:00:00.000Z', lastActivity: '2026-11-26T08:00:00.000Z' };
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    { id: 'left', name: 'Left Alone', ...at },
    { id: 'typed', name: 'Typed Into', ...at },
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31952), DOROTHY_E2E: '1' },
  });
  // What the window sends an agent (agent:input).
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const input = handlers.get('agent:input')!;
    const g = globalThis as unknown as { windowInputs: { id: string; input: string }[] };
    g.windowInputs = [];
    handlers.set('agent:input', async (event: unknown, ...args: unknown[]) => {
      const a = (args[0] ?? {}) as { id?: unknown; input?: unknown };
      g.windowInputs.push({ id: String(a.id ?? ''), input: String(a.input ?? '') });
      return input(event, ...args);
    });
  });
  const sentTo = (id: string) => app.evaluate((_electron, i) => (globalThis as unknown as { windowInputs: { id: string; input: string }[] }).windowInputs.filter(x => x.id === i).map(x => x.input), id);
  /** What has the focus: the agent's terminal (xterm's own textarea), the footer field, or something else. */
  const focusIs = () => page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return 'none';
    if (el.classList.contains('xterm-helper-textarea')) return 'terminal';
    if (el.getAttribute('placeholder') === 'type to the agent, or paste a task') return 'field';
    return el.tagName.toLowerCase();
  });
  let page: Awaited<ReturnType<ElectronApplication['firstWindow']>>;
  try {
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });

    // 1. Left alone: the terminal takes the focus.
    await page.locator('[data-agent-card="left"]').click({ position: { x: 24, y: 14 } });
    await expect.poll(focusIs, { timeout: 15_000, message: 'the terminal of a window left alone has the focus' }).toBe('terminal');
    const leftFocus = await focusIs();
    await page.getByRole('button', { name: 'close', exact: true }).first().click();

    // 2. Typed into at once, for longer than the terminal waits.
    await page.locator('[data-agent-card="typed"]').click({ position: { x: 24, y: 14 } });
    const field = page.getByPlaceholder('type to the agent, or paste a task');
    await field.focus();
    await page.keyboard.type(TEXT, { delay: 45 });
    // Past the terminal's own moment, whatever it is, before reading.
    await page.waitForTimeout(1_000);
    const fieldValue = await field.inputValue();
    const typedFocus = await focusIs();
    const sent = await sentTo('typed');
    await page.screenshot({ path: test.info().outputPath('focus-kept.png') });

    keep({ leftFocus, fieldValue, typedFocus, sent });
    expect.soft(leftFocus, 'the terminal takes the focus when nothing else has it').toBe('terminal');
    expect.soft(fieldValue, 'the field holds every key typed into it').toBe(TEXT);
    expect.soft(typedFocus, 'the focus stays in the field').toBe('field');
    expect.soft(sent, 'nothing reaches the agent').toEqual([]);
  } finally {
    await app.close();
    await removeHome(home);
  }
});
