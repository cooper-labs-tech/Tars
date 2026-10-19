import { execFile, execFileSync, type ExecFileOptions, type StdioOptions } from 'child_process';
import * as os from 'os';

/**
 * Every git call Tars's main process makes on a project folder (2.0.4, the
 * Audit's Hole 3): with every program the repository's configuration, the
 * user's or the system's names switched off, whatever they say. Any agent of
 * a project, or anything it runs, can write that project's .git/config, and
 * git runs what it names: core.fsmonitor on a status, diff.external, a diff
 * command or a textconv on a diff, a filter's clean, smudge or process when a
 * file meets the index, hooks on a checkout, a commit or a ref update,
 * gpg.program on a signed commit. Opening Review ran them inside Tars, outside
 * every CLI's permission mode. Hooks never run here, submodules are never
 * entered, and git gets an environment of Tars's own.
 *
 * The overrides go on the command line, which git reads after every
 * configuration file. A filter has no switch of its own: its names are read
 * first (`git config --get-regexp ^filter\.`, which runs nothing) and each one
 * is made to pass files through as they are.
 */

/** Read after every configuration file, so these win over any of them. */
const NO_PROGRAMS = [
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  `core.hooksPath=${os.devNull}`,
  'diff.external=',
  'core.pager=cat',
  'commit.gpgSign=false',
  'tag.gpgSign=false',
  // Verifying a signature runs a program too: log.showSignature makes log,
  // show and whatchanged verify every signed commit, and %G? asks it (the
  // Audit's M1 on #463). Off, and each verifier pointed at the null device,
  // which nothing can run, whatever a call or a format asks.
  'log.showSignature=false',
  `gpg.program=${os.devNull}`,
  `gpg.openpgp.program=${os.devNull}`,
  `gpg.ssh.program=${os.devNull}`,
  `gpg.x509.program=${os.devNull}`,
  `gpg.ssh.allowedSignersFile=${os.devNull}`,
  'credential.helper=',
  'protocol.allow=never',
  'submodule.recurse=false',
  'diff.ignoreSubmodules=all',
  'status.submoduleSummary=false',
  'core.quotePath=false',
];

/** Subcommands that never read a file's content through the index: no filter can run, none is looked for. */
const NO_CONTENT = new Set(['rev-parse', 'symbolic-ref', 'remote', 'config', 'rev-list', 'merge-base', 'branch', 'for-each-ref', 'ls-files', 'cat-file', 'show-ref', 'var', 'version']);

/** What a diff and its kin get: no external diff, no textconv. */
const DIFFS = new Set(['diff', 'log', 'show', 'whatchanged', 'format-patch', 'stash']);
/** What shows commits, and would verify their signatures: --no-show-signature. */
const LOGS = new Set(['log', 'show', 'whatchanged']);

/** What Tars's environment hands git, and nothing else: no GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_PARAMETERS, editor or askpass. */
const PASSED = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'];

export function safeGitEnv(base: GitEnv = process.env, extra: GitEnv = {}): NodeJS.ProcessEnv {
  const env: GitEnv = {};
  for (const k of PASSED) if (base[k] !== undefined) env[k] = base[k];
  // The caller's own (LC_ALL=C, a throwaway GIT_INDEX_FILE of Tars's), never one that points git elsewhere or runs a program.
  for (const [k, v] of Object.entries(extra)) {
    if (/^GIT_(DIR|WORK_TREE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_GLOBAL|CONFIG_SYSTEM|EXTERNAL_DIFF|EDITOR|SEQUENCE_EDITOR|ASKPASS|SSH|SSH_COMMAND|PAGER|EXEC_PATH|PROXY_COMMAND)$/.test(k)) continue;
    env[k] = v;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env as NodeJS.ProcessEnv;
}

/** Where the subcommand is in `args`, past the global options before it (-C <dir>, -c <k=v>, --no-pager...). */
function subcommandAt(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-C' || a === '-c') { i++; continue; }
    if (a.startsWith('-')) continue;
    return i;
  }
  return -1;
}

/** The -c that make every named filter pass files through as they are, and never fail a call. */
function filterOverrides(names: string): string[] {
  const filters = new Set<string>();
  for (const key of names.split('\0')) {
    const m = /^filter\.([\s\S]+)\.[^.]+$/.exec(key.trim());
    if (m) filters.add(m[1]);
  }
  return [...filters].flatMap((f) => [
    '-c', `filter.${f}.clean=cat`, '-c', `filter.${f}.smudge=cat`, '-c', `filter.${f}.process=`, '-c', `filter.${f}.required=false`,
  ]);
}

const LOOKUP = ['config', '-z', '--name-only', '--get-regexp', '^filter\\.'];
const globals = () => NO_PROGRAMS.flatMap((kv) => ['-c', kv]);

/** The command line: overrides, the filters' own, then the call, a diff without external diff or textconv. */
function argvOf(args: string[], filters: string[]): string[] {
  const at = subcommandAt(args);
  const out = [...args];
  if (at >= 0 && DIFFS.has(out[at])) out.splice(at + 1, 0, '--no-ext-diff', '--no-textconv');
  if (at >= 0 && LOGS.has(out[at])) out.splice(at + 1, 0, '--no-show-signature');
  if (at >= 0 && (out[at] === 'status' || out[at] === 'diff')) out.splice(at + 1, 0, '--ignore-submodules=all');
  return ['--no-optional-locks', ...globals(), ...filters, ...out];
}

const needsFilters = (args: string[]) => {
  const at = subcommandAt(args);
  if (at < 0) return false;
  if (args[at] === 'worktree') return args[at + 1] !== 'list' && args[at + 1] !== 'prune';
  return !NO_CONTENT.has(args[at]);
};

/** What a call adds to git's environment (LC_ALL=C, a throwaway index). */
type GitEnv = Record<string, string | undefined>;

export interface SafeGitOptions {
  env?: GitEnv;
  maxBuffer?: number;
  timeout?: number;
}

/** git, asynchronously, with no program of the repository's: what execFile('git', ...) promisified gave. */
export async function safeGit(cwd: string, args: string[], opts: SafeGitOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const env = safeGitEnv(process.env, opts.env);
  const call = (argv: string[], o: ExecFileOptions = {}) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile('git', argv, { cwd, env, encoding: 'utf8', maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024, timeout: opts.timeout ?? 30_000, windowsHide: true, ...o }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
  let filters: string[] = [];
  if (needsFilters(args)) {
    // No filter configured: git config exits 1 with nothing to say.
    filters = filterOverrides(await call(['--no-optional-locks', ...globals(), ...LOOKUP]).then((r) => r.stdout, () => ''));
  }
  return call(argvOf(args, filters));
}

/** git, synchronously, the same way: what execFileSync('git', ...) gave (a Buffer, unless an encoding is asked for). */
export function safeGitSync(cwd: string, args: string[], opts: SafeGitOptions & { stdio?: StdioOptions; encoding?: BufferEncoding } = {}): string {
  const env = safeGitEnv(process.env, opts.env);
  const base = { cwd, env, windowsHide: true, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024, ...(opts.timeout ? { timeout: opts.timeout } : {}) };
  let filters: string[] = [];
  if (needsFilters(args)) {
    try {
      filters = filterOverrides(execFileSync('git', ['--no-optional-locks', ...globals(), ...LOOKUP], { ...base, stdio: 'pipe', encoding: 'utf8' }));
    } catch {
      filters = [];
    }
  }
  return execFileSync('git', argvOf(args, filters), { ...base, stdio: opts.stdio ?? 'pipe', encoding: opts.encoding ?? 'utf8' }) as unknown as string;
}
