import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { parse as parseToml } from 'smol-toml';
import { cliEnv, execCli } from './cli-exec';
import { defaultShell } from '../utils/default-shell';
import { trustsTooMuch } from '../utils/trust-too-much';
import { updateSharedTextSync } from '../utils/shared-file';
import type { AgentEffort } from '../types';

/**
 * What Tars reads from codex itself before it starts it: the flags the installed codex has, the models the
 * account has, and the efforts each of them takes. Measured on codex-cli 0.163.0 (standalone install, ChatGPT
 * account). See codex-cli.test.ts for each way this goes wrong.
 */

/** Where codex keeps its config, its sessions and its model cache: CODEX_HOME, else ~/.codex, as codex reads it. */
export function codexHome(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return env.CODEX_HOME?.trim() || path.join(homeDir, '.codex');
}

/**
 * Whether codex is signed in in this home (the Audit's L7 on #465): its auth.json, where codex keeps a login by
 * default, else codex's own `codex login status` run on that home, which reads its keyring too (measured on 0.163:
 * exit 0 "Logged in using ChatGPT", exit 1 "Not logged in"). undefined when codex could not say: not there, hung past
 * its time, or ended otherwise, a config it cannot read among them. Signed in, its answer names the account: it is
 * looked at for "Not logged in" only, never kept or logged.
 */
export async function codexSignedIn(binaryPath: string, home: string, timeoutMs = 10_000): Promise<boolean | undefined> {
  if (fs.existsSync(path.join(home, 'auth.json'))) return true;
  try {
    await execCli(binaryPath, ['login', 'status'], {
      encoding: 'utf-8', timeout: timeoutMs, env: { ...((cliEnv() as NodeJS.ProcessEnv | undefined) ?? process.env), CODEX_HOME: home },
    });
    return true;
  } catch (err) {
    const { code, stdout, stderr } = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return code === 1 && /not logged in/i.test(`${String(stdout ?? '')}${String(stderr ?? '')}`) ? false : undefined;
  }
}

/** The line a login shell prints its CODEX_HOME on, among whatever its rc files print. */
const SHELL_MARK = '__TARS_CODEX_HOME__=';

/** The CODEX_HOME a login shell printed on its marked line (the last one), or none when it sets none. */
export function codexHomeFromShell(output: string): string | undefined {
  let found: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const at = line.indexOf(SHELL_MARK);
    if (at >= 0) found = line.slice(at + SHELL_MARK.length).trim();
  }
  return found || undefined;
}

const shellHomes = new Map<string, Promise<string | undefined>>();

/**
 * The CODEX_HOME the user's own shell sets, as a login shell of theirs prints it with its rc files run, which Tars
 * started from the Dock or Finder never reads: once per run once it has answered, off the main thread, and a shell
 * that failed or hung past `timeoutMs` is asked again next time. Waited for to 20 s: a login zsh with its rc files
 * answered in 7.6 s under a load average of 150 (measured on 19/10). undefined when it sets none, and on Windows,
 * which runs no rc file.
 */
export function loginShellCodexHome(shell: string = defaultShell(), platform: NodeJS.Platform = process.platform, timeoutMs = 20_000): Promise<string | undefined> {
  if (platform === 'win32') return Promise.resolve(undefined);
  let asked = shellHomes.get(shell);
  if (!asked) {
    asked = new Promise<string | undefined>((resolve, reject) => {
      // The shell leads a process group of its own, ended whole at its time, and is given up on then: interactive,
      // it ignores SIGTERM (macOS's zsh, measured), and what its rc files start can hold its output open after it.
      // Its answer is its marked line, whatever comes after. An rc file that asks something (compinit's insecure
      // folders) reads no answer from its input, and no terminal: it is not a wait.
      const child = spawn(shell, ['-ilc', `printf '\\n%s%s\\n' '${SHELL_MARK}' "$CODEX_HOME"`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      let settled = false;
      const settle = (done: () => void) => { if (!settled) { settled = true; clearTimeout(timer); done(); } };
      const timer = setTimeout(() => settle(() => {
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* ended already */ }
        reject(new Error(`${shell} gave no answer in ${timeoutMs} ms`));
      }), timeoutMs);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        out = (out + chunk).slice(-65_536);
        const at = out.lastIndexOf(SHELL_MARK);
        if (at >= 0 && out.includes('\n', at)) settle(() => resolve(codexHomeFromShell(out)));
      });
      child.on('error', (err) => settle(() => reject(err)));
      child.on('close', (code) => settle(() => (code === 0 ? resolve(codexHomeFromShell(out)) : reject(new Error(`${shell} exited with ${code}`)))));
    });
    const kept = asked;
    shellHomes.set(shell, kept);
    kept.catch(() => { if (shellHomes.get(shell) === kept) shellHomes.delete(shell); });
  }
  return asked.catch(() => undefined);
}

