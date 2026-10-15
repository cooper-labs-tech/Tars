import { afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { homeVariables } from './test-home';

/**
 * The suite runs in a HOME of its own, and cannot write into the one it started in.
 *
 * Measured on 2026-09-16: JeanBrasse's real ~/.claude.json held 171 project entries
 * written by this suite, one per run since 2026-09-02, each for a temp directory
 * that no longer existed. managed-cli-env.test.ts spawns through the real
 * initAgentPty and spawnAgentSession, both call ensureProjectTrusted, and that
 * reads the whole of `os.homedir()/.claude.json` and writes it back with one
 * more project. env-isolation.ts kept HOME on purpose and left each suite to
 * redirect it, and that suite never did. With the guard below and without the
 * redirect, three files write into the home they start in: that one and
 * task-never-started.test.ts into ~/.claude.json, and
 * agent-start-missing-skills.test.ts into ~/.dorothy/amp-settings.json, which
 * JeanBrasse's copy shows rewritten at the minute a suite ran. A rule each file has to
 * remember is how the class got three members.
 *
 * So this does it for every file, before the file's imports, which matters for
 * the same reason it does in env-isolation.ts: constants.ts computes DATA_DIR
 * from `os.homedir()` at module load. Children spawned without an explicit HOME
 * inherit the throwaway one too.
 *
 * The redirect removes the cause. The guard below is the witness that it holds:
 * any write, through node:fs, into the HOME the run started with or into the
 * account's home directory fails, and fails the file even when the product
 * swallows the error, as ensureProjectTrusted does. The repository is the one
 * place under that home a test may write. What it cannot see: a native module
 * writing on its own (better-sqlite3), and a child given the real HOME
 * explicitly. On Windows, two more: a child spawned with an environment that
 * lacks USERPROFILE (libuv then asks Windows for the account's real profile,
 * so its os.homedir() is the real one), and any program that asks Windows for
 * the profile folder directly instead of reading the environment, as
 * Electron's getPath('home') does.
 *
 * Windows, measured on 2026-09-25: `os.homedir()` reads USERPROFILE, not HOME,
 * so HOME alone left DATA_DIR on the real %USERPROFILE%\.dorothy. There the
 * profile variables move with HOME (USERPROFILE, HOMEDRIVE + HOMEPATH, APPDATA,
 * LOCALAPPDATA), and the ones the run started with are protected as HOME is.
 * And the temp dir lives under the account home (%LOCALAPPDATA%\Temp), so the
 * guard refused every test that wrote into it, 463 of them: the temp dir is let
 * through when it lies under a protected home, and nothing it contains that is
 * protected in its own right (a sandbox HOME made there) is. macOS and Linux
 * keep their temp dir outside the home, and get neither change.
 */

type Violation = { op: string; path: string; stack: string };

/** The Windows variables that name the profile, moved with HOME on win32. */
const PROFILE_VARIABLES = ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA'] as const;
const onWindows = process.platform === 'win32';
/** \\.\pipe\name or \\?\pipe\name, either slash: the Windows pipe namespace. */
const NAMED_PIPE = /^[\\/]{2}[.?][\\/]pipe[\\/]/i;
/** A `.` or `..` segment: Windows collapses it, and `\\.\pipe\..\C:\...` is a file. */
const DOT_SEGMENT = /(^|[\\/])\.{1,2}([\\/]|$)/;

/** A genuine named pipe: in the pipe namespace, and nothing in its name that climbs out of it. */
function isNamedPipe(target: string): boolean {
  const prefix = NAMED_PIPE.exec(target);
  return prefix !== null && !DOT_SEGMENT.test(target.slice(prefix[0].length));
}

type HomeGuard = {
  /** HOME as the run found it, before this file replaced it. */
  originalHome: string | undefined;
  /**
   * The profile variables as the run found them: on Windows all of them, and
   * elsewhere USERPROFILE alone, which the suite has always moved with HOME.
   */
  originalProfile: Record<string, string | undefined>;
  /** The account's home directory, which no environment variable can move. */
  accountHome: string;
  throwawayHome: string;
  protectedRoots: string[];
  allowedRoots: string[];
  violations: Violation[];
  protect(root: string): void;
  unprotect(root: string): void;
};

const KEY = Symbol.for('tars.test.homeGuard');

/** The module object itself: the ESM namespace imported above is frozen, and
 *  syncBuiltinESMExports copies this one into it. */
const nodeFs = createRequire(import.meta.url)('node:fs') as typeof fs;
const globals = globalThis as typeof globalThis & { [KEY]?: HomeGuard };

/** The path as the filesystem resolves it, for a target that may not exist yet. */
function canonical(target: string): string {
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

function inside(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

function pathOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof URL) return value.protocol === 'file:' ? fileURLToPath(value) : undefined;
  if (Buffer.isBuffer(value)) return value.toString();
  return undefined;
}

/** A container can run a uid with no passwd entry, and then there is no account home to name. */
function accountHome(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return '';
  }
}

