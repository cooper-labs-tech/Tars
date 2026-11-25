import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Disk hygiene (2.0.7): what agents leave behind, reported per project and per agent, proposed by the janitor, asked
 * for by an agent and approved by the owner in one click; and disk_scan answering under load. An orchestrator that
 * runs many agents on the owner's Mac reported on 19/11: disk_scan timed out after 30 s, so it deleted 4.6 GB of .next
 * by hand. Measured that night: a replay of the janitor's own scan took 57 s at a load of 20 (38.8 s of it walking the
 * npx cache), and the agents' temporary folders held 5.4 GB, 3 GB of it old outputs in their sessions' scratchpads,
 * which no rule proposed.
 *
 * A sandbox HOME: the project harbor with an idle worktree (its node_modules and release/ untouched for 10 days) and an
 * active one; a second project, quay; a worker `live` whose temporary folders hold an ended session's scratchpad, old
 * and fresh entries of its current session's scratchpad, and old and fresh entries of its TMPDIR; Docker as a
 * stand-in whose `image ls` takes 40 s, so a scan outlasts the 30 s an MCP call waits.
 * Asserted, once with the classic shell and once with the new interface:
 * 1. GET /api/janitor/scan?wait=2 answers within 10 s while the scan runs, saying so (red on the 2.0.7 train: it
 *    answers when the whole scan has ended, past 40 s);
 * 2. once the scan ends, the project's orchestrator gets the new items of its project: the ended session's
 *    scratchpad, the old entries of the agent's temporary folders, the idle worktree's release/ and node_modules;
 *    never a fresh entry, nor anything of the active worktree, nor the other project's (red: none of these kinds);
 * 3. GET /api/disk/report gives, for its project, each worktree with its agent and what its caches take, each agent
 *    with what its temporary folders take, the item ids, and the machine's free disk and swap (red: 404);
 * 4. POST /api/janitor/request records a cleanup request the window shows, deletes nothing, and refuses an id of
 *    another project (red: 404);
 * 5. one click in the window (diskJanitor.approveRequest) deletes exactly the requested items, each checked again,
 *    and the approval of four items with the slow Docker takes well under the four whole scans it took (red: no such
 *    channel);
 * 6. the periodic report is made with no one asking (DOROTHY_DISK_REPORT_EVERY_MS), and deletes nothing;
 * 7. (the Audit's M1 on #605) a release/ is proposed only as electron-builder's output, on its evidence: its marker
 *    (builder-debug.yml), git ignoring it; the project's own release/, committed, holding no marker, never.
 * The artefact: values.json (every answer, the timings, what stayed and what went).
 */

const DAY = 86_400_000;
type Item = { id: string; kind: string; path: string; label: string; bytes: number | null; outcome?: { kind: string; why?: string | null } | null };
type Report = {
  at: number;
  machine: { diskFreeBytes: number | null; swapUsedMb: number | null; swapGrowthMbPerMin: number | null };
  projects: Array<{ project: string; worktrees: Array<{ path: string; agent: string | null; bytes: Record<string, number | null>; itemIds: string[] }> }>;
  agents: Array<{ id: string; name: string; tmpBytes: number; itemIds: string[] }>;
};
type State = {
  scan: null | { running: boolean; askedBy: string | null; items: Item[] };
  deleting: unknown;
  cleanupRequests?: Array<{
    id: string; by: string; project: string; ids: string[]; bytes: number; why: string; state: string; freedBytes?: number;
    items?: Array<{ id: string; outcome?: { kind: string; bytes?: number | null; why?: string | null } | null }>;
  }>;
  report?: Report | null;
};
type Api = { electronAPI: { diskJanitor: {
  state(): Promise<State>;
  approveRequest(id: string): Promise<{ success: boolean; error?: string }>;
} } };

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
  test(`what agents leave behind is reported, proposed, asked for and approved in one click, and disk_scan answers under load${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(420_000);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-hygiene-${newInterface ? 'ni' : 'classic'}-`)));
    const harbor = path.join(home, 'projects', 'harbor');
    const quay = path.join(home, 'projects', 'quay');
    const wt = (p: string, n: string) => path.join(p, '.worktrees', n);
    repo(harbor, ['idle', 'active']);
    repo(quay, ['old']);
    filled(path.join(wt(harbor, 'idle'), 'node_modules', 'left-pad'), 10);
    built(path.join(wt(harbor, 'idle'), 'release'), 10, 256);
    age(wt(harbor, 'idle'), 10);
    filled(path.join(wt(harbor, 'active'), 'node_modules', 'left-pad'), 0);
    built(path.join(wt(harbor, 'active'), 'release'), 0);
    built(path.join(wt(quay, 'old'), 'release'), 10);
    // The project's own release/: committed notes, no builder's marker (the Audit's M1 on #605).
    const ownRelease = path.join(harbor, 'release');
    fs.mkdirSync(ownRelease, { recursive: true });
    fs.writeFileSync(path.join(ownRelease, 'NOTES.md'), 'how we cut a release\n');
    git(harbor, 'add', '-f', 'release/NOTES.md');
    git(harbor, 'commit', '-q', '-m', 'release notes');
    age(ownRelease, 10);
    age(wt(quay, 'old'), 10);
    // The worker's temporary folders, as Tars hands them (services/agent-tmp.ts): t is its TMPDIR, c Claude Code's.
    const tmp = path.join(home, '.tars', 'tmp', shortIdOf('live'));
    const sessions = path.join(tmp, 'c', `claude-${process.getuid?.() ?? 501}`, harbor.replace(/[^a-zA-Z0-9]/g, '-'));
    const ended = filled(path.join(sessions, 'sess-old', 'scratchpad', 'out-run'), 10, 512);
    age(path.join(sessions, 'sess-old'), 10);
    const oldOut = filled(path.join(sessions, 'sess-now', 'scratchpad', 'out-old'), 10, 512);
    const newOut = filled(path.join(sessions, 'sess-now', 'scratchpad', 'out-new'), 0, 128);
    const oldTmp = filled(path.join(tmp, 't', 'traces'), 10, 256);
    const newTmp = filled(path.join(tmp, 't', 'node-compile-cache'), 0, 64);
    const docker = path.join(home, 'fake-docker');
    fs.writeFileSync(docker, ['#!/bin/sh', 'case "$1 $2" in', '  "image ls") sleep 40; printf "" ;;', '  "ps -a") printf "" ;;', '  *) exit 1 ;;', 'esac', ''].join('\n'), { mode: 0o755 });
    const colima = path.join(home, 'fake-colima');
    fs.writeFileSync(colima, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const dir = path.join(home, '.tars');
    const agent = (id: string, name: string, project: string, role: string, more: Record<string, unknown> = {}) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, projectPath: project, skills: [],
      createdAt: '2026-11-01T08:00:00.000Z', lastActivity: '2026-11-01T08:00:00.000Z', ...more,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent('lead', 'Harbor Lead', harbor, 'orchestrator'),
      agent('live', 'Harbor Worker', harbor, 'worker', { worktreePath: wt(harbor, 'active'), currentSessionId: 'sess-now' }),
      agent('quay-lead', 'Quay Lead', quay, 'orchestrator'),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([harbor, quay]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const port = apiPort(newInterface ? 31542 : 31541);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const app = await launchSandboxed(electron, home, {
      env: {
        NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1',
        DOROTHY_DOCKER_BIN: docker, DOROTHY_COLIMA_BIN: colima, DOROTHY_HEALTH_EVERY_MS: '500', DOROTHY_DISK_REPORT_EVERY_MS: '3000',
      },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
      const state = () => page.evaluate(() => (window as unknown as Api).electronAPI.diskJanitor.state());
      const token = await app.evaluate((_e, { dist }) => process.mainModule!.require(`${dist}/core/agent-tokens.js`).mintAgentToken('lead') as string, { dist });
      const api = async (method: string, route: string, body?: unknown, timeoutMs = 120_000) => {
        const started = Date.now();
        const res = await fetch(`http://127.0.0.1:${port}${route}`, {
          method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs),
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: res.status, ms: Date.now() - started, body: await res.json().catch(() => ({})) as Record<string, unknown> };
      };

      // 6 (first half). The periodic report starts a scan with no one asking.
      let periodic: string | null = null;
      for (const end = Date.now() + 30_000; Date.now() < end && !periodic; await page.waitForTimeout(500)) periodic = (await state()).scan?.askedBy ?? null;
      keep({ periodicScan: periodic });
      expect.soft(periodic).toMatch(/^Tars/);

      // 1. Asked while the scan runs, it answers within its wait, saying so.
      const first = await api('GET', '/api/janitor/scan?wait=2', undefined, 15_000).catch((err) => ({ status: 0, ms: 15_000, body: { error: String(err) } }));
      keep({ first });
      expect.soft(first.ms).toBeLessThan(10_000);
      expect.soft(first.body.running).toBe(true);

      // 2. Once it ends, the project's new items.
      let scanned = first;
      for (const end = Date.now() + 240_000; Date.now() < end && scanned.body.running !== false;) scanned = await api('GET', '/api/janitor/scan?wait=30');
      const items = (scanned.body.items ?? []) as Array<{ id: string; kind: string; path?: string; label: string; sizeBytes: number }>;
      keep({ scanned: { ms: scanned.ms, running: scanned.body.running, items } });
      const at = (p: string) => items.find(i => i.path === p);
      expect.soft(at(path.dirname(path.dirname(ended)))?.kind).toBe('session-scratchpad');
      expect.soft(at(oldOut)?.kind).toBe('agent-tmp-entry');
      expect.soft(at(oldTmp)?.kind).toBe('agent-tmp-entry');
      expect.soft(at(path.join(wt(harbor, 'idle'), 'release'))?.kind).toBe('release-folder');
      expect.soft(at(path.join(wt(harbor, 'idle'), 'node_modules'))?.kind).toBe('worktree-node-modules');
      for (const never of [newOut, newTmp, ownRelease, path.join(wt(harbor, 'active'), 'release'), path.join(wt(harbor, 'active'), 'node_modules'), path.join(wt(quay, 'old'), 'release')]) {
        expect.soft(at(never), path.relative(home, never)).toBeUndefined();
      }

      // 3. The report, for the lead's project.
      const report = await api('GET', '/api/disk/report?wait=30');
      keep({ report });
      expect.soft(report.status).toBe(200);
      const r = report.body.report as Report | undefined;
      const idleRow = r?.projects.find(p => p.project === harbor)?.worktrees.find(w => w.path === wt(harbor, 'idle'));
      expect.soft(idleRow?.bytes.release ?? 0).toBeGreaterThan(200 * 1024);
      expect.soft(idleRow?.itemIds.length ?? 0).toBeGreaterThanOrEqual(2);
      expect.soft(r?.projects.find(p => p.project === harbor)?.worktrees.find(w => w.path === wt(harbor, 'active'))?.agent).toBe('Harbor Worker');
      expect.soft(r?.projects.some(p => p.project === quay)).toBe(false);
      const liveRow = r?.agents.find(a => a.id === 'live');
      expect.soft(liveRow?.tmpBytes ?? 0).toBeGreaterThan(1024 * 1024);
      expect.soft(liveRow?.itemIds.length ?? 0).toBe(3);
      expect.soft(typeof r?.machine.diskFreeBytes).toBe('number');
      expect.soft(typeof r?.machine.swapUsedMb).toBe('number');

      // 4. A cleanup request: recorded, shown, nothing deleted; another project's id refused.
      const wanted = [at(path.dirname(path.dirname(ended))), at(oldOut), at(oldTmp), at(path.join(wt(harbor, 'idle'), 'release'))].filter(Boolean).map(i => i!.id);
      const quayItems = (((await state()).scan?.items ?? []) as Item[]).filter(i => i.path.startsWith(quay));
      const refused = await api('POST', '/api/janitor/request', { ids: [...wanted, ...quayItems.map(i => i.id)], why: 'free disk under 15 GB' });
      const asked = await api('POST', '/api/janitor/request', { ids: wanted, why: 'free disk under 15 GB' });
      const shown = (await state()).cleanupRequests ?? [];
      keep({ wanted, refused, asked, shown });
      expect.soft(quayItems.length).toBeGreaterThan(0);
      expect.soft(refused.status).toBe(403);
      expect.soft(asked.status).toBe(200);
      expect.soft(shown.find(q => q.id === asked.body.requested)?.ids.sort()).toEqual([...wanted].sort());
      expect.soft(shown.find(q => q.id === asked.body.requested)?.by).toBe('Harbor Lead');
      for (const p of [ended, oldOut, oldTmp]) expect.soft(fs.existsSync(p), `requested, not deleted: ${path.relative(home, p)}`).toBe(true);

      // 5. One click in the window.
      const clickAt = Date.now();
      const click = await page.evaluate(id => (window as unknown as Api).electronAPI.diskJanitor.approveRequest(id), String(asked.body.requested));
      await expect.poll(async () => (await state()).deleting, { timeout: 200_000 }).toBeNull();
      const approvalMs = Date.now() - clickAt;
      const after = await state();
      keep({ click, approvalMs, after: after.scan?.items.filter(i => wanted.includes(i.id)), requestAfter: after.cleanupRequests });
      expect.soft(click).toEqual({ success: true });
      expect.soft(approvalMs).toBeLessThan(120_000);
      for (const gone of [path.dirname(path.dirname(ended)), oldOut, oldTmp, path.join(wt(harbor, 'idle'), 'release')]) {
        expect.soft(fs.existsSync(gone), `approved, deleted: ${path.relative(home, gone)}`).toBe(false);
      }
      for (const stays of [newOut, newTmp, path.join(ownRelease, 'NOTES.md'), path.join(wt(harbor, 'idle'), 'node_modules'), path.join(wt(harbor, 'active'), 'release'), path.join(wt(quay, 'old'), 'release')]) {
        expect.soft(fs.existsSync(stays), `not requested, stays: ${path.relative(home, stays)}`).toBe(true);
      }
      // The request keeps what became of each of its items and what it freed (QA's F2 on #606).
      const approved = after.cleanupRequests?.find(q => q.id === asked.body.requested);
      expect.soft(approved?.state).toBe('approved');
      expect.soft(approved?.items?.map(i => i.outcome?.kind)).toEqual(wanted.map(() => 'deleted'));
      expect.soft(approved?.freedBytes ?? 0).toBe((approved?.items ?? []).reduce((sum, i) => sum + (i.outcome?.bytes ?? 0), 0));
      expect.soft(approved?.freedBytes ?? 0).toBeGreaterThan(200 * 1024);
      // 6 (second half). The periodic report deleted nothing on its own, and the window holds a report.
      expect.soft((await state()).report?.at ?? 0).toBeGreaterThan(0);
    } finally {
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
