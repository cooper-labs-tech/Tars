import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent's cleanup request, approved by the owner in one click in Resources, Disk (#606, on the disk hygiene of
 * its base branch), and what agents leave behind, shown there. A sandbox HOME, as the base's own spec seeds it: the
 * project harbor with an idle worktree (its release/, electron-builder's, and its node_modules, untouched for 10 days)
 * and an active one; a worker `live` whose temporary folders hold an ended session's scratchpad and old and fresh
 * entries. Harbor's orchestrator asks for the cleanup over the API with its own token, as its MCP server does.
 *
 * How it can fail, written before it ran (QA, 19/11):
 * 1. Resources, Disk, does not show the request under ASKED BY AGENTS: who asked, how much, in which project, its
 *    items, and one button to approve it.
 * 2. Something is deleted before the click: by the request, by the periodic report (every 3 s here) or by showing it.
 * 3. The click does not delete exactly the requested items, or the request does not then say it was approved by the
 *    owner and what it freed; anything not asked for (fresh entries, the active worktree's) goes.
 * 4. What agents leave does not show the project's worktrees with their agent, or the agent's temporary files.
 * 5. An uncaught error in the page.
 * In the classic shell and in the new interface's.
 * Red on the base's head (feat/disk-hygiene-report, 737f5943b), which has no ASKED BY AGENTS: 1 finds no request.
 * The artefact: values.json (the scan's items, the request as shown, what stayed and what went), step screenshots.
 */

const DAY = 86_400_000;
type Item = { id: string; kind: string; path?: string; label: string };
type Api = { electronAPI: { diskJanitor: { state(): Promise<{ deleting: unknown; cleanupRequests?: Array<{ id: string; ids: string[]; state?: string; by?: string }> }> } } };
const shortIdOf = (id: string) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 10);
function age(dir: string, days: number): void {
  const t = new Date(Date.now() - days * DAY);
  const walk = (p: string) => {
    const st = fs.lstatSync(p);
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
    if (!st.isSymbolicLink()) fs.utimesSync(p, t, t);
  };
  walk(dir);
}
function filled(dir: string, days: number, kb = 64): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.bin'), Buffer.alloc(kb * 1024, 1));
  age(dir, days);
  return dir;
}
/** A release/ as electron-builder leaves it: its builder-debug.yml and its update manifest inside. */
function built(dir: string, days: number, kb = 64): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'App-1.0.0-arm64.dmg'), Buffer.alloc(kb * 1024, 1));
  fs.writeFileSync(path.join(dir, 'builder-debug.yml'), 'x: 1\n');
  fs.writeFileSync(path.join(dir, 'latest-mac.yml'), 'version: 1\n');
  age(dir, days);
  return dir;
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
function repo(at: string, worktrees: string[]): void {
  fs.mkdirSync(at, { recursive: true });
  git(at, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(at, '.gitignore'), '.worktrees/\nnode_modules/\nrelease/\n');
  fs.writeFileSync(path.join(at, 'README.md'), 'x\n');
  git(at, 'add', '.');
  git(at, 'commit', '-q', '-m', 'one');
  for (const n of worktrees) git(at, 'worktree', 'add', '-q', '-b', `b/${n}`, path.join(at, '.worktrees', n));
}

test.skip(process.platform === 'win32', 'the Docker stand-in is a POSIX script');

