import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PRIVATE_DIR } from '../constants';
import { isUnder, samePath } from '../platform/path-compare';
import { trustsTooMuch } from './trust-too-much';

type CredentialSystem = 'darwin' | 'linux' | 'win32';
/**
 * The folder an entry of CREDENTIAL_FOLDERS lies under: the home; on macOS and Linux XDG_CONFIG_HOME and
 * XDG_DATA_HOME when set to an absolute path, else ~/.config and ~/.local/share; on Windows %APPDATA% and
 * %LOCALAPPDATA%, else the home's AppData\Roaming and AppData\Local.
 */
type CredentialBase = 'home' | 'config' | 'data' | 'appData' | 'localAppData';

const ALL: readonly CredentialSystem[] = ['darwin', 'linux', 'win32'];
const POSIX: readonly CredentialSystem[] = ['darwin', 'linux'];

/**
 * Where credentials are kept, per system: the folders no agent is handed besides its project (handedFolderProblem
 * refuses a folder that is one, lies inside one or holds one). Each from the tool's own default; a tool moved
 * elsewhere by a variable of its own (GNUPGHOME, DOCKER_CONFIG, GH_CONFIG_DIR, CLOUDSDK_CONFIG, KUBECONFIG) is not
 * followed, but for the two CLI homes Tars itself follows (credentialFolders). A file kept directly in the home
 * (~/.netrc, ~/.git-credentials, ~/.npmrc, ~/.pypirc, ~/.pgpass) needs no entry: its folder is the home, which is
 * refused already, since it holds ~/.tars-private.
 */
