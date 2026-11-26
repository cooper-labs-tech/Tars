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
 * And, after 1 to 3 (the Audit's L1 on #636 at e4d550b48, and main typing the folder itself since 3a6dc22b8):
 * 0b. editing the path clears the line;
 * 0c. the plain folder added there is taken, the window types nothing into the agent (agent:input, which main's own
 *     typing does not go through), and the line under the field ([data-secondary-project-note]) says it applies at the
 *     agent's next start, as main answers for a gemini agent not running;
 * 0d. refused again, then the dialog opened on another agent: the line is gone.
 * Red on 3a6dc22b8: the window typed `/add-dir` itself, said nothing of when, and the line stayed through the edit
 * and the other agent. The artefact adds next-start-on-screen.png.
 * 0e. a grok agent at rest, whose line hands no secondary folder (main answers `not-handed` since 5a2c458b4): the plain
 *     folder added through its window is taken, nothing is typed, and [data-secondary-project-note] says its CLI is not
 *     handed it. Red on 5a2c458b4's window: no line said so. The artefact adds not-handed-on-screen.png.
 *
 * The second test: a folder set while the agent's CLI runs is typed into no CLI (the Audit's point on #636 at
 * 6970bc906: the window typed `/add-dir <path>` into every CLI's terminal, and grok 1.0.92, which has no such command,
 * took it as a prompt; then its M1 at f68f7901c: Claude Code 2.1.332's interactive `/add-dir` asks a question nobody
 * answers before it adds anything; the measures are in __tests__/electron/handlers/secondary-folder-live.test.ts). The
 * stand-ins of e2e/fake-clis.mjs log every line typed into them, and cannot ask: what is asserted is what main types.
 * 6. a claude agent whose CLI runs is typed nothing, and the answer says `next-start`, its line handing the folder;
 * 7. a grok agent whose CLI runs is typed nothing, and the answer says `not-handed`, grok's line handing none;
 * 8. ~/.tars-private is refused for the running claude agent, its reason naming it, and nothing is typed for it.
 * Red on e4d550b48: main typed nothing, its answer said nothing of when, and it took ~/.tars-private. Red on
 * f68f7901c: main typed `/add-dir <folder>` into claude and answered `now`, and answered `next-start` for grok.
 * And grok holding the folder 7 gave it (QA, on the Audit's M1 and M2 at 20c062cd3: a grok agent with a secondary
 * folder starts, and saves an edit):
 * 9. stopped and started again, it starts, and its kept output says, naming the folder, that Tars does not hand grok it;
 * 10. the window's rename of it is saved, its folder kept.
 * Shown on a mutant (QA's hold636g): 9 red with grok's launch notice left out (grok-provider.ts).
 *
 * Each fill of the custom path field in the first test is checked: the field holds the path and its Add is enabled,
 * else the path is filled again. The agent's terminal takes the focus a moment after its window opens, about 350 ms
 * under load (the Audit's reading of a red run of step 0, where Add stayed disabled after the fill).
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
    { id: 'grk', name: 'Grok Agent', character: 'robot', provider: 'grok', ...at },
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', geminiEnabled: true, grokEnabled: true }));
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31379), DOROTHY_E2E: '1' },
  });
  // What the window types into an agent (agent:input); main's own /add-dir goes through writeProgrammaticInput instead.
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const input = handlers.get('agent:input')!;
    const g = globalThis as unknown as { windowInputs: string[] };
    g.windowInputs = [];
    handlers.set('agent:input', async (event: unknown, ...args: unknown[]) => {
      g.windowInputs.push(String((args[0] as { input?: unknown } | undefined)?.input ?? ''));
      return input(event, ...args);
    });
  });
  const windowInputs = () => app.evaluate(() => (globalThis as unknown as { windowInputs: string[] }).windowInputs.slice());
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
    // Filled until the field holds the path and its Add is enabled: the terminal may take the focus meanwhile.
    const fillField = (value: string) => expect(async () => {
      await field.fill(value);
      await expect(field).toHaveValue(value, { timeout: 1_000 });
      await expect(field.locator('xpath=..').getByRole('button', { name: 'Add', exact: true })).toBeEnabled({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await fillField(comma);
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

    // 0b. Editing the path clears the line.
    const add = () => field.locator('xpath=..').getByRole('button', { name: 'Add', exact: true }).click();
    await fillField(plain);
    const errorAfterEdit = await line.count();
    // 0c. The plain folder, added there: taken, nothing typed by the window, and when it applies said under the field.
    const typedBefore = (await windowInputs()).length;
    await add();
    const note = page.locator('[data-secondary-project-note]');
    await expect.soft(note, 'when the folder applies').toBeVisible({ timeout: 10_000 });
    const noteShown = (await note.textContent({ timeout: 1_000 }).catch(() => null)) ?? null;
    await page.screenshot({ path: test.info().outputPath('next-start-on-screen.png') });
    const windowTyped = (await windowInputs()).slice(typedBefore);
    // 0d. Refused again, then the dialog on another agent: the line goes.
    await fillField(comma);
    await add();
    await expect.soft(line, 'refused again').toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'close', exact: true }).first().click();
    await page.locator('[data-agent-card="cla"]').click({ position: { x: 24, y: 14 } });
    await page.getByRole('radiogroup', { name: 'Agent rail' }).getByRole('radio', { name: /Memory/ }).click();
    const errorOnOtherAgent = await line.count();
    // 0e. A grok agent at rest: the plain folder taken, nothing typed, and its line not handed it, said under the field.
    await page.getByRole('button', { name: 'close', exact: true }).first().click();
    await page.locator('[data-agent-card="grk"]').click({ position: { x: 24, y: 14 } });
    await page.getByRole('radiogroup', { name: 'Agent rail' }).getByRole('radio', { name: /Memory/ }).click();
    const grokTypedBefore = (await windowInputs()).length;
    await fillField(plain);
    await add();
    await expect.soft(note, 'what becomes of the folder on grok').toBeVisible({ timeout: 10_000 });
    const grokNote = (await note.textContent({ timeout: 1_000 }).catch(() => null)) ?? null;
    await page.screenshot({ path: test.info().outputPath('not-handed-on-screen.png') });
    const grokWindowTyped = (await windowInputs()).slice(grokTypedBefore);
    const grokFolder = (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.get('grk')))?.secondaryProjectPath ?? null;
    keep({ errorAfterEdit, noteShown, windowTyped, errorOnOtherAgent, grokNote, grokWindowTyped, grokFolder });
    expect.soft(errorAfterEdit, 'the line gone once the path is edited').toBe(0);
    expect.soft(noteShown ?? '', 'the folder applies at the agent\'s next start').toMatch(/next start/);
    expect.soft(windowTyped, 'nothing typed by the window').toEqual([]);
    expect.soft(errorOnOtherAgent, 'the line gone on another agent').toBe(0);
    expect.soft(grokFolder, 'the folder kept in the record').toBe(plain);
    expect.soft(grokNote ?? '', 'grok is not handed the folder').toMatch(/not handed/);
    expect.soft(grokNote ?? '', 'never said to come at the next start').not.toMatch(/next start/);
    expect.soft(grokWindowTyped, 'nothing typed into grok by the window').toEqual([]);

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
  stop(id: string): Promise<{ success: boolean }>;
  update(p: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  setSecondaryProject(p: { id: string; secondaryProjectPath: string | null }): Promise<{ success: boolean; error?: string; appliesAt?: string }>;
  get(id: string): Promise<{ cliRunning?: boolean; currentSessionId?: string; status?: string; secondaryProjectPath?: string; name?: string } | null>;
} } };
type Rec = { agent?: string; kind?: string; launch?: unknown; typed?: string };

