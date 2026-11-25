import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR, PRIVATE_DIR, VAULT_DIR } from '../constants';
import { isUnder, samePath } from '../platform/path-compare';
import { coversHome } from './home-root';
import { isHardLinkInto, isWithinDir } from './path-identity';
import { inCredentialPlace, inCredentialPlaceByName, landsUnderSafeRoot, realTarget } from './real-target';

/**
 * What the window may read, write, and have local-file:// serve (the Audit's
 * Holes 1 and 2, 2.0.4). The window is the renderer: a page with an XSS, or a
 * dependency of it gone bad, holds every channel the preload hands it, and
 * these three took paths.
 *
 * Writes: the instruction files the Brain edits, by name, and nothing else:
 * ~/.claude/CLAUDE.md, ~/.tars/CLAUDE.md, and a project's CLAUDE.md or
 * .claude/CLAUDE.md. fs:write-text-file wrote any text under ~/.dorothy,
 * ~/.claude, ~/.codex, ~/.gemini, ~/.grok and every project: statusline.sh
 * (which Claude Code runs), bin/tars-mcp-node (which every Tars MCP server
 * runs on), a CLI's hooks or config, a project's git hooks. One call from a
 * compromised page ran code in every agent.
 *
 * Reads (fs:read-text-file): what the Brain and the code panel show, under the
 * CLIs' folders and the projects, and of ~/.tars only its CLAUDE.md. Never a
 * secret: nothing under ~/.tars-private, the settings or a copy of them, the
 * shared token, the Hermes files, a CLI's own credentials, by name, by real
 * path, or through a hard link into the private folder.
 *
 * local-file:// (no page uses it in 2.0.4; the vault's previews go through
 * /api/local-file): the vault's attachments, the project-files folders and
 * Claude Code's memory folders, and nothing else.
 */

/** Files that hold a credential wherever they are, by their last name. */
const SECRET_NAMES = new Set([
  'app-settings.json', 'settings-secrets.json', 'api-token', 'hermes-connection.json', 'hermes-session.json',
  'hermes-token', 'hermes-webhook-secret', 'sentry-token',
  // The CLIs' own: Claude Code's on Linux, codex's, gemini's.
  '.credentials.json', 'auth.json', 'oauth_creds.json', 'google_accounts.json',
  '.env', '.netrc', '.git-credentials', '.npmrc', '.pypirc', '.pgpass', 'credentials', 'credentials.json', 'id_rsa', 'id_ed25519',
]);

const nameIsSecret = (p: string) => {
  const name = path.basename(p).toLowerCase();
  return SECRET_NAMES.has(name) || name.startsWith('app-settings.json.') || name.startsWith('settings-secrets.json.')
    // .env.local, .env.production: a project's keys, as .env holds them (the Audit's L1 on #466).
    || name.startsWith('.env.');
};

/**
 * A CLI's settings that hold a key: Claude Code's settings.json and
 * settings.local.json, whose `env` may set ANTHROPIC_API_KEY, in ~/.claude or
 * a project's .claude, and Grok CLI's user-settings.json, where it keeps its
 * API key (the Audit's L1 on #466). No page reads one.
 */
const cliSettingsWithKey = (p: string) => {
  const name = path.basename(p).toLowerCase();
  const dir = path.basename(path.dirname(p)).toLowerCase();
  return (dir === '.claude' && (name === 'settings.json' || name === 'settings.local.json'))
    || (dir === '.grok' && name === 'user-settings.json');
};

/** A file the window must never get, judged as spelled, where it really lies, and by inode. */
export function isSecretFile(target: string): boolean {
  const resolved = path.resolve(target);
  const real = realTarget(resolved);
  if (!real) return true;
  if (nameIsSecret(resolved) || nameIsSecret(real) || cliSettingsWithKey(resolved) || cliSettingsWithKey(real)) return true;
  if (isUnder(resolved, PRIVATE_DIR) || samePath(resolved, PRIVATE_DIR) || isWithinDir(real, PRIVATE_DIR)) return true;
  return isHardLinkInto(real, PRIVATE_DIR);
}

