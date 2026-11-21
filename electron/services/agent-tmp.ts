import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { DATA_DIR } from '../constants';
import { usesPath, type InUse } from './paths-in-use';

/**
 * A durable temporary folder per agent (RD-REDEMARRAGE.md, 2.1, approved by
 * JeanBrasse on 2026-10-05).
 *
 * macOS empties /private/tmp and the app's /var/folders/.../T at every boot,
 * and every agent's scratchpad and background task output went with them on
 * the night of 2026-10-01: Claude Code files those under its own
 * CLAUDE_CODE_TMPDIR, the agent's commands under TMPDIR, and Tars set neither.
 * Each agent now gets ~/.tars/tmp/<short id>/, with `t/` as the TMPDIR of
 * its commands and `c/` as Claude Code's CLAUDE_CODE_TMPDIR. ~/.tars is in
 * every agent's --add-dir, so writing there asks no permission. The path stays
 * short, as the Unix sockets made under it require.
 *
 * Kept 7 days and 20 GB in all (10 GB when the disk has under 30 GB free),
 * oldest first, or the disk fills up again as it did that night: see
 * enforceTmpRetention.
 */

export const TMP_ROOT = path.join(DATA_DIR, 'tmp');

/** The agent's folder name: ten hex characters of its id, the same at every launch. */
export function shortIdOf(agentId: string): string {
  return createHash('sha256').update(agentId).digest('hex').slice(0, 10);
}

/** A real folder of its owner alone: a link planted in its place is removed, not followed. */
function ownDir(dir: string): void {
  try {
    if (!fs.lstatSync(dir).isDirectory()) fs.rmSync(dir, { force: true });
  } catch { /* absent */ }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** The two variables an agent's CLI is given, its folders made first. */
export function agentTmpEnv(agentId: string, root = TMP_ROOT): { TMPDIR: string; CLAUDE_CODE_TMPDIR: string } {
  const dir = path.join(root, shortIdOf(agentId));
  const t = path.join(dir, 't');
  const c = path.join(dir, 'c');
  for (const each of [root, dir, t, c]) ownDir(each);
  return { TMPDIR: t, CLAUDE_CODE_TMPDIR: c };
}

/**
 * The same, or nothing when the folder cannot be made (a full disk, a file in
 * its way): the CLI then starts with the temporary folder it would have had,
 * rather than not at all.
 */
export function agentTmpEnvOrNone(agentId: string): { TMPDIR?: string; CLAUDE_CODE_TMPDIR?: string } {
  try {
    return agentTmpEnv(agentId);
  } catch (err) {
    console.warn(`[agent-tmp] no durable temporary folder for ${agentId}: ${(err as Error).message}`);
    return {};
  }
}

/** Where each deletion is written: ~/.tars/logs/agent-tmp.log, moved to .1 past 256 KB. */
export function retentionLog(line: string, file = path.join(DATA_DIR, 'logs', 'agent-tmp.log')): void {
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(file).size > 256 * 1024) fs.renameSync(file, `${file}.1`);
    } catch { /* none yet */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch { /* the console has it */ }
}

// ── The retention ─────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const GB = 1024 ** 3;
export const TMP_MAX_AGE_MS = 7 * DAY_MS;
/**
 * What an agent whose CLI runs keeps: what was touched within a day, and the
 * folders of the sessions it runs or would resume, whatever their age. It kept
 * everything for as long as it ran: on 2026-10-13 one agent's folder held
 * 18.5 GB of its project's test sandboxes and build folders, and the pass
 * deleted nothing.
 */
export const TMP_LIVE_IDLE_MS = DAY_MS;
/**
 * How long a unit's measure is reused while the unit cannot be old enough to
 * go: a pass walked every file of every agent every hour (1.36 million lstat,
 * 49 s, 7 s of it on the main thread, on 2026-10-13) to delete nothing. A
 * unit's newest change only moves forward, so one seen touched within the
 * shortest limit cannot reach it before that limit has passed; its size is
 * weighed again after this.
 */
