import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Vault lists every folder of a project's folder, one level at a time (2.0.5, the owner's go of 28/10; the frames
 * of #526 and their notes for the Backend, GJwkc), driven from the real window over the channel the tree will use.
 *
 * The real app on a sandbox HOME with a project whose folder holds what agents leave there: missions/ and docs/ beside
 * reports/ and tools/, a worktree under reports/overnight/wt/ with its .git and node_modules, 230 briefs in one folder,
 * a link to a folder outside and a hard link to a file outside, and a folder nobody can read.
 *
 * Asserted, once with the classic shell and once with the new interface:
 * 1. vault.projectPlace on [] lists every folder of the project's folder, missions and docs included, with counts;
 * 2. in the worktree, .git and node_modules are named heavy, uncounted; asked for, node_modules answers `heavy`;
 * 3. the link is listed as a link with its target as written, the hard link as one; neither is read, and the place
 *    through the link answers `link`; nothing of outside is in any answer;
 * 4. 230 briefs come 200 then 30, newest first, with total, offset and more;
 * 5. the locked folder is said with EACCES in its parent's list, and asked for, answers unreadable;
 * 6. a nested file is read and written (0600) by its place; `..` is refused and nothing appears outside;
 *    today's form (`sub: 'reports'`) still reads;
 * 7. vault.onProjectFilesChanged says the nested folder an agent writes in, and nothing for a write in node_modules.
 * Red on main dc623b59: there is no vault.projectPlace.
 * The artefact: values.json (every answer), a screenshot of the Vault page, the app's trace with E2E_TRACE=on.
 */

type Failure = { error: string; code: string; errno?: string };
type Entry = { name: string; type: 'folder' | 'file' | 'link'; entries?: number; heavy?: true; error?: string; target?: string | null; hardlink?: true };
type List = { entries: Entry[]; total: number; offset: number; more?: number };
type Change = { key: string; place: string[]; sub?: string };
type Api = { electronAPI: { vault: {
  projectPlace(p: { key: string; place: string[]; offset?: number; limit?: number }): Promise<List | Failure>;
  readProjectFile(p: Record<string, unknown>): Promise<Record<string, unknown>>;
  writeProjectFile(p: Record<string, unknown>): Promise<Record<string, unknown>>;
  onProjectFilesChanged(cb: (e: Change) => void): () => void;
} } };

const posix = process.platform !== 'win32';

