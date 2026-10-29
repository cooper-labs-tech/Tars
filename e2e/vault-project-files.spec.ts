import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Vault reads and edits each project's folder (2.0.4, the frames "Vault · project folders" of #457, the Audit's
 * requirements for 2.0.4, section 1), driven from the real window over the channels the page uses.
 *
 * The real app on a sandbox HOME with a project and its folder as an agent of 2.0.3 left it: reports/ with a report,
 * tools/ with a script that runs, notes/ with a note, and in reports/ a link to an SSH key.
 *
 * Asserted, once with the classic shell and once with the new interface:
 * 1. vault.projectFolders names the folder by its project and counts its reports and tools; notes/ has moved into
 *    reports/notes, its file whole, and no notes/ is left;
 * 2. vault.projectFiles lists reports/ newest first, with size, time and kind; the link to the key is not listed;
 *    tools/ says the script runs as it is;
 * 3. vault.readProjectFile gives the report's text, its absolute path and time; the link is refused, and the key is
 *    not in any answer;
 * 4. vault.writeProjectFile with the time it was opened writes the file, 0600; after an agent wrote it, it answers
 *    changed and writes nothing; a name with a separator, a subfolder other than reports and tools, and a write of a
 *    program are refused, and nothing appears outside the folder;
 * 5. vault.onProjectFilesChanged says reports moved when an agent writes a file there.
 * Red on main (ce9c0084... 371d3c70): there are no such channels.
 * The artefact: values.json (every answer), a screenshot of the Vault page, the app's trace with E2E_TRACE=on.
 */

type Failure = { error: string; code: string };
type Api = { electronAPI: { vault: {
  projectFolders(): Promise<{ folders: Array<{ key: string; name: string; projectPath: string | null; reports: number | Failure; tools: number | Failure; notesMoved?: string }> }>;
  projectFiles(p: { key: string; sub: string }): Promise<{ files: Array<{ name: string; size: number; mtimeMs: number; kind: string; runnable: boolean }> } | Failure>;
  readProjectFile(p: { key: string; sub: string; name: string }): Promise<Record<string, unknown>>;
  writeProjectFile(p: { key: string; sub: string; name: string; text: string; mtimeSeen: number | null }): Promise<Record<string, unknown>>;
  onProjectFilesChanged(cb: (e: { key: string; sub: string }) => void): () => void;
} } };

