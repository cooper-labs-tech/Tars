#!/usr/bin/env node
/**
 * The team's worktrees: create, remove, prune, status.
 *
 *   node scripts/worktree.mjs new <name> [--branch <b>] [--from <ref>] [--agent <a>] [--task <t>] [--no-deps]
 *   node scripts/worktree.mjs remove <name|path> [--save] [--reason <text>]
 *   node scripts/worktree.mjs prune [--older-than <days>] [--dry-run] [--no-github]
 *   node scripts/worktree.mjs status [--json]
 *
 * On 01/10 the Mac crashed with 68 MB free: ~/tars/.worktrees weighed 46 GB
 * across 59 worktrees, most with a full `npm ci` of their own and a .next
 * cache, and nothing ever removed one. So:
 *
 * - **new** refuses under 30 GB free (TARS_WORKTREE_MIN_FREE_GB) and past 20
 *   worktrees (TARS_WORKTREE_MAX), counting every worktree of the repository
 *   but the main checkout, made by this tool or not. It creates
 *   `.worktrees/<name>` beside the main checkout, on a new branch that tracks
 *   nothing (a branch made from origin/main would otherwise track main), and
 *   records in `.worktrees/.registry.json` which agent and task it serves.
 * - **Dependencies are a clone** of an installed node_modules, never a
 *   symlink: next dev refuses a node_modules that points outside its root
 *   (measured 30/09), and vitest mistakes its own files for the project's in a
 *   worktree of 11 or 12 characters without one (__tests__/setup). On APFS
 *   `cp -c` shares every block: 9.8 s and about 65 MB for a 1.2 GB
 *   node_modules, against 20 s and 1.2 GB for `npm ci` plus the Electron
 *   binary and node-pty's build (measured 01/10). A clone at the same lock is
 *   used as is; one at another lock is reconciled by `npm install`, which only
 *   writes what differs; `npm ci` runs only when there is nothing to clone.
 * - **remove** loses nothing: a dirty worktree is refused with its files
 *   named, or with --save committed on wip/<name> (its own branch untouched);
 *   a detached HEAD on no branch gets wip/<name> first; a worktree any other
 *   process works in is left alone; git is never told --force. The branch is
 *   kept, and `.worktrees/.removed.log` records its head.
 * - **prune** removes, under the same rules, a worktree whose PR is merged or
 *   closed (an hour after its last activity), one merged into the base (a day
 *   after), and one inactive for --older-than days (7). Activity is the last
 *   move of its HEAD (a checkout, a commit, a reset); uncommitted work makes
 *   a worktree dirty, and a dirty one is never pruned. A locked worktree
 *   (`git worktree lock`) is never pruned.
 * - **The cleanup needs no schedule of its own**: every `new` prunes first
 *   (without asking GitHub, which would cost a call per worktree).
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const MIN_FREE_GB = 30;
export const MAX_WORKTREES = 20;
export const OLDER_THAN_DAYS = 7;
/** Commits behind its base past which an active worktree is told to merge it in. */
export const BEHIND_FLAG = 5;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** How long after its last activity a worktree whose PR is merged or closed may go. */
export const CLOSED_GRACE_MS = HOUR;
/** Without a PR to read, merged into the base is weaker evidence: a fresh worktree of main looks merged too. */
export const MERGED_GRACE_MS = DAY;
const GB = 1024 ** 3;

/** A refusal the caller is meant to read: nothing was done, and the message says why. */
export class WorktreeRefusal extends Error {}