for (const newInterface of [false, true]) {
  test(`the vault lists every folder of a project, one level at a time, and opens no heavy folder nor link${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-vault-tree-'));
    const dir = path.join(home, '.tars');
    const project = path.join(home, 'projects', 'harbor');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const port = apiPort(newInterface ? 31342 : 31341);
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const put = (file: string, text: string, mtimeSec?: number) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      if (mtimeSec !== undefined) fs.utimesSync(file, mtimeSec, mtimeSec);
    };

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    let lockedDir = '';
    try {
      // The project's folder, its key computed by the app itself, as agents fill it.
      const folder = await app.evaluate((_e, { dist, project }) => process.mainModule!.require(`${dist}/utils/project-files.js`).ensureProjectFiles(project).dir as string,
        { dist: path.resolve('electron', 'dist'), project });
      const key = path.basename(folder);
      put(path.join(folder, 'reports', 'release.md'), '# Release\n');
      put(path.join(folder, 'reports', 'overnight', 'summary.md'), '# Overnight\n');
      put(path.join(folder, 'reports', 'overnight', 'wt', 'w1', 'notes.md'), 'worktree notes');
      put(path.join(folder, 'reports', 'overnight', 'wt', 'w1', '.git', 'HEAD'), 'ref: refs/heads/main');
      put(path.join(folder, 'reports', 'overnight', 'wt', 'w1', 'node_modules', 'pkg', 'index.js'), 'module.exports = 1');
      put(path.join(folder, 'missions', 'm1', 'reports', 'r.md'), '# Mission report\n');
      put(path.join(folder, 'docs', 'a.md'), '# A');
      for (let i = 0; i < 230; i++) put(path.join(folder, 'briefs', 'many', `b${String(i).padStart(3, '0')}.md`), 'b', 1_700_000_000 + i);
      const outside = path.join(home, 'outside');
      put(path.join(outside, 'secret.md'), 'E2E OUTSIDE SECRET');
      fs.mkdirSync(path.join(folder, 'reports', 'links'), { recursive: true });
      fs.symlinkSync(outside, path.join(folder, 'reports', 'links', 'to-outside'));
      fs.linkSync(path.join(outside, 'secret.md'), path.join(folder, 'reports', 'links', 'hard.md'));
      lockedDir = path.join(folder, 'reports', 'locked');
      fs.mkdirSync(lockedDir);
      if (posix) fs.chmodSync(lockedDir, 0o000);

      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/vault`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      const vault = <T>(fn: (v: Api['electronAPI']['vault'], arg: unknown) => Promise<T>, arg?: unknown) =>
        page.evaluate(([src, a]) => (new Function('v', 'arg', `return (${src})(v, arg)`))((window as unknown as Api).electronAPI.vault, a), [fn.toString(), arg] as const) as Promise<T>;
      const place = (p: string[], more: { offset?: number; limit?: number } = {}) =>
        vault((v, a) => v.projectPlace(a as { key: string; place: string[] }), { key, place: p, ...more }) as Promise<List | Failure>;
      const byName = (l: List | Failure) => ('entries' in l ? Object.fromEntries(l.entries.map((e) => [e.name, e])) : {});

      // 1. The project's folder, every folder of it.
      const top = await place([]);
      keep({ key, top });
      expect.soft(Object.values(byName(top)).filter((e) => e.type === 'folder').map((e) => e.name)).toEqual(['briefs', 'docs', 'missions', 'reports', 'tools']);
      expect.soft(byName(top).missions).toMatchObject({ type: 'folder', entries: 1 });

      // 2. Heavy folders named, never opened.
      const worktree = await place(['reports', 'overnight', 'wt', 'w1']);
      const heavy = await place(['reports', 'overnight', 'wt', 'w1', 'node_modules']);
      keep({ worktree, heavy });
      expect.soft(worktree).toMatchObject({ total: 3 });
      for (const name of ['.git', 'node_modules']) {
        expect.soft(byName(worktree)[name], name).toMatchObject({ type: 'folder', heavy: true });
        expect.soft(byName(worktree)[name], name).not.toHaveProperty('entries');
      }
      expect.soft(heavy).toMatchObject({ code: 'heavy' });

      // 3. Links said, never followed nor read.
      const links = await place(['reports', 'links']);
      const throughLink = await place(['reports', 'links', 'to-outside']);
      const readHard = await vault((v, a) => v.readProjectFile(a as Record<string, unknown>), { key, place: ['reports', 'links'], name: 'hard.md' });
      const readThrough = await vault((v, a) => v.readProjectFile(a as Record<string, unknown>), { key, place: ['reports', 'links', 'to-outside'], name: 'secret.md' });
      keep({ links, throughLink, readHard, readThrough });
      expect.soft(byName(links)['to-outside']).toMatchObject({ type: 'link', target: outside });
      expect.soft(byName(links)['hard.md']).toMatchObject({ type: 'file', hardlink: true });
      expect.soft(throughLink).toMatchObject({ code: 'link' });
      expect.soft(readHard).toMatchObject({ code: 'link' });
      expect.soft(readThrough).toMatchObject({ code: 'link' });

      // 4. Pages.
      const first = await place(['briefs', 'many']);
      const next = await place(['briefs', 'many'], { offset: 200 });
      keep({ firstPage: 'entries' in first ? { ...first, entries: first.entries.slice(0, 3) } : first, nextPage: next });
      expect.soft(first).toMatchObject({ total: 230, offset: 0, more: 30 });
      expect.soft('entries' in first ? [first.entries.length, first.entries[0].name] : null).toEqual([200, 'b229.md']);
      expect.soft('entries' in next ? [next.entries.length, next.entries[0].name] : null).toEqual([30, 'b029.md']);
      expect.soft(next).not.toHaveProperty('more');

      // 5. A folder nobody can read.
      if (posix && process.getuid?.() !== 0) {
        const reports = await place(['reports']);
        const lockedList = await place(['reports', 'locked']);
        keep({ reports, lockedList });
        expect.soft(byName(reports).locked).toMatchObject({ type: 'folder', error: 'EACCES' });
        expect.soft(lockedList).toMatchObject({ code: 'unreadable', errno: 'EACCES' });
      }

      // 6. A nested file read and written by its place; `..` refused; today's form still reads.
      const nested = ['missions', 'm1', 'reports'];
      const read = await vault((v, a) => v.readProjectFile(a as Record<string, unknown>), { key, place: nested, name: 'r.md' });
      const written = await vault((v, a) => v.writeProjectFile(a as Record<string, unknown>), { key, place: nested, name: 'from-window.md', text: '# from the window\n', mtimeSeen: null });
      const escape = await vault((v, a) => v.writeProjectFile(a as Record<string, unknown>), { key, place: ['..'], name: 'escape.md', text: 'x', mtimeSeen: null });
      const today = await vault((v, a) => v.readProjectFile(a as Record<string, unknown>), { key, sub: 'reports', name: 'release.md' });
      const writtenFile = path.join(folder, ...nested, 'from-window.md');
      const mode = fs.existsSync(writtenFile) ? fs.statSync(writtenFile).mode & 0o777 : null;
      keep({ read, written, escape, today, mode });
      expect.soft(read).toMatchObject({ text: '# Mission report\n', editable: true });
      expect.soft(written).toMatchObject({ ok: true });
      expect.soft(fs.existsSync(writtenFile) ? fs.readFileSync(writtenFile, 'utf8') : null).toBe('# from the window\n');
      if (posix) expect.soft(mode).toBe(0o600);
      expect.soft(escape).toHaveProperty('error');
      expect.soft(fs.existsSync(path.join(dir, 'project-files', 'escape.md'))).toBe(false);
      expect.soft(today).toMatchObject({ text: '# Release\n' });
      expect.soft(JSON.stringify(values)).not.toContain('E2E OUTSIDE SECRET');

      // 7. What an agent writes, said by the folder it is in; nothing for node_modules.
      await page.evaluate(() => {
        const w = window as unknown as Api & { __changed: Change[] };
        w.__changed = [];
        w.electronAPI.vault.onProjectFilesChanged((e) => w.__changed.push(e));
      });
      fs.writeFileSync(path.join(folder, 'reports', 'overnight', 'wt', 'w1', 'node_modules', 'pkg', 'index.js'), 'module.exports = 2');
      fs.writeFileSync(path.join(folder, ...nested, 'by-agent.md'), '# by an agent');
      const changed = () => page.evaluate(() => (window as unknown as { __changed: Change[] }).__changed);
      await expect.poll(changed, { timeout: 10_000 }).toContainEqual({ key, place: nested });
      await page.waitForTimeout(800);
      const events = await changed();
      keep({ events });
      expect.soft(events.filter((e) => e.place.includes('node_modules')), 'a write in node_modules said').toEqual([]);
      await stepShot(page, newInterface ? 'vault-tree-new-interface' : 'vault-tree');
    } finally {
      await app.close().catch(() => undefined);
      if (posix && lockedDir && fs.existsSync(lockedDir)) fs.chmodSync(lockedDir, 0o700);
      await removeHome(home);
    }
  });
}
