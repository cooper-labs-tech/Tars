import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { writeFakeClis } from './fake-clis.mjs';

/**
 * A folder a gemini agent can never see is refused where the user sets it, with a reason the window shows (the
 * Audit's L1 on #636 at aef730f1c).
 *
 * gemini 0.70.0 splits every --include-directories value at commas and trims each piece (coerceCommaSeparated, read
 * in its bundle), so a secondary folder named "Acme, Inc" reaches it as two other folders. Since aef730f1c Tars leaves
 * such a folder off gemini's line, and said so only in its own log: the agent worked without the folder, and nobody
 * was told why.
 *
 * The real app on a sandbox HOME, a gemini agent seeded at rest. Asserted, through the window's own calls:
 * 1. agent.setSecondaryProject with a folder whose name holds a comma answers no, with words naming the comma;
 * 2. agent.update with that folder as its secondary folder answers no the same way, and changes nothing;
 * 3. a folder with no comma is taken, so the refusal is the comma's.
 * Red on aef730f1c: both calls took the folder.
 *
 * Judged on the move, not on what is sent (the Audit's M1 on #636 at 20c062cd3): the window's edit sends the agent's
 * provider every time, with its name, model, mode and skills, and never its secondary folder or vaults.
 * 4. a gemini agent already holding a comma folder and a comma vault saves the window's rename: its folders are said at
 *    its launch, and the dialog has no field to clear them;
 * 5. a claude agent holding a comma folder, moved to gemini, is refused, and stays claude.
 * Red on 20c062cd3: the rename was refused.
 * The artefact: values.json (each answer, the agent before and after).
 *
 * And on screen, through the window's one control for a secondary folder (the Audit's L1 on #636 at 6970bc906): the
 * agent's window, its Memory tab, the custom path field and its Add.
 * 0. The comma folder typed there and added is refused: main's reason shows under the field
 *    ([data-secondary-project-error]), word for word the same as main's answer in 1, the field keeps the path, and the
 *    agent keeps no folder.
 * Red on 6970bc906: the dialog dropped the answer, and no line showed. The artefact adds refused-on-screen.png.
 *
 * The second test: a folder set while the agent's CLI runs, typed by main as that CLI's own command, and only where
 * one was measured to take it (the Audit's point on #636 at 6970bc906: the window typed `/add-dir <path>` into every
 * CLI's terminal, and grok 1.0.92, which has no such command, took it as a prompt). Claude Code 2.1.332 takes
 * `/add-dir <path>` asking nothing; grok has none (the measures are in __tests__/electron/handlers/
 * secondary-folder-live.test.ts). The stand-ins of e2e/fake-clis.mjs log every line typed into them. Asserted:
 * 6. a claude agent whose CLI runs is typed `/add-dir <folder>` by main, and the answer says `now`;
 * 7. a grok agent whose CLI runs is typed nothing, and the answer says `next-start`;
 * 8. ~/.tars-private is refused for the running claude agent, its reason naming it, and nothing is typed for it.
 * Red on e4d550b48: main typed nothing, its answer said nothing of when, and it took ~/.tars-private.
 */

