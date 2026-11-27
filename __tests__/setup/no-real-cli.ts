import { afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { realCliOptIn } from './real-cli-opt-in';

/**
 * No unit test starts a real claude or tailscale (the Audit's I-3 on #616). secrets-shown-by-main.test.ts ran the
 * owner's real `tailscale status --json` through hermes:getConnectionInfo, and a call moved from execFile to spawn
 * made shared-files-atomic.test.ts start the real `claude mcp add`: a test that stands in for a CLI at one
 * child_process function stops standing in when the product changes function, and nothing fails.
 *
 * Here every function of child_process that starts a program (spawn, spawnSync, execFile, execFileSync, exec,
 * execSync) first asks what it would start: a binary named after one of the CLIs below, by its path or by its name on
 * the PATH it is handed, in any case and in its .exe, .cmd or .bat form, that lies outside the test's own temporary
 * folders, is refused before it starts, and the test fails, naming it. The CLIs: claude and tailscale (Tailscale.app's
 * `Tailscale` too), and, after this week's two incidents (codex's config.toml deleted by a test, Kilo writing into the
 * real home; the Audit's I-4 on #616), every agent CLI Tars runs. Also read: the program at the head of a line for a
 * shell (exec, execSync, a spawn with `shell: true`) and at the head of a shell's script (`sh -c '...'`, `zsh -ilc`).
 * A stand-in a test plants in its own folder is not concerned, nor is any other binary, nor a name nothing on the PATH
 * answers. Named imports of child_process see the guard (syncBuiltinESMExports), as home-isolation.ts's fs guard does.
 * no-real-cli.test.ts holds the ways it was written against.
 *
 * Not covered: node-pty (every unit test mocks it; a real agent terminal belongs to the E2E suite, whose sandbox
 * HOME and fixture.mjs's CLI_HOMES keep it out of the real one); fork (a node script, not a CLI binary); a CLI later
 * in a shell's line than its first word (`cd x && codex`); and a CLI another program starts (npx, a script, a CLI
 * starting another).
 *
 * Opting in (real-cli-opt-in.ts): TARS_REAL_CLAUDE=1 or an absolute path for claude, TARS_TEST_REAL_CLIS=codex (or
 * codex=/abs/path) for any CLI; `0`, `false` or an empty value opt nothing in. An opt-in counts for the whole run, not
 * for the one test that asks: every test of that run may then start that CLI, so run the opted-in files alone.
 */

// hermes and cline since 27/11: a unit test started the owner's real Hermes twice (the Audit's read of QA's #671).
const NAMES = new Set(['claude', 'tailscale', 'codex', 'gemini', 'kimi', 'opencode', 'pi', 'kilo', 'qwen', 'grok', 'amp', 'goose', 'hermes', 'cline']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
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
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const name = p.basename(file).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (!NAMES.has(name)) return null;
  // A test that runs a real CLI on purpose (codex's own parser reading a config Tars wrote) runs only when asked:
  // `1` lets that CLI through, an absolute path that binary alone (real-cli-opt-in.ts).
  const asked = realCliOptIn(name, env);
  if (asked === 'any') return null;
  const exts = platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(file) ? ['', '.exe', '.cmd', '.bat'] : [''];
  const candidates = /[\\/]/.test(file)
    ? exts.map(ext => p.resolve(file + ext))
    : (envPath ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean).flatMap(dir => exts.map(ext => p.join(dir, file + ext)));
  const found = candidates.find(exists);
  if (!found) return null;
  const resolved = platform === process.platform ? real(found) : found;
  if (asked && (resolved === asked || resolved === (platform === process.platform ? real(asked) : asked))) return null;
  const inside = (root: string) => resolved === root || resolved.startsWith(root.endsWith(p.sep) ? root : root + p.sep);
  return roots.some(inside) ? null : resolved;
}

/** The program a line for a shell starts: its first word, quoted or not. */
export function programOfLine(line: string): string {
  const text = line.trimStart();
  const quoted = /^(["'])(.*?)\1/.exec(text);
  return quoted ? quoted[2] : text.split(/\s+/)[0] ?? '';
}

/**
 * The programs a start would run that the guard reads: the file itself; for a line handed to a shell (exec, execSync,
 * `shell: true`) its first word instead; and for a shell started with a script (`sh -c`, `zsh -ilc`), that script's
 * first word too.
 */
export function startedPrograms(fn: string, first: unknown, rest: unknown[]): string[] {
  const line = String(first);
  if (fn === 'exec' || fn === 'execSync' || (optionsOf(rest) as { shell?: unknown } | undefined)?.shell) return [programOfLine(line)];
  const programs = [line];
  const args = rest.find(Array.isArray) as unknown[] | undefined;
  if (args && SHELLS.has(path.basename(line).toLowerCase())) {
    const at = args.findIndex(a => typeof a === 'string' && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (at >= 0 && typeof args[at + 1] === 'string') programs.push(programOfLine(args[at + 1] as string));
  }
  return programs;
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
    const original = childProcess[fn] as ((...args: unknown[]) => unknown) & { [promisify.custom]?: (...args: unknown[]) => unknown };
    const guarded = function guarded(this: unknown, first: unknown, ...rest: unknown[]) {
      for (const program of startedPrograms(fn, first, rest)) refuse(fn, program, optionsOf(rest));
      return original.call(this, first, ...rest);
    };
    // execFile and exec carry node's own promisified form, which resolves { stdout, stderr }: kept, and guarded too.
    const custom = original[promisify.custom];
    if (custom) {
      Object.defineProperty(guarded, promisify.custom, {
        value: function guardedPromise(this: unknown, first: unknown, ...rest: unknown[]) {
          for (const program of startedPrograms(fn, first, rest)) refuse(fn, program, optionsOf(rest));
          return custom.call(this, first, ...rest);
        },
      });
    }
    childProcess[fn] = guarded;
  }
  syncBuiltinESMExports();
}

afterEach(() => {
  const found = takeViolations();
  if (found.length === 0) return;
  throw new Error(`no-real-cli: this test started a real CLI:\n${found.map(v => `  ${v.binary} (by ${v.how})`).join('\n')}`);
});