const home = () => os.homedir();
const inside = (root: string, p: string) => samePath(root, p) || isUnder(p, root);
/** A project folder the window may reach: none that is ~/.tars, ~/.tars-private or in them. */
const projectRoots = (projects: string[]) => projects.filter((p) => typeof p === 'string' && p
  && !inside(DATA_DIR, path.resolve(p)) && !inside(PRIVATE_DIR, path.resolve(p)));

/** The CLIs' folders the window reads by their default paths: a project may be one, or lie in one. */
const CLI_FOLDERS = ['.claude', '.codex', '.gemini', '.grok'];

/**
 * The name of the home's folder `p` is in or is, under the home as spelled or where it really lies: none for the home
 * itself or a path outside it. Outside is `..` and what is under it, never a folder whose name starts with two dots.
 */
function homeFolderNames(p: string): string[] {
  const homes = [home(), realTarget(home())].filter((h): h is string => !!h);
  return homes.flatMap((h) => {
    const rel = path.relative(h, p);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return [];
    return [rel.split(path.sep)[0]];
  });
}

/** `p` is in a folder of the home whose name starts with a dot, other than the four CLI folders, or is one. */
function inOtherDotFolderOfHome(p: string): boolean {
  return homeFolderNames(p).some((first) => first.startsWith('.') && !CLI_FOLDERS.includes(first.toLowerCase()));
}

/**
 * Why a folder may not be a project, or undefined when it may: one of Tars's own folders, a folder of credentials or
 * one of the home's application folders (inCredentialPlace), or, since 2.0.7, a folder of the home whose name starts
 * with a dot other than the four CLI folders, as spelled or where it really lies. A page added any folder as a
 * project and then read it (the Audit's L1 on #466). The projects' list lives in ~/.tars, which every agent can write,
 * so each use judges a project again (windowMayRead, windowMayWrite, windowMaySearch), and fs:list-projects lists one
 * the rule refuses with this reason.
 */
export function projectRefusal(p: unknown): string | undefined {
  if (typeof p !== 'string' || !p) return 'A project is a folder named by its full path.';
  const resolved = path.resolve(p);
  return refusalOf(resolved, () => realTarget(resolved), inCredentialPlace);
}

/**
 * projectRefusal for fs:list-projects, which runs on the main thread for every project at each listing: the project is
 * followed asynchronously, and the places are then told by their names, the project's real path against the places'
 * own (inCredentialPlaceByName). A place reached under another name may go untold here; each use still judges the
 * project with projectRefusal, by identity too.
 */
export async function projectRefusalAsync(p: string): Promise<string | undefined> {
  const resolved = path.resolve(p);
  const real = projectRoots([resolved]).length > 0 ? await fs.promises.realpath(resolved).catch(() => undefined) : undefined;
  return refusalOf(resolved, () => real, inCredentialPlaceByName);
}

function refusalOf(resolved: string, realOf: () => string | undefined, credential: (spelled: string, real: string) => boolean): string | undefined {
  if (projectRoots([resolved]).length === 0) return "Tars's own folders cannot be a project.";
  const real = realOf();
  if (!real) return 'This folder cannot be followed to where it really lies.';
  if (credential(resolved, real)) {
    return 'A folder of credentials, or an application folder of the home (~/Library, AppData), cannot be a project.';
  }
  if (inOtherDotFolderOfHome(resolved) || inOtherDotFolderOfHome(real)) {
    return 'A folder of the home whose name starts with a dot cannot be a project, but for ~/.claude, ~/.codex, ~/.gemini and ~/.grok.';
  }
  return undefined;
}

/** A folder a page may add as a project, and one a use takes as a project. */
export function mayBeProject(p: unknown): boolean {
  return projectRefusal(p) === undefined;
}

/**
 * The projects among `projects` that `resolved` (or its real path) lies in, and that the rule allows. Only those are
 * judged on the disk: a project on a mount gone offline is not looked at to read another (fs-roots-home.test.ts, 7).
 */
function projectsHolding(resolved: string, real: string | undefined, projects: string[]): string[] {
  return projectRoots(projects).filter((p) => (inside(path.resolve(p), resolved) || (!!real && inside(path.resolve(p), real))) && mayBeProject(p));
}

