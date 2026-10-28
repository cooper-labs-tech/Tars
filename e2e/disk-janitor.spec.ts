import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The disk janitor (2.0.5, lot 3 item H), in the real app on a seeded sandbox, once with the classic shell and once
 * with the new interface: allowed and forbidden items side by side, Docker and colima as stand-ins (DOROTHY_DOCKER_BIN,
 * DOROTHY_COLIMA_BIN, read under DOROTHY_E2E only), so the machine's own Docker is never reached.
 *
 * Asserted:
 * 1. the scan proposes exactly the allowed items: an idle worktree's .next and test results, a merged worktree, an old
 *    npx entry, a gone agent's temporary folder, an unused Docker image, the VM's trim. Never ~/.tars-private,
 *    ~/Documents, the Trash, the uv cache, a worktree with uncommitted work, a fleet agent's worktree, a recent .next,
 *    an image a container uses;
 * 2. a scan deletes nothing;
 * 3. the approved items are deleted, and only they; an approved item a process started working in since the scan is
 *    kept, with why; the Docker image goes by `docker image rm <id>`;
 * 4. each deletion is logged with what it freed.
 * Red on main dc623b594: there is no janitor.
 * The artefact: values.json (the scan, the approval's report, the log).
 */

const DAY = 86_400_000;
type Item = { id: string; kind: string; path?: string; ref?: string; label: string; sizeBytes: number; rule: string };
type Api = { electronAPI: { system: {
  janitorScan(): Promise<{ items: Item[] } | { error: string }>;
  janitorApprove(ids: string[]): Promise<{ removed: number; freedBytes: number; kept: Array<{ id: string; label: string; why: string }> } | { error: string }>;
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
function filled(dir: string, days = 10): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.bin'), Buffer.alloc(64 * 1024, 1));
  age(dir, days);
  return dir;
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

test.skip(process.platform === 'win32', 'the stand-ins of docker and colima are POSIX scripts');

for (const newInterface of [false, true]) {
  test(`the disk janitor proposes only its list, and deletes only what the owner approved${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-janitor-${newInterface ? 'ni' : 'classic'}-`)));
    const project = path.join(home, 'projects', 'harbor');
    const wt = (n: string) => path.join(project, '.worktrees', n);
    fs.mkdirSync(project, { recursive: true });
    git(project, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(project, '.gitignore'), '.worktrees/\n.next/\ntest-results/\nplaywright-report/\n');
    fs.writeFileSync(path.join(project, 'README.md'), 'harbor\n');
    git(project, 'add', '.');
    git(project, 'commit', '-q', '-m', 'one');
    for (const n of ['done', 'dirty', 'agents', 'busy', 'fresh']) git(project, 'worktree', 'add', '-q', '-b', `b/${n}`, wt(n));
    git(project, 'worktree', 'add', '-q', '-b', 'b/open', wt('open'));
    fs.writeFileSync(path.join(wt('open'), 'work.txt'), 'work\n');
    git(wt('open'), 'add', '.');
    git(wt('open'), 'commit', '-q', '-m', 'unmerged work');
    fs.writeFileSync(path.join(wt('dirty'), 'uncommitted.txt'), 'not saved\n');
    for (const n of ['done', 'dirty', 'agents', 'busy', 'open']) { filled(path.join(wt(n), '.next')); filled(path.join(wt(n), 'test-results')); }
    filled(path.join(wt('fresh'), '.next'), 1);
    for (const n of ['done', 'dirty', 'agents', 'busy', 'open']) age(wt(n), 10);
    const tmp = path.join(home, '.tars', 'tmp');
    filled(path.join(tmp, shortIdOf('agent-gone')));
    filled(path.join(tmp, shortIdOf('live')));
    filled(path.join(home, '.npm', '_npx', 'oldhash'), 30);
    filled(path.join(home, '.npm', '_npx', 'newhash'), 3);
    const forbidden = ['.tars-private/x/.next', 'Documents/runs/test-results', '.Trash/x/.next', '.cache/uv/wheels', 'Library/Developer/CoreSimulator/Devices'].map(p => filled(path.join(home, p)));
    // Docker and colima as stand-ins: two images, one a stopped container uses; every call recorded.
    const calls = path.join(home, 'docker-calls.log');
    const docker = path.join(home, 'fake-docker');
    fs.writeFileSync(docker, [
      '#!/bin/sh',
      `echo "docker $*" >> '${calls}'`,
      'case "$1 $2" in',
      '  "image ls") printf "sha256:unused\\told/thing:1\\t2.1GB\\nsha256:used\\tpostgres:16\\t400MB\\n" ;;',
      '  "ps -a") printf "postgres:16\\n" ;;',
      '  "image rm") echo "Deleted: $3" ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });
    const colima = path.join(home, 'fake-colima');
    fs.writeFileSync(colima, ['#!/bin/sh', `echo "colima $*" >> '${calls}'`, 'exit 0', ''].join('\n'), { mode: 0o755 });
    const dir = path.join(home, '.tars');
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
      id: 'live', name: 'Harbor Worker', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
      projectPath: project, worktreePath: wt('agents'), skills: [], createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
    }], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    // A process working in the busy worktree from the start.
    const busy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { cwd: wt('busy'), stdio: 'ignore' });
    let late: ReturnType<typeof spawn> | undefined;
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

    const app = await launchSandboxed(electron, home, {
      env: {
        NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31360 : 31359), DOROTHY_E2E: '1',
        DOROTHY_DOCKER_BIN: docker, DOROTHY_COLIMA_BIN: colima,
      },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      const scan = async () => {
        const r = await page.evaluate(() => (window as unknown as Api).electronAPI.system.janitorScan());
        if ('error' in r) throw new Error(r.error);
        return r.items;
      };
      const key = (i: Item) => `${i.kind} ${i.path ? path.relative(home, i.path) : i.ref}`;

      // 1, 2. Exactly the list, and nothing deleted.
      const items = await scan();
      keep({ scan: items.map(i => ({ ...i, key: key(i) })) });
      expect(items.map(key).sort()).toEqual([
        'agent-tmp .tars/tmp/' + shortIdOf('agent-gone'),
        'closed-worktree projects/harbor/.worktrees/done',
        'docker-image sha256:unused',
        'docker-vm-trim colima',
        'next-cache projects/harbor/.worktrees/done/.next',
        'next-cache projects/harbor/.worktrees/open/.next',
        'npx-cache .npm/_npx/oldhash',
        'test-artefacts projects/harbor/.worktrees/done/test-results',
        'test-artefacts projects/harbor/.worktrees/open/test-results',
      ].sort());
      expect(fs.existsSync(path.join(wt('done'), '.next')), 'a scan deletes nothing').toBe(true);

      // 3. A process starts working in the open worktree after the scan: its .next is kept at the approval.
      late = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { cwd: wt('open'), stdio: 'ignore' });
      await page.waitForTimeout(500);
      const id = (k: string) => items.find(i => key(i) === k)!.id;
      const report = await page.evaluate(ids => (window as unknown as Api).electronAPI.system.janitorApprove(ids), [
        id('closed-worktree projects/harbor/.worktrees/done'), id('npx-cache .npm/_npx/oldhash'),
        id('agent-tmp .tars/tmp/' + shortIdOf('agent-gone')), id('docker-image sha256:unused'),
        id('next-cache projects/harbor/.worktrees/open/.next'),
      ]);
      const log = fs.readFileSync(path.join(home, '.tars', 'logs', 'janitor.log'), 'utf8');
      keep({ report, log, dockerCalls: fs.readFileSync(calls, 'utf8') });
      if ('error' in report) throw new Error(report.error);
      expect(report.removed).toBe(4);
      expect(report.kept.map(k => [k.label, k.why])).toEqual([[expect.stringContaining('open/.next'), expect.stringMatching(/no longer matches/)]]);
      expect(fs.existsSync(wt('done')), 'the merged worktree').toBe(false);
      expect(git(project, 'worktree', 'list')).not.toContain(wt('done'));
      expect(fs.existsSync(path.join(home, '.npm', '_npx', 'oldhash'))).toBe(false);
      expect(fs.existsSync(path.join(tmp, shortIdOf('agent-gone')))).toBe(false);
      expect(fs.readFileSync(calls, 'utf8')).toContain('docker image rm sha256:unused');
      // Only those.
      for (const stays of [path.join(wt('open'), '.next'), path.join(wt('open'), 'test-results'), wt('dirty'), wt('agents'), wt('busy'),
        path.join(wt('fresh'), '.next'), path.join(home, '.npm', '_npx', 'newhash'), path.join(tmp, shortIdOf('live')), ...forbidden]) {
        expect(fs.existsSync(stays), path.relative(home, stays)).toBe(true);
      }
      expect(fs.readFileSync(calls, 'utf8')).not.toContain('postgres');
      // 4. Each deletion logged with what it freed, the kept one with why.
      expect(log.match(/freed \d+ bytes/g)).toHaveLength(4);
      expect(log).toMatch(/kept .*open\/\.next: it no longer matches/);
    } finally {
      for (const p of [busy, late]) if (p?.pid) { try { process.kill(p.pid); } catch { /* gone */ } }
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
