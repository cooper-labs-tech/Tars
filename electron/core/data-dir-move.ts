import * as fs from 'fs';
import * as path from 'path';

/**
 * Tars's data folder is ~/.tars since 2.0.4 (the maintainer's decision of
 * 18/10), and was ~/.dorothy. It moves once, at the start, before anything
 * reads or writes it: constants/index.ts settles it as it loads, and every
 * path of the app is computed from what it answers.
 *
 * The move is one rename in the home folder, which the system does whole or
 * not at all: stopped at any moment, the data is in one place or the other,
 * never in both, never half. A link is then left at ~/.dorothy (a junction on
 * Windows, which needs no privilege) for what outside Tars still names the
 * old path: a CLI's settings Tars has not rewritten yet, an agent started by
 * an older Tars, a script of the user's. It is for 2.0.4 only; the next
 * version removes it.
 *
 * Nothing here deletes, copies or merges: when the folder cannot be moved
 * (Windows refuses to rename a folder a process holds), Tars goes on from
 * ~/.dorothy for this run and tries again at the next start; when two
 * different folders stand at ~/.tars and ~/.dorothy, the one that holds
 * Tars's records is used, the other left as it is, and the window is told
 * (`notice`). Which folder that is, pickDataDir decides, and every reader
 * outside the app (the hooks, the status line, the MCP servers, worktree.mjs)
 * follows the same rule. This file imports nothing of the app's: it runs
 * before the app's paths exist.
 */

export const DATA_DIR_NAME = '.tars';
export const LEGACY_DATA_DIR_NAME = '.dorothy';

export interface DataDirOutcome {
  /** The folder this run uses. */
  dir: string;
  /** moved: this start moved it; already: it was moved before; kept-old: it could not move; both: two different folders; none: a first start. */
  did: 'moved' | 'already' | 'kept-old' | 'both' | 'none';
  /** Whether the link of 2.0.4, to ~/.tars, is at ~/.dorothy, made now or before. */
  linked: boolean;
  why?: string;
  /** What the user must be told in the window: two folders, and which one Tars uses. */
  notice?: string;
}

interface Deps {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => void;
  symlink?: (target: string, at: string, type?: 'dir' | 'junction') => void;
}