/** fs:read-project-files' roots for one target: the fixed ones, and the projects it lies in that the rule allows. */
export function projectRootsFor(target: string, fixed: string[], projects: string[]): string[] {
  const resolved = path.resolve(target);
  return [...fixed, ...projectsHolding(resolved, realTarget(resolved), projects)];
}

export function windowMayRead(target: string, projects: string[]): boolean {
  const resolved = path.resolve(target);
  if (isSecretFile(resolved)) return false;
  if (samePath(resolved, path.join(DATA_DIR, 'CLAUDE.md'))) return true;
  const real = realTarget(resolved);
  if (!real || isWithinDir(real, DATA_DIR)) return false;
  // The target's own place, never the list's: a project on a mount gone
  // offline is not looked at to read another (fs-roots-home.test.ts, 7).
  if (inCredentialPlace(resolved, real)) return false;
  const roots = [path.join(home(), '.claude'), path.join(home(), '.codex'), path.join(home(), '.gemini'), path.join(home(), '.grok'), ...projectsHolding(resolved, real, projects)];
  return landsUnderSafeRoot(resolved, roots, inside, { linkedMarkdown: true });
}

/** The instruction files the Brain edits, and only those. */
export function instructionFiles(projects: string[]): string[] {
  return [
    path.join(home(), '.claude', 'CLAUDE.md'),
    path.join(DATA_DIR, 'CLAUDE.md'),
    ...projectRoots(projects).flatMap((p) => [path.join(p, 'CLAUDE.md'), path.join(p, '.claude', 'CLAUDE.md')]),
  ];
}

