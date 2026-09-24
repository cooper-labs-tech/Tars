import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentProvider, AppSettings } from '../types';
import { dataPath } from '../constants';
import { getAllProviders, getProvider } from '../providers';
import { buildFullPath } from '../utils/path-builder';

/**
 * Keeps the agent CLIs Tars runs up to date, so a model a CLI release adds can
 * be used the day it ships: Tars starts every claude with DISABLE_AUTOUPDATER=1
 * and every Amp with updates disabled, so neither ever updated itself (on
 * 2026-09-22 the fleet could not use Opus 5.5 until claude was updated by hand).
 *
 * Tars runs one update rather than each session's own, measured on claude
 * 2.1.273 and 2.1.280:
 * - each session's updater downloads for itself: three sessions, three 217 MB
 *   downloads, and every footer asking for a restart;
 * - `claude update` beside a live session leaves it alone: the new version is
 *   written beside the old one and ~/.local/bin/claude swapped in one step, and
 *   the session runs on from its own file, which a lock keeps from cleanup. A
 *   version deleted under a second session still answers, but its Grep and
 *   Glob fail (native claude runs its embedded ripgrep by starting its own file
 *   again): USE_BUILTIN_RIPGREP=0 with `rg` on PATH, in managedCliEnv, keeps
 *   them working. A new launch starts on the new version;
 * - concurrent `claude update`s all succeed; Tars still runs one pass at a time.
 *
 * Amp is a global npm package, replaced in place: `bin/amp` is missing for 3 to
 * over 31 s during an update (measured on @sourcegraph/amp), so an update
 * starts only when no process runs that binary (`lsof`), after a download into
 * a scratch prefix, and a launch in that window still fails. It updates the
 * package that owns the binary, by its own name: `amp update` installs
 * @ampcode/cli, which fails with EEXIST on the link the old package owns.
 *
 * Covered: claude's native installer and Amp as a global npm package; every
 * other CLI or install is left alone and says so in the log (no other path
 * could be checked here, and a guessed one would look covered and do nothing).
 * Only CLIs some agent runs, only while "Check for updates" is on (the one
 * switch for Tars and these, JeanBrasse 2026-09-23, read at every pass), and only
 * installs under the home Tars runs in, which keeps a sandbox or a test away
 * from the real CLIs.
 */

/** Claude Code's own cadence (1 800 000 ms in 2.1.280's footer), so an agent gets
 *  a release no later than a terminal of its own would have. */
const INTERVAL_MS = 30 * 60 * 1000;
/** After launch, as the app's own update check. */
const FIRST_PASS_DELAY_MS = 5_000;
/** A 217 MB download on a slow line. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const QUERY_TIMEOUT_MS = 60 * 1000;
/** Past this the log moves to `.1`, replacing the previous one. */
const LOG_MAX_BYTES = 256 * 1024;

export const CLI_UPDATES_LOG = dataPath('cli-updates.log');

/** The CLIs Tars updates, by the binary their providers run. */
export type UpdatableCli = 'claude' | 'amp';
const UPDATABLE: UpdatableCli[] = ['claude', 'amp'];

export type CliUpdateOutcome = 'updated' | 'unchanged' | 'deferred' | 'failed' | 'skipped';

export interface CliUpdateResult {
  cli: string;
  outcome: CliUpdateOutcome;
  /** The version found, and the one installed when it changed. */
  from?: string;
  to?: string;
  /** What happened, in the CLI's own words where it gave any. */
  detail: string;
}

export interface CliUpdateContext {
  /** The home an install must be under. os.homedir() in the app. */
  home: string;
  /** Every child's environment, PATH included. HOME must be `home`. */
  env: NodeJS.ProcessEnv;
  logFile: string;
}

interface Run {
  /** The exit code, or why there is none: 'timeout', a signal, a spawn error. */
  code: number | string;
  stdout: string;
  stderr: string;
  ms: number;
}

function runFile(file: string, args: string[], env: NodeJS.ProcessEnv, timeout: number, cwd: string): Promise<Run> {
  const started = Date.now();
  return new Promise(resolve => {
    execFile(file, args, { env, timeout, cwd, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      let code: number | string = 0;
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        code = e.killed ? 'timeout' : (typeof e.code === 'number' || typeof e.code === 'string' ? e.code : e.signal ?? 'error');
      }
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', ms: Date.now() - started });
    });
  });
}