for (const newInterface of [false, true]) {
  test(`the vault reads and edits each project's reports and tools, and nothing else${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-vault-files-'));
    const dir = path.join(home, '.tars');
    const project = path.join(home, 'projects', 'atlas');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const port = apiPort(newInterface ? 31407 : 31408);
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    try {
      // Its folder as 2.0.3 left it, its key computed by the app itself.
      const folder = await app.evaluate((_e, { dist, project }) => process.mainModule!.require(`${dist}/utils/project-files.js`).projectFilesDir(project) as string,
        { dist: path.resolve('electron', 'dist'), project });
      const key = path.basename(folder);
      for (const sub of ['reports', 'tools', 'notes']) fs.mkdirSync(path.join(folder, sub), { recursive: true });
      fs.writeFileSync(path.join(folder, 'reports', 'release.md'), '# Release\n\nShipped.\n');
      fs.writeFileSync(path.join(folder, 'tools', 'slot.sh'), '#!/bin/bash\necho slot\n', { mode: 0o755 });
      fs.writeFileSync(path.join(folder, 'notes', 'next.md'), 'what the next session should know');
      const sshKey = path.join(home, '.ssh', 'id_rsa');
      fs.mkdirSync(path.dirname(sshKey), { recursive: true });
      fs.writeFileSync(sshKey, 'E2E PRIVATE KEY');
      fs.symlinkSync(sshKey, path.join(folder, 'reports', 'key.md'));

      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/vault`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      const vault = <T>(fn: (v: Api['electronAPI']['vault'], arg: unknown) => Promise<T>, arg?: unknown) =>
        page.evaluate(([src, a]) => (new Function('v', 'arg', `return (${src})(v, arg)`))((window as unknown as Api).electronAPI.vault, a), [fn.toString(), arg] as const) as Promise<T>;

      // 1. The folders, notes/ moved.
      const folders = await vault((v) => v.projectFolders());
      const atlas = folders.folders.find((f) => f.key === key);
      const moved = path.join(folder, 'reports', 'notes', 'next.md');
      keep({ key, folders });
      expect.soft(atlas).toMatchObject({ name: 'atlas', projectPath: project, tools: 1 });
      expect.soft(fs.existsSync(path.join(folder, 'notes')), 'notes/ left').toBe(false);
      expect.soft(fs.existsSync(moved) ? fs.readFileSync(moved, 'utf8') : null).toBe('what the next session should know');

      // 2. The lists.
      const reports = await vault((v, a) => v.projectFiles(a as { key: string; sub: string }), { key, sub: 'reports' });
      const tools = await vault((v, a) => v.projectFiles(a as { key: string; sub: string }), { key, sub: 'tools' });
      keep({ reports, tools });
      const names = 'files' in reports ? reports.files.map((f) => f.name) : [];
      expect.soft(names).toContain('release.md');
      expect.soft(names, 'the link listed').not.toContain('key.md');
      expect.soft('files' in tools ? tools.files.find((f) => f.name === 'slot.sh') : undefined).toMatchObject({ kind: 'code', runnable: true });

      // 3. Reads.
      const read = await vault((v, a) => v.readProjectFile(a as { key: string; sub: string; name: string }), { key, sub: 'reports', name: 'release.md' });
      const viaLink = await vault((v, a) => v.readProjectFile(a as { key: string; sub: string; name: string }), { key, sub: 'reports', name: 'key.md' });
      keep({ read, viaLink });
      expect.soft(read).toMatchObject({ text: '# Release\n\nShipped.\n', kind: 'markdown', editable: true });
      expect.soft(fs.realpathSync(String(read.path))).toBe(fs.realpathSync(path.join(folder, 'reports', 'release.md')));
      expect.soft(viaLink).toHaveProperty('error');
      expect.soft(JSON.stringify(values)).not.toContain('E2E PRIVATE KEY');

      // 4. Writes: with its time, then over an agent's change, then what is refused.
      const saved = await vault((v, a) => v.writeProjectFile(a as never), { key, sub: 'reports', name: 'release.md', text: '# Release\n\nShipped, checked.\n', mtimeSeen: read.mtimeMs });
      const onDisk = fs.readFileSync(path.join(folder, 'reports', 'release.md'), 'utf8');
      const mode = fs.statSync(path.join(folder, 'reports', 'release.md')).mode & 0o777;
      await new Promise((r) => setTimeout(r, 30));
      fs.writeFileSync(path.join(folder, 'reports', 'release.md'), '# Release, by an agent\n');
      const stale = await vault((v, a) => v.writeProjectFile(a as never), { key, sub: 'reports', name: 'release.md', text: '# mine again\n', mtimeSeen: saved.mtimeMs });
      const refused = {
        separator: await vault((v, a) => v.writeProjectFile(a as never), { key, sub: 'reports', name: '../../escape.md', text: 'x', mtimeSeen: null }),
        subfolder: await vault((v, a) => v.writeProjectFile(a as never), { key, sub: '..', name: 'escape.md', text: 'x', mtimeSeen: null }),
        program: await vault((v, a) => v.writeProjectFile(a as never), { key, sub: 'tools', name: 'run.command', text: 'x', mtimeSeen: null }),
        throughLink: await vault((v, a) => v.writeProjectFile(a as never), { key, sub: 'reports', name: 'key.md', text: 'pwned', mtimeSeen: null }),
      };
      keep({ saved, onDisk, mode, stale, refused });
      expect.soft(saved).toMatchObject({ ok: true });
      expect.soft(onDisk).toBe('# Release\n\nShipped, checked.\n');
      expect.soft(mode).toBe(0o600);
      expect.soft(stale).toMatchObject({ changed: true });
      expect.soft(fs.readFileSync(path.join(folder, 'reports', 'release.md'), 'utf8')).toBe('# Release, by an agent\n');
      for (const [why, r] of Object.entries(refused)) expect.soft(r, why).toHaveProperty('error');
      expect.soft(fs.existsSync(path.join(dir, 'project-files', 'escape.md')) || fs.existsSync(path.join(folder, 'escape.md'))).toBe(false);
      expect.soft(fs.readFileSync(sshKey, 'utf8')).toBe('E2E PRIVATE KEY');

      // 5. An agent writes a report: the window is told.
      await page.evaluate(() => {
        const w = window as unknown as Api & { __changed: Array<{ key: string; sub: string }> };
        w.__changed = [];
        w.electronAPI.vault.onProjectFilesChanged((e) => w.__changed.push(e));
      });
      fs.writeFileSync(path.join(folder, 'reports', 'new-from-agent.md'), '# new');
      await expect.poll(() => page.evaluate(() => (window as unknown as { __changed: Array<{ key: string; sub: string }> }).__changed), { timeout: 10_000 })
        .toContainEqual(expect.objectContaining({ key, sub: 'reports' }));
      await page.waitForTimeout(800);
      await stepShot(page, newInterface ? 'vault-new-interface' : 'vault');
    } finally {
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