type Api = { electronAPI: { agent: {
  setSecondaryProject(p: { id: string; secondaryProjectPath: string | null }): Promise<{ success: boolean; error?: string }>;
  update(p: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  get(id: string): Promise<{ secondaryProjectPath?: string; name?: string; provider?: string } | null>;
} } };

test('a gemini agent is refused a secondary folder whose name holds a comma, with words the window shows', async () => {
  test.setTimeout(120_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-comma-folder-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const comma = path.join(home, 'Acme, Inc');
  const plain = path.join(home, 'Acme Inc');
  for (const d of [project, dir, comma, plain]) fs.mkdirSync(d, { recursive: true });
  const vault = path.join(home, 'Notes, 2026');
  fs.mkdirSync(vault, { recursive: true });
  const at = { status: 'idle', role: 'worker', projectPath: project, skills: [], permissionMode: 'normal', createdAt: '2026-11-25T08:00:00.000Z', lastActivity: '2026-11-25T08:00:00.000Z' };
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    { id: 'gem', name: 'Gemini Agent', character: 'robot', provider: 'gemini', ...at },
    { id: 'held', name: 'Gemini Held', character: 'robot', provider: 'gemini', secondaryProjectPath: comma, obsidianVaultPaths: [vault], ...at },
    { id: 'cla', name: 'Claude Held', character: 'robot', provider: 'claude', secondaryProjectPath: comma, ...at },
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', geminiEnabled: true }));
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31379), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const setTo = (folder: string) => page.evaluate((f) => (window as unknown as Api).electronAPI.agent.setSecondaryProject({ id: 'gem', secondaryProjectPath: f }), folder);
    const updateTo = (folder: string) => page.evaluate((f) => (window as unknown as Api).electronAPI.agent.update({ id: 'gem', secondaryProjectPath: f }), folder);
    const read = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.get('gem'));

    // 0. The window's own control: the agent's window, Memory, the custom path field and its Add.
    await page.locator('[data-agent-card="gem"]').click({ position: { x: 24, y: 14 } });
    await page.getByRole('radiogroup', { name: 'Agent rail' }).getByRole('radio', { name: /Memory/ }).click();
    const field = page.getByPlaceholder('/path/to/project...');
    await field.fill(comma);
    await field.locator('xpath=..').getByRole('button', { name: 'Add', exact: true }).click();
    const line = page.locator('[data-secondary-project-error]');
    await expect.soft(line, 'the refusal under the field').toBeVisible({ timeout: 10_000 });
    const onScreen = (await line.textContent({ timeout: 1_000 }).catch(() => null)) ?? null;
    const fieldAfter = await field.inputValue();
    const afterControl = await read();
    await page.screenshot({ path: test.info().outputPath('refused-on-screen.png') });

    const set = await setTo(comma);
    keep({ onScreen, fieldAfter, afterControl: afterControl?.secondaryProjectPath ?? null });
    expect.soft(onScreen, 'main\'s reason, word for word, under the field').toBe(set.error ?? '(no answer)');
    expect.soft(fieldAfter, 'the field keeps the path').toBe(comma);
    expect.soft(afterControl?.secondaryProjectPath ?? null, 'no folder set from the control').toBeNull();
    const afterSet = await read();
    const updated = await updateTo(comma);
    const afterUpdate = await read();
    const taken = await setTo(plain);
    const afterTaken = await read();
    keep({ set, afterSet: afterSet?.secondaryProjectPath ?? null, updated, afterUpdate: afterUpdate?.secondaryProjectPath ?? null, taken, afterTaken: afterTaken?.secondaryProjectPath ?? null });

    // 1. setSecondaryProject.
    expect.soft(set.success, JSON.stringify(set)).toBe(false);
    expect.soft(set.error ?? '').toMatch(/comma/);
    expect.soft(afterSet?.secondaryProjectPath ?? null).toBeNull();
    // 2. update.
    expect.soft(updated.success, JSON.stringify(updated)).toBe(false);
    expect.soft(updated.error ?? '').toMatch(/comma/);
    expect.soft(afterUpdate?.secondaryProjectPath ?? null).toBeNull();
    // 3. A folder with no comma.
    expect.soft(taken.success, JSON.stringify(taken)).toBe(true);
    expect.soft(afterTaken?.secondaryProjectPath).toBe(plain);

    // 4 and 5, as the window's edit sends them (NewChatModal's commitAgent): the provider, never the folders.
    const edit = (id: string, fields: Record<string, unknown>) => page.evaluate(
      ({ i, f }) => (window as unknown as Api).electronAPI.agent.update({ id: i, ...f }),
      { i: id, f: { projectPath: project, skills: [], permissionMode: 'normal', character: 'robot', model: null, savedPrompt: null, role: 'worker', cliPath: null, ...fields } },
    );
    const readOf = (id: string) => page.evaluate((i) => (window as unknown as Api).electronAPI.agent.get(i), id);
    const renamed = await edit('held', { name: 'Gemini Renamed', provider: 'gemini' });
    const afterRename = await readOf('held');
    const moved = await edit('cla', { name: 'Claude Held', provider: 'gemini' });
    const afterMove = await readOf('cla');
    keep({ renamed, afterRename: { name: afterRename?.name, provider: afterRename?.provider }, moved, afterMove: { name: afterMove?.name, provider: afterMove?.provider } });
    // 4. The rename of an agent already holding such folders is saved.
    expect.soft(renamed.success, JSON.stringify(renamed)).toBe(true);
    expect.soft(afterRename?.name).toBe('Gemini Renamed');
    // 5. A move to gemini with such a folder is refused, and the agent stays claude.
    expect.soft(moved.success, JSON.stringify(moved)).toBe(false);
    expect.soft(moved.error ?? '').toMatch(/comma/);
    expect.soft(afterMove?.provider ?? 'claude').toBe('claude');
  } finally {
    await app.close();
    await removeHome(home);
  }
});

type LiveApi = { electronAPI: { agent: {
  start(p: { id: string; prompt: string }): Promise<unknown>;
  setSecondaryProject(p: { id: string; secondaryProjectPath: string | null }): Promise<{ success: boolean; error?: string; appliesAt?: string }>;
  get(id: string): Promise<{ cliRunning?: boolean; currentSessionId?: string; status?: string; secondaryProjectPath?: string } | null>;
} } };
type Rec = { agent?: string; kind?: string; launch?: unknown; typed?: string };

