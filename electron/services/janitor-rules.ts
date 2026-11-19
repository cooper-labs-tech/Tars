import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { shortIdOf } from './agent-tmp';

/**
 * The disk janitor's rules (2.0.5, lot 3 item H; brief lot3-disk-janitor-2810.md, with the orchestrator's additions of
 * 28/10). A scan proposes, by rule, only what is on this list, each item with its size and the rule that matched, and
 * never deletes anything. The owner ticks and approves in the window; each approved item is checked again against its
 * rule at the moment it goes, deleted by its exact absolute path (never a glob, never a shell), and logged with what
 * it freed.
 *
 * The list:
 * - next-cache: the `.next` of a project's worktree (under `.worktrees/`), untouched for 3 days;
 * - test-artefacts: `test-results` and `playwright-report` of a worktree, untouched for 3 days, that no report names;
 * - closed-worktree: a worktree whose branch is merged into its project's main branch, clean, unlocked, idle a day,
 *   removed by `git worktree remove` (never --force), as scripts/worktree.mjs does;
 * - npx-cache: an entry of ~/.npm/_npx untouched for 14 days;
 * - docker-image: an image no container uses, a stopped one included (`docker image rm`, never -f, never a volume);
 * - docker-vm-trim: a trim of the Docker VM (colima), which gives the disk back what the VM freed;
 * - agent-tmp: the temporary folders (~/.tars/tmp/<id>) of an agent no longer in the fleet.
 * And what agents leave behind (2.0.7; an orchestrator's report of 19/11: 5.4 GB in live agents' temporary folders
 * on the owner's Mac, 475 MB in an electron-builder release/, none of it proposed):
 * - session-scratchpad: an ended session's folder in a live agent's Claude Code temporary folder
 *   (~/.tars/tmp/<id>/c/<user>/<project>/<session>, neither its current nor its resumable session), untouched 3 days;
 * - agent-tmp-entry: an entry of a live agent's TMPDIR (t/) or of its current session's scratchpad, untouched 7 days;
 * - release-folder: the release/ of a project or a worktree (electron-builder's output), untouched 3 days, holding
 *   its marker (builder-debug.yml, builder-effective-config.yaml) and a second sign of a build (an update manifest
 *   latest*.yml, or an artefact beside its .blockmap), no file git tracks in it, and ignored by git (at a
 *   project's root) or ignored or untracked (in a worktree): a user's own release/ is never proposed;
 * - worktree-node-modules: the node_modules of a worktree nothing changed in for 7 days (caches aside).
 * None of these when a report names it or a process works in it. A temporary item carries its agent's project.
 * Never, whatever matches: ~/.tars-private, ~/Documents, the uv cache, the Trash, ~/Library/Developer (Xcode, the iOS
 * runtimes and simulators), a Docker volume, a project's own folder, anything inside a worktree a fleet agent works
 * in, one with uncommitted work, or one a process works in. When the processes cannot be read (no lsof, Windows),
 * nothing that needs "nothing runs in it" is proposed.
 */

export type JanitorKind = 'next-cache' | 'test-artefacts' | 'closed-worktree' | 'npx-cache' | 'docker-image' | 'docker-vm-trim' | 'agent-tmp'
  | 'session-scratchpad' | 'agent-tmp-entry' | 'release-folder' | 'worktree-node-modules';

export type JanitorItem = {
  id: string;
  kind: JanitorKind;
  /** What goes: a folder's absolute path. */
  path?: string;
  /** A Docker image's id, or `colima` for the trim. */
  ref?: string;
  /** The worktree or the project it is in. */
  project?: string;
  label: string;
  sizeBytes: number;
  /** A worktree's item: its branch, whether it is merged, how long nothing changed in it (caches aside), clean. */
  details?: { branch: string | null; merged: boolean | null; idleDays: number; clean: boolean };
  /** The rule that matched, the same sentence for every item of a kind. */
  rule: string;
  /** Why this item matched: its last change, its merged branch, its image. */
  why: string;
};