test("a folder set while the agent's CLI runs is typed into no CLI, and the answer says when it reaches it", async () => {
  test.setTimeout(270_000);
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

    // 6. claude, given the time main's writer takes to paste and submit (300 ms), many times over.
    const claudeAnswer = await setFor('live-claude', shared);
    await page.waitForTimeout(3_000);
    const claudeTyped = typedBy('live-claude').slice(before.claude);
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
    keep({ claudeAnswer, claudeTyped, grokAnswer, grokTyped, privateAnswer, privateTyped, claudeFolder: claudeAfter?.secondaryProjectPath ?? null });

    expect.soft(claudeAnswer.success, JSON.stringify(claudeAnswer)).toBe(true);
    expect.soft(claudeAnswer.appliesAt).toBe('next-start');
    expect.soft(claudeTyped, 'nothing typed into claude').toEqual([]);
    expect.soft(grokAnswer.success, JSON.stringify(grokAnswer)).toBe(true);
    expect.soft(grokAnswer.appliesAt).toBe('not-handed');
    expect.soft(grokTyped, 'nothing typed into grok').toEqual([]);
    expect.soft(privateAnswer.success, JSON.stringify(privateAnswer)).toBe(false);
    expect.soft(privateAnswer.error ?? '').toMatch(/tars-private/);
    expect.soft(privateTyped, 'nothing typed for ~/.tars-private').toEqual([]);
    expect.soft(claudeAfter?.secondaryProjectPath).toBe(shared);

    // 9. grok, holding the folder 7 gave it, stopped and started again: it starts, and its output names the folder
    //    Tars does not hand it.
    const grokLaunches = () => recs('live-grok').filter((r) => r.launch).length;
    const launchesBefore = grokLaunches();
    await page.evaluate((i) => (window as unknown as LiveApi).electronAPI.agent.stop(i), 'live-grok');
    await expect.poll(async () => !!(await get('live-grok'))?.cliRunning, { timeout: 30_000, message: "grok's CLI stopped" }).toBe(false);
    await page.evaluate((i) => (window as unknown as LiveApi).electronAPI.agent.start({ id: i, prompt: '' }), 'live-grok');
    await expect.poll(grokLaunches, { timeout: 60_000, message: 'grok launched again' }).toBeGreaterThan(launchesBefore);
    // The notice is a [Tars] line in the agent's kept output (core/agent-notices.ts), read from main as
    // chat-runners.spec.ts reads a refused session's: agent:get answers a running CLI's screen instead.
    const dist = path.resolve('electron', 'dist');
    const grokOutput = () => app.evaluate((_e, { dist, id }) => {
      const agent = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get(id);
      return ((agent?.output ?? []) as string[]).join('');
    }, { dist, id: 'live-grok' });
    await expect.poll(grokOutput, { timeout: 15_000, message: "grok's launch notice in its kept output" }).toMatch(/does not hand grok its secondary folder/);
    const grokSaid = await grokOutput();
    // 10. The window's rename of that grok agent, as its edit sends it: saved, its folder kept.
    const grokRenamed = await page.evaluate(({ i, f }) => (window as unknown as LiveApi).electronAPI.agent.update({ id: i, ...f }), {
      i: 'live-grok',
      f: { projectPath: project, skills: [], permissionMode: 'bypass', character: 'robot', model: null, savedPrompt: null, role: 'worker', cliPath: fakes.grok, name: 'Grok Renamed', provider: 'grok' },
    });
    const grokAfter = await get('live-grok');
    keep({ grokRelaunched: grokLaunches() - launchesBefore, grokNoticeNamesFolder: grokSaid.includes(shared), grokRenamed, grokAfter: { name: grokAfter?.name, folder: grokAfter?.secondaryProjectPath ?? null } });
    expect.soft(grokSaid, "grok's notice names its folder").toContain(shared);
    expect.soft(grokRenamed.success, JSON.stringify(grokRenamed)).toBe(true);
    expect.soft(grokAfter?.name).toBe('Grok Renamed');
    expect.soft(grokAfter?.secondaryProjectPath).toBe(shared);
  } finally {
    await app.close();
    await removeHome(home);
  }
});
