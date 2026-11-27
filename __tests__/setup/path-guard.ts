import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The folders of the homes leave PATH, and the suite's own tools come back by their resolved paths.
 *
 * path-isolation.ts applies it to every test file; path-isolation.test.ts lists how it can fail, and holds it to each.
 * Pure but for the folder of links guardPath makes, so a test can hand it another platform, another home and another
 * PATH than the run's.
 */

type Platform = NodeJS.Platform;

/** The path functions that read paths as `platform` writes them, so Windows can be stood in for elsewhere. */
const pathFor = (platform: Platform) => (platform === 'win32' ? path.win32 : path.posix);
const delimiterFor = (platform: Platform) => (platform === 'win32' ? ';' : ':');

/** The path as the filesystem resolves it, links included, for one that may not exist: its nearest existing parent's. */
export function canonicalPath(target: string): string {
  const absolute = path.resolve(target);
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

export type PathFilter = {
  /** A PATH value, in `platform`'s delimiter. */
  value: string;
  /** The homes whose folders leave: the account's, the HOME the run started with, on Windows the profile's. */
  homes: string[];
  /** What a relative or empty entry is read against. */
  cwd: string;
  platform?: Platform;
  /** How a path is resolved on disk; the run's filesystem unless a test stands in. */
  canonical?: (target: string) => string;
};

/** Each entry of `value`, kept when it lies outside every home and removed when it lies in one, each in its order. */
export function pathWithoutHomes({ value, homes, cwd, platform = process.platform, canonical = canonicalPath }: PathFilter): { kept: string[]; removed: string[] } {
  const p = pathFor(platform);
  // macOS and Windows ignore case: /users/a and C:\USERS\A are the home too.
  const fold = (s: string) => (platform === 'darwin' || platform === 'win32' ? s.toLowerCase() : s);
  const where = (entry: string) => fold(p.resolve(canonical(p.resolve(cwd, entry === '' ? '.' : entry))));
  const roots = homes
    .filter(home => home !== '')
    .map(home => p.resolve(canonical(p.resolve(cwd, home))))
    // A root as a home would take every folder: never protected.
    .filter(home => p.parse(home).root !== home)
    .map(fold);
  const kept: string[] = [];
  const removed: string[] = [];
  // An unset or empty PATH has no entry; split would read it as one empty entry, the current folder.
  for (const entry of value === '' ? [] : value.split(delimiterFor(platform))) {
    const at = where(entry);
    const inHome = roots.some(root => at === root || at.startsWith(root.endsWith(p.sep) ? root : root + p.sep));
    (inHome ? removed : kept).push(entry);
  }
  return { kept, removed };
}

/** Every file named `name` that `value` resolves to, in its order: on Windows with each of PATHEXT's extensions. */
export function findOnPath(name: string, value: string, platform: Platform = process.platform): string[] {
  const p = pathFor(platform);
  const extensions = platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  const found: string[] = [];
  for (const dir of value.split(delimiterFor(platform))) {
    if (dir === '') continue;
    for (const extension of extensions) {
      const file = p.join(dir, name + extension);
      try {
        if (!fs.statSync(file).isFile()) continue;
        fs.accessSync(file, fs.constants.X_OK);
        found.push(file);
        break;
      } catch {
        // Not here, or not one that runs.
      }
    }
  }
  return found;
}

export type GuardOptions = {
  homes: string[];
  cwd: string;
  /** Where the links to the suite's own tools are made: a folder of the file's own temporary folder. */
  binDir: string;
  /** The node running the suite, whose npm and npx come back with it. */
  execPath: string;
  platform?: Platform;
};

export type Guarded = {
  /** The entries that left, as they were written. */
  removed: string[];
  /** Each tool brought back, by the path it links to. */
  linked: Record<string, string>;
  /** PATH as it was found, unset included. */
  restore(): void;
};

/**
 * The real claude a test opted into: TARS_REAL_CLAUDE=1 is the one the PATH found, a path is that file, anything else
 * is none.
 */
function realClaude(optIn: string | undefined, original: string, platform: Platform): string | undefined {
  if (optIn === '1') return findOnPath('claude', original, platform)[0];
  if (optIn && pathFor(platform).isAbsolute(optIn) && fs.existsSync(optIn)) return optIn;
  return undefined;
}

/** `env`'s PATH without the homes' folders, the suite's own tools first. */
export function guardPath(env: NodeJS.ProcessEnv, opts: GuardOptions): Guarded {
  const platform = opts.platform ?? process.platform;
  const p = pathFor(platform);
  const delimiter = delimiterFor(platform);
  // Windows names it Path as often as PATH, and reads either.
  const key = platform === 'win32' ? Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH' : 'PATH';
  const original = env[key];
  const { kept, removed } = pathWithoutHomes({ value: original ?? '', homes: opts.homes, cwd: opts.cwd, platform });
  const linked: Record<string, string> = {};
  const lostGit = findOnPath('git', kept.join(delimiter), platform).length === 0 ? findOnPath('git', original ?? '', platform)[0] : undefined;
  const claude = realClaude(env.TARS_REAL_CLAUDE, original ?? '', platform);
  let front: string[];
  if (platform === 'win32') {
    // Windows makes a link only with a privilege the suite does not ask for: node's own folder goes first, whole,
    // and the folder of git or of the claude opted into, when only a home held it. What those folders carry
    // besides is the limit path-isolation.ts names.
    front = [p.dirname(opts.execPath), ...[lostGit, claude].filter((file): file is string => !!file).map(file => p.dirname(file))];
  } else {
    fs.mkdirSync(opts.binDir, { recursive: true });
    const link = (name: string, target: string) => {
      const at = p.join(opts.binDir, name);
      fs.rmSync(at, { force: true });
      fs.symlinkSync(target, at);
      linked[name] = target;
    };
    link('node', opts.execPath);
    for (const tool of ['npm', 'npx']) {
      const beside = p.join(p.dirname(opts.execPath), tool);
      if (fs.existsSync(beside)) link(tool, beside);
    }
    if (lostGit) link('git', lostGit);
    if (claude) link('claude', claude);
    front = [opts.binDir];
  }
  env[key] = [...new Set(front), ...kept.filter(dir => !front.includes(dir))].join(delimiter);
  return {
    removed,
    linked,
    restore() {
      if (original === undefined) delete env[key];
      else env[key] = original;
    },
  };
}