export interface JanitorWorld {
  home: string;
  dataDir: string;
  privateDir: string;
  now: number;
  projects: string[];
  /**
   * The fleet's agents: their project and worktree, and, for the report and the temporary folders' rules, their
   * name, status and the sessions they hold (current and resumable).
   */
  fleet: Array<{ id: string; projectPath: string; worktreePath?: string; name?: string; status?: string; sessions?: string[] }>;
  /**
   * Every process, with its command line and the paths it is in, resolved: its working folder, its executable, and on
   * Linux the files it holds open (the Audit's M1 on #542: six servers ran from an npx entry with their working folder
   * elsewhere). Null when they cannot be read, wholly (janitor-processes.ts).
   */
  processes: Array<{ pid: number; command: string; paths: string[] }> | null;
  worktrees(project: string): Promise<Array<{ path: string; branch?: string; locked: boolean }> | null>;
  /** Uncommitted work in it; null when git cannot say. */
  dirty(worktree: string): Promise<boolean | null>;
  /** Merged into the project's main branch; null when git cannot say. */
  merged(project: string, branch: string): Promise<boolean | null>;
  /** Its ignored files but the rebuildable caches (as scripts/worktree.mjs reads them); null when git cannot say. */
  ignored(worktree: string): Promise<string[] | null>;
  /** A git operation it is in the middle of (a rebase, a merge...), or null; undefined when git cannot say. */
  operation(worktree: string): Promise<string | null | undefined>;
  /** A report names this folder (by its path, as reports cite their runs). */
  named(folder: string): boolean;
  docker: { images(): Promise<Array<{ id: string; repo: string; sizeBytes: number; used: boolean }> | null>; vm: boolean };
  sizeOf(p: string): Promise<number>;
  /**
   * What git says of a folder (2.0.7, the Audit's M1 on #605): `tracked` when it holds a file git tracks, else
   * `ignored` or `untracked`; null when git cannot say. Absent: nothing that needs it is proposed.
   */
  tracking?(dir: string): Promise<'tracked' | 'ignored' | 'untracked' | null>;
}

export interface JanitorOps {
  rm(p: string): Promise<void>;
  removeWorktree(project: string, p: string): Promise<void>;
  dockerRm(id: string): Promise<void>;
  trim(): Promise<void>;
  log(line: string): void;
  /** An approved item is about to be checked again: the window is told. */
  checking?(id: string): void;
  /** Right before an item goes, after its re-check: the window is told (and a test races it here). */
  beforeDelete?(item: JanitorItem): void;
  /** What the approval did to each item it was asked for, as it goes: for the window. */
  done?(id: string, outcome: { kind: 'deleted' | 'kept' | 'failed'; bytes?: number | null; why?: string | null }): void;
}

const DAY = 86_400_000;
const CACHE_IDLE_DAYS = 3;
const WORKTREE_IDLE_DAYS = 1;
const NPX_IDLE_DAYS = 14;
const SESSION_IDLE_DAYS = 3;
const TMP_ENTRY_IDLE_DAYS = 7;
const RELEASE_IDLE_DAYS = 3;
const NODE_MODULES_IDLE_DAYS = 7;
/**
 * How deep an npx entry is walked for its last change: the entry, its node_modules, each package's folder. The whole
 * walk read every file of every entry: 38.8 s of a 57 s scan on the owner's Mac (19/11), under load past the 30 s an
 * MCP call waits. npm writes the folders it installs, and node_modules/.package-lock.json, at those depths.
 */
const NPX_DEPTH = 2;
/** Past this many entries the newest change is not looked for further, and the folder reads as just touched. */
const WALK_MAX = 20_000;

// The disk's own spelling (case included): a fleet agent's path saved in another case is the same folder (L2).
const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return p; } };
function inside(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
const idOf = (kind: string, what: string) => createHash('sha256').update(`${kind}\0${what}`).digest('hex').slice(0, 16);
const isDir = (p: string) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The rebuildable caches, as scripts/worktree.mjs lists them: left out of a worktree's idleness (the Audit's L3). */
const CACHES = [
  /(^|\/)node_modules\/?$/, /^\.next\/?$/, /^out\/?$/, /^electron\/dist\/?$/, /^mcp-[^/]+\/dist\/?$/,
  /\.tsbuildinfo$/, /(^|\/)next-env\.d\.ts$/, /(^|\/)\.DS_Store$/, /(^|\/)\.vite(-temp)?\/?$/,
];
const isCache = (rel: string) => CACHES.some(c => c.test(rel));

/**
 * The newest change in a folder, links not followed; `now` past WALK_MAX entries (as if just touched). Asynchronous:
 * the main process keeps answering. With `cachesAside`, the rebuildable caches are not walked.
 */