/** Something is at p, a link that leads nowhere included. */
function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** A folder at p, or a link to one. */
function folder(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sameFolder(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

/** Tars's records: what a folder that is Tars's holds, and a folder of somebody else's does not. */
function holdsRecords(dir: string): boolean {
  return ['agents.json', 'app-settings.json'].some((f) => {
    try {
      return fs.statSync(path.join(dir, f)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * The data folder as the home is now, the move done or not: ~/.tars when it is
 * a folder, ~/.dorothy when ~/.tars is anything else (a file, a link to one, a
 * link that leads nowhere) or nothing while ~/.dorothy is a folder; and when
 * both are folders and not the same one, ~/.dorothy only if it holds Tars's
 * records and ~/.tars does not. It reads and never writes: the readers outside
 * the app copy this rule (hooks/tars-hook-lib.mjs, hooks/tars-hook.sh,
 * hooks/statusline.mjs, mcp-shared/src/settings.ts, scripts/worktree.mjs), and
 * data-dir-readers.test.ts holds them all to it.
 */
export function pickDataDir(home: string): string {
  const tars = path.join(home, DATA_DIR_NAME);
  const old = path.join(home, LEGACY_DATA_DIR_NAME);
  if (!folder(tars)) return present(tars) || folder(old) ? old : tars;
  if (!folder(old) || sameFolder(tars, old)) return tars;
  return holdsRecords(old) && !holdsRecords(tars) ? old : tars;
}

const reason = (err: unknown) => `${(err as NodeJS.ErrnoException)?.code ?? ''} ${(err as Error)?.message ?? String(err)}`.trim();

export function settleDataDir(home: string, deps: Deps = {}): DataDirOutcome {
  const platform = deps.platform ?? process.platform;
  const rename = deps.rename ?? ((a: string, b: string) => fs.renameSync(a, b));
  const symlink = deps.symlink ?? ((target: string, at: string, type?: 'dir' | 'junction') => fs.symlinkSync(target, at, type));
  const tars = path.join(home, DATA_DIR_NAME);
  const old = path.join(home, LEGACY_DATA_DIR_NAME);

  /** The link at the old place, for 2.0.4: made, or why it was not. */
  const link = (): { linked: boolean; why?: string } => {
    try {
      // Relative where it can be, so a home that moves keeps it whole; Windows takes a junction's absolute target.
      if (platform === 'win32') symlink(tars, old, 'junction');
      else symlink(DATA_DIR_NAME, old, 'dir');
      return { linked: true };
    } catch (err) {
      return { linked: false, why: `no link left at ${old}: ${reason(err)}` };
    }
  };

  if (present(tars) && !folder(tars)) {
    return { dir: old, did: 'kept-old', linked: false, why: `${tars} is not a folder: Tars stays in ${old}` };
  }
  if (folder(tars)) {
    if (!present(old)) return { dir: tars, did: 'already', ...link() };
    if (!folder(old)) return { dir: tars, did: 'already', linked: false, why: `${old} is not a folder: no link left there` };
    if (sameFolder(tars, old)) return { dir: tars, did: 'already', linked: fs.lstatSync(old).isSymbolicLink() };
    // Two different folders: an older Tars ran after the link was removed, a
    // ~/.dorothy kept on another disk, a ~/.tars of somebody else's. Neither
    // is touched; Tars uses the one with its records, and says so.
    const dir = pickDataDir(home);
    const other = dir === tars ? old : tars;
    const notice = `Two data folders: ${tars} and ${old}, which are not the same folder. Tars uses ${dir}${dir === old ? ', which holds its agents and settings' : ''}, and has left ${other} as it is.`;
    return { dir, did: 'both', linked: false, why: notice, notice };
  }
  // Nothing at ~/.tars. Only a folder at ~/.dorothy, or a link to one, moves.
  if (!folder(old)) return { dir: tars, did: 'none', linked: false };
  try {
    rename(old, tars);
  } catch (err) {
    return { dir: old, did: 'kept-old', linked: false, why: `${old} could not be moved to ${tars} (${reason(err)}): Tars goes on from it, and moves it at the next start` };
  }
  return { dir: tars, did: 'moved', ...link() };
}

/** What a file rewritten keeps: under 4 MB, text. */
const REWRITE_MAX_BYTES = 4 * 1024 * 1024;
/** How often a file another program keeps writing is read again before it is left as it is. */
const REWRITE_ATTEMPTS = 3;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The old folder's path where Tars wrote it in a file outside its folder (a
 * CLI's settings and MCP servers, a status line, a scheduled job), rewritten
 * to the new one in every form Tars writes it: the absolute path, `~/`,
 * `$HOME/`, `${HOME}/`, and on Windows the path as JSON escapes it. A name
 * that only starts the same (`.dorothy-backup`) is not touched. A file
 * nothing changed in is not written; one that is keeps its mode, and is
 * written to a file of its own beside it, renamed over it. Other programs
 * write some of these files while Tars starts (every claude session rewrites
 * ~/.claude.json): the file is read again before the rename, and a change
 * made in between starts the rewrite over from what it holds now, so that
 * write is kept. A file that changes under every attempt is left as its
 * writer made it, and the link covers it in 2.0.4. Answers the files it
 * rewrote. `beforeReplace` is the tests' way into that window.
 */
export function rewriteLegacyPaths(opts: { home: string; files: string[]; winHome?: string; beforeReplace?: (file: string) => void }): string[] {
  const end = '(?![\\w.\\-])';
  const forms: Array<[RegExp, string]> = [];
  const add = (from: string, to: string) => forms.push([new RegExp(escapeRe(from) + end, 'g'), to]);
  add(path.join(opts.home, LEGACY_DATA_DIR_NAME), path.join(opts.home, DATA_DIR_NAME));
  for (const prefix of ['~/', '$HOME/', '${HOME}/']) add(prefix + LEGACY_DATA_DIR_NAME, prefix + DATA_DIR_NAME);
  if (opts.winHome) {
    add(`${opts.winHome}\\${LEGACY_DATA_DIR_NAME}`, `${opts.winHome}\\${DATA_DIR_NAME}`);
    const json = (s: string) => s.replace(/\\/g, '\\\\');
    add(json(`${opts.winHome}\\${LEGACY_DATA_DIR_NAME}`), json(`${opts.winHome}\\${DATA_DIR_NAME}`));
  }
  /** The file's text when it is one to rewrite: a file, not a link, under 4 MB, without a NUL. */
  const readable = (file: string): { text: string; mode: number } | undefined => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > REWRITE_MAX_BYTES) return undefined;
      const text = fs.readFileSync(file, 'utf8');
      return text.includes('\0') ? undefined : { text, mode: stat.mode & 0o777 };
    } catch {
      return undefined;
    }
  };
  const changed: string[] = [];
  for (const file of opts.files) {
    for (let attempt = 0; attempt < REWRITE_ATTEMPTS; attempt++) {
      const current = readable(file);
      if (!current) break;
      let next = current.text;
      for (const [re, to] of forms) next = next.replace(re, () => to);
      if (next === current.text) break;
      const temp = `${file}.tars-move-${process.pid}.tmp`;
      try {
        fs.writeFileSync(temp, next, { mode: current.mode, flag: 'wx' });
        opts.beforeReplace?.(file);
        if (readable(file)?.text !== current.text) {
          // Written to since it was read: start again from what it holds now.
          fs.rmSync(temp, { force: true });
          if (attempt === REWRITE_ATTEMPTS - 1) console.warn(`[data-dir] ${file} changed under every rewrite, left as its writer made it; the link covers it in 2.0.4`);
          continue;
        }
        fs.renameSync(temp, file);
        changed.push(file);
      } catch (err) {
        fs.rmSync(temp, { force: true });
        console.warn(`[data-dir] ${file} still names ${LEGACY_DATA_DIR_NAME}, which the link covers in 2.0.4: ${reason(err)}`);
      }
      break;
    }
  }
  return changed;
}

/**
 * The files the old path may be written in: what Tars writes outside its
 * folder (each CLI's settings and MCP servers, the status line, each Claude
 * account's folder, Tars's own launchd jobs) and its own records that hold
 * absolute paths (its JSON files, the scheduled scripts, Qwen Code's per-agent
 * settings). Logs and ledgers are left as they are: they say what was.
 */
export function legacyPathFiles(home: string, dataDir: string): string[] {
  const list = (dir: string, keep: (name: string) => boolean): string[] => {
    try {
      return fs.readdirSync(dir).filter(keep).map((n) => path.join(dir, n));
    } catch {
      return [];
    }
  };
  const claudeFiles = (dir: string) => ['settings.json', 'settings.local.json', 'mcp.json'].map((f) => path.join(dir, f));
  const accounts = list(path.join(home, '.claude-accounts'), () => true)
    .flatMap((dir) => [path.join(dir, '.claude.json'), ...claudeFiles(dir)]);
  return [
    path.join(home, '.claude.json'), ...claudeFiles(path.join(home, '.claude')), ...accounts,
    path.join(home, '.codex', 'config.toml'),
    path.join(home, '.gemini', 'settings.json'),
    path.join(home, '.grok', 'config.toml'), path.join(home, '.grok', 'user-settings.json'),
    path.join(home, '.opencode', 'config.json'), path.join(home, '.config', 'opencode', 'opencode.json'),
    path.join(home, '.config', 'kilo', 'kilo.json'),
    path.join(home, '.pi', 'mcp.json'), path.join(home, '.pi', 'settings.json'), path.join(home, '.pi', 'agent', 'settings.json'),
    path.join(home, '.config', 'amp', 'settings.json'),
    path.join(home, '.qwen', 'settings.json'),
    ...list(path.join(home, 'Library', 'LaunchAgents'), (n) => /^(xyz\.cooperlabs\.tars|com\.dorothy|com\.tars)/.test(n) && n.endsWith('.plist')),
    ...list(dataDir, (n) => n.endsWith('.json')),
    ...list(path.join(dataDir, 'scripts'), (n) => n.endsWith('.sh')),
    ...list(path.join(dataDir, 'qwen-code'), () => true).flatMap((d) => list(d, (n) => n.endsWith('.json'))),
  ];
}
