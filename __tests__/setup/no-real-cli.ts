import { afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';

/**
 * No unit test starts a real claude or tailscale (the Audit's I-3 on #616). secrets-shown-by-main.test.ts ran the
 * owner's real `tailscale status --json` through hermes:getConnectionInfo, and a call moved from execFile to spawn
 * made shared-files-atomic.test.ts start the real `claude mcp add`: a test that stands in for a CLI at one
 * child_process function stops standing in when the product changes function, and nothing fails.
 *
 * Here every function of child_process that starts a program (spawn, spawnSync, execFile, execFileSync, exec,
 * execSync) first asks what it would start: a binary named claude or tailscale (Tailscale.app's `Tailscale` too, and
 * a .exe or .cmd of either on Windows), by its path or by its name on the PATH it is handed, that lies outside the
 * test's own temporary folders, is refused before it starts, and the test fails, naming it. A stand-in a test plants
 * in its own folder is not concerned, nor is any other binary, nor a name nothing on the PATH answers. Named imports
 * of child_process see the guard (syncBuiltinESMExports), as home-isolation.ts's fs guard does. no-real-cli.test.ts
 * holds the ways it was written against.
 */

const NAMES = new Set(['claude', 'tailscale']);
const START = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'] as const;

export type Violation = { binary: string; how: string; test: string };

type Guard = { violations: Violation[]; narrowed: string[] | null; wrapped: boolean };
const KEY = Symbol.for('tars.test.noRealCli');
const globals = globalThis as typeof globalThis & { [KEY]?: Guard };
const guard: Guard = globals[KEY] ?? { violations: [], narrowed: null, wrapped: false };
globals[KEY] = guard;

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** The folders a test's stand-ins live in: the run's temporary folder and the file's, /tmp, and the suite's own. */
function allowedRoots(): string[] {
  if (guard.narrowed) return guard.narrowed;
  const run = (globalThis as typeof globalThis & { [key: symbol]: string | undefined })[Symbol.for('tars.test.runTmpdir')];
  const roots = [os.tmpdir(), run, '/tmp', '/private/tmp', path.join(process.cwd(), '__tests__')].filter((r): r is string => !!r);
  return [...new Set(roots.flatMap(r => [r, real(r)]))];
}

/**
 * The real claude or tailscale `file` would start, as it would find it: its own path, or the first file by that name
 * on `envPath`; null for any other binary, one the test's folders hold, or a name nothing answers.
 */
export function realBinary(
  file: string, envPath: string | undefined, roots: string[], exists: (p: string) => boolean = isFile, platform: NodeJS.Platform = process.platform,
): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const name = p.basename(file).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (!NAMES.has(name)) return null;
  const exts = platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(file) ? ['', '.exe', '.cmd', '.bat'] : [''];
  const candidates = /[\\/]/.test(file)
    ? exts.map(ext => p.resolve(file + ext))
    : (envPath ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean).flatMap(dir => exts.map(ext => p.join(dir, file + ext)));
  const found = candidates.find(exists);
  if (!found) return null;
  const resolved = platform === process.platform ? real(found) : found;
  const inside = (root: string) => resolved === root || resolved.startsWith(root.endsWith(p.sep) ? root : root + p.sep);
  return roots.some(inside) ? null : resolved;
}

/** The program a line for a shell starts: its first word, quoted or not. */
export function programOfLine(line: string): string {
  const text = line.trimStart();
  const quoted = /^(["'])(.*?)\1/.exec(text);
  return quoted ? quoted[2] : text.split(/\s+/)[0] ?? '';
}

/** For no-real-cli.test.ts only: the allowed folders, narrowed (an empty list makes every claude a real one); null restores them. */
export function narrowRootsForTest(roots: string[] | null): void {
  guard.narrowed = roots;
}

/** What was refused since the last read, and no longer held against the test. */
export function takeViolations(): Violation[] {
  return guard.violations.splice(0);
}

/** The options a start was handed: the first plain object after the file (and its arguments). */
function optionsOf(rest: unknown[]): { env?: NodeJS.ProcessEnv } | undefined {
  return rest.find((r): r is { env?: NodeJS.ProcessEnv } => !!r && typeof r === 'object' && !Array.isArray(r));
}

function refuse(how: string, program: string, options: { env?: NodeJS.ProcessEnv } | undefined): void {
  const env = options?.env ?? process.env;
  const binary = realBinary(program, env.PATH ?? env.Path, allowedRoots());
  if (!binary) return;
  const test = (globalThis as { expect?: { getState?: () => { currentTestName?: string } } }).expect?.getState?.().currentTestName ?? '';
  guard.violations.push({ binary, how, test });
  throw new Error(`a unit test started the real ${path.basename(binary)} (${binary}, by ${how}): stand in for it, as the moved probes are (__tests__/setup/no-real-cli.ts)`);
}

if (!guard.wrapped) {
  guard.wrapped = true;
  const childProcess = createRequire(import.meta.url)('node:child_process') as Record<string, (...args: unknown[]) => unknown>;
  for (const fn of START) {
    const original = childProcess[fn];
    childProcess[fn] = function guarded(this: unknown, first: unknown, ...rest: unknown[]) {
      const program = fn === 'exec' || fn === 'execSync' ? programOfLine(String(first)) : String(first);
      refuse(fn, program, optionsOf(rest));
      return original.call(this, first, ...rest);
    };
  }
  syncBuiltinESMExports();
}

afterEach(() => {
  const found = takeViolations();
  if (found.length === 0) return;
  throw new Error(`no-real-cli: this test started a real CLI:\n${found.map(v => `  ${v.binary} (by ${v.how})`).join('\n')}`);
});