async function newestChange(dir: string, now: number, cachesAside = false, maxDepth = Infinity): Promise<number> {
  let newest = 0;
  let seen = 0;
  const stack: Array<[string, number]> = [[dir, 0]];
  while (stack.length) {
    const [at, depth] = stack.pop()!;
    let st: fs.Stats;
    try { st = await fs.promises.lstat(at); } catch { continue; }
    newest = Math.max(newest, st.mtimeMs);
    if (++seen > WALK_MAX) return now;
    if (!st.isDirectory() || depth >= maxDepth) continue;
    let names: string[] = [];
    try { names = await fs.promises.readdir(at); } catch { continue; }
    for (const n of names) {
      const child = path.join(at, n);
      if (cachesAside && isCache(path.relative(dir, child).split(path.sep).join('/'))) continue;
      stack.push([child, depth + 1]);
    }
  }
  return newest;
}

/** The never list: folders nothing is ever proposed in. */
function never(world: JanitorWorld): string[] {
  const h = world.home;
  return [
    world.privateDir, path.join(h, 'Documents'), path.join(h, '.cache', 'uv'), path.join(h, 'Library', 'Caches', 'uv'),
    path.join(h, '.Trash'), path.join(h, 'Library', 'Developer'), '/Library/Developer',
  ].map(real);
}

/** A folder on the never list, or under one (a project in ~/Documents, a .worktrees linked into it). */
function onNeverList(world: JanitorWorld, p: string): boolean {
  const at = real(p);
  return never(world).some(n => inside(at, n));
}

/** Why a folder is not the janitor's to propose, or undefined. */
function kept(world: JanitorWorld, p: string, worktree?: string): string | undefined {
  const at = real(p);
  if (never(world).some(n => inside(at, n))) return 'it is on the never list';
  if (world.processes === null) return 'the processes cannot be read';
  const folder = worktree ? real(worktree) : at;
  // In it by its working folder, its executable or an open file, or named on its command line (M1). The paths come
  // resolved once with the world (janitor-processes.ts): compared as strings here, never resolved again per folder.
  const user = world.processes.find(c => c.paths.some(x => inside(x, folder)) || c.command.includes(folder) || (folder !== p && c.command.includes(p)));
  if (user) return `${user.command.split(' ')[0]} (${user.pid}) runs in it`;
  if (worktree && world.fleet.some(a => real(a.worktreePath || a.projectPath) === folder)) return 'an agent of the fleet works in it';
  return undefined;
}

type Progress = (p: { what: string; done: number; total: number; foundBytes: number }) => void;

/**
 * Where a scan looks: everywhere, or, for an approved item's re-check, its own kind in its own place (2.0.7): the
 * re-check ran the whole scan for each item, Docker and every project included, and four items behind a Docker that
 * answered in 40 s took four whole scans.
 */
export type ScanScope = { kinds: JanitorKind[]; project?: string; agentTmp?: string };
const WORKTREE_KINDS: readonly JanitorKind[] = ['next-cache', 'test-artefacts', 'closed-worktree', 'release-folder', 'worktree-node-modules'];
const looksAt = (scope: ScanScope | undefined, kinds: readonly JanitorKind[]) => !scope || kinds.some(k => scope.kinds.includes(k));

/**
 * What electron-builder writes into its output folder, measured in the Tars checkout's release/ (builder-debug.yml),
 * and the Audit's other marker: a release/ holding neither is a user's own folder (the Audit's M1 on #605).
 */
const BUILDER_MARKERS = ['builder-debug.yml', 'builder-effective-config.yaml'];
const isFile = (p: string) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };
/** The update manifests electron-builder writes beside its artefacts (latest.yml, latest-mac.yml, latest-linux.yml...). */
const UPDATE_MANIFEST = /^latest(-[a-z0-9]+)?\.yml$/;

/**
 * A second sign of a build beside the marker, which an injected agent could plant alone in an ignored folder of the
 * owner's (the Audit's Info on #605): an update manifest, or an artefact beside its .blockmap (measured in the Tars
 * checkout's release/: latest-mac.yml, the .dmg and the .zip each with theirs). A .blockmap alone is none.
 */
function builtHere(dir: string): boolean {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return false; }
  if (!BUILDER_MARKERS.some(m => names.includes(m) && isFile(path.join(dir, m)))) return false;
  return names.some(n => (UPDATE_MANIFEST.test(n) && isFile(path.join(dir, n)))
    || (n.endsWith('.blockmap') && names.includes(n.slice(0, -'.blockmap'.length)) && isFile(path.join(dir, n.slice(0, -'.blockmap'.length)))));
}

