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
 *
 * The window's quick shell, under its Git tab, is a login shell in the project folder: it took the focus 250 ms after
 * it was built, with no look at the user (the Audit's M1 on #649 at 65457d56f). A shell once opened is built again with
 * every window, and with every "Rail section" click (the Audit's L1), so an Enter after the steal ran the tail of what
 * the user typed as a command. main's pty:write and pty:create handlers are wrapped too. Asserted, on a third agent:
 * 3. its window opened, its shell opened, the window closed and opened again, and its footer field typed into at once:
 *    the field holds the whole text, and neither the shell nor the agent gets a key;
 * 4. then, the window settled, the "Rail section" tab already shown clicked, and a key pressed a moment later: neither
 *    the shell nor the agent gets it.
 * Red on 65457d56f: the shell took the field's keys in 3, and the key in 4.
 * And the moves that are neither a key nor a click (QA), each on an agent of its own, its window's terminal built (its
 * listeners on) and its focus not yet given:
 * 5. the footer field focused, then its text put in with no key event once the terminal's moment has passed: what
 *    Playwright's fill does, its two halves stretched apart as load stretched them in comma-folder-refused.spec.ts
 *    step 0. The field keeps the focus and the text, and nothing reaches the agent;
 * 6. text put into the footer field at once with no key, no click and no change of focus, as dictation or Paste from
 *    the Edit menu put it: the field keeps the focus and the text, and nothing reaches the agent.
 * Shown on QA's mutants of noteUserMoves (src/lib/terminal.ts): 5 red alone without its focusin listener, 6 red alone
 * without beforeinput.
 * The artefact: values.json (the field, the focus, what the agent and the shell were sent) and focus-kept.png.
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
    { id: 'shelly', name: 'Shell Open', ...at },
    { id: 'focused', name: 'Focused In', ...at },
    { id: 'dictated', name: 'Dictated In', ...at },
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
    // What the window's quick shells are created with, and sent (pty:create, pty:write).
    const create = handlers.get('pty:create')!;
    const write = handlers.get('pty:write')!;
    const s = globalThis as unknown as { shellsCreated: number; shellWrites: string[] };
    s.shellsCreated = 0;
    s.shellWrites = [];
    handlers.set('pty:create', async (event: unknown, ...args: unknown[]) => { s.shellsCreated += 1; return create(event, ...args); });
    handlers.set('pty:write', async (event: unknown, ...args: unknown[]) => {
      s.shellWrites.push(String(((args[0] ?? {}) as { data?: unknown }).data ?? ''));
      return write(event, ...args);
    });
  });
  const sentTo = (id: string) => app.evaluate((_electron, i) => (globalThis as unknown as { windowInputs: { id: string; input: string }[] }).windowInputs.filter(x => x.id === i).map(x => x.input), id);
  const shells = () => app.evaluate(() => (globalThis as unknown as { shellsCreated: number }).shellsCreated);
  const shellWrites = () => app.evaluate(() => (globalThis as unknown as { shellWrites: string[] }).shellWrites.slice());
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

    // The window keeps its footer's text from one agent to the next: emptied, so case 3 reads its own keys alone.
    await field.fill('');
    await page.getByRole('button', { name: 'close', exact: true }).first().click();

    // 3. A window whose shell is open, opened again and typed into at once.
    await page.locator('[data-agent-card="shelly"]').click({ position: { x: 24, y: 14 } });
    await page.getByRole('button', { name: 'open shell', exact: true }).click();
    await expect.poll(shells, { timeout: 20_000, message: 'the quick shell started' }).toBe(1);
    await page.waitForTimeout(1_500);
    await page.getByRole('button', { name: 'close', exact: true }).first().click();
    const writesBefore = (await shellWrites()).length;
    await page.locator('[data-agent-card="shelly"]').click({ position: { x: 24, y: 14 } });
    await field.focus();
    await page.keyboard.type(TEXT, { delay: 45 });
    await page.waitForTimeout(1_000);
    const shellFieldValue = await field.inputValue();
    const shellFocus = await focusIs();
    const shellGot = (await shellWrites()).slice(writesBefore);
    const shellAgentGot = await sentTo('shelly');
    await page.screenshot({ path: test.info().outputPath('shell-kept.png') });

    // 4. Settled, the "Rail section" tab already shown clicked, and a key a moment later.
    await page.waitForTimeout(1_500);
    const railWritesBefore = (await shellWrites()).length;
    const railAgentBefore = (await sentTo('shelly')).length;
    const railFocusBefore = await focusIs();
    await page.getByRole('radiogroup', { name: 'Rail section' }).getByRole('radio', { name: 'Git' }).click();
    await page.waitForTimeout(1_200);
    await page.keyboard.press('q');
    await page.waitForTimeout(300);
    const railShellGot = (await shellWrites()).slice(railWritesBefore);
    const railAgentGot = (await sentTo('shelly')).slice(railAgentBefore);

    keep({ leftFocus, fieldValue, typedFocus, sent, shellFieldValue, shellFocus, shellGot, shellAgentGot, railFocusBefore, railShellGot, railAgentGot });
    expect.soft(leftFocus, 'the terminal takes the focus when nothing else has it').toBe('terminal');
    expect.soft(fieldValue, 'the field holds every key typed into it').toBe(TEXT);
    expect.soft(typedFocus, 'the focus stays in the field').toBe('field');
    expect.soft(sent, 'nothing reaches the agent').toEqual([]);
    expect.soft(shellFieldValue, 'with the shell open, the field holds every key typed into it').toBe(TEXT);
    expect.soft(shellFocus, 'with the shell open, the focus stays in the field').toBe('field');
    expect.soft(shellGot, 'with the shell open, nothing reaches the shell').toEqual([]);
    expect.soft(shellAgentGot, 'with the shell open, nothing reaches the agent').toEqual([]);
    expect.soft(railShellGot, 'a tab click does not hand the shell the next key').toEqual([]);
    expect.soft(railAgentGot, 'a tab click does not hand the agent the next key').toEqual([]);

    // 5. (QA) Focused with no key and no click, then filled with no key event once the terminal's moment has passed:
    //    the window's terminal built (its listeners on), and its focus not yet given.
    await field.fill('');
    await page.getByRole('button', { name: 'close', exact: true }).first().click();
    await page.locator('[data-agent-card="focused"]').click({ position: { x: 24, y: 14 } });
    await page.locator('.xterm').first().waitFor({ state: 'attached', timeout: 15_000 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await field.focus();
    await page.waitForTimeout(1_000);
    const focusedBefore = await focusIs();
    await page.keyboard.insertText(TEXT);
    const focusedValue = await field.inputValue();
    const focusedSent = await sentTo('focused');

    // 6. (QA) Text put in at once with no key, no click and no change of focus, as dictation puts it.
    await field.fill('');
    await page.getByRole('button', { name: 'close', exact: true }).first().click();
    await page.locator('[data-agent-card="dictated"]').click({ position: { x: 24, y: 14 } });
    await page.locator('.xterm').first().waitFor({ state: 'attached', timeout: 15_000 });
    const dictatedFocusFirst = await focusIs();
    await page.keyboard.insertText(TEXT);
    await page.waitForTimeout(1_000);
    const dictatedFocus = await focusIs();
    const dictatedValue = await field.inputValue();
    const dictatedSent = await sentTo('dictated');

    keep({ focusedBefore, focusedValue, focusedSent, dictatedFocusFirst, dictatedFocus, dictatedValue, dictatedSent });
    expect.soft(focusedBefore, 'a field focused with no key or click keeps the focus').toBe('field');
    expect.soft(focusedValue, 'the text put in with no key event is in the field').toBe(TEXT);
    expect.soft(focusedSent, 'nothing reaches the agent').toEqual([]);
    expect.soft(dictatedFocusFirst, 'the footer field has the focus as the window opens').toBe('field');
    expect.soft(dictatedFocus, 'text from an input method keeps the focus in the field').toBe('field');
    expect.soft(dictatedValue, 'the dictated text is in the field').toBe(TEXT);
    expect.soft(dictatedSent, 'nothing reaches the agent').toEqual([]);
  } finally {
    await app.close();
    await removeHome(home);
  }
});