export const CREDENTIAL_FOLDERS: ReadonlyArray<{ readonly base: CredentialBase; readonly path: readonly string[]; readonly on: readonly CredentialSystem[] }> = [
  // OpenSSH's keys: ~/.ssh (ssh(1)); Windows's own OpenSSH reads %USERPROFILE%\.ssh.
  { base: 'home', path: ['.ssh'], on: ALL },
  // GnuPG's keyrings: ~/.gnupg (gpg(1)); Gpg4win's on Windows: %APPDATA%\gnupg.
  { base: 'home', path: ['.gnupg'], on: POSIX },
  { base: 'appData', path: ['gnupg'], on: ['win32'] },
  // The AWS CLI's credentials file and config: ~/.aws on every system.
  { base: 'home', path: ['.aws'], on: ALL },
  // The Azure CLI's tokens: ~/.azure on every system.
  { base: 'home', path: ['.azure'], on: ALL },
  // The Google Cloud CLI's credentials: ~/.config/gcloud; %APPDATA%\gcloud on Windows.
  { base: 'config', path: ['gcloud'], on: POSIX },
  { base: 'appData', path: ['gcloud'], on: ['win32'] },
  // GitHub CLI's hosts.yml, which holds its token: ~/.config/gh; %APPDATA%\GitHub CLI on Windows.
  { base: 'config', path: ['gh'], on: POSIX },
  { base: 'appData', path: ['GitHub CLI'], on: ['win32'] },
  // Docker's config.json, which holds its registries' logins: ~/.docker on every system.
  { base: 'home', path: ['.docker'], on: ALL },
  // kubectl's kubeconfig, which holds its clusters' credentials: ~/.kube on every system.
  { base: 'home', path: ['.kube'], on: ALL },
  // pass, the password store: ~/.password-store.
  { base: 'home', path: ['.password-store'], on: POSIX },
  // macOS's keychains: ~/Library/Keychains.
  { base: 'home', path: ['Library', 'Keychains'], on: ['darwin'] },
  // GNOME Keyring's and KWallet's stores, under the XDG data folder.
  { base: 'data', path: ['keyrings'], on: ['linux'] },
  { base: 'data', path: ['kwalletd'], on: ['linux'] },
  // Windows's Credential Manager (both of its folders) and the DPAPI keys that open what it keeps.
  { base: 'appData', path: ['Microsoft', 'Credentials'], on: ['win32'] },
  { base: 'localAppData', path: ['Microsoft', 'Credentials'], on: ['win32'] },
  { base: 'appData', path: ['Microsoft', 'Protect'], on: ['win32'] },
  // The CLIs Tars runs whose own folder holds their login (names read in their packages for #647):
  // Claude Code: .credentials.json on Linux and Windows (macOS keeps it in the keychain); settings.json's env may hold
  // an API key on every system.
  { base: 'home', path: ['.claude'], on: ALL },
  // codex: auth.json, its login (ChatGPT's tokens or an API key), at the top of its home.
  { base: 'home', path: ['.codex'], on: ALL },
  // gemini 0.70.0: oauth_creds.json, gemini-credentials.json, mcp-oauth-tokens.json.
  { base: 'home', path: ['.gemini'], on: ALL },
  // Qwen Code 0.25.2 and 0.28.4: oauth_creds.json, mcp-oauth-tokens-v2.json, subscription_credentials.json.
  { base: 'home', path: ['.qwen'], on: ALL },
  // grok 1.0.92: user-settings.json, where it keeps its API key, and mcp_credentials.json.
  { base: 'home', path: ['.grok'], on: ALL },
  // pi 1.3.0: its logins under ~/.pi/agent.
  { base: 'home', path: ['.pi'], on: ALL },
  // opencode 1.19.3: auth.json and mcp-auth.json in its data folder.
  { base: 'data', path: ['opencode'], on: ALL },
  // Amp 0.0.1795752045: its data folder, which its own code builds from ~/.local/share on macOS and Windows and from
  // XDG_DATA_HOME on Linux; a secrets.json sits beside its CLI account's keys (read in its binary, not run).
  { base: 'home', path: ['.local', 'share', 'amp'], on: ['darwin', 'win32'] },
  { base: 'data', path: ['amp'], on: ['linux'] },
  // Kimi Code 2.6.3: its credentials folder, and the one of its older versions (its provider comes with the harness
  // adapters; KIMI_CODE_HOME, which moves it, is not followed).
  { base: 'home', path: ['.kimi-code', 'credentials'], on: ALL },
  { base: 'home', path: ['.kimi', 'credentials'], on: ALL },
  // Tars's own Claude accounts: each folder holds its account's identity, and on Linux its login
  // (services/claude-accounts/provision.ts).
  { base: 'home', path: ['.claude-accounts'], on: ALL },
];

/**
 * The CLIs' content folders: every session of that CLI, in every project, loads what is in them (its skills, commands,
 * agents or prompts). They hold no credential, and are refused all the same, as the safer default until the owner
 * says otherwise (the Audit's L1 on #666): an agent handed one could leave instructions for all the others.
 */
export const CLI_CONTENT_FOLDERS: ReadonlyArray<{ readonly path: readonly string[]; readonly cli: string }> = [
  { path: ['.claude', 'skills'], cli: 'Claude Code' },
  { path: ['.claude', 'commands'], cli: 'Claude Code' },
  { path: ['.claude', 'agents'], cli: 'Claude Code' },
  { path: ['.codex', 'prompts'], cli: 'codex' },
  { path: ['.gemini', 'commands'], cli: 'gemini' },
  { path: ['.qwen', 'commands'], cli: 'Qwen Code' },
];

