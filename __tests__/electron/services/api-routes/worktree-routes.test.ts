import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The worktree tools' routes (2.0.7, W6 of the fresh-install report): /api/worktrees, for worktree_new,
 * worktree_list, worktree_remove and worktree_prune. On a real repository; the fleet is the only thing stood in.
 *
 * How it fails, written before the code (2026-11-10):
 * WR1. A caller that is no agent (the shared token, Tars's own pass) makes or removes a worktree: refused, 403.
 * WR2. The project is taken from the request (a projectPath in the body): an agent makes worktrees in another
 *      project's repository. It is the caller's own project, always.
 * WR3. A remove or a prune takes a worktree an agent of the project runs in (its worktreePath): kept, and said so.
 * WR4. A refusal of the service reaches the caller as a success, or without its code.
 * WR5. (The Audit's L2 on #585) a worktree an agent's terminal was started in (its ptyCwd), a task worktree no
 *      agent's worktreePath names, is removed from under it.
 */

vi.setConfig({ testTimeout: 60_000 });
const { fleet } = vi.hoisted(() => ({ fleet: new Map<string, Record<string, unknown>>() }));
vi.mock('../../../../electron/core/agent-manager', () => ({ agents: fleet }));

import { registerWorktreeRoutes } from '../../../../electron/services/api-routes/worktree-routes';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-worktree-routes-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

let n = 0;
function repo(): string {
  const dir = path.join(root, `r${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'a');
  return dir;
}

type Answer = { body: Record<string, unknown>; status: number };
async function call(method: 'GET' | 'POST', url: string, body: Record<string, unknown>, callerAgentId?: string): Promise<Answer> {
  const routes: Array<{ method: string; pattern: string; handler: (...x: unknown[]) => unknown }> = [];
  registerWorktreeRoutes({
    get: (p: string, h: never) => routes.push({ method: 'GET', pattern: p, handler: h }),
    post: (p: string, h: never) => routes.push({ method: 'POST', pattern: p, handler: h }),
  } as never);
  const route = routes.find(r => r.method === method && r.pattern === url)!;
  let answer: Answer = { body: {}, status: 0 };
  await route.handler({ body, callerAgentId, params: {}, headers: {}, url: new URL(`http://localhost${url}`) }, (b: Record<string, unknown>, s?: number) => { answer = { body: b, status: s ?? 200 }; });
  return answer;
}

let mine: string;
let theirs: string;
beforeEach(() => {
  fleet.clear();
  mine = repo();
  theirs = repo();
  fleet.set('w', { id: 'w', name: 'Worker', role: 'worker', projectPath: mine });
});

describe('the worktree routes', () => {
  it('WR1. refuse a caller that is no agent', async () => {
    expect((await call('POST', '/api/worktrees', { branch: 'feat/x' })).status).toBe(403);
    expect((await call('GET', '/api/worktrees', {})).status).toBe(403);
    expect(fs.existsSync(path.join(mine, '.worktrees'))).toBe(false);
  });

  it('WR2. make it in the caller\'s own project, whatever the body names', async () => {
    const a = await call('POST', '/api/worktrees', { branch: 'feat/x', projectPath: theirs }, 'w');
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(fs.realpathSync(String(a.body.path))).toBe(fs.realpathSync(path.join(mine, '.worktrees', 'feat', 'x')));
    expect(fs.existsSync(path.join(theirs, '.worktrees'))).toBe(false);
    const listed = await call('GET', '/api/worktrees', {}, 'w');
    expect((listed.body.worktrees as Array<{ branch: string }>).map(w => w.branch)).toEqual(['feat/x']);
  });

  it('WR3. keep the worktree an agent of the project runs in, on a remove and on a prune', async () => {
    const made = await call('POST', '/api/worktrees', { branch: 'feat/agent' }, 'w');
    fleet.set('dev', { id: 'dev', name: 'Dev', role: 'worker', projectPath: mine, worktreePath: made.body.path });
    const removed = await call('POST', '/api/worktrees/remove', { branch: 'feat/agent' }, 'w');
    expect(removed).toMatchObject({ status: 409, body: { code: 'in_use' } });
    const pruned = await call('POST', '/api/worktrees/prune', { dryRun: true }, 'w');
    expect(pruned.body.removed).toEqual([]);
    expect(fs.existsSync(String(made.body.path))).toBe(true);
  });

  it('WR5. keep a task worktree an agent\'s terminal was started in', async () => {
    const made = await call('POST', '/api/worktrees', { branch: 'feat/task' }, 'w');
    fleet.set('qa', { id: 'qa', name: 'QA', role: 'worker', projectPath: mine, ptyCwd: made.body.path });
    expect(await call('POST', '/api/worktrees/remove', { branch: 'feat/task' }, 'w')).toMatchObject({ status: 409, body: { code: 'in_use' } });
    expect(fs.existsSync(String(made.body.path))).toBe(true);
  });

  it('WR4. say the service\'s refusal with its code', async () => {
    const bad = await call('POST', '/api/worktrees', { branch: '../escape' }, 'w');
    expect(bad).toMatchObject({ status: 400, body: { code: 'invalid_branch' } });
    const none = await call('POST', '/api/worktrees/remove', { branch: 'feat/none' }, 'w');
    expect(none).toMatchObject({ status: 404, body: { code: 'not_found' } });
  });
});