/** A folder as the window names it: under the user's home, from ~. */
function tilde(dir: string, homeDir: string): string {
  return dir === homeDir || dir.startsWith(`${homeDir}${path.sep}`) ? `~${dir.slice(homeDir.length)}` : dir;
}

/** Two writings of one folder: the same real path, or the same resolved path where it does not exist. */
function sameFolder(a: string, b: string): boolean {
  const real = (dir: string) => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };
  return real(a) === real(b);
}

/**
 * Why codex agents start not signed in, when it is this (the Audit's L7 on #465). Tars hands the codex it starts its
 * own home (`env CODEX_HOME=<home>` on the line, the Audit's L4), and a user whose rc files set another, where their
 * login is, with Tars started from the Dock or Finder, gets codex agents codex asks to sign in: measured on 0.163,
 * "Welcome to Codex ... Sign in with ChatGPT ... Press enter to continue", and no session written. The sentence for
 * the agent's status, or undefined: Tars's home signed in, a key from Settings (which codex takes instead of a login),
 * a shell that sets no other folder, that folder not signed in either, or a codex that could not say.
 */
export async function codexSignInGap(opts: {
  binaryPath: string;
  home: string;
  keyed: boolean;
  shellHome: () => Promise<string | undefined>;
  homeDir?: string;
  signedIn?: (binaryPath: string, home: string) => Promise<boolean | undefined>;
}): Promise<string | undefined> {
  if (opts.keyed) return undefined;
  const signedIn = opts.signedIn ?? codexSignedIn;
  if ((await signedIn(opts.binaryPath, opts.home)) !== false) return undefined;
  const other = await opts.shellHome();
  if (!other || sameFolder(other, opts.home)) return undefined;
  if ((await signedIn(opts.binaryPath, other)) !== true) return undefined;
  const homeDir = opts.homeDir ?? os.homedir();
  return `codex asks to sign in: Tars starts it on ${tilde(opts.home, homeDir)}, and your login is in ${tilde(other, homeDir)}, the CODEX_HOME your shell sets. Sign in from this terminal, or give Tars that CODEX_HOME.`;
}

/** A codex session id: a UUID (codex's own are version 7), and the only thing a resume puts on a command line. */
export const CODEX_SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A day's folder under sessions/, as codex names it: by the local day, and the UTC one read too. */
function dayFolder(at: Date, utc: boolean): string {
  const [y, m, d] = utc ? [at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate()] : [at.getFullYear(), at.getMonth() + 1, at.getDate()];
  return path.join(String(y), String(m).padStart(2, '0'), String(d).padStart(2, '0'));
}

const rolloutFound = new Map<string, string>();

/**
 * The rollout file codex keeps a session in, $CODEX_HOME/sessions/<y>/<m>/<d>/rollout-<time>-<id>.jsonl, under the
 * day the session began, which `codex resume <id>` appends to (measured on 0.163). Looked for first in the days the
 * id itself names (a version 7 id begins with its time in milliseconds), then in every day; undefined when codex has
 * no such session.
 */
