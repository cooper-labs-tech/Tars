import { execFile as nodeExecFile, execFileSync as nodeExecFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Env } from './fs-probe';
import { envValue } from './path-env';
import { childEnv } from './child-env';

/**
 * Close a secret file, or the private directory, to every account but its
 * owner, on Windows.
 *
 * `0o600` and `0o700` do nothing there: Node maps chmod to the read-only bit.
 * What stands in for them is the access list: the current user and SYSTEM,
 * full control, nothing inherited, so a grant added to the folder later (Codex
 * adds `CodexSandboxUsers` to the folders its sandbox reads, with (OI)(CI))
 * does not reach the file either. The Administrators group the profile hands
 * down goes too; an administrator can take the file back, so that is not a
 * boundary, only no standing grant.
 *
 * Not a boundary against the agents: they run as the same user, and the user
 * keeps full control. What it keeps out is the other accounts on the machine,
 * the sandbox accounts included.
 *
 * icacls and whoami by their absolute path under %SystemRoot%\System32, never
 * looked up on the PATH (where an agent's project could plant one), with an
 * argv; the user named by SID (`*S-1-5-21-...`), never by a name icacls would
 * have to resolve, and SYSTEM by its well-known SID, so nothing depends on the
 * language of the machine. The SID is asked of `whoami /user` once per process.
 *
 * Two forms. The synchronous one is for a write, which must close its temp
 * file before the rename. The asynchronous one is for the pass at startup,
 * which starts two icacls per file: measured on a machine at 100% CPU, 2 to
 * 4.6 s for three files and a directory of three, time the main process would
 * otherwise spend frozen before its window shows.
 *
 * Never throws, never rejects: a failure is logged with the path and reported,
 * and the caller keeps what it wrote. darwin/linux: nothing runs, the answer
 * is `skipped`.
 */

export const SYSTEM_SID = 'S-1-5-18';

/** `skipped`: not win32, or nothing there to close. `failed`: logged, the file left as it was. */
export type OwnerOnlyResult = 'skipped' | 'restricted' | 'failed';

export interface OwnerOnlyDeps {
  platform?: NodeJS.Platform;
  env?: Env;
  /** Runs a program, returns its stdout; throws as child_process.execFileSync does. */
  execFileSync?: (file: string, args: readonly string[]) => string;
  /** The same, asynchronously; rejects as child_process.execFile does. */
  execFile?: (file: string, args: readonly string[]) => Promise<string>;
  warn?: (message: string) => void;
}

export interface OwnerOnlyOptions {
  /**
   * Drop the file's explicit entries too (`icacls /reset` first), for a file
   * that already existed: one Tars just created has none, only what it
   * inherited, which `/inheritance:r` removes.
   */
  replaceExplicit?: boolean;
}

const SID_SHAPE = /^S-1-\d+(-\d+)+$/;
const WHOAMI_ARGS = ['/user', '/fo', 'csv', '/nh'];

/** A hung icacls must not hold the main process for ever. */
const TIMEOUT_MS = 10_000;
const RUN_OPTIONS = { encoding: 'utf8', windowsHide: true, timeout: TIMEOUT_MS } as const;

const runSync = (file: string, args: readonly string[]): string =>
  nodeExecFileSync(file, args as string[], { ...RUN_OPTIONS, stdio: ['ignore', 'pipe', 'pipe'] });

const runAsync = (file: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = nodeExecFile(file, args as string[], RUN_OPTIONS, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve(stdout);
    });
    child.stdin?.end();
  });

/**
 * The SID in `whoami /user /fo csv /nh`: `"domain\name","S-1-5-21-..."`. The
 * last quoted field, so a name with a comma or a doubled quote does not shift
 * it; null for anything that is not a SID.
 */
export function parseWhoamiUserSid(stdout: string): string | null {
  const last = /"([^"]*)"\s*$/.exec(stdout.trim())?.[1];
  return last && SID_SHAPE.test(last) ? last : null;
}

let cachedSid: string | undefined;

/** Cached only for the real runners: an injected one is a test's own world. */
function rememberSid(out: unknown, injected: boolean): string {
  const sid = parseWhoamiUserSid(String(out ?? ''));
  if (!sid) throw new Error('whoami /user gave no SID');
  if (!injected) cachedSid = sid;
  return sid;
}

function system32(deps: OwnerOnlyDeps, exe: string): string {
  const systemRoot = envValue(deps.env ?? process.env, 'SystemRoot', 'win32') || 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', exe);
}

const notWindows = (deps: OwnerOnlyDeps) => !closesByAccessList(deps.platform);