export const TMP_REMEASURE_MS = 6 * 3_600_000;
export const TMP_CAP_BYTES = 20 * GB;
export const TMP_LOW_DISK_BYTES = 30 * GB;
export const TMP_LOW_DISK_CAP_BYTES = 10 * GB;

export interface RetentionDeps {
  root?: string;
  now?: () => number;
  /** Agents whose CLI runs now, in a terminal or a delegated run: nothing of theirs is deleted. */
  liveAgentIds: () => string[];
  /** Every agent of the fleet: a folder of none of them belongs to a deleted agent. */
  knownAgentIds: () => string[];
  /** The sessions an agent runs or would resume: their folders in its `c/` are kept while it runs, whatever their age. */
  sessionsOf?: (agentId: string) => string[];
  /** Free space on the disk that holds the root, or null when it cannot be read. */
  freeBytes?: () => number | null;
  capBytes?: number;
  log?: (line: string) => void;
  /**
   * What the live processes use (paths-in-use.ts), read once a unit is about to go: a unit one of them uses is kept,
   * whatever its date. Undefined from it: they could not be read, and nothing is deleted that pass.
   */
  inUse?: () => Promise<InUse | undefined>;
}

/** One thing the retention keeps or deletes whole. */
interface Unit {
  path: string;
  owner: string;
  bytes: number;
  /** Its newest modification or run (an executable's access time), itself and everything under it: its age. */
  newest: number;
  /** Its newest modification alone, as the pass weighed units before an access time counted: the cap's order. */
  changed: number;
  /**
   * It holds a socket or a FIFO, itself or under it: what a running server
   * listens on (claude's messaging socket in `c/cc-socks`, a tmux, an editor),
   * whose date never moves while it is used (the Audit's M1 on #384).
   */
  live?: boolean;
}

export interface RetentionResult {
  removed: Array<{ path: string; bytes: number; reason: string }>;
  totalBytes: number;
  capBytes: number;
  /** The units this pass walked; the others were weighed from an earlier pass. */
  walked: number;
}

/** Each unit's last measure, and when it was taken, kept between passes. */
const measures = new Map<string, { bytes: number; newest: number; changed: number; live: boolean; at: number }>();

/** Size and newest date of what is under `p`, never through a link; null when it cannot be read. */
async function measure(p: string): Promise<{ bytes: number; newest: number; changed: number; live: boolean } | null> {
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(p);
  } catch {
    return null;
  }
  let bytes = st.isDirectory() ? 0 : (typeof st.blocks === 'number' ? st.blocks * 512 : st.size);
  // An executable's run is a use: running it changes no date but its access time (measured on APFS 21/11; Linux's
  // relatime too). A data file's access time is not read: a read does not move it on APFS, and an indexer's daily
  // reads would keep everything on Linux. Folders' neither: this walk reads them.
  let newest = st.isFile() && (st.mode & 0o111) !== 0 ? Math.max(st.mtimeMs, st.atimeMs) : st.mtimeMs;
  let changed = st.mtimeMs;
  let live = st.isSocket() || st.isFIFO();
  if (st.isDirectory()) {
    let names: string[];
    try {
      names = await fs.promises.readdir(p);
    } catch {
      return null;
    }
    for (const name of names) {
      const inner = await measure(path.join(p, name));
      if (!inner) return null;
      bytes += inner.bytes;
      newest = Math.max(newest, inner.newest);
      changed = Math.max(changed, inner.changed);
      live = live || inner.live;
    }
  }
  return { bytes, newest, changed, live };
}

async function childrenOf(dir: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(dir)).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

