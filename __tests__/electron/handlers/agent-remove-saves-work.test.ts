/**
 * The window's Delete saves an agent's uncommitted work before it removes the
 * agent's worktree (JeanBrasse, 05/10: "deleting an agent first saves its uncommitted
 * work on wip/<name>, without asking"). agent:remove ran
 * `git worktree remove --force`, and whatever was not committed went with it.
 *
 * How it fails:
 * 1. The worktree goes and its uncommitted work with it: no wip/<name>.
 * 2. A save that fails still removes the worktree, so the work it could not
 *    save is lost all the same.
 * 3. The window is not told where the work went, or that a worktree was kept.
 * And from the Audit's gate of #312 (Low): `git add -A` leaves out what
 * .gitignore names, and the forced removal deleted it with no word.
 * 4. A worktree holding ignored files that are not rebuildable caches (a .env,
 *    an e2e run under test-results/) is removed: it must be kept, and the
 *    answer must name what kept it.
 * 5. Over-correction: a worktree whose only ignored files are caches
 *    (node_modules, .next, electron/dist...) is kept.
 * And from QA's gate of #312: a git repository inside the worktree was saved
 * as a pointer to a commit that exists only in its own .git, then lost with
 * the worktree, while the answer named a wip branch.
 * 6. A worktree holding a git repository of its own is removed.
 * And from the same gate (Info, follow-ups of 06/10): a submodule the project
 * commits, checked out in the worktree, keeps its git store in the worktree's
 * own (.git/worktrees/<name>/modules/), which `git worktree remove --force`
 * deletes. Measured: a commit made in it and on no remote is gone after.
 * 7. A worktree whose submodule holds commits no remote has is removed, even
 *    when the worktree has nothing uncommitted (the agent committed the
 *    submodule's new commit as the gitlink): it must be kept, and named.
 * 8. A worktree whose submodule has uncommitted changes is removed.
 * 9. Over-correction: a worktree whose submodules hold nothing their remote
 *    lacks, or were never checked out, is kept.
 * And from the Audit's gate of #335 (bench gate-335/), work no branch holds:
 * 10. A submodule's stash, or a commit only a local tag holds, is lost: only
 *     HEAD and the branches were looked at.
 * 11. A file git ignores inside a submodule (a .env) is lost: the worktree's
 *     ignored files are read by a git status that does not go into it.
 * (12, a submodule that cannot be read, is in save-worktree-work.test.ts: the
 * worktree's own git status fails on it first, and the save keeps it.)
 * And from the Audit's gate of #398 (L1, written before the code, 2026-10-13):
 * `git worktree remove --force` can refuse after the save (a locked worktree, a
 * folder git does not know as a worktree, a permission error), and the removal
 * only logged it.
 * 13. The worktree stays and the answer has neither savedTo nor worktreeKept:
 *     the Agents page and the chat list say nothing of a folder still on disk.
 *     It must say git's reason and where the worktree is, in the shape of the
 *     other reasons ("..., so its worktree was kept at <path>").
 * And from QA's gate of #399 (Low, probes P1 and P2, written before the fix, 2026-10-13):
 * 14. Over-correction: a worktree already gone (removed outside Tars, or moved
 *     then pruned), which git answers "is not a working tree", is announced as
 *     kept at a path where nothing is.
 *
 * The handler and git are the real ones, on a repository in a throwaway folder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { skipOnWindows } from '../../setup/platform-limits';

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-remove-saves-${process.pid}-${Date.now()}`,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.3', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import type { AgentStatus, AppSettings } from '../../../electron/types';

fs.mkdirSync(tmpHome, { recursive: true });

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = { agents, ptyProcesses, saveAgents: vi.fn(), getAppSettings: () => ({} as AppSettings) };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}
registerIpcHandlers(deps());

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A library the project commits as a submodule at vendor/lib, checked out in the worktree when `checkout`. */
function withSubmodule(checkout = true): string {
  const lib = path.join(path.dirname(repo), 'lib');
  fs.mkdirSync(lib);
  git(lib, 'init', '-q', '-b', 'main');
  git(lib, 'config', 'user.email', 't@t.example');
  git(lib, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(lib, 'l.txt'), 'one\n');
  git(lib, 'add', '-A');
  git(lib, 'commit', '-qm', 'lib');
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib');
  git(repo, 'commit', '-qm', 'lib as a submodule');
  git(wt, 'merge', '-q', 'main');
  const sub = path.join(wt, 'vendor', 'lib');
  if (checkout) {
    git(wt, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
    git(sub, 'config', 'user.email', 't@t.example');
    git(sub, 'config', 'user.name', 'T');
  }
  return sub;
}
let repo: string;
let wt: string;

beforeEach(() => {
  repo = path.join(fs.realpathSync(fs.mkdtempSync(path.join(tmpHome, 'repo-'))), 'project');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t.example');
  git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  wt = path.join(repo, '.worktrees', 'feat-x');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/x');
  agents.set('w1', {
    id: 'w1', name: 'Backend Engineer', status: 'idle', projectPath: repo, worktreePath: wt, branchName: 'feat/x',
    skills: [], output: [], lastActivity: '',
  } as unknown as AgentStatus);
});

afterEach(() => {
  agents.clear();
});

/** Why 2, 3 cannot hold on Windows. */
const READ_ONLY_FOLDER_REASON = 'chmod 0o555 only sets the read-only attribute on Windows, which it ignores on a folder: '
  + 'git still writes its objects, and the save cannot be made to fail this way; test 2, 3 runs on macOS, Linux and CI';

// A submodule test runs some thirty git commands: about 4 s on Windows alone, more under load.
describe('the window\'s Delete', { timeout: 30_000 }, () => {
  it('1, 3. saves the uncommitted work on wip/<name>, removes the worktree, and says where the work went', async () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(wt, 'new.txt'), 'fresh\n');

    const result = await handlers.get('agent:remove')!({}, 'w1');

    expect(result).toEqual({ success: true, savedTo: 'wip/backend-engineer' });
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(repo, 'show', 'wip/backend-engineer:a.txt')).toBe('one\ntwo');
    expect(git(repo, 'show', 'wip/backend-engineer:new.txt')).toBe('fresh');
    expect(agents.has('w1')).toBe(false);
  });

  it('removes a clean worktree and makes no branch', async () => {
    expect(await handlers.get('agent:remove')!({}, 'w1')).toEqual({ success: true });
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(repo, 'branch', '--list', 'wip/*')).toBe('');
  });

  it('4. keeps a worktree holding ignored files that are not caches, and names them', async () => {
    fs.writeFileSync(path.join(wt, '.gitignore'), '.env\ntest-results/\nnode_modules/\n');
    fs.writeFileSync(path.join(wt, '.env'), 'SECRET=1\n');
    fs.mkdirSync(path.join(wt, 'test-results', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'test-results', 'runs', 'values.json'), '{}');
    fs.mkdirSync(path.join(wt, 'node_modules', 'x'), { recursive: true });
    // git lists no empty folder: a cache with nothing in it would prove nothing.
    fs.writeFileSync(path.join(wt, 'node_modules', 'x', 'index.js'), 'module.exports = 1;\n');

    const result = await handlers.get('agent:remove')!({}, 'w1') as { success: boolean; savedTo?: string; worktreeKept?: string };

    expect(result.success).toBe(true);
    expect(result.savedTo).toBe('wip/backend-engineer');
    expect(result.worktreeKept).toContain('.env');
    expect(result.worktreeKept).toContain('test-results/');
    expect(result.worktreeKept).not.toContain('node_modules');
    expect(fs.readFileSync(path.join(wt, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(agents.has('w1')).toBe(false);
  });

  it('6. keeps a worktree holding a git repository of its own, and names it', async () => {
    const nested = path.join(wt, 'vendor-lib');
    fs.mkdirSync(nested);
    git(nested, 'init', '-q', '-b', 'main');
    git(nested, 'config', 'user.email', 't@t.example');
    git(nested, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(nested, 'lib.js'), 'module.exports = 1;\n');
    git(nested, 'add', '-A');
    git(nested, 'commit', '-qm', 'lib');

    const result = await handlers.get('agent:remove')!({}, 'w1') as { savedTo?: string; worktreeKept?: string };

    expect(result.worktreeKept).toContain('vendor-lib');
    expect(fs.readFileSync(path.join(nested, 'lib.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(agents.has('w1')).toBe(false);
  });

  it('7. keeps a worktree whose submodule holds a commit no remote has, the worktree itself clean, and names it', async () => {
    const sub = withSubmodule();
    fs.writeFileSync(path.join(sub, 'l.txt'), 'one\ntwo\n');
    git(sub, 'commit', '-qam', 'local only');
    const local = git(sub, 'rev-parse', 'HEAD');
    git(wt, 'commit', '-qam', 'points at the local commit');
    expect(git(wt, 'status', '--porcelain')).toBe('');

    const result = await handlers.get('agent:remove')!({}, 'w1') as { savedTo?: string; worktreeKept?: string };

    expect(result.savedTo).toBeUndefined();
    expect(result.worktreeKept).toContain('vendor/lib');
    expect(git(sub, 'cat-file', '-t', local)).toBe('commit');
    expect(agents.has('w1')).toBe(false);
  });

  it('8. keeps a worktree whose submodule has uncommitted changes, and names it', async () => {
    const sub = withSubmodule();
    fs.writeFileSync(path.join(sub, 'draft.txt'), 'not committed\n');

    const result = await handlers.get('agent:remove')!({}, 'w1') as { worktreeKept?: string };

    expect(result.worktreeKept).toContain('vendor/lib');
    expect(fs.readFileSync(path.join(sub, 'draft.txt'), 'utf8')).toBe('not committed\n');
  });

  it('9. removes a worktree whose submodule holds nothing its remote lacks', async () => {
    withSubmodule();
    expect(await handlers.get('agent:remove')!({}, 'w1')).toEqual({ success: true });
    expect(fs.existsSync(wt)).toBe(false);
  });

  it('9. removes a worktree whose submodule was never checked out', async () => {
    withSubmodule(false);
    expect(await handlers.get('agent:remove')!({}, 'w1')).toEqual({ success: true });
    expect(fs.existsSync(wt)).toBe(false);
  });

  it('10. keeps a worktree whose submodule holds a stash', async () => {
    const sub = withSubmodule();
    fs.writeFileSync(path.join(sub, 'l.txt'), 'one\nstashed\n');
    git(sub, 'stash', '-q');
    expect(git(wt, 'status', '--porcelain')).toBe('');

    const result = await handlers.get('agent:remove')!({}, 'w1') as { worktreeKept?: string };

    expect(result.worktreeKept).toContain('vendor/lib');
    expect(git(sub, 'stash', 'list')).not.toBe('');
  });

  it('10. keeps a worktree whose submodule holds a commit only a local tag holds', async () => {
    const sub = withSubmodule();
    const pinned = git(sub, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(sub, 'l.txt'), 'one\ntagged\n');
    git(sub, 'commit', '-qam', 'tagged only');
    git(sub, 'tag', 'keep');
    git(sub, 'checkout', '-q', pinned);
    expect(git(wt, 'status', '--porcelain')).toBe('');

    const result = await handlers.get('agent:remove')!({}, 'w1') as { worktreeKept?: string };

    expect(result.worktreeKept).toContain('vendor/lib');
    expect(git(sub, 'cat-file', '-t', 'keep')).toBe('commit');
  });

  it('11. keeps a worktree whose submodule holds a file git ignores, such as a .env', async () => {
    const sub = withSubmodule();
    fs.appendFileSync(path.resolve(sub, git(sub, 'rev-parse', '--git-path', 'info/exclude')), '.env\n');
    fs.writeFileSync(path.join(sub, '.env'), 'SECRET=1\n');
    expect(git(sub, 'status', '--porcelain')).toBe('');

    const result = await handlers.get('agent:remove')!({}, 'w1') as { worktreeKept?: string };

    expect(result.worktreeKept).toContain('vendor/lib');
    expect(fs.readFileSync(path.join(sub, '.env'), 'utf8')).toBe('SECRET=1\n');
  });

  it('5. removes a worktree whose only ignored files are rebuildable caches', async () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.next/\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-qm', 'ignore');
    git(wt, 'merge', '-q', 'main');
    fs.mkdirSync(path.join(wt, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'node_modules', 'x', 'index.js'), 'module.exports = 1;\n');
    fs.mkdirSync(path.join(wt, '.next'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.next', 'build-manifest.json'), '{}');

    expect(await handlers.get('agent:remove')!({}, 'w1')).toEqual({ success: true });
    expect(fs.existsSync(wt)).toBe(false);
  });

  it.skipIf(skipOnWindows(READ_ONLY_FOLDER_REASON))('2, 3. keeps the worktree when the work cannot be saved, and says why', async () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'kept\n');
    const objects = path.join(repo, '.git', 'objects');
    fs.chmodSync(objects, 0o555);
    let result: unknown;
    try {
      result = await handlers.get('agent:remove')!({}, 'w1');
    } finally {
      fs.chmodSync(objects, 0o755);
    }
    expect(result).toMatchObject({ success: true, worktreeKept: expect.stringContaining(wt) });
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')).toBe('kept\n');
    expect(agents.has('w1')).toBe(false);
  });

  it('13. a worktree git refuses to remove (locked): the answer says why, and where it stays', async () => {
    git(repo, 'worktree', 'lock', '--reason', 'kept by hand', wt);

    const result = await handlers.get('agent:remove')!({}, 'w1');

    expect(result).toEqual({
      success: true,
      worktreeKept: `git could not remove it (cannot remove a locked working tree, lock reason: kept by hand), so its worktree was kept at ${wt}`,
    });
    expect(fs.existsSync(wt)).toBe(true);
    expect(agents.has('w1')).toBe(false);
  });

  it('14. a worktree already removed outside Tars is not announced as kept', async () => {
    git(repo, 'worktree', 'remove', '--force', wt);

    expect(await handlers.get('agent:remove')!({}, 'w1')).toEqual({ success: true });
    expect(agents.has('w1')).toBe(false);
  });

  it('14. nor one moved away then pruned', async () => {
    fs.renameSync(wt, path.join(path.dirname(repo), 'moved'));
    git(repo, 'worktree', 'prune');

    expect(await handlers.get('agent:remove')!({}, 'w1')).toEqual({ success: true });
    expect(agents.has('w1')).toBe(false);
  });
});
