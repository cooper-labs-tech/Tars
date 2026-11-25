import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

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

    const set = await setTo(comma);
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