export function codexRolloutOf(sessionId: string, home: string = codexHome()): string | undefined {
  if (!CODEX_SESSION_ID.test(sessionId)) return undefined;
  const key = `${home}\0${sessionId}`;
  const known = rolloutFound.get(key);
  if (known && fs.existsSync(known)) return known;
  const sessions = path.join(home, 'sessions');
  const suffix = `-${sessionId.toLowerCase()}.jsonl`;
  const numbered = (dir: string): string[] => { try { return fs.readdirSync(dir).filter(n => /^\d+$/.test(n)); } catch { return []; } };
  const days: string[] = [];
  const at = parseInt(sessionId.slice(0, 8) + sessionId.slice(9, 13), 16);
  for (const t of [at - 86_400_000, at, at + 86_400_000]) {
    const day = new Date(t);
    if (!Number.isNaN(day.getTime())) days.push(dayFolder(day, false), dayFolder(day, true));
  }
  for (const y of numbered(sessions)) for (const m of numbered(path.join(sessions, y))) for (const d of numbered(path.join(sessions, y, m))) days.push(path.join(y, m, d));
  for (const day of new Set(days)) {
    let names: string[];
    try { names = fs.readdirSync(path.join(sessions, day)); } catch { continue; }
    const name = names.find(n => n.startsWith('rollout-') && n.toLowerCase().endsWith(suffix));
    if (name) {
      const file = path.join(sessions, day, name);
      rolloutFound.set(key, file);
      return file;
    }
  }
  return undefined;
}

/** The flags a codex `--help` lists. */
export function codexFlagsFromHelp(help: string): Set<string> {
  return new Set(help.match(/--[a-z][a-z0-9-]*/g) ?? []);
}

/** The flags each codex binary listed, by binaryKey; and the asks of --help still running. */
const flagsByBinary = new Map<string, Set<string>>();
const asking = new Map<string, Promise<Set<string> | undefined>>();