/**
 * The release/ of a folder (a project or a worktree), when it is electron-builder's output by its own evidence (its
 * marker, no file git tracks, ignored by git, or untracked in a worktree: at a project's root that is uncommitted
 * work), old, and nothing works in it.
 */
async function releaseItem(world: JanitorWorld, folder: string, label: string, project: string, atRoot: boolean): Promise<JanitorItem | undefined> {
  const p = path.join(folder, 'release');
  if (!isDir(p) || !builtHere(p) || kept(world, p) || world.named(p)) return undefined;
  const git = world.tracking ? await world.tracking(p) : null;
  if (git !== 'ignored' && !(git === 'untracked' && !atRoot)) return undefined;
  const changed = await newestChange(p, world.now);
  if (changed > world.now - RELEASE_IDLE_DAYS * DAY) return undefined;
  return {
    id: idOf('release-folder', p), kind: 'release-folder', path: p, project, label: `${label}/release`, sizeBytes: await world.sizeOf(p),
    rule: `electron-builder's output (its builder-debug.yml, and its update manifest or an artefact beside its .blockmap), git tracking nothing in it, untouched for ${RELEASE_IDLE_DAYS} days, nothing running in it`,
    why: `last changed ${day(changed)}`,
  };
}

async function scanWorktrees(world: JanitorWorld, out: JanitorItem[], step: (what: string) => void, scope?: ScanScope): Promise<void> {
  const wants = (k: JanitorKind) => !scope || scope.kinds.includes(k);
  for (const project of world.projects) {
    step(`the worktrees of ${path.basename(project)}`);
    if (scope && (!scope.project || real(scope.project) !== real(project))) continue;
    if (onNeverList(world, project)) continue;
    // The project's own release/: a build output, not its source.
    if (wants('release-folder')) {
      const own = await releaseItem(world, project, path.basename(project), project, true);
      if (own) out.push(own);
    }
    const list = await world.worktrees(project);
    if (!list) continue;
    const base = real(path.join(project, '.worktrees'));
    if (onNeverList(world, base)) continue;
    for (const w of list) {
      const wt = real(w.path);
      if (!inside(wt, base) || wt === base || real(project) === wt) continue;
      if (kept(world, wt, wt)) continue;
      if ((await world.dirty(wt)) !== false) continue;
      const name = path.relative(project, wt);
      const merged = w.branch ? await world.merged(project, w.branch) : null;
      const idleSince = await newestChange(wt, world.now, true);
      const details = { branch: w.branch ?? null, merged, idleDays: Math.floor((world.now - idleSince) / DAY), clean: true };
      for (const [kind, dirName] of [['next-cache', '.next'], ['test-artefacts', 'test-results'], ['test-artefacts', 'playwright-report']] as const) {
        const p = path.join(wt, dirName);
        if (!wants(kind) || !isDir(p)) continue;
        const changed = await newestChange(p, world.now);
        if (changed > world.now - CACHE_IDLE_DAYS * DAY) continue;
        if (kind === 'test-artefacts' && world.named(p)) continue;
        out.push({
          id: idOf(kind, p), kind, path: p, project: wt, label: `${name}/${dirName}`, sizeBytes: await world.sizeOf(p), details,
          why: `last changed ${day(changed)}`,
          rule: kind === 'next-cache'
            ? `the .next of a worktree nothing runs in, untouched for ${CACHE_IDLE_DAYS} days`
            : `test artefacts of a worktree nothing runs in, untouched for ${CACHE_IDLE_DAYS} days, named by no report`,
        });
      }
      if (wants('release-folder')) {
        const release = await releaseItem(world, wt, name, wt, false);
        if (release) out.push(release);
      }
      // Its node_modules, by the worktree's idleness: one of more than 20,000 entries reads as just touched when walked.
      const modules = path.join(wt, 'node_modules');
      if (wants('worktree-node-modules') && isDir(modules) && !world.named(modules)
        && idleSince <= world.now - NODE_MODULES_IDLE_DAYS * DAY && (await fs.promises.lstat(modules)).mtimeMs <= world.now - NODE_MODULES_IDLE_DAYS * DAY) {
        out.push({
          id: idOf('worktree-node-modules', modules), kind: 'worktree-node-modules', path: modules, project: wt, label: `${name}/node_modules`,
          sizeBytes: await world.sizeOf(modules), details,
          rule: `the node_modules of a worktree nothing changed in for ${NODE_MODULES_IDLE_DAYS} days, nothing running in it; a clone of another worktree's (scripts/worktree.mjs) shares most of its blocks and frees less than its size`,
          why: `the worktree last changed ${day(idleSince)}`,
        });
      }
      if (!wants('closed-worktree') || w.locked || merged !== true) continue;
      if (idleSince > world.now - WORKTREE_IDLE_DAYS * DAY) continue;
      // As scripts/worktree.mjs refuses (the Audit's M2): ignored files but the caches, and an operation under way.
      const ignored = await world.ignored(wt);
      if (ignored === null || ignored.some(f => !isCache(f))) continue;
      if ((await world.operation(wt)) !== null) continue;
      out.push({
        id: idOf('closed-worktree', wt), kind: 'closed-worktree', path: wt, project, label: name, sizeBytes: await world.sizeOf(wt), details,
        why: `its branch ${w.branch} is merged, last changed ${day(idleSince)}`,
        rule: 'a worktree whose branch is merged, clean, no ignored file but caches, unlocked, idle a day, no agent\'s, nothing running in it',
      });
    }
  }
}