export function windowMayWrite(target: string, projects: string[]): boolean {
  const resolved = path.resolve(target);
  if (!instructionFiles(projects).some((f) => samePath(f, resolved))) return false;
  if (isSecretFile(resolved)) return false;
  // A project's instruction file, of a project the rule allows: judged for the project it belongs to only.
  const owners = projectRoots(projects).filter((p) => ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')].some((f) => samePath(path.join(p, f), resolved)));
  if (owners.length > 0 && !owners.some((p) => mayBeProject(p))) return false;
  // Followed as the write follows it: what it really writes is a markdown file.
  const real = realTarget(resolved);
  return !!real && real.toLowerCase().endsWith('.md');
}

/**
 * A file under `root` the window may read: never a secret, in no credential place, and where it really lies, inside
 * `root` itself, so a link in it leads nowhere out (strict: not even the markdown exception). What the Code panel's
 * search and the Obsidian vaults read (2.0.7).
 */
export function windowMayReadUnder(target: string, root: string): boolean {
  const resolved = path.resolve(target);
  if (isSecretFile(resolved)) return false;
  const real = realTarget(resolved);
  if (!real || inCredentialPlace(resolved, real)) return false;
  return landsUnderSafeRoot(resolved, [path.resolve(root)], inside);
}

/**
 * A folder the Code panel may list and search (project:list-files, search-files, search-content): one a project
 * Tars knows is, or lies in, where it really lies. `projects` are those added by hand and the agents' folders and
 * worktrees; ~/.tars/projects.json is every agent's to write, so each is judged as a project is (mayBeProject),
 * and none that is the home or above it opens anything (landsUnderSafeRoot).
 */
export function windowMaySearch(root: unknown, projects: string[]): boolean {
  if (typeof root !== 'string' || !root || !path.isAbsolute(root)) return false;
  const resolved = path.resolve(root);
  const real = realTarget(resolved);
  if (!real || isWithinDir(real, DATA_DIR) || inCredentialPlace(resolved, real)) return false;
  return landsUnderSafeRoot(resolved, projectsHolding(resolved, real, projects), inside);
}

/** `p` is in a folder of the home whose name starts with a dot (a CLI's settings, a credential place), or is one. */
function inDotFolderOfHome(p: string): boolean {
  return homeFolderNames(p).some((first) => first.startsWith('.'));
}

/**
 * Why a folder may not be an Obsidian vault the window reads and writes, or undefined when it may (2.0.7). Judged
 * at every use too, not only when added: the vaults live in ~/.tars/app-settings.json, which every agent can write.
 */
export function vaultRefusal(p: unknown): string | undefined {
  if (typeof p !== 'string' || !p || !path.isAbsolute(p)) return 'A vault is a folder named by its full path.';
  const resolved = path.resolve(p);
  const real = realTarget(resolved);
  if (!real) return 'This folder cannot be followed to where it really lies.';
  if (coversHome(resolved) || coversHome(real)) {
    return 'The home folder, or a folder above it, cannot be a vault: every file in the home would be open to the window.';
  }
  if (inDotFolderOfHome(resolved) || inDotFolderOfHome(real)) {
    return "A folder of the home whose name starts with a dot (a CLI's settings, credentials) cannot be a vault.";
  }
  if (!mayBeProject(resolved)) {
    return "Tars's own folders, folders of credentials and the home's application folders cannot be a vault.";
  }
  return undefined;
}

export const mayBeVault = (p: unknown): boolean => vaultRefusal(p) === undefined;

/** A file with a second name may be that of anything (SECURITY.md §5): one with no name but its own, or none yet. */
function oneName(real: string): boolean {
  try {
    return fs.statSync(real).nlink < 2;
  } catch {
    return true;
  }
}

/** A file of a vault the window may read (obsidian:readFile, the previews of obsidian:scan). */
export function windowMayReadInVault(target: string, vault: string): boolean {
  if (!mayBeVault(vault) || !windowMayReadUnder(target, vault)) return false;
  const real = realTarget(path.resolve(target));
  return !!real && oneName(real);
}

/**
 * A file of a vault the window may write (obsidian:writeFile): a markdown note, as spelled and where it really lies,
 * inside the vault, and no dotfile nor anything in a dot folder (.obsidian's own files, a CLI's settings), as spelled
 * and as it lies.
 */
export function windowMayWriteInVault(target: string, vault: string): boolean {
  if (!windowMayReadInVault(target, vault)) return false;
  const resolved = path.resolve(target);
  const real = realTarget(resolved);
  const realVault = realTarget(path.resolve(vault));
  if (!real || !realVault) return false;
  if (!resolved.toLowerCase().endsWith('.md') || !real.toLowerCase().endsWith('.md')) return false;
  const dotted = (p: string, root: string) => path.relative(root, p).split(path.sep).some((part) => part.startsWith('.'));
  return !dotted(resolved, path.resolve(vault)) && !dotted(real, realVault);
}

/**
 * A file the window may copy into the vault's attachments (vault:attachFile), once the user picked it in the dialog
 * (utils/picked-files.ts): a regular file, never a secret, nothing in a folder of credentials, as spelled or where it
 * really lies. The copy lands in ~/.tars, which every agent reads (2.0.7).
 */
export function windowMayAttach(target: string): boolean {
  const resolved = path.resolve(target);
  if (isSecretFile(resolved)) return false;
  const real = realTarget(resolved);
  if (!real || inCredentialPlace(resolved, real)) return false;
  try {
    return fs.statSync(real).isFile();
  } catch {
    return false;
  }
}

export function localFileServes(target: string): boolean {
  const resolved = path.resolve(target);
  if (isSecretFile(resolved)) return false;
  const roots = [path.join(VAULT_DIR, 'attachments'), path.join(DATA_DIR, 'project-files')];
  // ~/.claude/projects/<project>/memory/..., as spelled and where it really lies.
  const projectsDir = path.join(home(), '.claude', 'projects');
  const memory = (p: string, dir: string | undefined) => {
    if (!dir || !isUnder(p, dir)) return false;
    const parts = path.relative(dir, p).split(path.sep);
    return parts.length >= 3 && parts[1] === 'memory';
  };
  const real = realTarget(resolved);
  if (!real) return false;
  const served = landsUnderSafeRoot(resolved, roots, inside)
    || (memory(resolved, projectsDir) && memory(real, realTarget(projectsDir)));
  if (!served) return false;
  // A file with a second name may be that of anything (SECURITY.md §5).
  try {
    return fs.statSync(real).nlink < 2;
  } catch {
    return true;
  }
}
