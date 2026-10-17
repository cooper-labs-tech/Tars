import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { updateSharedJsonSync } from '../../utils/shared-file';
import { writeSecretFileSync } from '../../utils/secret-file';
import { closesByAccessList, ownerOnlyDirProblemSync, ownerOnlyDirSync } from '../../platform/owner-only';
import { accountsRoot } from './registry';

/**
 * Makes an account's configuration folder one Tars's agents can work in
 * (DESIGN-COMPTES-CLAUDE.md, B2). Run when the account is added, before its
 * login terminal, and again at each launch on it, so what it copies stays
 * current.
 *
 * Measured on claude 2.1.283: with CLAUDE_CONFIG_DIR set, everything below is
 * read from that folder, symbolic links followed.
 *
 * - Shared through links to ~/.claude: projects/ (the transcripts, and every
 *   agent's memory, which lives in projects/<project>/memory; Usage, the Chat,
 *   resume and the Memory page all read ~/.claude/projects, and `--resume`
 *   from another account finds nothing without it), history.jsonl and
 *   sessions/ (the stats Tars reads, the Audit's N3; measured on 2.1.283, a
 *   prompt is appended through the link and a session's file written and
 *   removed through it, the links staying links), and the user's own
 *   CLAUDE.md, skills, agents, commands, plugins and output styles.
 * - settings.json: a copy of ~/.claude/settings.json, which is the source. It
 *   carries Tars's hooks and status line, so every account reports like
 *   account 1. A copy and not a link: a file Claude Code rewrites by renaming
 *   a new one over it would turn a link into a file of its own, silently.
 *   Without any credential Claude Code would sign in with (see
 *   CREDENTIAL_KEYS): a copied API key would make every account one account,
 *   and copying a credential is exactly what Tars never does.
 * - .claude.json: the account's own (its identity lives there). Mirrored from
 *   ~/.claude.json: the MCP servers, the theme, and the bypass acceptance
 *   (measured: without it, `--dangerously-skip-permissions` stops on a warning
 *   with "No, exit" preselected); and, for the project being launched, its
 *   whole projects[] entry: trust, and the approvals of its .mcp.json servers
 *   and CLAUDE.md imports, which would otherwise ask again in every account.
 *   Onboarding is marked done.
 *
 * The folder must be Tars's own before anything is written (accountDirProblem).
 * One that is not is refused, never repaired. Nothing else in it is opened,
 * listed or read: the credential (the keychain item named after the folder, or
 * .credentials.json on Linux and Windows) is Claude Code's alone.
 *
 * Windows (the parity program's P6): a folder is closed and read by its access
 * list, the user and SYSTEM alone (platform/owner-only.ts), where macOS and
 * Linux use its mode and uid. A symbolic link needs Developer Mode or an
 * administrator there, so a shared folder is joined by a junction, and a
 * shared file by a symbolic link when Windows allows one, else by a hard link
 * to the same file; at the next launch each is recognised as Tars's own, and a
 * hard link that is no longer the same file is reported, as anything real is.
 */

export const SHARED_ENTRIES = ['projects', 'history.jsonl', 'sessions', 'CLAUDE.md', 'skills', 'agents', 'commands', 'plugins', 'output-styles'] as const;

/** Keys of ~/.claude.json an account mirrors. */
const MIRRORED_KEYS = ['mcpServers', 'theme', 'bypassPermissionsModeAccepted'] as const;

/** What in settings.json signs Claude Code in instead of the account's own login. */
const CREDENTIAL_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport'] as const;
/** Credentials Claude Code signs in with, whenever they are set. */
const CREDENTIAL_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN'] as const;
/**
 * Switches that send Claude Code to another provider (names read from the
 * 2.1.285 binary): with one on, every account runs on that provider's
 * credentials, whichever folder it is launched with.
 */
const PROVIDER_SWITCHES = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
] as const;
/**
 * Those providers' own credentials: used only behind a switch, so they do not
 * refuse the option, but a credential all the same, never copied.
 */