async function scanFolders(world: JanitorWorld, out: JanitorItem[], step: (what: string) => void, scope?: ScanScope): Promise<void> {
  step('the npx cache');
  if (!scope || scope.kinds.includes('npx-cache')) await scanNpx(world, out);
  step('the temporary folders of agents gone');
  if (!scope || scope.kinds.includes('agent-tmp')) await scanGoneTmp(world, out);
  for (const item of await scanLiveTmp(world, step, scope)) out.push(item);
}

/** How deep a temporary folder's entry is walked for its last change: a run's output can hold tens of thousands of files. */
const TMP_DEPTH = 4;
const subdirs = (dir: string) => { try { return fs.readdirSync(dir).filter(n => isDir(path.join(dir, n))); } catch { return []; } };

/**
 * What a live agent leaves in its temporary folders (services/agent-tmp.ts: t is its TMPDIR, c Claude Code's, where
 * each session keeps its scratchpad and its background tasks' output): an ended session's folder, and old entries of
 * the current session's scratchpad and of t/. Each carries the agent's project, so its orchestrator is shown it.
 */
async function scanLiveTmp(world: JanitorWorld, step: (what: string) => void, scope?: ScanScope): Promise<JanitorItem[]> {
  step('the temporary folders of agents');
  const sessionsToo = !scope || scope.kinds.includes('session-scratchpad');
  const entriesToo = !scope || scope.kinds.includes('agent-tmp-entry');
  const items: JanitorItem[] = [];
  if (!sessionsToo && !entriesToo) return items;
  for (const agent of world.fleet) {
    const short = shortIdOf(agent.id);
    const root = path.join(world.dataDir, 'tmp', short);
    if (scope?.agentTmp && real(scope.agentTmp) !== real(root)) continue;
    if (!isDir(root) || onNeverList(world, root)) continue;
    const who = agent.name || agent.id;
    const old = async (p: string, days: number) => {
      if (kept(world, p) || world.named(p)) return null;
      const changed = await newestChange(p, world.now, false, TMP_DEPTH);
      return changed <= world.now - days * DAY ? changed : null;
    };
    const entry = async (p: string, label: string) => {
      const changed = await old(p, TMP_ENTRY_IDLE_DAYS);
      if (changed === null) return;
      items.push({
        id: idOf('agent-tmp-entry', p), kind: 'agent-tmp-entry', path: p, project: agent.projectPath, label, sizeBytes: await world.sizeOf(p),
        rule: `an entry of a live agent's temporary folder or of its current session's scratchpad, untouched for ${TMP_ENTRY_IDLE_DAYS} days, named by no report, nothing running in it`,
        why: `${who}'s, last changed ${day(changed)}`,
      });
    };
    if (entriesToo) for (const n of subdirs(path.join(root, 't'))) await entry(path.join(root, 't', n), `${who}: t/${n}`);
    // c/<user>/<project>/<session>: the agent's own sessions, its current and resumable ones held; with none known,
    // its newest is.
    const sessions: Array<{ dir: string; id: string; changed: number }> = [];
    for (const user of subdirs(path.join(root, 'c'))) {
      for (const proj of subdirs(path.join(root, 'c', user))) {
        for (const sid of subdirs(path.join(root, 'c', user, proj))) {
          const dir = path.join(root, 'c', user, proj, sid);
          sessions.push({ dir, id: sid, changed: await newestChange(dir, world.now, false, TMP_DEPTH) });
        }
      }
    }
    const held = new Set(agent.sessions?.length ? agent.sessions : sessions.length ? [sessions.reduce((a, b) => (b.changed > a.changed ? b : a)).id] : []);
    for (const session of sessions) {
      if (held.has(session.id)) {
        if (!entriesToo) continue;
        const pad = path.join(session.dir, 'scratchpad');
        for (const n of subdirs(pad)) await entry(path.join(pad, n), `${who}: scratchpad/${n}`);
        continue;
      }
      if (!sessionsToo || session.changed > world.now - SESSION_IDLE_DAYS * DAY || kept(world, session.dir) || world.named(session.dir)) continue;
      items.push({
        id: idOf('session-scratchpad', session.dir), kind: 'session-scratchpad', path: session.dir, project: agent.projectPath,
        label: `${who}: session ${session.id.slice(0, 8)}`, sizeBytes: await world.sizeOf(session.dir),
        rule: `an ended session's folder in a live agent's temporary folder (its scratchpad, its tasks' output), untouched for ${SESSION_IDLE_DAYS} days, named by no report, nothing running in it`,
        why: `${who}'s session ${session.id}, which it no longer holds, last changed ${day(session.changed)}`,
      });
    }
  }
  return items;
}

