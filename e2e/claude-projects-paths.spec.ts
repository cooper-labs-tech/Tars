import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, seedSandbox } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Projects and Memory pages list a project Claude Code has opened, read
 * back from the folder Claude Code files it under in ~/.claude/projects.
 *
 * On Windows that folder is named `C--Users-...`: Claude turns every character
 * that is not a letter or a digit into `-`, the drive's colon, the backslashes
 * and the spaces included. Tars decoded it from `/`, with no drive and no
 * space, got `\C\Users\...`, which does not exist, and both pages lost the
 * project. The folder is seeded here the way Claude Code names
 * it, independently of the app's encoder; on Windows the project's path holds
 * a space, an underscore and a dot, the three separators the decoder has to
 * rebuild from the disk. On macOS and Linux the path keeps to the characters
 * their unchanged decoder rebuilds, so the spec holds there too.
 *
 * Artefacts in the run directory: memory.png, projects.png, values.json.
 * Reproduce: `E2E_PORT_OFFSET=40 npx playwright test e2e/claude-projects-paths.spec.ts`
 */

const MARKER = 'Remember: the fleet ships on Fridays.';

/** Claude Code's folder name for a path, written out here rather than imported from the app. */
const claudeFolder = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');

test('lists a project Claude Code opened, under its own name, on Projects and on Memory', async () => {
  // Through realpath on Windows only, for its 8.3 names (RUNNER~1); on macOS
  // the app reports /var/..., as os.tmpdir() gives it, not /private/var/...
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-claude-projects-'));
  const home = process.platform === 'win32' ? fs.realpathSync(made) : made;
  seedSandbox(home);
  const parent = process.platform === 'win32' ? 'Claude Project' : 'claude-project';
  const project = path.join(home, 'work', parent, 'my_app.v2');
  fs.mkdirSync(project, { recursive: true });
  const folder = path.join(home, '.claude', 'projects', claudeFolder(project));
  fs.mkdirSync(path.join(folder, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'memory', 'MEMORY.md'), `# my_app\n\n${MARKER}\n`);
  fs.writeFileSync(path.join(folder, '0b6f2a4e-9c1d-4e8a-b7f3-2d5c8e1a9f04.jsonl'), `${JSON.stringify({
    type: 'user', sessionId: '0b6f2a4e-9c1d-4e8a-b7f3-2d5c8e1a9f04', cwd: project, timestamp: '2026-09-25T10:00:00.000Z',
    message: { role: 'user', content: 'hello' },
  })}\n`);

  // Two pages compiled cold by next dev on a busy machine.
  test.setTimeout(240_000);
  const out = test.info().outputPath();
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31484), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState('domcontentloaded');

    // What the main process decodes the folder to, recorded before anything is
    // asserted, so a red run says what it got.
    const decoded = await page.evaluate(async () => (await window.electronAPI!.fs.listProjects()).map(p => p.path));
    const memories = await page.evaluate(async () => {
      const r = await window.electronAPI!.memory.listProjects([]);
      return r.projects.map(p => ({ projectPath: p.projectPath, files: p.files.map(f => f.name) }));
    });
    const values = { platform: process.platform, project, folder: path.basename(folder), decoded, memories };
    fs.writeFileSync(path.join(out, 'values.json'), JSON.stringify(values, null, 2));
    expect(decoded).toContain(project);
    expect(memories).toContainEqual({ projectPath: project, files: ['MEMORY.md'] });

    await page.goto(`${DEV_URL}/projects`, { waitUntil: 'domcontentloaded' });
    const projects = page.locator('main');
    await expect(projects.getByText('my_app.v2', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    await page.screenshot({ path: path.join(out, 'projects.png') });

    await page.goto(`${DEV_URL}/memory`, { waitUntil: 'domcontentloaded' });
    const memory = page.locator('main');
    const row = memory.getByText('my_app.v2', { exact: true }).first();
    await expect(row).toBeVisible({ timeout: 90_000 });
    await row.click();
    await memory.getByText('MEMORY.md', { exact: true }).first().click();
    await expect(memory).toContainText(MARKER, { timeout: 15_000 });
    await page.screenshot({ path: path.join(out, 'memory.png') });
    fs.writeFileSync(path.join(out, 'values.json'), JSON.stringify({ ...values, projectsPage: true, memoryPage: true }, null, 2));
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