/** A command with an argv array and no shell. Never rejects. */
function run(command, args, options = {}) {
  return new Promise(done => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      done({
        code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        missing: error?.code === 'ENOENT',
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

/** git without writing the index, which `git status` refreshes otherwise: this tool only reads. */
async function git(ctx, cwd, args) {
  ctx.onGit?.(args);
  return run('git', args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
}

async function gitOk(ctx, cwd, args) {
  const r = await git(ctx, cwd, args);
  if (r.code !== 0) throw new WorktreeRefusal(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/** The main checkout, found through git from anywhere in it or in any of its worktrees. */
export async function openRepo(cwd = process.cwd()) {
  const r = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (r.missing) throw new WorktreeRefusal('git is not installed');
  if (r.code !== 0) throw new WorktreeRefusal(`${cwd} is not inside a git checkout`);
  const commonDir = r.stdout.trim();
  if (path.basename(commonDir) !== '.git') {
    throw new WorktreeRefusal(`git's directory ${commonDir} is not a checkout's .git`);
  }
  const root = path.dirname(commonDir);
  const worktreesDir = path.join(root, '.worktrees');
  return {
    root,
    commonDir,
    worktreesDir,
    registryPath: path.join(worktreesDir, '.registry.json'),
    removedLog: path.join(worktreesDir, '.removed.log'),
  };
}

/** Every worktree git knows, the main checkout first. */
export async function listWorktrees(repo, ctx) {
  const out = await gitOk(ctx, repo.root, ['worktree', 'list', '--porcelain']);
  const entries = [];
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    const field = key => lines.find(l => l === key || l.startsWith(`${key} `));
    const value = key => field(key)?.slice(key.length + 1) ?? null;
    const at = value('worktree');
    if (!at) continue;
    entries.push({
      path: at,
      name: path.basename(at),
      head: value('HEAD'),
      branch: value('branch')?.replace(/^refs\/heads\//, '') ?? null,
      locked: field('locked') ? (value('locked') || 'locked') : null,
      prunable: Boolean(field('prunable')),
      main: entries.length === 0,
    });
  }
  return entries;
}

function readRegistry(repo) {
  try {
    return JSON.parse(fs.readFileSync(repo.registryPath, 'utf8'));
  } catch {
    return {};
  }
}

function writeRegistry(repo, registry) {
  fs.mkdirSync(repo.worktreesDir, { recursive: true });
  const tmp = `${repo.registryPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(tmp, repo.registryPath);
}

/** `git status` in short form: tracked changes and untracked files, never ignored ones. */
async function dirtyFiles(ctx, at) {
  const args = ['status', '--porcelain', '--untracked-files=normal'];
  const r = await git(ctx, at, args);
  if (r.code !== 0) throw new WorktreeRefusal(`git ${args.join(' ')} failed in ${at}: ${r.stderr.trim()}`);
  // Untrimmed: each line starts with its two status columns, the first often a space.
  return r.stdout.split('\n').filter(Boolean).map(line => line.slice(3));
}

/**
 * When the worktree last moved: its HEAD or its reflog (a checkout, a commit,
 * a reset), or its registration. Not its index: a `git status` from anyone
 * rewrites it, so on 01/10 worktrees idle for days read as used that hour.
 * Work that was never committed does not need a date: it is dirty, and a dirty
 * worktree is never pruned.
 */
async function lastActivity(ctx, entry, registry) {
  const gitDir = await gitOk(ctx, entry.path, ['rev-parse', '--absolute-git-dir']);
  let latest = registry[entry.name]?.createdAt ?? 0;
  for (const file of ['HEAD', path.join('logs', 'HEAD')]) {
    try {
      latest = Math.max(latest, fs.statSync(path.join(gitDir, file)).mtimeMs);
    } catch { /* absent */ }
  }
  return latest;
}

async function defaultBase(ctx, repo) {
  const r = await git(ctx, repo.root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
  return r.code === 0 ? 'origin/main' : 'main';
}

async function isMerged(ctx, repo, head, base) {
  return (await git(ctx, repo.root, ['merge-base', '--is-ancestor', head, base])).code === 0;
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The processes working in this folder, or null when they cannot be known.
 * `exemptCaller`: the caller's own processes (this one and the ones that
 * started it) do not count, so an agent may remove the worktree it is in.
 * For an explicit remove only: prune leaves a worktree its caller works in
 * (the Audit's gate of #270).
 */
async function occupants(ctx, at, { exemptCaller = false } = {}) {
  const cwds = await ctx.processCwds();
  if (!cwds) return null;
  const mine = exemptCaller ? await ctx.lineage() : new Set();
  return cwds.filter(p => inside(p.cwd, at) && !mine.has(p.pid));
}

/**
 * Ignored files git would delete with the worktree, but the rebuildable caches:
 * a .env.local, the e2e run directories Rule 3 asks a PR to name, a release
 * build went without a word (the Audit's gate of #270). Folded as git lists
 * them, a folder once.
 */
const CACHES = [
  /(^|\/)node_modules\/?$/, /^\.next\/?$/, /^out\/?$/, /^electron\/dist\/?$/, /^mcp-[^/]+\/dist\/?$/,
  /\.tsbuildinfo$/, /(^|\/)next-env\.d\.ts$/, /(^|\/)\.DS_Store$/, /(^|\/)\.vite(-temp)?\/?$/,
];

async function ignoredNotCaches(ctx, at) {
  const r = await git(ctx, at, ['status', '--porcelain', '--ignored', '--untracked-files=normal']);
  if (r.code !== 0) throw new WorktreeRefusal(`git status --ignored failed in ${at}: ${r.stderr.trim()}`);
  return r.stdout.split('\n')
    .filter(line => line.startsWith('!! '))
    .map(line => line.slice(3))
    .filter(file => !CACHES.some(cache => cache.test(file)));
}

/** A git operation the worktree is in the middle of: removing it would drop its state. */
const IN_PROGRESS = { 'rebase-merge': 'a rebase', 'rebase-apply': 'a rebase', MERGE_HEAD: 'a merge', CHERRY_PICK_HEAD: 'a cherry-pick', REVERT_HEAD: 'a revert', BISECT_LOG: 'a bisect' };

async function operationInProgress(ctx, at) {
  const gitDir = await gitOk(ctx, at, ['rev-parse', '--absolute-git-dir']);
  for (const [file, what] of Object.entries(IN_PROGRESS)) {
    if (fs.existsSync(path.join(gitDir, file))) return what;
  }
  return null;
}

const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** The Tars agent whose worktree this is, by ~/.dorothy/agents.json, or null. */
function agentOf(ctx, at) {
  const here = real(at);
  const found = ctx.agentWorktrees().map(w => (typeof w === 'string' ? { path: w, name: w } : w))
    .find(w => real(w.path) === here);
  return found ? found.name : null;
}

function depsKind(at) {
  try {
    const stat = fs.lstatSync(path.join(at, 'node_modules'));
    return stat.isSymbolicLink() ? 'link' : 'folder';
  } catch {
    return 'none';
  }
}

/**
 * Whether the tree npm installed (its hidden lockfile) is the one this lock
 * describes. Optional packages the lock lists may be missing: npm installs
 * only those for this platform.
 */
export function installedMatches(nodeModules, lockPath) {
  let installed;
  let lock;
  try {
    installed = JSON.parse(fs.readFileSync(path.join(nodeModules, '.package-lock.json'), 'utf8')).packages ?? {};
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')).packages ?? {};
  } catch {
    return false;
  }
  for (const [key, got] of Object.entries(installed)) {
    const want = lock[key];
    if (!want || want.version !== got.version) return false;
    if (want.integrity && got.integrity && want.integrity !== got.integrity) return false;
  }
  for (const [key, want] of Object.entries(lock)) {
    if (key === '' || installed[key]) continue;
    if (!want.optional && !want.devOptional && !want.peer) return false;
  }
  return true;
}

/** A copy that shares its blocks where the file system can: APFS on macOS, btrfs or XFS on Linux. */
async function cloneTree(source, target, ctx) {
  const args = process.platform === 'darwin' ? ['-c', '-R', source, target]
    : process.platform === 'linux' ? ['-R', '--reflink=auto', source, target]
      : ['-R', source, target];
  let r = await run('cp', args);
  if (r.code !== 0 && process.platform === 'darwin') {
    ctx.log(`clone refused (${r.stderr.trim()}), copying ${source} in full`);
    fs.rmSync(target, { recursive: true, force: true });
    r = await run('cp', ['-R', source, target]);
  }
  if (r.code !== 0) throw new WorktreeRefusal(`could not copy ${source}: ${r.stderr.trim()}`);
}

async function tool(ctx, command, args, cwd) {
  ctx.log(`${command} ${args.join(' ')}`);
  const r = await ctx.runTool(command, args, { cwd });
  if (r.code !== 0) {
    throw new WorktreeRefusal(`${command} ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
  }
}

/**
 * node_modules for a new worktree: a clone of an installed one (at the same
 * lock if any), reconciled by npm when the lock differs, installed from
 * scratch only when there is nothing to clone. Then what npm leaves out: the
 * Electron binary (no postinstall since Electron 44), and on macOS node-pty's
 * own build, whose prebuilt spawn-helper comes out of npm without its execute
 * bit (posix_spawnp failed, 24/09).
 */
export async function prepareDeps(repo, target, ctx) {
  const lock = path.join(target, 'package-lock.json');
  if (!fs.existsSync(lock)) return 'none';
  const nm = path.join(target, 'node_modules');
  const sources = (await listWorktrees(repo, ctx))
    .map(e => path.join(e.path, 'node_modules'))
    .filter(p => p !== nm && depsKind(path.dirname(p)) === 'folder');
  const matching = sources.find(p => installedMatches(p, lock));
  const recency = p => {
    try { return fs.statSync(path.join(p, '.package-lock.json')).mtimeMs; } catch { return 0; }
  };
  const source = matching ?? sources.sort((a, b) => recency(b) - recency(a))[0];

  let how;
  if (source) {
    ctx.log(`cloning ${source}`);
    await cloneTree(source, nm, ctx);
    how = `cloned from ${source}`;
    if (!matching) {
      await tool(ctx, 'npm', ['install', '--no-audit', '--no-fund'], target);
      how += ', then npm install for the lock';
    }
  } else {
    await tool(ctx, 'npm', ['ci', '--no-audit', '--no-fund'], target);
    how = 'npm ci (nothing to clone)';
  }
  if (fs.existsSync(path.join(nm, 'electron', 'package.json')) && !fs.existsSync(path.join(nm, 'electron', 'dist'))) {
    await tool(ctx, 'npx', ['--no-install', 'install-electron'], target);
  }
  if (process.platform === 'darwin' && fs.existsSync(path.join(nm, 'node-pty', 'package.json'))
    && !fs.existsSync(path.join(nm, 'node-pty', 'build', 'Release', 'spawn-helper'))) {
    await tool(ctx, 'npx', ['--no-install', 'electron-rebuild', '-f', '-o', 'node-pty'], target);
  }
  return how;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * One `new` at a time from the prune to the `git worktree add`: two at once
 * both counted the worktrees before either added one, and passed the cap
 * together (the Audit's gate of #270). A lock older than LOCK_STALE_MS is
 * taken for one a killed run left behind.
 */
const LOCK_STALE_MS = 10 * 60_000;
async function withLock(repo, work) {
  fs.mkdirSync(repo.worktreesDir, { recursive: true });
  const lock = path.join(repo.worktreesDir, '.lock');
  for (let waited = 0; ; waited += 100) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch { /* gone meanwhile */ }
      if (waited > 120_000) throw new WorktreeRefusal(`${lock} has been held for two minutes: another new is stuck, or delete it`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try {
    return await work();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/**
 * The main checkout on its default branch, clean, and fast-forwarded to
 * origin's: Tars shows an agent the branch of the folder it works in, and the
 * root sat on test/final-1.7.1 from 16/09 while everyone worked in
 * worktrees ("vraiment confusing", JeanBrasse, 01/10). Without an origin there is
 * nothing to fetch, and the local branch is the base.
 */
async function freshMainCheckout(ctx, repo) {
  const base = await defaultBase(ctx, repo);
  const branch = base.replace(/^origin\//, '');
  const current = (await git(ctx, repo.root, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
  if (current !== branch) {
    throw new WorktreeRefusal(`the main checkout ${repo.root} is on ${current || 'a detached HEAD'}, not ${branch}: switch it back to ${branch} first, nothing created`);
  }
  const changed = (await git(ctx, repo.root, ['status', '--porcelain', '--untracked-files=no'])).stdout
    .split('\n').filter(Boolean).map(line => line.slice(3));
  if (changed.length) {
    throw new WorktreeRefusal(`the main checkout ${repo.root} has uncommitted changes (${changed.join(', ')}): nothing created`);
  }
  if (base === branch) return base;
  const fetched = await git(ctx, repo.root, ['fetch', '-q', 'origin']);
  if (fetched.code !== 0) ctx.log(`git fetch failed (${fetched.stderr.trim()}): starting from origin/${branch} as it was`);
  const ff = await git(ctx, repo.root, ['merge', '--ff-only', '-q', base]);
  if (ff.code !== 0) {
    throw new WorktreeRefusal(`the main checkout's ${branch} cannot be fast-forwarded to ${base} (${ff.stderr.trim()}): nothing created`);
  }
  return base;
}

export async function createWorktree(repo, name, opts, ctx) {
  if (!NAME.test(name) || name.includes('..')) {
    throw new WorktreeRefusal(`"${name}" is not a worktree name: letters, digits, dot, dash and underscore, 64 at most`);
  }
  const made = await withLock(repo, () => addWorktree(repo, name, opts, ctx));
  const deps = opts.deps === false ? 'skipped' : await prepareDeps(repo, made.path, ctx);
  return { ...made, deps };
}

async function addWorktree(repo, name, opts, ctx) {
  const freshBase = await freshMainCheckout(ctx, repo);
  const pruned = await prune(repo, { olderThanDays: OLDER_THAN_DAYS, github: false }, ctx);
  for (const r of pruned.removed) ctx.log(`pruned ${r.name}: ${r.why}`);

  const free = ctx.freeBytes(repo.root);
  if (free < ctx.minFreeGb * GB) {
    throw new WorktreeRefusal(
      `${(free / GB).toFixed(1)} GB free on the disk of ${repo.root}, under the ${ctx.minFreeGb} GB floor: nothing created. `
      + 'Remove the worktrees you are done with (status, then remove), or tell the orchestrator.',
    );
  }
  const count = (await listWorktrees(repo, ctx)).filter(e => !e.main).length;
  if (count >= ctx.max) {
    throw new WorktreeRefusal(
      `${count} worktrees already, the cap is ${ctx.max}: nothing created. Remove the ones you are done with (status, then remove).`,
    );
  }
  const target = path.join(repo.worktreesDir, name);
  if (fs.existsSync(target)) throw new WorktreeRefusal(`${target} already exists`);
  const branch = opts.branch ?? name;
  await gitOk(ctx, repo.root, ['check-ref-format', '--branch', branch]);
  const from = opts.from ?? freshBase;

  const exists = (await git(ctx, repo.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  fs.mkdirSync(repo.worktreesDir, { recursive: true });
  await gitOk(ctx, repo.root, exists
    ? ['worktree', 'add', target, branch]
    : ['worktree', 'add', '--no-track', '-b', branch, target, from]);

  const registry = readRegistry(repo);
  registry[name] = { branch, base: exists ? null : from, agent: opts.agent ?? null, task: opts.task ?? null, createdAt: ctx.now() };
  writeRegistry(repo, registry);
  return { name, path: target, branch, pruned: pruned.removed };
}

async function findEntry(repo, nameOrPath, ctx) {
  const entries = await listWorktrees(repo, ctx);
  const asPath = path.resolve(nameOrPath);
  const entry = entries.find(e => e.path === asPath)
    ?? entries.find(e => !e.main && e.name === nameOrPath && inside(e.path, repo.worktreesDir))
    ?? entries.find(e => !e.main && e.name === nameOrPath);
  if (!entry) throw new WorktreeRefusal(`no worktree named ${nameOrPath}`);
  return entry;
}

async function freeWipName(ctx, repo, name) {
  let candidate = `wip/${name}`;
  for (let i = 2; (await git(ctx, repo.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`])).code === 0; i++) {
    candidate = `wip/${name}-${i}`;
  }
  return candidate;
}

/**
 * Why this worktree cannot be removed now, or null. It only reads, and both
 * remove and prune ask it, so a dry run says what a real one would do.
 */
async function blocker(ctx, entry, { save = false, exemptCaller = false } = {}) {
  if (entry.main) return `${entry.path} is the main checkout, which is never removed`;
  if (entry.locked) return `it is locked (${entry.locked}): git worktree unlock it first if it is done`;
  const agent = agentOf(ctx, entry.path);
  // Tars starts that agent there; without it, the agent works in the home folder.
  if (agent) return `it is the worktree of the Tars agent ${agent}, which Tars starts in it: delete the agent first if it is done`;
  const operation = await operationInProgress(ctx, entry.path);
  if (operation) return `${operation} is in progress in it: finish it or abort it first`;
  const busy = await occupants(ctx, entry.path, { exemptCaller });
  if (busy === null) return 'the processes working in it cannot be listed';
  if (busy.length) return `it is in use: ${busy.map(p => `PID ${p.pid} (${p.command})`).join(', ')}`;
  const dirty = await dirtyFiles(ctx, entry.path);
  if (dirty.length && !save) return `it has uncommitted work: ${dirty.join(', ')}. Commit it, or pass --save to keep it on a wip/ branch`;
  const ignored = await ignoredNotCaches(ctx, entry.path);
  if (ignored.length) {
    return `it holds ignored files git would delete with it: ${ignored.join(', ')}. `
      + 'Move what must survive (an e2e run directory under ~/Documents, say), delete the rest, then remove it';
  }
  return null;
}

/** The removal every path shares: nothing is written until blocker() has found nothing. */
async function removeEntry(repo, entry, { save = false, why = 'removed', exemptCaller = false } = {}, ctx) {
  const blocked = await blocker(ctx, entry, { save, exemptCaller });
  if (blocked) throw new WorktreeRefusal(`${entry.name} is kept: ${blocked}`);
  const dirty = await dirtyFiles(ctx, entry.path);

  let savedAs = null;
  if (dirty.length) {
    savedAs = await freeWipName(ctx, repo, entry.name);
    await gitOk(ctx, entry.path, ['switch', '-q', '-c', savedAs]);
    await gitOk(ctx, entry.path, ['add', '-A']);
    // A backup, not a delivery: a refusing commit hook would leave it all staged on wip/.
    await gitOk(ctx, entry.path, ['commit', '-q', '--no-verify', '-m', `wip: ${entry.name}, saved by scripts/worktree.mjs before removal`]);
  } else if (!entry.branch) {
    const holders = await gitOk(ctx, repo.root, ['for-each-ref', '--contains', entry.head, '--format=%(refname)', 'refs/heads', 'refs/remotes']);
    if (!holders) {
      savedAs = await freeWipName(ctx, repo, entry.name);
      await gitOk(ctx, repo.root, ['branch', savedAs, entry.head]);
    }
  }
  const head = await gitOk(ctx, entry.path, ['rev-parse', 'HEAD']);
  await gitOk(ctx, repo.root, ['worktree', 'remove', entry.path]);

  const registry = readRegistry(repo);
  if (registry[entry.name]) {
    delete registry[entry.name];
    writeRegistry(repo, registry);
  }
  fs.mkdirSync(repo.worktreesDir, { recursive: true });
  fs.appendFileSync(repo.removedLog, `${JSON.stringify({
    at: new Date(ctx.now()).toISOString(), name: entry.name, path: entry.path, branch: entry.branch, head, savedAs, why,
  })}\n`);
  return { name: entry.name, head, branch: entry.branch, savedAs, why };
}

export async function removeWorktree(repo, nameOrPath, { save = false, reason } = {}, ctx) {
  const entry = await findEntry(repo, nameOrPath, ctx);
  return removeEntry(repo, entry, { save, why: reason ?? 'removed by hand', exemptCaller: true }, ctx);
}

export async function prune(repo, { olderThanDays = OLDER_THAN_DAYS, dryRun = false, github = true, base } = {}, ctx) {
  const removed = [];
  const kept = [];
  if (!dryRun) await git(ctx, repo.root, ['worktree', 'prune']);
  const baseRef = base ?? await defaultBase(ctx, repo);
  const registry = readRegistry(repo);
  const now = ctx.now();

  for (const entry of await listWorktrees(repo, ctx)) {
    if (entry.main || entry.prunable) continue;
    const keep = why => kept.push({ name: entry.name, path: entry.path, why });

    const idle = now - await lastActivity(ctx, entry, registry);
    const pr = github && entry.branch ? await ctx.prState(entry.branch) : null;
    let why = null;
    if ((pr === 'MERGED' || pr === 'CLOSED') && idle >= CLOSED_GRACE_MS) why = `its PR is ${pr.toLowerCase()}`;
    else if (entry.head && idle >= MERGED_GRACE_MS && await isMerged(ctx, repo, entry.head, baseRef)) why = `merged into ${baseRef}`;
    else if (idle >= olderThanDays * DAY) why = `inactive for ${Math.floor(idle / DAY)} days`;
    if (!why) { keep(`active ${Math.max(0, Math.round(idle / HOUR))} h ago`); continue; }

    const blocked = await blocker(ctx, entry);
    if (blocked) { keep(`${why}, but ${blocked}`); continue; }

    if (dryRun) { removed.push({ name: entry.name, path: entry.path, why }); continue; }
    try {
      removed.push(await removeEntry(repo, entry, { why }, ctx));
    } catch (error) {
      if (!(error instanceof WorktreeRefusal)) throw error;
      keep(`${why}, but ${error.message}`);
    }
  }
  return { removed, kept };
}

export async function status(repo, ctx) {
  const registry = readRegistry(repo);
  const baseRef = await defaultBase(ctx, repo);
  const now = ctx.now();
  const worktrees = [];
  for (const entry of await listWorktrees(repo, ctx)) {
    if (entry.main || entry.prunable) continue;
    const activity = await lastActivity(ctx, entry, registry);
    const own = registry[entry.name] ?? {};
    const behind = entry.head
      ? Number((await git(ctx, repo.root, ['rev-list', '--count', `${entry.head}..${baseRef}`])).stdout.trim()) || 0
      : 0;
    worktrees.push({
      name: entry.name,
      path: entry.path,
      branch: entry.branch,
      head: entry.head?.slice(0, 8) ?? null,
      agent: own.agent ?? null,
      task: own.task ?? null,
      lastActivity: new Date(activity).toISOString(),
      idleDays: Math.round(((now - activity) / DAY) * 10) / 10,
      dirty: await dirtyFiles(ctx, entry.path),
      merged: entry.head ? await isMerged(ctx, repo, entry.head, baseRef) : false,
      behind,
      // Active and well behind its base: merge it in before any gate.
      mergeMainFirst: behind >= BEHIND_FLAG && now - activity < OLDER_THAN_DAYS * DAY,
      locked: entry.locked,
      deps: depsKind(entry.path),
    });
  }
  return {
    freeGb: Math.round((ctx.freeBytes(repo.root) / GB) * 10) / 10,
    minFreeGb: ctx.minFreeGb,
    max: ctx.max,
    base: baseRef,
    worktrees,
  };
}

// ---------------------------------------------------------------- the real world

function freeBytes(at) {
  const s = fs.statfsSync(at);
  return Number(s.bavail) * Number(s.bsize);
}

/** This process and the ones that started it: the caller removing its own worktree is not a reason to refuse. */
async function ownLineage() {
  const pids = new Set([process.pid]);
  let pid = process.ppid;
  for (let i = 0; pid > 1 && i < 32; i++) {
    pids.add(pid);
    const r = await run('ps', ['-o', 'ppid=', '-p', String(pid)]);
    pid = Number(r.stdout.trim());
    if (!Number.isFinite(pid)) break;
  }
  return pids;
}

/**
 * Every process's working directory: /proc on Linux, lsof elsewhere. Null when
 * neither answers. The caller's own processes are in it (occupants exempts them
 * for a remove only); the lsof this runs is not, though it inherits this cwd and
 * made every remove from inside a worktree read "in use: (lsof)" on macOS.
 */
async function processCwds() {
  const found = [];
  if (process.platform === 'linux') {
    for (const pid of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
      try {
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        const command = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
        found.push({ pid: Number(pid), command, cwd });
      } catch { /* gone, or not ours to read */ }
    }
  } else {
    const r = await run('lsof', ['-w', '-a', '-d', 'cwd', '-F', 'pcRn']);
    if (r.missing || (r.code !== 0 && !r.stdout)) return null;
    let current = null;
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('p')) current = { pid: Number(line.slice(1)), ppid: 0, command: '', cwd: '' };
      else if (current && line.startsWith('R')) current.ppid = Number(line.slice(1));
      else if (current && line.startsWith('c')) current.command = line.slice(1);
      else if (current && line.startsWith('n')) {
        current.cwd = line.slice(1);
        if (!(current.command === 'lsof' && current.ppid === process.pid)) found.push(current);
      }
    }
  }
  return found;
}

/** The worktrees of Tars's own agents, from ~/.dorothy/agents.json (a list, or { agents }). */
function tarsAgentWorktrees() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dorothy', 'agents.json'), 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.agents ?? [];
    return list.filter(a => a && typeof a.worktreePath === 'string')
      .map(a => ({ path: a.worktreePath, name: a.name || a.id }));
  } catch {
    return [];
  }
}

/** The state of the PR opened from this branch on the repository of build.publish, or null. */
function githubPrState(repo) {
  let slug = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo.root, 'package.json'), 'utf8'));
    const publish = [pkg.build?.publish].flat().find(p => p?.provider === 'github');
    if (publish?.owner && publish?.repo) slug = `${publish.owner}/${publish.repo}`;
  } catch { /* no package.json */ }
  return async branch => {
    if (!slug) return null;
    const r = await run('gh', ['pr', 'list', '--repo', slug, '--head', branch, '--state', 'all', '--json', 'state']);
    if (r.code !== 0) return null;
    const states = JSON.parse(r.stdout || '[]').map(p => p.state);
    if (states.includes('OPEN')) return 'OPEN';
    if (states.includes('MERGED')) return 'MERGED';
    return states.includes('CLOSED') ? 'CLOSED' : null;
  };
}

function realContext(repo) {
  const envNumber = (name, fallback) => {
    const n = Number(process.env[name]);
    return process.env[name] && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    freeBytes,
    processCwds,
    lineage: ownLineage,
    agentWorktrees: tarsAgentWorktrees,
    now: () => Date.now(),
    prState: githubPrState(repo),
    runTool: (command, args, options) => run(command, args, options),
    minFreeGb: envNumber('TARS_WORKTREE_MIN_FREE_GB', MIN_FREE_GB),
    max: envNumber('TARS_WORKTREE_MAX', MAX_WORKTREES),
    log: message => console.log(message),
  };
}

const USAGE = `usage:
  node scripts/worktree.mjs new <name> [--branch <b>] [--from <ref>] [--agent <a>] [--task <t>] [--no-deps]
  node scripts/worktree.mjs remove <name|path> [--save] [--reason <text>]
  node scripts/worktree.mjs prune [--older-than <days>] [--dry-run] [--no-github]
  node scripts/worktree.mjs status [--json]`;

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      branch: { type: 'string' }, from: { type: 'string' }, agent: { type: 'string' }, task: { type: 'string' },
      'no-deps': { type: 'boolean' }, save: { type: 'boolean' }, reason: { type: 'string' },
      'older-than': { type: 'string' }, 'dry-run': { type: 'boolean' }, 'no-github': { type: 'boolean' },
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, target] = positionals;
  if (values.help || !command) { console.log(USAGE); return 0; }
  const repo = await openRepo();
  const ctx = realContext(repo);

  if (command === 'new' && target) {
    const wt = await createWorktree(repo, target, {
      branch: values.branch, from: values.from, agent: values.agent, task: values.task, deps: !values['no-deps'],
    }, ctx);
    console.log(`${wt.path} on ${wt.branch}; node_modules: ${wt.deps}`);
    console.log(`When the task ends: node scripts/worktree.mjs remove ${wt.name}`);
    return 0;
  }
  if (command === 'remove' && target) {
    const r = await removeWorktree(repo, target, { save: values.save, reason: values.reason }, ctx);
    console.log(`removed ${r.name} at ${r.head.slice(0, 8)}${r.branch ? ` (branch ${r.branch} kept)` : ''}${r.savedAs ? `, work saved on ${r.savedAs}` : ''}`);
    return 0;
  }
  if (command === 'prune') {
    const days = values['older-than'] === undefined ? OLDER_THAN_DAYS : Number(values['older-than']);
    if (!Number.isFinite(days) || days < 0) throw new WorktreeRefusal(`--older-than takes a number of days, not ${values['older-than']}`);
    const r = await prune(repo, { olderThanDays: days, dryRun: values['dry-run'], github: !values['no-github'] }, ctx);
    for (const x of r.removed) console.log(`${values['dry-run'] ? 'would remove' : 'removed'} ${x.name}: ${x.why}`);
    for (const x of r.kept) console.log(`kept ${x.name}: ${x.why}`);
    return 0;
  }
  if (command === 'status') {
    const s = await status(repo, ctx);
    if (values.json) { console.log(JSON.stringify(s, null, 2)); return 0; }
    console.log(`${s.freeGb} GB free (floor ${s.minFreeGb} GB), ${s.worktrees.length} of ${s.max} worktrees, base ${s.base}`);
    for (const w of s.worktrees) {
      const flags = [
        w.merged && 'merged', w.behind && `${w.behind} behind`, w.mergeMainFirst && 'merge main in before a gate',
        w.locked && 'locked', w.dirty.length && `${w.dirty.length} uncommitted`, `deps ${w.deps}`,
      ].filter(Boolean).join(', ');
      console.log(`${w.name.padEnd(28)} ${(w.branch ?? `(detached ${w.head})`).padEnd(40)} ${String(w.idleDays).padStart(5)} d  ${w.agent ?? '-'}${w.task ? ` / ${w.task}` : ''}  ${flags}`);
    }
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof WorktreeRefusal ? error.message : error);
    process.exitCode = 1;
  });
}
