import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR, PRIVATE_DIR, VAULT_DIR } from '../constants';
import { isUnder, samePath } from '../platform/path-compare';
import { isHardLinkInto, isWithinDir } from './path-identity';
import { inCredentialPlace, landsUnderSafeRoot, realTarget } from './real-target';

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
  // The CLIs' own: Claude Code's on Linux, codex's (0.163.0: auth.json, and .credentials.json for its MCP servers),
  // gemini's.
  '.credentials.json', 'auth.json', 'oauth_creds.json', 'google_accounts.json',
  // Read in each CLI's package at the version Tars measured (the Audit's read of #645, 25/11), never run:
  // - gemini 0.70.0, the three its own SENSITIVE_SETTINGS_FILENAMES names beside the two above (mcp-oauth-tokens.json
  //   plain JSON by default); qwen-code 0.25.2 keeps the first too;
  'gemini-credentials.json', 'mcp-oauth-tokens.json', 'a2a-oauth-tokens.json',
  // - qwen-code 0.25.2, in ~/.qwen, encrypted with a key made of the host and user names, so readable as plain;
  'mcp-oauth-tokens-v2.json', 'extension-secrets-v1.json',
  // - grok 1.0.92, its MCP servers' OAuth tokens beside auth.json in ~/.grok;
  'mcp_credentials.json',
  // - pi 1.3.0 (~/.pi/agent) and opencode 1.19.3 (its data folder), their MCP servers' credentials, and pi's
  //   oauth.json, which it migrates into auth.json and may still be there;
  'mcp-auth.json', 'oauth.json',
  // - cline 3.0.74, <dataDir>/secrets.json; goose 1.60.1, secrets.yaml in its config folder with the keyring off;
  'secrets.json', 'secrets.yaml',
  // - gcloud's, which gemini, qwen-code, pi, opencode, cline and grok read for Google's sign-in.
  'application_default_credentials.json',
  // kilo 7.8.27 keeps auth.json, and kimi-code 2.6.3 a folder of its own (kimiCredential).
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

/**
 * kimi-code's credentials (2.6.3): every file of its `credentials` folder ($KIMI_CODE_HOME, else ~/.kimi-code), which
 * have no fixed name: its OAuth token, an MCP server's `<key>-tokens.json` and `<key>-client.json`. By the folder's
 * two names, so a project's `src/credentials` stays readable; a KIMI_CODE_HOME of another name is not known here.
 */
const kimiCredential = (p: string) => path.basename(path.dirname(p)).toLowerCase() === 'credentials'
  && path.basename(path.dirname(path.dirname(p))).toLowerCase() === '.kimi-code';

/** A file the window must never get, judged as spelled, where it really lies, and by inode. */
export function isSecretFile(target: string): boolean {
  const resolved = path.resolve(target);
  const real = realTarget(resolved);
  if (!real) return true;
  if (nameIsSecret(resolved) || nameIsSecret(real) || cliSettingsWithKey(resolved) || cliSettingsWithKey(real)
    || kimiCredential(resolved) || kimiCredential(real)) return true;
  if (isUnder(resolved, PRIVATE_DIR) || samePath(resolved, PRIVATE_DIR) || isWithinDir(real, PRIVATE_DIR)) return true;
  return isHardLinkInto(real, PRIVATE_DIR);
}

const home = () => os.homedir();
const inside = (root: string, p: string) => samePath(root, p) || isUnder(p, root);
/** A project folder the window may reach: none that is ~/.tars, ~/.tars-private or in them. */
const projectRoots = (projects: string[]) => projects.filter((p) => typeof p === 'string' && p
  && !inside(DATA_DIR, path.resolve(p)) && !inside(PRIVATE_DIR, path.resolve(p)));

/**
 * A folder a page may add as a project: one that exists, none of Tars's own
 * folders, and no folder of credentials or one inside it, as spelled or where
 * it really lies. A page added any folder as a project and then read it (the
 * Audit's L1 on #466). The projects' list lives in ~/.tars, which every
 * agent can write, so a read judges its own target too (windowMayRead).
 */
export function mayBeProject(p: unknown): boolean {
  if (typeof p !== 'string' || !p) return false;
  const resolved = path.resolve(p);
  if (projectRoots([resolved]).length === 0) return false;
  const real = realTarget(resolved);
  return !!real && !inCredentialPlace(resolved, real);
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
  // The CLIs' folders by their default paths only: a home GEMINI_CLI_HOME or GROK_HOME moves (#645) is no root here,
  // so the window reads none of it unless it lies in a project, where the names above still hold.
  const roots = [path.join(home(), '.claude'), path.join(home(), '.codex'), path.join(home(), '.gemini'), path.join(home(), '.grok'), ...projectRoots(projects)];
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
  // Followed as the write follows it: what it really writes is a markdown file.
  const real = realTarget(resolved);
  return !!real && real.toLowerCase().endsWith('.md');
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