async function scanNpx(world: JanitorWorld, out: JanitorItem[]): Promise<void> {
  const npx = real(path.join(world.home, '.npm', '_npx'));
  let names: string[] = [];
  try { names = fs.readdirSync(npx); } catch { /* none */ }
  for (const n of names) {
    const p = path.join(npx, n);
    if (!isDir(p) || kept(world, p)) continue;
    const changed = await newestChange(p, world.now, false, NPX_DEPTH);
    if (changed > world.now - NPX_IDLE_DAYS * DAY) continue;
    out.push({ id: idOf('npx-cache', p), kind: 'npx-cache', path: p, label: `~/.npm/_npx/${n}`, sizeBytes: await world.sizeOf(p), rule: `an npx cache entry untouched for ${NPX_IDLE_DAYS} days`, why: `last used ${day(changed)}` });
  }
}

/** The temporary folders of agents no longer in the fleet. */
async function scanGoneTmp(world: JanitorWorld, out: JanitorItem[]): Promise<void> {
  const tmp = real(path.join(world.dataDir, 'tmp'));
  const live = new Set(world.fleet.map(a => shortIdOf(a.id)));
  let names: string[] = [];
  try { names = fs.readdirSync(tmp); } catch { names = []; }
  for (const n of names) {
    const p = path.join(tmp, n);
    if (!/^[0-9a-f]{10}$/.test(n) || live.has(n) || !isDir(p) || kept(world, p)) continue;
    out.push({ id: idOf('agent-tmp', p), kind: 'agent-tmp', path: p, label: `~/.tars/tmp/${n}`, sizeBytes: await world.sizeOf(p), rule: 'the temporary folders of an agent no longer in the fleet', why: `no agent of the fleet has the folder ${n}` });
  }
}

async function scanDocker(world: JanitorWorld, out: JanitorItem[], step: (what: string) => void, scope?: ScanScope): Promise<void> {
  step('Docker');
  if (!looksAt(scope, ['docker-image', 'docker-vm-trim'])) return;
  const images = await world.docker.images();
  for (const i of images ?? []) {
    if (i.used) continue;
    out.push({ id: idOf('docker-image', i.id), kind: 'docker-image', ref: i.id, label: i.repo, sizeBytes: i.sizeBytes, rule: 'a Docker image no container uses, a stopped one included', why: `${i.repo}: no container uses it` });
  }
  if (world.docker.vm) {
    out.push({ id: idOf('docker-vm-trim', 'colima'), kind: 'docker-vm-trim', ref: 'colima', label: 'the Docker VM (colima)', sizeBytes: 0, rule: 'a trim of the Docker VM, which gives the disk back what the VM freed', why: 'colima runs; what its VM freed stays taken on the disk until a trim' });
  }
}