const firstRun = !globals[KEY];
const guard: HomeGuard = globals[KEY] ?? {
  originalHome: process.env.HOME,
  originalProfile: Object.fromEntries((onWindows ? [...PROFILE_VARIABLES] : ['USERPROFILE']).map(key => [key, process.env[key]])),
  accountHome: accountHome(),
  throwawayHome: '',
  protectedRoots: [],
  allowedRoots: [],
  violations: [],
  protect(root) { this.protectedRoots.push(canonical(root)); },
  unprotect(root) {
    const at = this.protectedRoots.lastIndexOf(canonical(root));
    if (at >= 0) this.protectedRoots.splice(at, 1);
  },
};
globals[KEY] = guard;

if (firstRun) {
  const { USERPROFILE, APPDATA, LOCALAPPDATA } = guard.originalProfile;
  const profile = onWindows ? [USERPROFILE, APPDATA, LOCALAPPDATA] : [];
  for (const home of [guard.originalHome, guard.accountHome, ...profile]) {
    if (home) guard.protect(home);
  }
}

guard.throwawayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-vitest-home-'));
// The temporary folder too: on Windows it lives inside the account's home
// (C:\Users\<you>\AppData\Local\Temp), so without it every mkdtemp of the
// suite read as a write into the real home (the first Windows run, 01/10:
// about 300 of 340 failing files). Elsewhere it is outside the home anyway.
// On Windows, the run's folder, which holds the file's own (tmpdir-isolation.ts
// hands it over): a write past the file's folder is for the run's guard to
// report (tmpdir-run.ts), as on macOS and Linux, and this guard refused it
// first there, as a write into the real home (tmpdir-isolation.test.ts, 7).
// macOS and Linux keep the file's own folder, as before.
const runTmpdir = onWindows
  ? (globalThis as typeof globalThis & { [key: symbol]: string | undefined })[Symbol.for('tars.test.runTmpdir')] ?? os.tmpdir()
  : os.tmpdir();
guard.allowedRoots = [canonical(process.cwd()), canonical(guard.throwawayHome), canonical(runTmpdir)];
// HOME, and on Windows the variables that name the profile (test-home.ts's
// list). USERPROFILE everywhere, as the suite has always moved it.
const moved = { USERPROFILE: guard.throwawayHome, ...homeVariables(guard.throwawayHome) };
for (const dir of [moved.APPDATA, moved.LOCALAPPDATA]) if (dir) fs.mkdirSync(dir, { recursive: true });
Object.assign(process.env, moved);

/** The length of the closest of `roots` that holds `target`, or -1. */
function closest(target: string, roots: string[]): number {
  return roots.filter(root => inside(target, root)).reduce((longest, root) => Math.max(longest, root.length), -1);
}

/**
 * Refused when some protected root holds the target and no allowed root inside
 * that protected root does. An allowed root lets through only what is more
 * specific than the protection it overrides: the temp dir opens up the account
 * home around it, never a protected folder made inside it.
 */
function violationAt(value: unknown): string | undefined {
  const target = pathOf(value);
  if (target === undefined) return undefined;
  // A Windows named pipe (\\.\pipe\..., as node-pty's ConPTY input) is not a
  // file under any home, and resolving one opens it: realpath took the pipe's
  // only connection, and node-pty's own open then failed with EBUSY. One that
  // climbs out with `..` is a file, and is checked as one.
  if (onWindows && isNamedPipe(target)) return undefined;
  const resolved = canonical(target);
  const guarded = closest(resolved, guard.protectedRoots);
  if (guarded < 0) return undefined;
  // The closer root decides: the temporary folder inside the account's home on
  // Windows stays writable, and a home a test protects inside the temporary
  // folder stays protected.
  if (closest(resolved, guard.allowedRoots) >= guarded) return undefined;
  return resolved;
}