const CLOUD_CREDENTIAL_ENV = /^(AWS_|ANTHROPIC_(FOUNDRY|AWS|IDENTITY)_|GOOGLE_APPLICATION_CREDENTIALS$)/;

/** A switch as Claude Code reads one: on for 1, true, yes or on. */
function switchedOn(value: unknown): boolean {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

const ACCOUNT_ID = /^acct-[0-9a-f]{6}$/;

export interface ProvisionReport {
  /** Shared entries where something real sits in place of the link, left alone. */
  conflicts: string[];
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** A folder Tars made: a directory, not a link, this user's, closed to others (as #224's stillOurs). */
function folderProblem(p: string, what: string): string | null {
  const st = lstatOrNull(p);
  if (!st) return `${what} does not exist.`;
  if (st.isSymbolicLink()) return `${what} is a link, not a folder Tars made.`;
  if (!st.isDirectory()) return `${what} is not a folder.`;
  if (closesByAccessList()) {
    const open = ownerOnlyDirProblemSync(p);
    return open ? `${what} ${open}.` : null;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
  if (st.uid !== uid) return `${what} belongs to another user.`;
  if ((st.mode & 0o077) !== 0) return `${what} is open to other users.`;
  return null;
}

/**
 * Why `dir` is not an account folder Tars may use, or null. It must be exactly
 * <root>/<id>, and both it and the root must pass folderProblem.
 */
export function accountDirProblem(dir: string, root: string = accountsRoot()): string | null {
  if (!path.isAbsolute(dir) || path.dirname(dir) !== root || !ACCOUNT_ID.test(path.basename(dir))) {
    return 'This is not an account folder under ~/.claude-accounts.';
  }
  return folderProblem(root, 'The accounts folder ~/.claude-accounts') ?? folderProblem(dir, 'This account folder');
}

function readJsonOrUndefined(file: string): Record<string, unknown> | undefined | 'unreadable' {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/**
 * What would sign every account in with one credential, by name, never by
 * value: in ~/.claude/settings.json (its keys and its env) and in Tars's own
 * environment, which every CLI inherits. A provider switch turned on counts:
 * Bedrock, Vertex and the others sign in with their own credentials. A settings.json that does not parse
 * is named too, since nobody can tell what it holds.
 */
export function claudeCredentialOverrides(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const found: string[] = [];
  const settings = readJsonOrUndefined(path.join(home, '.claude', 'settings.json'));
  if (settings === 'unreadable') {
    found.push('~/.claude/settings.json, which does not parse');
  } else if (settings) {
    for (const key of CREDENTIAL_KEYS) if (settings[key] !== undefined) found.push(`${key} in ~/.claude/settings.json`);
    const settingsEnv = settings.env && typeof settings.env === 'object' ? settings.env as Record<string, unknown> : {};
    for (const name of CREDENTIAL_ENV) if (settingsEnv[name] !== undefined) found.push(`${name} in the env of ~/.claude/settings.json`);
    for (const name of PROVIDER_SWITCHES) if (switchedOn(settingsEnv[name])) found.push(`${name} in the env of ~/.claude/settings.json`);
  }
  for (const name of CREDENTIAL_ENV) if (env[name]) found.push(`${name} in the environment Tars was started with`);
  for (const name of PROVIDER_SWITCHES) if (switchedOn(env[name])) found.push(`${name} in the environment Tars was started with`);
  return found;
}

/**
 * ~/.claude/settings.json without its credentials: the sign-in keys, and in
 * its env the credentials, the provider switches and those providers' own
 * credentials (AWS_*, GOOGLE_APPLICATION_CREDENTIALS, ANTHROPIC_FOUNDRY_*...).
 */
function withoutCredentials(settings: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...settings };
  for (const key of CREDENTIAL_KEYS) delete copy[key];
  if (copy.env && typeof copy.env === 'object' && !Array.isArray(copy.env)) {
    const env = { ...(copy.env as Record<string, unknown>) };
    for (const name of Object.keys(env)) {
      if ((CREDENTIAL_ENV as readonly string[]).includes(name)
        || (PROVIDER_SWITCHES as readonly string[]).includes(name)
        || CLOUD_CREDENTIAL_ENV.test(name)) delete env[name];
    }
    copy.env = env;
  }
  return copy;
}

function ensureOwnFolder(p: string, what: string): void {
  if (!lstatOrNull(p)) {
    // A mode closes nothing on Windows: there the folder is made with its access list.
    if (closesByAccessList()) ownerOnlyDirSync(p);
    else fs.mkdirSync(p, { mode: 0o700 });
  }
  const problem = folderProblem(p, what);
  if (problem) throw new Error(problem);
}

/** The same file, by its volume and its id: a hard link to `b` is one. */
function sameFile(a: string, b: string): boolean {
  try {
    const x = fs.statSync(a, { bigint: true });
    const y = fs.statSync(b, { bigint: true });
    return x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

/** A path as Windows compares it: no long-path prefix, no trailing separator, any case. */
const windowsKey = (p: string) => path.win32.resolve(p.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '').toLowerCase();

/** Whether what is at `link` is Tars's link to `target`: a symbolic link or a junction to it, or on Windows a hard link to it. */
function linksTo(link: string, current: fs.Stats, target: string): boolean {
  if (current.isSymbolicLink()) {
    const to = fs.readlinkSync(link);
    return closesByAccessList() ? windowsKey(to) === windowsKey(target) : to === target;
  }
  return closesByAccessList() && current.isFile() && sameFile(link, target);
}

/** A symbolic link; on Windows, a junction for a folder, and for a file a hard link when Windows refuses a symbolic one. */
function makeLink(target: string, link: string): void {
  if (!closesByAccessList()) {
    fs.symlinkSync(target, link);
    return;
  }
  if (fs.statSync(target).isDirectory()) {
    fs.symlinkSync(target, link, 'junction');
    return;
  }
  try {
    fs.symlinkSync(target, link, 'file');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    fs.linkSync(target, link);
  }
}

function linkShared(configDir: string, claudeDir: string, conflicts: string[]): void {
  for (const name of SHARED_ENTRIES) {
    const target = path.join(claudeDir, name);
    const link = path.join(configDir, name);
    // These must be shared even before account 1 has run anything, or the
    // account's first session would create its own there, and then keep it.
    if (name === 'projects') fs.mkdirSync(target, { recursive: true });
    if (name === 'sessions') fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    if (name === 'history.jsonl' && !lstatOrNull(target)) {
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(target, '', { flag: 'a', mode: 0o600 });
    }
    let current = lstatOrNull(link);
    // An empty folder where a link should be holds nothing to lose: Claude
    // Code run in this folder before Tars made projects/ that way, and what
    // the account then writes there never reaches ~/.claude/projects (the
    // Audit's gap 5). rmdir removes only an empty folder, so nothing in the
    // account folder is listed to find out.
    if (current?.isDirectory()) {
      try {
        fs.rmdirSync(link);
        current = null;
      } catch {
        // not empty: left as it is, and reported
      }
    }
    if (current) {
      if (linksTo(link, current, target)) continue;
      if (!current.isSymbolicLink()) {
        conflicts.push(name);
        continue;
      }
      // A link, and only a link, is removed: it is Tars's own. A junction too:
      // libuv unlinks one as a link, the folder it points to untouched.
      fs.unlinkSync(link);
    }
    if (!lstatOrNull(target)) continue;
    makeLink(target, link);
  }
}

function copySettings(configDir: string, claudeDir: string): void {
  const source = readJsonOrUndefined(path.join(claudeDir, 'settings.json'));
  // Unreadable: nobody can tell what to leave out, so nothing is copied and
  // the account keeps the copy it had.
  if (source === undefined || source === 'unreadable') return;
  const next = JSON.stringify(withoutCredentials(source), null, 2);
  const copy = path.join(configDir, 'settings.json');
  let current: string | undefined;
  try {
    current = fs.readFileSync(copy, 'utf-8');
  } catch {
    current = undefined;
  }
  if (current !== next) writeSecretFileSync(copy, next);
}

function mirrorClaudeJson(configDir: string, home: string, projectPath: string | undefined): void {
  const source = readJsonOrUndefined(path.join(home, '.claude.json'));
  updateSharedJsonSync<Record<string, unknown>>(path.join(configDir, '.claude.json'), current => {
    const next: Record<string, unknown> = { ...(current ?? {}) };
    next.hasCompletedOnboarding = true;
    // Unreadable: the account keeps what it has rather than losing its servers.
    if (source === 'unreadable') return next;
    for (const key of MIRRORED_KEYS) {
      if (source && source[key] !== undefined) next[key] = source[key];
      else delete next[key];
    }
    const entry = projectPath && source?.projects && typeof source.projects === 'object'
      ? (source.projects as Record<string, unknown>)[projectPath]
      : undefined;
    if (projectPath && entry && typeof entry === 'object') {
      const projects = next.projects && typeof next.projects === 'object' ? { ...(next.projects as Record<string, unknown>) } : {};
      const own = projects[projectPath] && typeof projects[projectPath] === 'object' ? projects[projectPath] as Record<string, unknown> : {};
      // Account 1's entry over the account's, every key it has winning (its
      // last session and costs included, which only feed the exit summary);
      // keys only the account wrote are kept.
      projects[projectPath] = { ...own, ...(entry as Record<string, unknown>) };
      next.projects = projects;
    }
    return next;
  }, { createMode: 0o600 });
}

/**
 * The account folder, and its root, made when missing (owner-only) and
 * checked as Tars's own; nothing is written into it. Throws for anything that
 * is not ~/.claude-accounts/<id> or not Tars's own.
 */
export function ensureAccountDir(configDir: string, home: string = os.homedir()): void {
  const root = path.join(fs.realpathSync(home), '.claude-accounts');
  if (!path.isAbsolute(configDir) || path.dirname(configDir) !== root || !ACCOUNT_ID.test(path.basename(configDir))) {
    throw new Error('This is not an account folder under ~/.claude-accounts.');
  }
  ensureOwnFolder(root, 'The accounts folder ~/.claude-accounts');
  ensureOwnFolder(configDir, 'This account folder');
}

/**
 * Why no agent starts on this account, or null: its projects/ is a folder of
 * its own holding something, so the transcripts and memory its agents write
 * would stay out of ~/.claude/projects, where Usage, resume and the Chat read
 * (the Audit's gap 5, measured: a reply written there never reached the
 * page). Tars never empties it. Shown in Settings, and the launch starts the
 * agent on account 1 instead.
 */
export function projectsProblem(configDir: string): string | null {
  const projects = lstatOrNull(path.join(configDir, 'projects'));
  if (!projects || projects.isSymbolicLink()) return null;
  return `Its projects folder (${path.join(configDir, 'projects')}) is a folder of its own, not the link to ~/.claude/projects, `
    + 'so its agents start on account 1: what they wrote there would never reach Usage or be resumed. '
    + 'Move its contents into ~/.claude/projects and delete it, and Tars links it at the next launch.';
}

export function provisionAccountDir(configDir: string, home: string = os.homedir(), opts: { projectPath?: string } = {}): ProvisionReport {
  ensureAccountDir(configDir, home);

  const claudeDir = path.join(home, '.claude');
  const conflicts: string[] = [];
  linkShared(configDir, claudeDir, conflicts);
  copySettings(configDir, claudeDir);
  mirrorClaudeJson(configDir, home, opts.projectPath);
  return { conflicts };
}