/** Whether this platform closes a secret with an access list (win32), not with its mode. */
export function closesByAccessList(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

/** The icacls argv lists that leave `target` with the user and SYSTEM only. */
function icaclsSteps(target: string, kind: 'file' | 'directory', options: OwnerOnlyOptions, sid: string): string[][] {
  const inherit = kind === 'directory' ? '(OI)(CI)' : '';
  return [
    ...(options.replaceExplicit ? [[target, '/reset']] : []),
    [target, '/inheritance:r', '/grant:r', `*${sid}:${inherit}(F)`, `*${SYSTEM_SID}:${inherit}(F)`],
  ];
}

function why(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { code?: unknown; status?: unknown; stdout?: unknown; stderr?: unknown };
  const said = `${String(e.stderr ?? '')} ${String(e.stdout ?? '')}`.replace(/\s+/g, ' ').trim();
  const code = e.status ?? e.code;
  return [code === undefined || code === null ? e.message : `exit ${String(code)}`, said].filter(Boolean).join(': ');
}

function failed(target: string, err: unknown, deps: OwnerOnlyDeps, what = 'keeps the access list its folder hands down'): 'failed' {
  (deps.warn ?? ((m: string) => console.warn(m)))(`[secret-acl] ${target} ${what}: ${why(err)}`);
  return 'failed';
}

function grantSync(target: string, kind: 'file' | 'directory', options: OwnerOnlyOptions, deps: OwnerOnlyDeps): OwnerOnlyResult {
  const run = deps.execFileSync ?? runSync;
  try {
    const sid = (!deps.execFileSync && cachedSid) || rememberSid(run(system32(deps, 'whoami.exe'), WHOAMI_ARGS), !!deps.execFileSync);
    for (const args of icaclsSteps(target, kind, options, sid)) run(system32(deps, 'icacls.exe'), args);
    return 'restricted';
  } catch (err) {
    return failed(target, err, deps);
  }
}

async function grantAsync(target: string, kind: 'file' | 'directory', options: OwnerOnlyOptions, deps: OwnerOnlyDeps): Promise<OwnerOnlyResult> {
  const run = deps.execFile ?? runAsync;
  try {
    const sid = (!deps.execFile && cachedSid) || rememberSid(await run(system32(deps, 'whoami.exe'), WHOAMI_ARGS), !!deps.execFile);
    for (const args of icaclsSteps(target, kind, options, sid)) await run(system32(deps, 'icacls.exe'), args);
    return 'restricted';
  } catch (err) {
    return failed(target, err, deps);
  }
}

/**
 * Leave `target` (a file) with the user and SYSTEM only, full control,
 * inheritance removed. Synchronous: for a write, before its rename.
 */
export function restrictToOwnerSync(target: string, options: OwnerOnlyOptions = {}, deps: OwnerOnlyDeps = {}): OwnerOnlyResult {
  if (notWindows(deps)) return 'skipped';
  return grantSync(target, 'file', options, deps);
}

/** The same, without holding the caller: for the pass at startup. */
export async function restrictToOwner(target: string, options: OwnerOnlyOptions = {}, deps: OwnerOnlyDeps = {}): Promise<OwnerOnlyResult> {
  if (notWindows(deps)) return 'skipped';
  return grantAsync(target, 'file', options, deps);
}

/**
 * Close a directory the same way, handing the two entries down to whatever is
 * made in it later, and bring what is in it now to exactly that: each entry
 * loses its own list (`/reset`) and takes the directory's. One level, as
 * narrowDataDir: the private directory has no subdirectories. A link or a
 * junction is never followed or reset, since what it points at may be any
 * file the account owns (~/.ssh); nor is the directory itself when it is one.
 * A missing directory is skipped quietly, or made first with `create`, so
 * that what is written into it later is closed from the start. The names in
 * `keep` are left with their own list (the staging directory, closed on its
 * own and never to inherit).
 */
export async function restrictDirToOwner(dir: string, deps: OwnerOnlyDeps = {}, options: { create?: boolean; keep?: string[] } = {}): Promise<OwnerOnlyResult> {
  if (notWindows(deps)) return 'skipped';
  let names: string[];
  try {
    if (options.create) fs.mkdirSync(dir, { recursive: true });
    if (!fs.lstatSync(dir).isDirectory()) return 'skipped';
    names = fs.readdirSync(dir);
  } catch {
    return 'skipped';
  }
  const own = await grantAsync(dir, 'directory', { replaceExplicit: true }, deps);
  if (own !== 'restricted') return own;
  const run = deps.execFile ?? runAsync;
  let result: OwnerOnlyResult = 'restricted';
  for (const name of names) {
    if (options.keep?.includes(name)) continue;
    const entry = path.join(dir, name);
    try {
      if (fs.lstatSync(entry).isSymbolicLink()) continue;
      await run(system32(deps, 'icacls.exe'), [entry, '/reset']);
    } catch (err) {
      result = failed(entry, err, deps, 'keeps its own access list');
    }
  }
  return result;
}

/**
 * A directory of the account's alone, made if it is missing: the user and
 * SYSTEM, handed down to what is created in it, inheritance removed, and any
 * entry of its own it carried (a grant planted on it beforehand) removed too.
 * Nothing in it is touched. Its own list is reset first, so for that moment it
 * has its parent's; the caller creates nothing in it until this has returned.
 * Where a secret is born before it takes its place (utils/secret-file.ts): a
 * file created in it has that list from its first byte. A link, a junction or
 * a file at that name is refused, and so reported.
 */
export function ownerOnlyDirSync(dir: string, deps: OwnerOnlyDeps = {}): OwnerOnlyResult {
  if (notWindows(deps)) return 'skipped';
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('not a directory of its own');
  } catch (err) {
    return failed(dir, err, deps, 'cannot be a directory of the account alone');
  }
  return grantSync(dir, 'directory', { replaceExplicit: true }, deps);
}