/** What the janitor proposes now. Reads only: nothing is deleted. */
export async function scanJanitor(world: JanitorWorld, onProgress?: Progress, scope?: ScanScope): Promise<JanitorItem[]> {
  const out: JanitorItem[] = [];
  const total = world.projects.length + 4;
  let done = -1;
  const found = () => out.reduce((sum, i) => sum + i.sizeBytes, 0);
  const step = (what: string) => { done++; onProgress?.({ what, done, total, foundBytes: found() }); };
  if (looksAt(scope, WORKTREE_KINDS)) await scanWorktrees(world, out, step, scope);
  await scanFolders(world, out, step, scope);
  await scanDocker(world, out, step, scope);
  done = total - 1;
  step('done');
  // A re-check's scope is not a scan the owner was shown.
  if (!scope) last = new Map(out.map(i => [i.id, i]));
  return out;
}

/** Where an approved item is checked again: its kind, in its own project or its agent's temporary folder. */
function scopeOf(item: JanitorItem, world: JanitorWorld): ScanScope {
  const at = item.path ? real(item.path) : undefined;
  const project = at ? world.projects.find(p => inside(at, real(p))) : undefined;
  const tmpRoot = real(path.join(world.dataDir, 'tmp'));
  const agentTmp = at && inside(at, tmpRoot) ? path.join(tmpRoot, path.relative(tmpRoot, at).split(path.sep)[0]) : undefined;
  return { kinds: [item.kind], ...(project ? { project } : {}), ...(agentTmp ? { agentTmp } : {}) };
}

/** The last scan's items, by id: only these can be approved. */
let last = new Map<string, JanitorItem>();

export type JanitorReport = { removed: number; freedBytes: number; kept: Array<{ id: string; label: string; why: string }> };

/**
 * The owner's approval: each approved item of the last scan, checked again against its rule just before it goes
 * (a world read anew for each), deleted by its exact path, and logged. Anything else is kept, and logged with why.
 */
export async function approveJanitor(ids: string[], worldNow: () => JanitorWorld | Promise<JanitorWorld>, ops: JanitorOps): Promise<JanitorReport> {
  const report: JanitorReport = { removed: 0, freedBytes: 0, kept: [] };
  for (const id of [...new Set(ids)]) {
    ops.checking?.(id);
    const asked = last.get(id);
    const keep = (label: string, why: string, kind: 'kept' | 'failed' = 'kept') => {
      report.kept.push({ id, label, why });
      ops.log(`${kind} ${label}: ${why}`);
      ops.done?.(id, { kind, why });
    };
    if (!asked) { keep(id, 'it is not in the scan the window showed'); continue; }
    const world = await worldNow();
    const now = await scanJanitor(world, undefined, scopeOf(asked, world));
    const item = now.find(i => i.id === id);
    if (!item) { keep(`${asked.kind} ${asked.label}`, 'it no longer matches its rule (something runs in it, it was touched, an agent took it, or it has uncommitted work)'); continue; }
    ops.beforeDelete?.(item);
    // Right before it goes: its real path is still its path, and a folder; a link planted on a parent since the
    // re-check would take the deletion elsewhere (the Audit's L4 on #542).
    if (item.path) {
      let where: string | undefined;
      try { where = fs.realpathSync.native(item.path); } catch { where = undefined; }
      let folder = false;
      try { folder = fs.lstatSync(item.path).isDirectory(); } catch { folder = false; }
      if (where !== item.path || !folder) { keep(`${item.kind} ${item.label}`, 'it is no longer where it was (moved, or reached through a link)'); continue; }
    }
    try {
      if (item.kind === 'closed-worktree') await ops.removeWorktree(item.project!, item.path!);
      else if (item.kind === 'docker-image') await ops.dockerRm(item.ref!);
      else if (item.kind === 'docker-vm-trim') await ops.trim();
      else await ops.rm(item.path!);
      // What the owner saw it take: the re-check does not measure again.
      report.removed++;
      report.freedBytes += asked.sizeBytes;
      ops.log(`${item.kind} ${item.path ?? item.ref}: freed ${asked.sizeBytes} bytes`);
      ops.done?.(id, { kind: 'deleted', bytes: asked.sizeBytes });
    } catch (err) {
      keep(`${item.kind} ${item.label}`, `the deletion failed: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`, 'failed');
    }
  }
  return report;
}