for (const newInterface of [false, true]) {
  test(`an agent's cleanup request approved in one click in Resources, Disk, nothing deleted before it, and what agents leave shown${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(5 * 60_000);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-disk-window-')));
    const harbor = path.join(home, 'projects', 'harbor');
    const wt = (n: string) => path.join(harbor, '.worktrees', n);
    repo(harbor, ['idle', 'active']);
    const idleModules = filled(path.join(wt('idle'), 'node_modules', 'left-pad'), 10);
    const idleRelease = built(path.join(wt('idle'), 'release'), 10, 256);
    age(wt('idle'), 10);
    const activeModules = filled(path.join(wt('active'), 'node_modules', 'left-pad'), 0);
    const activeRelease = built(path.join(wt('active'), 'release'), 0);
    const tmp = path.join(home, '.tars', 'tmp', shortIdOf('live'));
    const sessions = path.join(tmp, 'c', `claude-${process.getuid?.() ?? 501}`, harbor.replace(/[^a-zA-Z0-9]/g, '-'));
    const ended = filled(path.join(sessions, 'sess-old', 'scratchpad', 'out-run'), 10, 512);
    age(path.join(sessions, 'sess-old'), 10);
    const oldOut = filled(path.join(sessions, 'sess-now', 'scratchpad', 'out-old'), 10, 512);
    const newOut = filled(path.join(sessions, 'sess-now', 'scratchpad', 'out-new'), 0, 128);
    const oldTmp = filled(path.join(tmp, 't', 'traces'), 10, 256);
    const newTmp = filled(path.join(tmp, 't', 'node-compile-cache'), 0, 64);
    // Docker and Colima as stand-ins that answer at once: the scan's own speed is the base's spec.
    const docker = path.join(home, 'fake-docker');
    fs.writeFileSync(docker, ['#!/bin/sh', 'case "$1 $2" in', '  "image ls") printf "" ;;', '  "ps -a") printf "" ;;', '  *) exit 1 ;;', 'esac', ''].join('\n'), { mode: 0o755 });
    const colima = path.join(home, 'fake-colima');
    fs.writeFileSync(colima, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const dir = path.join(home, '.tars');
    const agent = (id: string, name: string, role: string, more: Record<string, unknown> = {}) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, projectPath: harbor, skills: [],
      createdAt: '2026-11-01T08:00:00.000Z', lastActivity: '2026-11-01T08:00:00.000Z', ...more,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent('lead', 'Harbor Lead', 'orchestrator'),
      agent('live', 'Harbor Worker', 'worker', { worktreePath: wt('active'), currentSessionId: 'sess-now' }),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([harbor]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const port = apiPort(newInterface ? 31949 : 31948);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const tag = newInterface ? 'new-' : '';
    const errors: string[] = [];
    let app: ElectronApplication | undefined;
    try {
      app = await launchSandboxed(electron, home, {
        env: {
          NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1',
          DOROTHY_DOCKER_BIN: docker, DOROTHY_COLIMA_BIN: colima, DOROTHY_HEALTH_EVERY_MS: '500', DOROTHY_DISK_REPORT_EVERY_MS: '3000',
        },
      });
      const page: Page = await app.firstWindow();
      listenForErrors(page, errors);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, undefined, { timeout: 60_000 });
      const state = () => page.evaluate(() => (window as unknown as Api).electronAPI.diskJanitor.state());
      const token = await app.evaluate((_e, { dist }) => process.mainModule!.require(`${dist}/core/agent-tokens.js`).mintAgentToken('lead') as string, { dist });
      const api = async (method: string, route: string, body?: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}${route}`, {
          method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000),
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
      };

      // The scan, then Harbor Lead's request for four of its items.
      let scanned = await api('GET', '/api/janitor/scan?wait=30');
      for (const end = Date.now() + 180_000; Date.now() < end && scanned.body.running !== false;) scanned = await api('GET', '/api/janitor/scan?wait=30');
      const items = (scanned.body.items ?? []) as Item[];
      const at = (p: string) => items.find(i => i.path === p);
      const wanted = [at(path.dirname(path.dirname(ended))), at(oldOut), at(oldTmp), at(idleRelease)].filter(Boolean).map(i => i!.id);
      const asked = await api('POST', '/api/janitor/request', { ids: wanted, why: 'free disk under 15 GB' });
      keep({ items, wanted, asked });
      expect(wanted, 'the four items the scan proposes').toHaveLength(4);
      expect(asked.status, `the request: ${JSON.stringify(asked.body)}`).toBe(200);

      // 1, 2. Resources, Disk: the request, and nothing deleted before the click.
      await page.goto(`${DEV_URL}/resources?view=disk`, { waitUntil: 'domcontentloaded' });
      const request = page.locator('[data-cleanup-request]').first();
      await expect(request).toBeVisible({ timeout: 60_000 });
      await expect(request).toContainText('Harbor Lead asks to free', { timeout: 15_000 });
      const approve = request.getByRole('button', { name: /^Approve, delete / });
      await expect(approve).toBeVisible();
      const shown = { state: await request.getAttribute('data-cleanup-request'), text: await request.innerText(), items: await request.locator('[data-request-item]').count() };
      await stepShot(page, `${tag}1-asked`);
      await page.waitForTimeout(7_000);
      const requestedPaths = [ended, oldOut, oldTmp, idleRelease];
      const beforeClick = Object.fromEntries(requestedPaths.map(p => [path.relative(home, p), fs.existsSync(p)]));
      keep({ shown, beforeClick });
      expect.soft(shown.text, 'the request: who, in which project').toMatch(/Harbor Lead asks to free [\s\S]+ in harbor/);
      expect.soft(shown.items, 'its items').toBe(4);
      expect.soft(Object.values(beforeClick).every(Boolean), 'something deleted before the click').toBe(true);

      // 3. One click.
      await approve.click();
      await expect.poll(async () => (await state()).deleting, { timeout: 120_000 }).toBeNull();
      const approvedRow = page.locator('[data-cleanup-request]').first();
      await expect(approvedRow).toHaveAttribute('data-cleanup-request', 'approved', { timeout: 30_000 });
      const afterClick = Object.fromEntries(requestedPaths.map(p => [path.relative(home, p), fs.existsSync(p)]));
      const notAsked = [newOut, newTmp, activeModules, activeRelease, idleModules];
      const kept = Object.fromEntries(notAsked.map(p => [path.relative(home, p), fs.existsSync(p)]));
      const outcomes = ((await page.evaluate(() => (window as unknown as { electronAPI: { diskJanitor: { state(): Promise<{ scan?: { items?: Array<{ id: string; outcome?: unknown }> } }> } } }).electronAPI.diskJanitor.state())).scan?.items ?? [])
        .filter(i => wanted.includes(i.id)).map(i => ({ id: i.id, outcome: i.outcome ?? null }));
      await page.waitForTimeout(2_000);
      const requestAfter = await approvedRow.innerText();
      await stepShot(page, `${tag}2-approved`);
      keep({ afterClick, kept, outcomes, requestAfter });
      expect(Object.values(afterClick).every(e => !e), 'the requested items gone').toBe(true);
      expect(Object.values(kept).every(Boolean), 'something not asked for gone').toBe(true);
      // An approved request says what it freed (the PR: "An approved request says what was freed and what was kept").
      expect.soft(requestAfter, 'the approved request says what it freed').toMatch(/approved by you at \d\d:\d\d · \S+ \S*B freed/);

      // 4. What agents leave, the Disk view's second half: the project's worktrees with their agent, the agent's
      // temporary files.
      await page.getByRole('radio', { name: 'What agents leave', exact: true }).click({ timeout: 15_000 });
      const project = page.locator('[data-report-project="harbor"]');
      await expect(project).toBeVisible({ timeout: 30_000 });
      const left = await project.innerText();
      keep({ left });
      expect.soft(left, "the active worktree's agent").toContain('Harbor Worker');
      expect.soft(left, 'the idle worktree').toMatch(/idle|b\/idle/);
      await expect(page.getByText('Harbor Worker', { exact: true }).first()).toBeVisible();

      // 5.
      keep({ errors });
      expect(errors).toEqual([]);
    } finally {
      await app?.close().catch(() => {});
      await removeHome(home);
    }
  });
}