export interface OwnerOnlyReadDeps extends OwnerOnlyDeps {
  /** Runs the PowerShell that prints a folder's security descriptor; throws as execFileSync does. */
  readSddl?: (file: string, args: string[], env: Env) => string;
}

const SDDL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '(Get-Acl -LiteralPath $env:TARS_ACL_PATH).Sddl'];

const realReadSddl = (file: string, args: string[], env: Env): string =>
  nodeExecFileSync(file, args, { ...RUN_OPTIONS, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });

/** SYSTEM, by its alias or its SID, as SDDL may write either. */
const SYSTEM_NAMES = new Set(['SY', SYSTEM_SID]);

/**
 * Why a security descriptor (SDDL, `O:<owner>G:<group>D:<flags>(ace)...`)
 * leaves its object open to an account other than `userSid` and SYSTEM, or
 * null when it is closed as ownerOnlyDirSync closes one: `userSid` its owner,
 * its list protected from its parent's (`P`), no entry inherited (`ID`), and
 * every entry that grants (anything but a Deny) this user's or SYSTEM's.
 * By SID, so nothing depends on the language of the machine.
 */
export function sddlOpenness(sddl: string, userSid: string): string | null {
  const m = /^O:(.+?)(?:G:.+?)?D:([A-Z]*)((?:\([^()]*\))*)(?:S:.*)?$/.exec(sddl.trim());
  if (!m) return 'could not be read: its access list is not one Windows writes';
  const [, owner, flags, aces] = m;
  if (owner !== userSid) return 'belongs to another user';
  if (!flags.includes('P')) return 'is open to other users: it takes its parent\'s access list';
  for (const ace of aces.match(/\([^()]*\)/g) ?? []) {
    const [type, aceFlags = '', , , , sid] = ace.slice(1, -1).split(';');
    if (aceFlags.includes('ID')) return 'is open to other users: it holds an entry inherited from its parent';
    if (type === 'D') continue;
    if (sid !== userSid && !SYSTEM_NAMES.has(sid)) return 'is open to other users';
  }
  return null;
}

/** Folders read closed in this run, by lowercase path: one PowerShell per folder and run, not one per check. */
const closedThisRun = new Set<string>();

/**
 * Why `dir` is not closed to every account but this user's, as
 * ownerOnlyDirSync leaves one, or null when it is: its security descriptor,
 * asked of the Windows PowerShell under %SystemRoot% (no profile, no
 * PowerShell 7 module path), its path handed through the environment and never
 * written into the command. A folder that cannot be read is refused. A folder
 * read closed is not read again in this run. darwin/linux: null, nothing runs:
 * their mode decides.
 */
export function ownerOnlyDirProblemSync(dir: string, deps: OwnerOnlyReadDeps = {}): string | null {
  if (notWindows(deps)) return null;
  const injected = !!deps.readSddl || !!deps.execFileSync;
  if (!injected && closedThisRun.has(dir.toLowerCase())) return null;
  try {
    const run = deps.execFileSync ?? runSync;
    const sid = (!deps.execFileSync && cachedSid) || rememberSid(run(system32(deps, 'whoami.exe'), WHOAMI_ARGS), !!deps.execFileSync);
    const powershell = system32(deps, 'WindowsPowerShell\\v1.0\\powershell.exe');
    const env = childEnv(powershell, { ...(deps.env ?? process.env), TARS_ACL_PATH: dir }, 'win32');
    const open = sddlOpenness(String((deps.readSddl ?? realReadSddl)(powershell, SDDL_ARGS, env)), sid);
    if (!open && !injected) closedThisRun.add(dir.toLowerCase());
    return open;
  } catch (err) {
    return `could not be read: Windows did not give its access list (${why(err)})`;
  }
}