function refuse(op: string, target: string): Error {
  const error = new Error(
    `home-isolation: ${op} into ${target}, outside the throwaway HOME the suite runs in. `
    + 'A test reached the real home directory; see __tests__/setup/home-isolation.ts.',
  ) as Error & { code: string };
  error.code = 'E_TARS_HOME_GUARD';
  guard.violations.push({ op, path: target, stack: new Error().stack ?? '' });
  return error;
}

const O_WRITE = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT
  | fs.constants.O_TRUNC | fs.constants.O_APPEND;

/** open() writes only with a writing flag; reading the real home stays allowed. */
function opensForWriting(flags: unknown): boolean {
  if (typeof flags === 'number') return (flags & O_WRITE) !== 0;
  return typeof flags === 'string' && /[wa+]/.test(flags);
}

type Style = 'sync' | 'callback' | 'promise';

/**
 * Replace `holder[name]` with a version that refuses a write into a protected
 * root. `paths` lists which arguments are write targets; `when` narrows it, for
 * open(), to the calls that write.
 */
function wrap(holder: any, name: string, style: Style, paths: number[], when?: (args: unknown[]) => boolean): void {
  const original = holder?.[name];
  if (typeof original !== 'function' || original.__homeGuarded) return;
  const op = holder === nodeFs.promises ? `fs.promises.${name}` : `fs.${name}`;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    if (!when || when(args)) {
      for (const index of paths) {
        const target = violationAt(args[index]);
        if (target === undefined) continue;
        const error = refuse(op, target);
        if (style === 'promise') return Promise.reject(error);
        const callback = args[args.length - 1];
        if (style === 'callback' && typeof callback === 'function') {
          process.nextTick(() => callback(error));
          return undefined;
        }
        throw error;
      }
    }
    return original.apply(this, args);
  };
  // Whatever a caller may read off the function, such as a promisify hook,
  // but not what every function already has of its own.
  const own = Object.getOwnPropertyDescriptors(original) as Record<string, PropertyDescriptor>;
  for (const intrinsic of ['length', 'name', 'prototype', 'arguments', 'caller']) delete own[intrinsic];
  Object.defineProperties(wrapped, own);
  Object.defineProperty(wrapped, '__homeGuarded', { value: true });
  holder[name] = wrapped;
}

if (firstRun) {
  const first = [0];
  const second = [1];
  const both = [0, 1];
  const writing = (args: unknown[]) => opensForWriting(args[1]);
  for (const [name, targets] of [
    ['writeFile', first], ['appendFile', first], ['mkdir', first], ['mkdtemp', first],
    ['rename', both], ['copyFile', second], ['cp', second], ['rm', first], ['rmdir', first],
    ['unlink', first], ['symlink', second], ['link', second], ['truncate', first],
    ['utimes', first], ['lutimes', first], ['chmod', first], ['lchmod', first],
    ['chown', first], ['lchown', first],
  ] as const) {
    wrap(nodeFs, `${name}Sync`, 'sync', [...targets]);
    wrap(nodeFs, name, 'callback', [...targets]);
    wrap(nodeFs.promises, name, 'promise', [...targets]);
  }
  wrap(nodeFs, 'openSync', 'sync', first, writing);
  wrap(nodeFs, 'open', 'callback', first, writing);
  wrap(nodeFs.promises, 'open', 'promise', first, writing);
  wrap(nodeFs, 'createWriteStream', 'sync', first);
  // `import * as fs` and named imports of node:fs are ESM bindings copied from
  // the module object; without this they would keep the unguarded functions.
  syncBuiltinESMExports();
}

afterAll(() => {
  const found = guard.violations.splice(0);
  fs.rmSync(guard.throwawayHome, { recursive: true, force: true });
  if (guard.originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = guard.originalHome;
  for (const [key, value] of Object.entries(guard.originalProfile)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (found.length > 0) {
    const lines = found.map(v => {
      const where = v.stack.split('\n').find(line => line.includes(process.cwd()) && !line.includes('home-isolation.ts'));
      return `  ${v.op} ${v.path}${where ? `\n    ${where.trim()}` : ''}`;
    });
    throw new Error(`home-isolation: this file wrote outside its throwaway HOME, into the home it started in:\n${lines.join('\n')}`);
  }
});