async function isRealDir(p: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What the retention weighs, one unit at a time: each entry of an agent's
 * `t/`, each Claude Code session folder of its `c/`
 * (`claude-<uid>/<project>/<session>`), and the whole folder of an agent the
 * fleet no longer has, or anything at the top that is not a real folder.
 */
async function unitsOf(root: string, known: Map<string, string>): Promise<Array<{ path: string; owner: string }>> {
  const units: Array<{ path: string; owner: string }> = [];
  for (const top of await childrenOf(root)) {
    const owner = known.get(path.basename(top));
    if (!owner || !(await isRealDir(top))) {
      units.push({ path: top, owner: owner ?? '' });
      continue;
    }
    for (const entry of await childrenOf(path.join(top, 't'))) units.push({ path: entry, owner });
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const entry of await childrenOf(dir)) {
        if (depth < 3 && (await isRealDir(entry)) && (await childrenOf(entry)).length > 0) await walk(entry, depth + 1);
        else units.push({ path: entry, owner });
      }
    };
    await walk(path.join(top, 'c'), 1);
    for (const other of await childrenOf(top)) {
      if (!['t', 'c'].includes(path.basename(other))) units.push({ path: other, owner });
    }
  }
  return units;
}

/**
 * One pass: deletes what nothing touched for 7 days, or for a day when its
 * agent runs (never the folder of the session it runs or would resume), then
 * the oldest first while the whole is over the cap, nothing of a running agent
 * there. Never through a
 * link (a link is deleted as the link it is), nothing outside the root, and
 * nothing at all when the root itself is a link.
 */