/** A binary and its version, as its flags are kept: its real path, size and time of change, which an update changes. */
function binaryKey(binaryPath: string): string {
  try {
    const real = fs.realpathSync(binaryPath);
    const stat = fs.statSync(real);
    return `${real}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return binaryPath; // asked by its name: on the PATH, or not there at all
  }
}

/**
 * The flags the codex at `binaryPath` has, from its own `--help`, read off the main thread (the Audit's L6 on #465:
 * read with execFileSync, it froze the window for as long as codex took). Kept per binary and version, and the asks
 * made while codex answers share that one codex. Waited for as long as it takes, to `timeoutMs`: under a heavy load (a
 * load average of 170, measured at #465's gate) a slow answer given up on at 2 s handed every launch of the run the
 * stable flags. undefined when codex could not answer (not there, failed, hung past its time): that is not kept, and
 * the next launch asks again.
 */
export function readCodexFlags(binaryPath: string, timeoutMs = 10_000): Promise<Set<string> | undefined> {
  const key = binaryKey(binaryPath);
  const known = flagsByBinary.get(key);
  if (known) return Promise.resolve(known);
  let ask = asking.get(key);
  if (!ask) {
    ask = execCli(binaryPath, ['--help'], { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
      .then(({ stdout }) => {
        const flags = codexFlagsFromHelp(stdout);
        flagsByBinary.set(key, flags);
        return flags;
      }, () => undefined)
      .finally(() => asking.delete(key));
    asking.set(key, ask);
  }
  return ask;
}

/**
 * The `-c` value that runs codex on the databases of `dir` (services/agent-tmp.ts, agentCodexDbDir): the path as a
 * TOML basic string, which a JSON string is, so a Windows path's backslashes reach codex whole. Codex 0.163 takes
 * the key; a key it does not know, it ignores (measured).
 */
export function codexSqliteHomeArg(dir: string): string {
  return `sqlite_home=${JSON.stringify(dir)}`;
}

/**
 * Whether the codex at `binaryPath` has a flag, from the answer readCodexFlags kept for it (only auto needs one): never
 * codex run on the main thread. A launch reads the flags before it builds its line (CodexProvider.prepareLaunch); a
 * line built without that answer, or for a codex that could not answer, has the stable flags only, and the flags are
 * read for the next.
 */
export function codexAccepts(binaryPath: string): (flag: string) => boolean {
  let known: Set<string> | undefined;
  return (flag: string) => {
    if (!known) {
      known = flagsByBinary.get(binaryKey(binaryPath));
      if (!known) {
        void readCodexFlags(binaryPath);
        known = new Set();
      }
    }
    return known.has(flag);
  };
}

/**
 * The flags a Tars permission mode becomes for codex. Never `--full-auto` (0.163 refuses it, exit 2), nor an
 * approval policy that waits for a person, whom nobody is in an agent's terminal:
 * - auto: codex's automatic review of each approval (`--approve-for-me`, 0.163) where the installed codex has it,
 *   else no approval asked inside the workspace sandbox (`-a never -s workspace-write`, the stable flags);
 * - bypass: codex's own bypass;
 * - normal: nothing, so codex asks as the user set it to (plan is refused for codex before it gets here).
 */
export function codexPermissionArgs(mode: string | undefined, accepts: (flag: string) => boolean): string[] {
  if (mode === 'bypass') return ['--dangerously-bypass-approvals-and-sandbox'];
  if (mode === 'auto') {
    return accepts('--approve-for-me') ? ['--approve-for-me'] : ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'];
  }
  return [];
}

/** A model of the account, as codex lists it. */
export interface CodexModel {
  id: string;
  name: string;
  description: string;
  defaultEffort?: string;
  /** The efforts the model takes, in codex's words. */
  efforts: string[];
  contextWindow?: number;
}

/**
 * The models in codex's own cache (models_cache.json, which codex fetches for the account it is signed in with):
 * those it lists (`visibility: list`), in its order (`priority`). Anything written otherwise is left out, never a
 * crash.
 */
export function codexModelsFrom(cache: unknown): CodexModel[] {
  const models = cache && typeof cache === 'object' ? (cache as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) return [];
  const listed: Array<{ model: CodexModel; priority: number }> = [];
  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const entry = m as Record<string, unknown>;
    if (typeof entry.slug !== 'string' || !entry.slug) continue;
    if (entry.visibility !== undefined && entry.visibility !== 'list') continue;
    const efforts = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
        .map(level => (level && typeof level === 'object' ? (level as { effort?: unknown }).effort : level))
        .filter((effort): effort is string => typeof effort === 'string')
      : [];
    listed.push({
      model: {
        id: entry.slug,
        name: typeof entry.display_name === 'string' && entry.display_name ? entry.display_name : entry.slug,
        description: typeof entry.description === 'string' ? entry.description : '',
        ...(typeof entry.default_reasoning_level === 'string' ? { defaultEffort: entry.default_reasoning_level } : {}),
        efforts,
        ...(typeof entry.context_window === 'number' ? { contextWindow: entry.context_window } : {}),
      },
      priority: typeof entry.priority === 'number' ? entry.priority : Number.MAX_SAFE_INTEGER,
    });
  }
  return listed.sort((a, b) => a.priority - b.priority).map(entry => entry.model);
}

/** The account's models from the cache codex keeps in its home; none when codex has not written one. */
export function readCodexModels(home: string = codexHome()): CodexModel[] {
  try {
    return codexModelsFrom(JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf-8')));
  } catch {
    return [];
  }
}

const EFFORT_ORDER: AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The effort as codex takes it, `-c model_reasoning_effort=<level>`. At the level asked when the model takes it,
 * else the nearest level below that it takes (codex refuses a turn at a level the model has not); as asked when
 * codex's list does not name the model. Nothing for no effort, or for a word that is not one of Tars's levels.
 */
export function codexEffortArgs(effort: string | undefined, model: string | undefined, models: CodexModel[]): string[] {
  if (!effort || !EFFORT_ORDER.includes(effort as AgentEffort)) return [];
  const takes = model ? models.find(m => m.id === model)?.efforts : undefined;
  let level = effort;
  if (takes && takes.length > 0 && !takes.includes(effort)) {
    const below = EFFORT_ORDER.slice(0, EFFORT_ORDER.indexOf(effort as AgentEffort)).reverse().find(e => takes.includes(e));
    level = below ?? EFFORT_ORDER.find(e => takes.includes(e)) ?? effort;
  }
  return ['-c', `model_reasoning_effort=${level}`];
}

/**
 * config.toml with this folder trusted, from what it holds now (the Audit's L1 and L2 on #465). 'already' when it has
 * a table for the folder under any writing of its key: codex writes a key holding a backslash or a double quote as a
 * literal string (every path on Windows), and a dotted key under [projects] defines the table too. 'unreadable' when
 * it is not TOML, or would not be with the table added (a `projects` written inline takes no table): a second table
 * for one key is invalid TOML, and codex then refuses its whole config, every session of its user with it. Else the
 * file with the table at its end, the rest as it was. Keys compare as TOML compares them, whole and exact, which is
 * how codex looks a folder up: another case of a letter is another key, and Tars's own goes beside it.
 */
export function trustTableFor(content: string | undefined, folder: string): 'already' | 'unreadable' | { next: string } {
  const text = content ?? '';
  let parsed: Record<string, unknown>;
  try { parsed = parseToml(text); } catch { return 'unreadable'; }
  const projects = parsed.projects;
  if (projects && typeof projects === 'object' && Object.prototype.hasOwnProperty.call(projects, folder)) return 'already';
  const header = `[projects.${JSON.stringify(folder).replace(/\u007f/g, '\\u007F')}]`;
  const next = `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${header}\ntrust_level = "trusted"\n`;
  try { parseToml(next); } catch { return 'unreadable'; }
  return { next };
}

/**
 * The agent's folder trusted in codex's config before its codex starts, as ensureProjectTrusted does for Claude Code.
 * Measured on codex-cli 0.163.0: in a folder its config does not trust, codex first asks "Trust this folder?",
 * writes no session and does nothing until someone answers, which nobody does in an agent's terminal; with
 * `[projects."<folder>"] trust_level = "trusted"` the same launch ran its turn. Under the folder's real path, the
 * one codex records (its session's cwd). A choice already in the config, trusted or not, is the user's and is left
 * as it is; a folder that would trust every folder below it is refused (utils/trust-too-much.ts), and codex asks.
 * The file is read before it is written, and only its absence reads as none; it is replaced whole, as Tars writes
 * ~/.claude.json (utils/shared-file.ts): a codex starting meanwhile never reads half of it.
 */
export function ensureCodexProjectTrusted(projectPath: string, home: string = codexHome()): 'written' | 'already' | 'refused' | 'failed' {
  if (!projectPath || trustsTooMuch(projectPath)) return 'refused';
  let real: string;
  try { real = fs.realpathSync(projectPath); } catch { return 'failed'; }
  const file = path.join(home, 'config.toml');
  let found: 'already' | 'unreadable' | undefined;
  try {
    const outcome = updateSharedTextSync(file, current => {
      const table = trustTableFor(current, real);
      found = typeof table === 'string' ? table : undefined;
      return typeof table === 'string' ? undefined : table.next;
    });
    if (found === 'already') return 'already';
    if (outcome === 'written') return 'written';
    console.warn(found === 'unreadable'
      ? `[codex] ${file} is not TOML Tars can add a table to: ${real} is not trusted there, and codex will ask`
      : `[codex] ${real} not trusted in ${file}: the file kept changing while Tars wrote it`);
    return 'failed';
  } catch (err) {
    console.warn(`[codex] ${real} not trusted in ${file}: it could not be read`, err instanceof Error ? err.message : err);
    return 'failed';
  }
}