function lines(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}

/**
 * What a failed command said, with its exit code. Two error lines, because the
 * first is often only the heading: claude's is "Failed to install native
 * update", and the ECONNREFUSED that explains it is the second.
 */
function failure(run: Run): string {
  const errors = lines(run.stderr).filter(l => /error/i.test(l)).slice(0, 2);
  const said = errors.length > 0 ? errors.join('; ') : lines(run.stderr)[0] ?? lines(run.stdout).pop();
  return `${said ?? 'no output'} (exit ${run.code})`;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A command as a launch finds it: a path from Settings, or a name on PATH. */
export function locate(command: string, envPath: string): string | null {
  if (path.isAbsolute(command)) return isExecutableFile(command) ? command : null;
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function inside(target: string, dir: string): boolean {
  const rel = path.relative(dir, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

type Install =
  | { kind: 'native'; launcher: string; binary: string; version: string }
  | { kind: 'npm'; launcher: string; binary: string; prefix: string; pkg: string; version: string }
  | { kind: 'other'; launcher: string; binary: string };

/**
 * How a CLI is installed, read from where its launcher really points: the
 * native installer names each binary after its version under
 * ~/.local/share/claude/versions; a global npm package lives in
 * <prefix>/lib/node_modules, owned by the top-level package there (Amp's
 * binary sits in @ampcode/cli, inside the installed @sourcegraph/amp).
 */
export function classifyInstall(launcher: string): Install {
  const binary = fs.realpathSync(launcher);
  const versions = path.dirname(binary);
  if (path.basename(versions) === 'versions' && path.basename(path.dirname(versions)) === 'claude'
    && /^\d+\.\d+\.\d+/.test(path.basename(binary))) {
    return { kind: 'native', launcher, binary, version: path.basename(binary) };
  }
  const marker = `${path.sep}lib${path.sep}node_modules${path.sep}`;
  const at = binary.indexOf(marker);
  if (at > 0) {
    const prefix = binary.slice(0, at);
    const [first, second] = binary.slice(at + marker.length).split(path.sep);
    const pkg = first.startsWith('@') ? `${first}/${second}` : first;
    const manifest = readJson(path.join(prefix, 'lib', 'node_modules', pkg, 'package.json'));
    if (manifest?.name === pkg && typeof manifest.version === 'string') {
      return { kind: 'npm', launcher, binary, prefix, pkg, version: manifest.version };
    }
  }
  return { kind: 'other', launcher, binary };
}

/** Claude Code's reading of an environment flag: 1, true, yes or on. */
function flagSet(value: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase().trim());
}

/**
 * Whether the user turned Claude Code's updates off, by the rules its own
 * updater follows (2.1.280), read from their configuration rather than from
 * the environment Tars gives its agents: DISABLE_UPDATES, DISABLE_AUTOUPDATER
 * and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, in Tars's environment or in
 * ~/.claude/settings.json, and `autoUpdates: false` in ~/.claude.json unless the
 * native installer set it there itself (`autoUpdatesProtectedForNative`), which
 * it does on every native install, JeanBrasse's included.
 */
function claudeUpdatesOff(ctx: CliUpdateContext): string | null {
  const settingsEnv = (readJson(path.join(ctx.home, '.claude', 'settings.json'))?.env ?? {}) as Record<string, unknown>;
  for (const name of ['DISABLE_UPDATES', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']) {
    const on = name === 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' ? (v: unknown) => !!v : flagSet;
    if (on(ctx.env[name])) return `${name} is set in the environment Tars was started with`;
    if (on(settingsEnv[name])) return `${name} is set in ~/.claude/settings.json`;
  }
  const config = readJson(path.join(ctx.home, '.claude.json'));
  if (config?.autoUpdates === false
    && !(config.installMethod === 'native' && config.autoUpdatesProtectedForNative === true)) {
    return 'autoUpdates is false in ~/.claude.json';
  }
  return null;
}

async function updateNativeClaude(install: Extract<Install, { kind: 'native' }>, ctx: CliUpdateContext): Promise<CliUpdateResult> {
  const from = install.version;
  const off = claudeUpdatesOff(ctx);
  if (off) return { cli: 'claude', outcome: 'skipped', from, detail: off };
  // A path in Settings that names one version rather than the installer's
  // link: the update would move the link and every launch would stay put.
  if (!fs.lstatSync(install.launcher).isSymbolicLink()) {
    return { cli: 'claude', outcome: 'skipped', from, detail: `${install.launcher} is one fixed version, not the link the installer moves: point Settings at ~/.local/bin/claude` };
  }

  const run = await runFile(install.launcher, ['update'], ctx.env, INSTALL_TIMEOUT_MS, ctx.home);
  // The verdict is the link, not the words: `claude update` exits 0 when the
  // administrator lockdown refuses it, and prints what it did in a form that
  // has changed before.
  let to: string | null = null;
  try {
    to = path.basename(fs.realpathSync(install.launcher));
  } catch {
    // Gone mid-update: reported as a failure below.
  }
  const said = lines(run.stdout).pop();
  const took = `${(run.ms / 1000).toFixed(1)} s`;
  if (to && to !== from) return { cli: 'claude', outcome: 'updated', from, to, detail: `${said ?? 'claude update'} (${took})` };
  if (run.code === 0 && to) return { cli: 'claude', outcome: 'unchanged', from, detail: said ?? 'claude update printed nothing' };
  return { cli: 'claude', outcome: 'failed', from, detail: `${failure(run)}, ${took}` };
}

/** 1.2.3 as numbers; anything after the patch is ignored, since Amp's is a commit hash. */
function release(version: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function newer(candidate: string, installed: string): boolean {
  const a = release(candidate);
  const b = release(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The pids that have `file` open, a running binary included; null when it cannot be told. */
async function processesUsing(file: string, ctx: CliUpdateContext): Promise<number[] | null> {
  const run = await runFile('lsof', ['-t', file], ctx.env, QUERY_TIMEOUT_MS, ctx.home);
  const pids = lines(run.stdout).map(Number).filter(Number.isInteger);
  if (run.code === 0 && pids.length > 0) return pids;
  // lsof exits 1 and prints nothing when no process has the file open.
  if (run.code === 1 && pids.length === 0) return [];
  return null;
}

/** Whether the user turned Amp's own updates off, in their settings rather than in the copy Tars hands its agents. */
function ampUpdatesOff(ctx: CliUpdateContext): string | null {
  const settings = readJson(path.join(ctx.home, '.config', 'amp', 'settings.json'));
  return settings?.['amp.updates.mode'] === 'disabled' ? 'amp.updates.mode is "disabled" in ~/.config/amp/settings.json' : null;
}

async function updateNpmGlobal(cli: string, install: Extract<Install, { kind: 'npm' }>, ctx: CliUpdateContext): Promise<CliUpdateResult> {
  const from = install.version;
  const off = cli === 'amp' ? ampUpdatesOff(ctx) : null;
  if (off) return { cli, outcome: 'skipped', from, detail: off };

  // The npm beside the prefix's node, which is the pair that installed it, and
  // the prefix named outright either way.
  const binDir = path.join(install.prefix, 'bin');
  const env = { ...ctx.env, PATH: `${binDir}${path.delimiter}${ctx.env.PATH ?? ''}`, npm_config_update_notifier: 'false' };
  const npm = locate('npm', env.PATH);
  if (!npm) return { cli, outcome: 'failed', from, detail: `no npm found to update ${install.pkg} in ${install.prefix}` };

  // npm's cache goes to a scratch folder deleted at the end, never ~/.npm, which
  // npm never prunes (QA: 38 MB kept per Amp release, about ten releases a day).
  // The price: the package's metadata fetched whole on every check, 1.2 MB.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-cli-update-'));
  const cache = path.join(scratch, 'npm-cache');
  try {
    // No retries: npm retries a refused connection for 70 s, past the query
    // timeout, and the log then said "exit timeout" instead of naming the network.
    const view = await runFile(npm, ['view', install.pkg, 'version', '--prefix', install.prefix, '--cache', cache, '--fetch-retries=0'], env, QUERY_TIMEOUT_MS, ctx.home);
    const latest = lines(view.stdout).pop();
    if (view.code !== 0 || !latest) return { cli, outcome: 'failed', from, detail: `npm view ${install.pkg}: ${failure(view)}` };
    if (!newer(latest, from)) return { cli, outcome: 'unchanged', from, detail: `${install.pkg} ${latest} is the latest on npm` };

    // Asked before the download as well as after it: with nothing kept between
    // checks, an update deferred every half hour would download the tarball
    // again each time.
    const deferred = runningFor(cli, from, latest, install.binary, await processesUsing(install.binary, ctx));
    if (deferred) return deferred;

    // Downloaded before anything is removed: the window in which the binary is
    // missing then lasts as long as unpacking, not as long as the network.
    const download = path.join(scratch, 'download');
    const fetched = await runFile(npm, ['install', '--prefix', download, '--cache', cache, '--ignore-scripts', '--no-save', '--no-audit', '--no-fund', `${install.pkg}@${latest}`], env, INSTALL_TIMEOUT_MS, scratch);
    if (fetched.code !== 0) return { cli, outcome: 'failed', from, detail: `downloading ${install.pkg}@${latest}: ${failure(fetched)}` };

    const deferredNow = runningFor(cli, from, latest, install.binary, await processesUsing(install.binary, ctx));
    if (deferredNow) return deferredNow;

    const run = await runFile(npm, ['install', '--global', '--prefix', install.prefix, '--cache', cache, '--prefer-offline', '--no-audit', '--no-fund', `${install.pkg}@${latest}`], env, INSTALL_TIMEOUT_MS, ctx.home);
    const now = readJson(path.join(install.prefix, 'lib', 'node_modules', install.pkg, 'package.json'))?.version;
    const took = `${(run.ms / 1000).toFixed(1)} s`;
    if (run.code === 0 && typeof now === 'string' && now !== from) {
      return { cli, outcome: 'updated', from, to: now, detail: `npm install -g ${install.pkg}@${latest} (${took})` };
    }
    return { cli, outcome: 'failed', from, detail: `npm install -g ${install.pkg}@${latest}: ${failure(run)}, ${took}` };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The deferral for an update whose binary is in use, or null when nothing runs it. */
function runningFor(cli: string, from: string, latest: string, binary: string, running: number[] | null): CliUpdateResult | null {
  if (running === null) return { cli, outcome: 'deferred', from, detail: `${latest} is out, and whether ${binary} is running could not be checked` };
  if (running.length === 0) return null;
  return { cli, outcome: 'deferred', from, detail: `${latest} is out; waiting for ${running.length === 1 ? 'the process' : `the ${running.length} processes`} running it to end (pid ${running.join(', ')})` };
}

/** Update one CLI if Tars knows how to for the way it is installed. */
export async function updateCli(cli: string, command: string, ctx: CliUpdateContext): Promise<CliUpdateResult> {
  const launcher = locate(command, ctx.env.PATH ?? '');
  if (!launcher) return { cli, outcome: 'skipped', detail: `not installed: ${command} not found` };
  let install: Install;
  try {
    install = classifyInstall(launcher);
  } catch (err) {
    return { cli, outcome: 'failed', detail: `could not resolve ${launcher}: ${err instanceof Error ? err.message : String(err)}` };
  }

  const outside = (from: string): CliUpdateResult | null => inside(install.binary, fs.realpathSync(ctx.home)) ? null
    : { cli, outcome: 'skipped', from, detail: `${install.binary} is outside ${ctx.home}, and Tars only updates what is installed under the home it runs in` };
  if (cli === 'claude' && install.kind === 'native') return outside(install.version) ?? updateNativeClaude(install, ctx);
  if (cli === 'amp' && install.kind === 'npm') return outside(install.version) ?? updateNpmGlobal(cli, install, ctx);

  const how = install.kind === 'native' ? 'the native installer' : install.kind === 'npm' ? `npm (${install.pkg})` : install.binary;
  const why = UPDATABLE.includes(cli as UpdatableCli)
    ? 'Tars updates claude through its native installer and amp as a global npm package'
    : 'no update path for it has been measured';
  return { cli, outcome: 'skipped', detail: `installed through ${how}; ${why}. Update it yourself` };
}

export function formatResult(result: CliUpdateResult, at = new Date()): string {
  const versions = result.to ? ` ${result.from} to ${result.to}` : result.from ? ` ${result.from}` : '';
  return `${at.toISOString()} ${result.cli} ${result.outcome}${versions}: ${result.detail}`;
}

function writeLog(file: string, line: string): void {
  console.log(`[cli-updates] ${line}`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      // No log yet.
    }
    fs.appendFileSync(file, `${line}\n`);
  } catch (err) {
    console.error('[cli-updates] could not write', file, err);
  }
}

/** What each CLI last came to, per log, so a check that changes nothing is written once and not every half hour. */
const lastOutcome = new Map<string, string>();

/**
 * One pass over the CLIs, one at a time. A result is logged when it differs
 * from that CLI's previous one, and a failure every time.
 */
export async function runCliUpdatePass(
  targets: Array<{ cli: string; command: string; inUse?: boolean }>,
  ctx: CliUpdateContext,
): Promise<CliUpdateResult[]> {
  const results: CliUpdateResult[] = [];
  for (const { cli, command, inUse } of targets) {
    let result: CliUpdateResult;
    try {
      result = inUse === false
        ? { cli, outcome: 'skipped', detail: 'no agent runs it, so Tars does not check it' }
        : await updateCli(cli, command, ctx);
    } catch (err) {
      result = { cli, outcome: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }
    results.push(result);
    // A skip's reason is part of what it says: an Amp no agent runs, then one
    // an agent runs that is not installed, are two lines, not one repeated.
    const key = `${result.outcome} ${result.from ?? ''} ${result.to ?? ''} ${result.outcome === 'skipped' ? result.detail : ''}`;
    const slot = `${ctx.logFile}\0${cli}`;
    const repeat = result.outcome !== 'failed' && lastOutcome.get(slot) === key;
    lastOutcome.set(slot, key);
    if (!repeat) writeLog(ctx.logFile, formatResult(result));
  }
  return results;
}

let passInFlight: Promise<unknown> | null = null;

/**
 * The binaries the fleet runs, by each agent's provider. An agent with none is
 * on Claude, as every launch reads it, and so are the thirteen providers that
 * point the claude binary at another vendor.
 */
export function clisInUse(providers: Iterable<AgentProvider | undefined>): Set<string> {
  return new Set([...providers].map(provider => getProvider(provider ?? 'claude').binaryName));
}

/**
 * Update the CLIs the agents run 5 s after launch and every thirty minutes
 * after, one pass at a time, while "Check for updates" is on. The first pass
 * also names the CLIs in use here that Tars leaves alone. Never in an E2E run,
 * which boots the real app in a scratch HOME.
 */
export function startCliUpdates(
  getSettings: () => AppSettings,
  getProvidersInUse: () => Iterable<AgentProvider | undefined>,
): void {
  if (process.env.DOROTHY_E2E === '1') return;
  let first = true;
  let wasOff = false;
  const pass = () => {
    if (passInFlight) return;
    const settings = getSettings();
    const ctx: CliUpdateContext = {
      home: os.homedir(),
      env: { ...process.env, PATH: buildFullPath() },
      logFile: CLI_UPDATES_LOG,
    };
    if (settings.autoCheckUpdates === false) {
      if (!wasOff) writeLog(ctx.logFile, `${new Date().toISOString()} all off: "Check for updates" is off in Settings, so no CLI is checked`);
      wasOff = true;
      return;
    }
    wasOff = false;
    const inUse = clisInUse(getProvidersInUse());
    const binaries: string[] = first
      ? [...new Set([...UPDATABLE, ...getAllProviders().map(p => p.binaryName)])]
      : UPDATABLE;
    const targets = binaries
      // One Tars updates but no agent runs is named, and not touched.
      .filter(cli => inUse.has(cli) || UPDATABLE.includes(cli as UpdatableCli))
      .flatMap(cli => {
        const provider = getAllProviders().find(p => p.binaryName === cli);
        return provider ? [{ cli, command: provider.resolveBinaryPath(settings), inUse: inUse.has(cli) }] : [];
      })
      // A CLI Tars does not update is only worth a line when it is there.
      .filter(t => UPDATABLE.includes(t.cli as UpdatableCli) || locate(t.command, ctx.env.PATH ?? ''));
    first = false;
    passInFlight = runCliUpdatePass(targets, ctx)
      .catch(err => console.error('[cli-updates] pass failed:', err))
      .finally(() => { passInFlight = null; });
  };
  setTimeout(pass, FIRST_PASS_DELAY_MS).unref?.();
  setInterval(pass, INTERVAL_MS).unref?.();
}