export async function enforceTmpRetention(deps: RetentionDeps): Promise<RetentionResult> {
  const root = deps.root ?? TMP_ROOT;
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? ((line: string) => console.log(line));
  const free = deps.freeBytes?.() ?? null;
  const lowDisk = free !== null && free < TMP_LOW_DISK_BYTES;
  const capBytes = deps.capBytes ?? (lowDisk ? TMP_LOW_DISK_CAP_BYTES : TMP_CAP_BYTES);
  const result: RetentionResult = { removed: [], totalBytes: 0, capBytes, walked: 0 };
  if (lowDisk) {
    log(`[agent-tmp] under 30 GB free on the disk (${(free / GB).toFixed(1)} GB): the agents' temporary folders are kept to ${(capBytes / GB).toFixed(0)} GB`);
  }

  let rootReal: string;
  try {
    const st = fs.lstatSync(root);
    if (!st.isDirectory()) {
      log(`[agent-tmp] ${root} is a link or not a folder: nothing is measured or deleted under it`);
      return result;
    }
    rootReal = fs.realpathSync(root);
  } catch {
    return result;
  }
  /**
   * Still the folder the pass began in, and the entry still inside it. Checked
   * before each deletion, not once: a pass awaits a long time between its
   * start and its deletions, and an agent that swapped ~/.tars/tmp for a
   * link meanwhile would have the same name deleted elsewhere (the Audit's
   * gate of #306).
   */
  const stillInside = (p: string): boolean => {
    try {
      if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== rootReal) return false;
      const parent = fs.realpathSync(path.dirname(p));
      return parent === rootReal || parent.startsWith(rootReal + path.sep);
    } catch {
      return false;
    }
  };

  const known = new Map(deps.knownAgentIds().map((id) => [shortIdOf(id), id] as const));
  const sessionsOf = deps.sessionsOf ?? (() => []);
  /** A folder of a session its agent runs or would resume (`c/<claude-uid>/<project>/<session>`). */
  const isLiveSession = (p: string, owner: string, running: Set<string>): boolean => {
    const parts = path.relative(root, p).split(path.sep);
    return !!owner && running.has(owner) && parts[1] === 'c' && parts.length === 5 && sessionsOf(owner).includes(parts[4]);
  };
  const units: Unit[] = [];
  const seen = new Set<string>();
  for (const { path: p, owner } of await unitsOf(root, known)) {
    seen.add(p);
    const last = measures.get(p);
    // Weighed from the last pass while it cannot be deletable yet: touched
    // within the shortest limit, so not old enough for any rule before then.
    if (last && last.newest > now - TMP_LIVE_IDLE_MS && now - last.at < TMP_REMEASURE_MS) {
      units.push({ path: p, owner, bytes: last.bytes, newest: last.newest, changed: last.changed, live: last.live });
      continue;
    }
    const m = await measure(p);
    result.walked += 1;
    if (!m) {
      measures.delete(p);
      log(`[agent-tmp] ${p} could not be read: kept, and weighed again at the next pass`);
      continue;
    }
    measures.set(p, { ...m, at: now });
    units.push({ path: p, owner, ...m });
  }
  for (const p of measures.keys()) if (!seen.has(p) && (p === root || p.startsWith(root + path.sep))) measures.delete(p);

  // Who runs now, read once the measuring is done: an agent started during a
  // long pass is spared too.
  const live = new Set(deps.liveAgentIds());
  let swapped = false;
  // What the live processes use, read before the first deletion of the pass, once (QA's gate of #601's stack: the
  // gate's codex and Kimi went while it ran them). Compared under both spellings of a unit, the root's and the real
  // one (macOS's /tmp is /private/tmp), which is the one lsof and /proc give.
  let inUseRead: Promise<InUse | undefined> | undefined;
  let unreadSaid = false;
  /** Units kept for a live process's use (the Audit's L1 on #627): weighed out of the cap, as the pass before took them. */
  const inUseKept = new Set<string>();
  const usedBy = async (resolved: string): Promise<'used' | 'unknown' | 'free'> => {
    if (!deps.inUse) return 'free';
    inUseRead ??= deps.inUse().catch(() => undefined);
    const inUse = await inUseRead;
    if (!inUse) return 'unknown';
    return usesPath(inUse, [resolved, rootReal + resolved.slice(root.length)]) ? 'used' : 'free';
  };
  const remove = async (unit: Unit, reason: string): Promise<boolean> => {
    const resolved = path.resolve(unit.path);
    if (swapped || !resolved.startsWith(root + path.sep)) return false;
    if (!stillInside(resolved)) {
      swapped = true;
      log(`[agent-tmp] ${root} was moved or changed into a link during the pass: nothing more is deleted until the next one`);
      return false;
    }
    // Its top's date, read again: a pass can take a minute and more between
    // its measures and its deletions, and a unit written meanwhile stays (L3).
    try {
      if ((await fs.promises.lstat(resolved)).mtimeMs > unit.changed) {
        log(`[agent-tmp] ${resolved} changed since it was weighed: kept`);
        return false;
      }
    } catch {
      return false;
    }
    const use = await usedBy(resolved);
    if (use === 'unknown') {
      if (!unreadSaid) log('[agent-tmp] the processes could not be read: nothing is deleted this pass, in case one of them uses it');
      unreadSaid = true;
      return false;
    }
    if (use === 'used') {
      inUseKept.add(unit.path);
      log(`[agent-tmp] ${resolved} is in use by a live process (its executable, its current folder, a file it holds open, or its command line): kept`);
      return false;
    }
    // Moved aside in one step, then deleted: Windows refuses the move while a process holds the unit (a running image,
    // its current folder), where a recursive removal would have deleted what it could around it.
    const aside = `${resolved}.tars-removing-${process.pid}-${now.toString(36)}`;
    try {
      await fs.promises.rename(resolved, aside);
    } catch (err) {
      log(`[agent-tmp] ${resolved} could not be moved aside to be deleted (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}): kept whole, a process may hold it`);
      return false;
    }
    try {
      await fs.promises.rm(aside, { recursive: true, force: true });
    } catch (err) {
      log(`[agent-tmp] ${aside} could not be deleted (${(err as Error).message}): left, and weighed again at the next pass`);
      return false;
    }
    measures.delete(unit.path);
    result.removed.push({ path: resolved, bytes: unit.bytes, reason });
    const since = new Date(unit.newest).toISOString().slice(0, 16).replace('T', ' ');
    log(`[agent-tmp] removed ${resolved} (${unit.bytes} bytes, untouched since ${since}): ${reason}`);
    return true;
  };

  // A project's folder is its absolute path, every other character a dash:
  // `-Users-demo-tars`, `C--Users-demo-tars` on Windows. Beside them Claude
  // Code keeps `bash-edit-diff` and `bundled-skills/<version>/<hash>`, as deep.
  const PROJECT_FOLDER = /^(-|[A-Za-z]--)/;
  /**
   * What a running agent no longer uses: an entry of its `t/`, or the folder
   * of a Claude Code session in its `c/` that it neither runs nor would
   * resume, holding nothing a server listens on. What else is in `c/` (the
   * messaging sockets' folder, Claude Code's own diffs, its bundled skills) is
   * Claude Code's, kept while it runs. A session the agent runs is known from its record: a
   * nested CLI that took the record would leave the real one's folder
   * unprotected, which #380 closes (L2).
   */
  const isLeftover = (unit: Unit): boolean => {
    if (unit.live) return false;
    const parts = path.relative(root, unit.path).split(path.sep);
    if (parts[1] === 't') return parts.length === 3;
    return parts[1] === 'c' && parts.length === 5 && PROJECT_FOLDER.test(parts[3])
      && !isLiveSession(unit.path, unit.owner, live);
  };
  const kept: Unit[] = [];
  for (const unit of units) {
    const mine = unit.owner && live.has(unit.owner);
    if (!mine && unit.newest < now - TMP_MAX_AGE_MS && (await remove(unit, 'untouched for 7 days'))) continue;
    if (mine && isLeftover(unit) && unit.newest < now - TMP_LIVE_IDLE_MS
      && (await remove(unit, 'untouched for a day, its agent running'))) continue;
    kept.push(unit);
  }

  // The cap deletes what it deleted before 17, less what is used (the Audit's L1 on #627): units in the order of their
  // changes, as before; what a live process uses, or what was run since its last change (an executable's access
  // time), is weighed out and never cut, as the pass before took it and went on. So it deletes no unit the pass before
  // kept, and what is used can stay over the cap without bound (said below).
  const usedOrRun = (u: Unit) => inUseKept.has(u.path) || u.newest > u.changed;
  let total = kept.reduce((sum, u) => sum + (usedOrRun(u) ? 0 : u.bytes), 0);
  const oldestFirst = kept.filter((u) => !(u.owner && live.has(u.owner))).sort((a, b) => a.changed - b.changed);
  for (const unit of oldestFirst) {
    if (total <= capBytes) break;
    if (usedOrRun(unit)) continue;
    if (await remove(unit, `over ${(capBytes / GB).toFixed(0)} GB in all, the oldest first`)) total -= unit.bytes;
    else if (inUseKept.has(unit.path)) total -= unit.bytes;
  }
  const usedBytes = kept.reduce((sum, u) => sum + (usedOrRun(u) ? u.bytes : 0), 0);
  if (total > capBytes) {
    log(`[agent-tmp] still ${total} bytes over a cap of ${capBytes}: what is left belongs to agents whose CLI runs`);
  }
  if (usedBytes > 0 && total + usedBytes > capBytes) {
    log(`[agent-tmp] ${usedBytes} bytes in use by live processes or run since their last change are kept, never cut to the cap`);
  }
  result.totalBytes = total + usedBytes;
  return result;
}

/** At launch (a minute after, out of the way of the start) and every hour. */
export function startTmpRetention(deps: RetentionDeps, opts: { firstMs?: number; everyMs?: number } = {}): () => void {
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    enforceTmpRetention(deps)
      .catch((err) => console.warn('[agent-tmp] the retention pass failed:', err))
      .finally(() => { running = false; });
  };
  const first = setTimeout(pass, opts.firstMs ?? 60_000);
  const every = setInterval(pass, opts.everyMs ?? 3_600_000);
  first.unref?.();
  every.unref?.();
  return () => { clearTimeout(first); clearInterval(every); };
}