/** CLI_CONTENT_FOLDERS under `home`, on `system`. */
export function cliContentFolders(system: NodeJS.Platform = process.platform, _env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Array<{ folder: string; cli: string }> {
  const p = system === 'win32' ? path.win32 : path.posix;
  return CLI_CONTENT_FOLDERS.map(entry => ({ folder: p.join(home, ...entry.path), cli: entry.cli }));
}

/**
 * CREDENTIAL_FOLDERS on `system`, as paths, with the folders the variables of Tars's own environment move a tool to:
 * CODEX_HOME (providers/codex-cli.ts codexHome) and PI_CODING_AGENT_DIR (providers/pi-provider.ts), which Tars itself
 * follows; GNUPGHOME, DOCKER_CONFIG, GH_CONFIG_DIR, CLOUDSDK_CONFIG; the folders of KUBECONFIG's files (`:` between
 * them on macOS and Linux, `;` on Windows); and a CLAUDE_CONFIG_DIR the user set. A Tars started from the Dock or the
 * Start menu sees no shell's exports, so this follows only what its process has: a guard against a mistaken choice,
 * not a boundary (SECURITY.md §4). None that is the root, the home or a folder above it, nor a relative one: as a
 * credential folder, it would refuse every folder.
 */
export function credentialFolders(system: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
  const on: CredentialSystem = system === 'win32' || system === 'darwin' ? system : 'linux';
  const p = on === 'win32' ? path.win32 : path.posix;
  const absolute = (value: string | undefined) => (value && p.isAbsolute(value) ? value : undefined);
  const bases: Record<CredentialBase, string> = {
    home,
    config: (on !== 'win32' && absolute(env.XDG_CONFIG_HOME)) || p.join(home, '.config'),
    data: (on !== 'win32' && absolute(env.XDG_DATA_HOME)) || p.join(home, '.local', 'share'),
    appData: absolute(env.APPDATA) || p.join(home, 'AppData', 'Roaming'),
    localAppData: absolute(env.LOCALAPPDATA) || p.join(home, 'AppData', 'Local'),
  };
  const folders = CREDENTIAL_FOLDERS.filter(entry => entry.on.includes(on)).map(entry => p.join(bases[entry.base], ...entry.path));
  for (const followed of [env.CODEX_HOME, env.PI_CODING_AGENT_DIR, env.GNUPGHOME, env.DOCKER_CONFIG, env.GH_CONFIG_DIR, env.CLOUDSDK_CONFIG, env.CLAUDE_CONFIG_DIR]) {
    const dir = absolute(followed);
    if (dir) folders.push(dir);
  }
  for (const file of (env.KUBECONFIG ?? '').split(on === 'win32' ? ';' : ':')) {
    const absoluteFile = absolute(file.trim());
    if (absoluteFile) folders.push(p.dirname(absoluteFile));
  }
  return [...new Set(folders)].filter(folder => !trustsTooMuch(folder, on, home));
}

/**
 * Why a folder may not be handed to an agent besides its project (claude's and
 * codex's --add-dir, gemini's --include-directories), or null when it may.
 *
 * Never ~/.tars-private: nothing under it is ever passed to a CLI (CLAUDE.md),
 * and create_agent and update_agent took any folder that existed (the Audit's
 * L1 on #480). Refused: that folder, a folder inside it, and a folder that holds
 * it (the home folder, its parents, the root), by the spelling given and by
 * where its links lead: a folder not made yet is read where its nearest made
 * parent really is, so a link, a junction or a Windows 8.3 short name on its way
 * is followed too.
 *
 * Never a folder where credentials are kept either (CREDENTIAL_FOLDERS: ~/.ssh,
 * the cloud CLIs', a keychain, a CLI's own login folder, Tars's accounts...), by
 * the same rule (the Audit's I-1 on #665): handed, such a folder was in the
 * agent's workspace, and claude found it trusted.
 *
 * The paths are compared by the rules of the `path` that resolved them, Windows
 * for path.win32 (separators, case, trailing dots and spaces, `\\?\`), never by
 * process.platform alone: a Windows host whose process.platform said linux read
 * a C:\ path by POSIX rules, and a folder inside the private one was not inside
 * it (update-agent-route.test.ts 12b on a Windows PC, 2026-10-20).
 */
export function handedFolderProblem(
  folder: string,
  where: { privateDir: string; credentialDirs?: string[]; contentDirs?: Array<{ folder: string; cli: string }> } = { privateDir: PRIVATE_DIR },
): string | null {
  // A `.` or `..` is refused as written: the system follows a link before it goes up, path.resolve goes up on the
  // text first, so proj/lnk/../x was read as proj/x (the Audit's M1 on #503).
  if (folder.split(/[\\/]/).some(seg => seg === '.' || seg === '..')) {
    return `${folder} has a "." or ".." in it: name the folder by its plain path`;
  }
  const rules: NodeJS.Platform = path.sep === '\\' ? 'win32' : 'linux';
  const same = (a: string, b: string) => samePath(a, b, rules);
  const under = (a: string, b: string) => isUnder(a, b, rules);
  const privates = places(where.privateDir);
  const folderPlaces = places(folder);
  for (const place of folderPlaces) {
    for (const priv of privates) {
      if (same(place, priv) || under(place, priv)) {
        return `${folder} is ${same(place, priv) ? '' : 'inside '}${where.privateDir}, which agents are never handed`;
      }
      if (under(priv, place)) {
        return `${folder} holds ${where.privateDir}, which agents are never handed: name a folder of its own`;
      }
    }
  }
  // A CLI's content folder (CLI_CONTENT_FOLDERS), or one inside it, for what it is: no credential, but what every
  // session of that CLI loads. Before the credentials, which the CLI's own folder around it is.
  for (const { folder: content, cli } of where.contentDirs ?? cliContentFolders()) {
    const contentPlaces = places(content).filter(place => !trustsTooMuch(place));
    for (const place of folderPlaces) {
      for (const loaded of contentPlaces) {
        if (same(place, loaded) || under(place, loaded)) {
          return `${folder} is ${same(place, loaded) ? '' : 'inside '}a folder ${cli} loads in every session, so an agent handed it could leave instructions for all the others: it is never handed`;
        }
      }
    }
  }
  // Never a folder where credentials are kept (CREDENTIAL_FOLDERS), by the same rule: the folder, one inside it, one
  // that holds it, as spelled and where links lead. A credential folder whose link leads to the root, the home or
  // above is not taken as one, or it would refuse every folder. The words name nothing the folder holds.
  const kept = (where.credentialDirs ?? credentialFolders()).flatMap(places).filter(place => !trustsTooMuch(place));
  for (const place of folderPlaces) {
    for (const credential of kept) {
      if (same(place, credential)) return `${folder} is a folder where credentials are kept, which agents are never handed`;
      if (under(place, credential)) return `${folder} is inside a folder where credentials are kept, which agents are never handed`;
      if (under(credential, place)) {
        return `${folder} holds a folder where credentials are kept, which agents are never handed: name a folder of its own`;
      }
    }
  }
  return null;
}

/** A folder as spelled, and where it really is: its own real path, or its nearest made parent's with the rest after it. */
function places(folder: string): string[] {
  const spelled = path.resolve(folder);
  const rest: string[] = [];
  for (let dir = spelled; ; dir = path.dirname(dir)) {
    try {
      return [spelled, path.join(fs.realpathSync.native(dir), ...rest)];
    } catch {
      // Not made yet, or not readable: try its parent.
    }
    if (path.dirname(dir) === dir) return [spelled];
    rest.unshift(path.basename(dir));
  }
}

/**
 * The secondary folder a launch hands the CLI, or undefined when it may not
 * be: one saved before create_agent and update_agent checked it, through a
 * window path that did not, or by hand in agents.json (the Audit's L4 on
 * #480). The four providers that hand one ask it as they write the flag, so
 * every launch path does, and ask it of each template folder
 * (obsidianVaultPaths) too, read back from agents.json and templates.json,
 * which any agent can write (the Audit's L1 on #501). The folder is left out
 * with a line in the log; the launch itself goes on.
 */
export function handedSecondaryFolder(folder: string | undefined): string | undefined {
  if (!folder) return undefined;
  const problem = handedFolderProblem(folder);
  if (!problem) return folder;
  console.warn(`[launch] folder not handed: ${problem}`);
  return undefined;
}
