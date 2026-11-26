import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Review, every repository of every project (2.0.4, the frames "Review · projects and their repositories" of #457,
 * the Audit's requirements for 2.0.4, section 2), driven from the real window over the channels the page uses.
 *
 * The real app on a sandbox HOME with three projects: `meridian`, holding repositories at three depths (one 9 folders
 * down), one inside node_modules and a link to the home, which are not repositories of it; `field-notes`, with no git;
 * `old-shop`, a folder gone.
 *
 * Asserted:
 * 1. review.repositories(meridian) answers a scan id, and its events say each repository as it is found, its branch,
 *    its changed files and how far ahead of main, then done with the state `repositories`; node_modules and the link
 *    bring nothing; asked again, the scan is kept;
 * 2. field-notes is `no-git`, old-shop is `gone`, each said once, with no error;
 * 3. review.search finds a repository by its name and a changed file by its path, in every project, every result
 *    (1,200 changed files match), case aside;
 * 4. review.diff refuses a path Tars did not find (the home), and reads a repository it found.
 * Red on main (e7b38a23): there are no such channels, and review.diff reads any path it is given.
 * The artefact: values.json (every answer and event), a screenshot of the Review page, the app's trace with E2E_TRACE=on.
 */

type Api = { electronAPI: { review: {
  repositories(p: string, o?: { refresh?: boolean }): Promise<Record<string, unknown>>;
  search(q: string): Promise<Record<string, unknown>>;
  diff(p: string, b?: string, o?: { listOnly?: boolean }): Promise<Record<string, unknown>>;
  onRepositoriesEvent(cb: (e: Record<string, unknown>) => void): () => void;
  onSearchEvent(cb: (e: Record<string, unknown>) => void): () => void;
} } };

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
function repo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

test(`review finds every repository of a project, and searches them all`, async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-review-repos-'));
  const dir = path.join(home, '.tars');
  const meridian = path.join(home, 'projects', 'meridian');
  const fieldNotes = path.join(home, 'projects', 'field-notes');
  const oldShop = path.join(home, 'projects', 'old-shop');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(fieldNotes, { recursive: true });
  fs.writeFileSync(path.join(fieldNotes, 'notes.txt'), 'no git here');
  const contracts = repo(path.join(meridian, 'contracts'));
  const sdk = repo(path.join(meridian, 'sdk-js'));
  const deep = repo(path.join(meridian, 'services', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'indexer'));
  repo(path.join(meridian, 'node_modules', 'pkg'));
  repo(path.join(home, 'outside', 'not-meridian'));
  fs.symlinkSync(path.join(home, 'outside'), path.join(meridian, 'link-to-outside'));
  git(sdk, 'checkout', '-q', '-b', 'feat/indexer');
  fs.mkdirSync(path.join(sdk, 'src', 'indexer'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'src', 'indexer', 'client.ts'), 'export {};\n');
  git(sdk, 'add', '-A');
  git(sdk, 'commit', '-q', '-m', 'client');
  fs.writeFileSync(path.join(sdk, 'src', 'indexer', 'client.ts'), 'export const a = 1;\n');
  for (let i = 0; i < 1200; i++) fs.writeFileSync(path.join(contracts, `client-gen-${i}.ts`), 'x\n');
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([meridian, fieldNotes, oldShop]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const port = apiPort(31405);
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    // The channels are driven from Settings: the Review page scans every project as it opens (#488), and a
    // project it scanned first is answered kept, with no scan id, where step 1 and 2 wait for a scan's events.
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(1, { timeout: 30_000 });
    await page.evaluate(() => {
      const w = window as unknown as Api & { __repoEvents: unknown[]; __searchEvents: unknown[] };
      w.__repoEvents = [];
      w.__searchEvents = [];
      w.electronAPI.review.onRepositoriesEvent((e) => w.__repoEvents.push(e));
      w.electronAPI.review.onSearchEvent((e) => w.__searchEvents.push(e));
    });
    const review = <T>(fn: (r: Api['electronAPI']['review'], arg: unknown) => Promise<T>, arg?: unknown) =>
      page.evaluate(([src, a]) => (new Function('r', 'arg', `return (${src})(r, arg)`))((window as unknown as Api).electronAPI.review, a), [fn.toString(), arg] as const) as Promise<T>;
    type Ev = Record<string, unknown>;
    const events = (key: '__repoEvents' | '__searchEvents') => page.evaluate((k) => (window as unknown as Record<string, unknown[]>)[k], key) as Promise<Ev[]>;
    const doneFor = async (id: string, key: '__repoEvents' | '__searchEvents', idKey: 'scanId' | 'searchId') => {
      await expect.poll(async () => (await events(key)).some((e) => e[idKey] === id && e.kind === 'done'), { timeout: 60_000 }).toBe(true);
      return (await events(key)).filter((e) => e[idKey] === id);
    };

    // 1. meridian, scanned: each repository as it is found, then done.
    const started = await review((r, p) => r.repositories(p as string), meridian);
    const meridianEvents = await doneFor(String(started.scanId), '__repoEvents', 'scanId');
    const found = meridianEvents.filter((e) => e.kind === 'found').map((e) => e.repo as string);
    const states = meridianEvents.filter((e) => e.kind === 'repository').map((e) => e.repository as Ev);
    const done = meridianEvents.find((e) => e.kind === 'done')!;
    const again = await review((r, p) => r.repositories(p as string), meridian);
    keep({ started, found, states: states.map((s) => ({ path: s.path, branch: s.branch, ahead: s.ahead, changed: (s.changed as unknown[]).length })), done, againKept: !!again.cached && !again.scanId });
    expect.soft(found.sort()).toEqual([contracts, deep, sdk].sort());
    expect.soft(done.state).toBe('repositories');
    const sdkState = states.find((s) => s.path === sdk);
    expect.soft(sdkState).toMatchObject({ branch: 'feat/indexer', base: 'main', ahead: 1 });
    expect.soft((sdkState?.changed as Array<{ file: string }> | undefined)?.map((c) => c.file)).toEqual(['src/indexer/client.ts']);
    expect.soft(again.cached && !again.scanId, 'kept, not scanned again').toBe(true);

    // 2. No git, gone.
    const fn = await review((r, p) => r.repositories(p as string), fieldNotes);
    const os2 = await review((r, p) => r.repositories(p as string), oldShop);
    const fnDone = (await doneFor(String(fn.scanId), '__repoEvents', 'scanId')).find((e) => e.kind === 'done')!;
    const osDone = (await doneFor(String(os2.scanId), '__repoEvents', 'scanId')).find((e) => e.kind === 'done')!;
    keep({ fieldNotes: fnDone, oldShop: osDone });
    expect.soft(fnDone).toMatchObject({ state: 'no-git' });
    expect.soft(osDone).toMatchObject({ state: 'gone' });
    expect.soft(fnDone.error ?? osDone.error).toBeUndefined();

    // 3. Search: a name, every changed file, case aside.
    const s1 = await review((r, q) => r.search(q as string), 'SDK-JS');
    const s1Events = await doneFor(String(s1.searchId), '__searchEvents', 'searchId');
    const s2 = await review((r, q) => r.search(q as string), 'Client');
    const s2Events = await doneFor(String(s2.searchId), '__searchEvents', 'searchId');
    const s2Files = s2Events.filter((e) => e.kind === 'batch').flatMap((e) => (e.groups as Array<{ files: string[] }>).flatMap((g) => g.files));
    keep({ s1: s1Events.find((e) => e.kind === 'done'), s2: s2Events.find((e) => e.kind === 'done'), s2Count: s2Files.length });
    expect.soft(s1Events.filter((e) => e.kind === 'batch').flatMap((e) => (e.groups as Array<{ repo: string; nameMatch: boolean }>)).find((g) => g.repo === sdk)?.nameMatch).toBe(true);
    expect.soft(s2Files.filter((f) => f.startsWith('client-gen-')).length).toBe(1200);
    expect.soft(s2Files).toContain('src/indexer/client.ts');
    expect.soft(s2Events.find((e) => e.kind === 'done')?.total).toBe(1201);

    // 4. Only what Tars found.
    const outside = await review((r, p) => r.diff(p as string, undefined, { listOnly: true }), home);
    const inside = await review((r, p) => r.diff(p as string, undefined, { listOnly: true }), sdk);
    keep({ outside, insideOk: inside.success });
    expect.soft(outside).toMatchObject({ success: false });
    expect.soft(inside.success).toBe(true);

    await page.goto(`${DEV_URL}/review`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await stepShot(page, 'review-new-interface');
  } finally {
    await app.close().catch(() => undefined);
    await removeHome(home);
  }
});