test("a folder set while the agent's CLI runs is typed into it as that CLI's own command, and only claude's", async () => {
  test.setTimeout(150_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-live-folder-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const shared = path.join(home, 'shared lib');
  const privateDir = path.join(home, '.tars-private');
  for (const d of [project, dir, shared, privateDir]) fs.mkdirSync(d, { recursive: true });
  const fakes = writeFakeClis(home, ['claude', 'grok']) as Record<string, string>;
  const at = { character: 'robot', status: 'idle', role: 'worker', projectPath: project, skills: [], permissionMode: 'bypass', createdAt: '2026-11-25T08:00:00.000Z', lastActivity: '2026-11-25T08:00:00.000Z' };
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    { id: 'live-claude', name: 'Claude Live', provider: 'claude', cliPath: fakes.claude, ...at },
    { id: 'live-grok', name: 'Grok Live', provider: 'grok', cliPath: fakes.grok, ...at },
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', grokEnabled: true,
    cliPaths: { claude: fakes.claude, grok: fakes.grok, additionalPaths: [path.join(home, 'bin')] },
  }));
  const log = path.join(home, 'fake-cli.jsonl');
  const recs = (id: string): Rec[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as Rec; } catch { return {}; } }) : []).filter((r) => r.agent === id);
  const typedBy = (id: string) => recs(id).filter((r) => typeof r.typed === 'string').map((r) => r.typed as string);
  const values: Record<string, unknown> = { home };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31380), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<LiveApi>).electronAPI);
    const get = (id: string) => page.evaluate((i) => (window as unknown as LiveApi).electronAPI.agent.get(i), id);
    const setFor = (id: string, folder: string) => page.evaluate(({ i, f }) => (window as unknown as LiveApi).electronAPI.agent.setSecondaryProject({ id: i, secondaryProjectPath: f }), { i: id, f: folder });

    for (const id of ['live-claude', 'live-grok']) await page.evaluate((i) => (window as unknown as LiveApi).electronAPI.agent.start({ id: i, prompt: '' }), id);
    await expect.poll(() => ['live-claude', 'live-grok'].filter((id) => recs(id).some((r) => r.launch)).length, { timeout: 60_000, message: 'both CLIs launched' }).toBe(2);
    // Up, and claude's session registered: its launch is over, so Tars may type into it.
    await expect.poll(async () => !!(await get('live-claude'))?.currentSessionId && !!(await get('live-claude'))?.cliRunning, { timeout: 60_000, message: "claude's session up" }).toBe(true);
    await expect.poll(async () => !!(await get('live-grok'))?.cliRunning, { timeout: 60_000, message: "grok's CLI up" }).toBe(true);
    const before = { claude: typedBy('live-claude').length, grok: typedBy('live-grok').length };

    // 6. claude.
    const claudeAnswer = await setFor('live-claude', shared);
    await expect.poll(() => typedBy('live-claude').slice(before.claude), { timeout: 15_000, message: 'what claude was typed' }).toContain(`/add-dir ${shared}`);
    // 7. grok, given the same time.
    const grokAnswer = await setFor('live-grok', shared);
    await page.waitForTimeout(3_000);
    const grokTyped = typedBy('live-grok').slice(before.grok);
    // 8. ~/.tars-private, for the running claude agent.
    const claudeTypedBefore = typedBy('live-claude').length;
    const privateAnswer = await setFor('live-claude', privateDir);
    await page.waitForTimeout(3_000);
    const privateTyped = typedBy('live-claude').slice(claudeTypedBefore);
    const claudeAfter = await get('live-claude');
    keep({ claudeAnswer, claudeTyped: typedBy('live-claude').slice(before.claude), grokAnswer, grokTyped, privateAnswer, privateTyped, claudeFolder: claudeAfter?.secondaryProjectPath ?? null });

    expect.soft(claudeAnswer.success, JSON.stringify(claudeAnswer)).toBe(true);
    expect.soft(claudeAnswer.appliesAt).toBe('now');
    expect.soft(grokAnswer.success, JSON.stringify(grokAnswer)).toBe(true);
    expect.soft(grokAnswer.appliesAt).toBe('next-start');
    expect.soft(grokTyped, 'nothing typed into grok').toEqual([]);
    expect.soft(privateAnswer.success, JSON.stringify(privateAnswer)).toBe(false);
    expect.soft(privateAnswer.error ?? '').toMatch(/tars-private/);
    expect.soft(privateTyped, 'nothing typed for ~/.tars-private').toEqual([]);
    expect.soft(claudeAfter?.secondaryProjectPath).toBe(shared);
  } finally {
    await app.close();
    await removeHome(home);
  }
});
