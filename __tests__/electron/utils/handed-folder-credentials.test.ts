import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A folder where credentials are kept is never handed to an agent besides its project (27/11, the Audit's I-1 on #665).
 *
 * The secondary folder and a template's folders are handed to the CLI (claude's and codex's --add-dir, gemini's and
 * Qwen Code's --include-directories), and since #665 claude finds them trusted, where its "Adding a new directory"
 * dialog used to stop the agent. Set by the user's window or by the project's orchestrator through update_agent, they
 * were refused only when they were, held or lay inside ~/.tars-private: ~/.ssh, ~/.aws, ~/.gnupg, ~/.config/gh,
 * ~/Library/Keychains, a CLI's own login folder or Tars's ~/.claude-accounts went through.
 *
 * How it fails, written before the code:
 *  1. A credential folder itself is handed: OpenSSH's, the cloud CLIs', GnuPG's, GitHub CLI's, Docker's, Kubernetes',
 *     the system's keychain or credential store, a CLI's own login folder (~/.codex...), Tars's ~/.claude-accounts.
 *  2. A folder inside one is handed, made or not yet made.
 *  3. A folder that holds one is handed (~/.config holds gh's, ~/Library holds the keychains).
 *  4. A link to one, or into one, is handed, or a folder not made yet behind such a link.
 *  5. Another spelling of one is handed: a trailing separator, a doubled one, another case on a disk that ignores case.
 *  6. A system's own place is missing from its list, or another system's is in it: macOS's keychains, Linux's keyrings
 *     and its XDG folders, Windows's %APPDATA% and %LOCALAPPDATA% stores and %USERPROFILE% dot folders; CODEX_HOME and
 *     PI_CODING_AGENT_DIR, which Tars itself follows, not followed.
 *  7. A value that would make every folder a credential folder is taken: CODEX_HOME set to the home, the root or a
 *     relative path, or a credential folder that is a link to the root; every project is then refused.
 *  8. The refusal lists what the folder holds, or says nothing a person can act on.
 *  9. A path that sets or hands a folder lets one through: the launch line of each CLI that hands one (claude,
 *     codex, gemini, Qwen Code), update_agent and the window's agent:update for the secondary folder and for the
 *     template's folders, a template created or imported with one.
 * 10. Over-refusal: a project, a sibling named .ssh-notes, another folder of ~/.config or ~/Library, a folder outside
 *     the home is refused; or the check throws when no credential folder exists.
 *
 * The negative witness is main at 58f2863b4, which hands every one of them.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '0.0.0', on: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } },
}));
type Handler = (event: unknown, ...args: unknown[]) => Promise<Record<string, unknown>>;
const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => Promise<Record<string, unknown>>>());

import { cliContentFolders, credentialFolders, handedFolderProblem } from '../../../electron/utils/handed-folder';
import { getProvider } from '../../../electron/providers';
import { agents } from '../../../electron/core/agent-manager';
import { updateAgent } from '../../../electron/core/agent-update';
import { registerTemplateHandlers } from '../../../electron/handlers/template-handlers';
import type { AgentStatus } from '../../../electron/types';

let root: string;
let home: string;
let privateDir: string;
let project: string;
let creds: string[];

/** The credential folders of the stand-in home, one of them not made (~/.azure). */
const CRED = ['.ssh', '.aws', '.gnupg', path.join('.config', 'gh'), path.join('Library', 'Keychains'), '.docker', '.kube', '.codex', '.claude-accounts'];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handed-cred-')));
  home = path.join(root, 'home');
  privateDir = path.join(home, '.tars-private');
  project = path.join(home, 'projects', 'demo');
  for (const d of [privateDir, project, path.join(home, '.ssh', 'keys'), path.join(home, '.claude-accounts', 'acct-aaaaaa'),
    path.join(home, '.ssh-notes'), path.join(home, '.config', 'other-app'), path.join(home, 'Library', 'Application Support', 'Notes')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  for (const c of CRED) fs.mkdirSync(path.join(home, c), { recursive: true });
  creds = [...CRED.map(c => path.join(home, c)), path.join(home, '.azure')];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const problem = (folder: string) => handedFolderProblem(folder, { privateDir, credentialDirs: creds } as never);

describe('a folder where credentials are kept, as handed besides a project', () => {
  it('1. refuses each credential folder itself', () => {
    expect(creds.filter(c => problem(c) === null)).toEqual([]);
  });

  it('2. refuses a folder inside one, made or not yet made', () => {
    const inside = [path.join(home, '.ssh', 'keys'), path.join(home, '.claude-accounts', 'acct-aaaaaa'), path.join(home, '.azure', 'not-made'), path.join(home, '.ssh', 'not-made', 'deeper')];
    expect(inside.filter(f => problem(f) === null)).toEqual([]);
  });

  it('3. refuses a folder that holds one', () => {
    expect([path.join(home, '.config'), path.join(home, 'Library')].filter(f => problem(f) === null)).toEqual([]);
  });

  it('4. refuses a link to one, a link into one, and a folder not made yet behind such a link', () => {
    fs.symlinkSync(path.join(home, '.ssh'), path.join(project, 'keys-link'));
    fs.symlinkSync(path.join(home, '.ssh', 'keys'), path.join(project, 'inner-link'));
    const through = [path.join(project, 'keys-link'), path.join(project, 'inner-link'), path.join(project, 'keys-link', 'not-made')];
    expect(through.filter(f => problem(f) === null)).toEqual([]);
  });

  it('5. refuses another spelling of one', () => {
    const spelled = [`${path.join(home, '.ssh')}${path.sep}`, path.join(home, '.ssh').replace(`${path.sep}.ssh`, `${path.sep}${path.sep}.ssh`)];
    // Another case is the same folder only on a disk that ignores case (macOS's default); elsewhere it is another one.
    const upper = path.join(home, '.SSH');
    if (fs.existsSync(upper)) spelled.push(upper);
    expect(spelled.filter(f => problem(f) === null)).toEqual([]);
  });

  it('8. says so in plain words, and names nothing the folder holds', () => {
    expect(problem(path.join(home, '.ssh'))).toMatch(/credentials/);
    expect(problem(path.join(home, '.ssh', 'keys'))).toMatch(/inside a folder where credentials are kept/);
    const holds = problem(path.join(home, '.config'))!;
    expect(holds).toMatch(/holds a folder where credentials are kept/);
    expect(holds).not.toMatch(/gh\b|\.ssh|Keychains/);
  });

  it('10. takes a project, a sibling that only looks like one, another folder of ~/.config or ~/Library, a folder outside the home', () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const fine = [project, path.join(home, '.ssh-notes'), path.join(home, '.config', 'other-app'), path.join(home, 'Library', 'Application Support', 'Notes'), elsewhere];
    expect(fine.map(f => [f, problem(f)])).toEqual(fine.map(f => [f, null]));
  });

  it('10. never throws when no credential folder exists', () => {
    const none = handedFolderProblem(project, { privateDir, credentialDirs: [path.join(root, 'none', '.ssh')] } as never);
    expect(none).toBeNull();
  });

  it('7. a credential folder that leads to the root refuses nothing by itself', () => {
    fs.symlinkSync(path.parse(root).root, path.join(home, '.weird-store'));
    const result = handedFolderProblem(project, { privateDir, credentialDirs: [path.join(home, '.weird-store')] } as never);
    expect(result).toBeNull();
  });
});

describe('6. the list on each system', () => {
  it('macOS: the dot folders, ~/.config\'s, the keychains, the CLIs\' and Tars\'s accounts', () => {
    const list = credentialFolders('darwin', {}, '/Users/a');
    for (const f of ['/Users/a/.ssh', '/Users/a/.aws', '/Users/a/.azure', '/Users/a/.gnupg', '/Users/a/.docker', '/Users/a/.kube',
      '/Users/a/.config/gh', '/Users/a/.config/gcloud', '/Users/a/Library/Keychains', '/Users/a/.password-store',
      '/Users/a/.claude', '/Users/a/.codex', '/Users/a/.gemini', '/Users/a/.qwen', '/Users/a/.grok', '/Users/a/.pi',
      '/Users/a/.local/share/opencode', '/Users/a/.claude-accounts']) {
      expect(list, f).toContain(f);
    }
    expect(list.some(f => /keyrings|AppData/.test(f))).toBe(false);
  });

  it('Linux: its XDG folders, followed when set, and its keyrings', () => {
    const list = credentialFolders('linux', { XDG_CONFIG_HOME: '/srv/conf', XDG_DATA_HOME: '/srv/data' }, '/home/a');
    for (const f of ['/home/a/.ssh', '/home/a/.gnupg', '/srv/conf/gh', '/srv/conf/gcloud', '/srv/data/keyrings', '/srv/data/kwalletd',
      '/srv/data/opencode', '/home/a/.password-store', '/home/a/.claude', '/home/a/.codex', '/home/a/.claude-accounts']) {
      expect(list, f).toContain(f);
    }
    expect(list.some(f => /Library|AppData/.test(f))).toBe(false);
    expect(credentialFolders('linux', {}, '/home/a')).toEqual(expect.arrayContaining(['/home/a/.config/gh', '/home/a/.local/share/keyrings']));
  });

  it('Windows: %USERPROFILE%\'s dot folders, %APPDATA%\'s and %LOCALAPPDATA%\'s stores', () => {
    const list = credentialFolders('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a');
    for (const f of ['C:\\Users\\a\\.ssh', 'C:\\Users\\a\\.aws', 'C:\\Users\\a\\.azure', 'C:\\Users\\a\\.docker', 'C:\\Users\\a\\.kube',
      'C:\\Users\\a\\AppData\\Roaming\\GitHub CLI', 'C:\\Users\\a\\AppData\\Roaming\\gcloud', 'C:\\Users\\a\\AppData\\Roaming\\gnupg',
      'C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Credentials', 'C:\\Users\\a\\AppData\\Local\\Microsoft\\Credentials',
      'C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Protect', 'C:\\Users\\a\\.claude', 'C:\\Users\\a\\.codex', 'C:\\Users\\a\\.claude-accounts']) {
      expect(list, f).toContain(f);
    }
    expect(list.some(f => /Library|keyrings|\.config/.test(f))).toBe(false);
  });

  it('Kimi Code\'s credentials folder, and its older one, on every system (its provider comes with the harness adapters)', () => {
    expect(credentialFolders('darwin', {}, '/Users/a')).toEqual(expect.arrayContaining(['/Users/a/.kimi-code/credentials', '/Users/a/.kimi/credentials']));
    expect(credentialFolders('linux', {}, '/home/a')).toEqual(expect.arrayContaining(['/home/a/.kimi-code/credentials', '/home/a/.kimi/credentials']));
    expect(credentialFolders('win32', {}, 'C:\\Users\\a')).toEqual(expect.arrayContaining(['C:\\Users\\a\\.kimi-code\\credentials', 'C:\\Users\\a\\.kimi\\credentials']));
  });

  it('follows CODEX_HOME and PI_CODING_AGENT_DIR, as Tars itself does', () => {
    const list = credentialFolders('darwin', { CODEX_HOME: '/Volumes/x/codex', PI_CODING_AGENT_DIR: '/Volumes/x/pi-agent' }, '/Users/a');
    expect(list).toEqual(expect.arrayContaining(['/Volumes/x/codex', '/Volumes/x/pi-agent', '/Users/a/.codex']));
  });

  it('7. never takes a CODEX_HOME that is the home, the root, above the home or relative', () => {
    for (const bad of ['/Users/a', '/', '/Users', 'codex']) {
      const list = credentialFolders('darwin', { CODEX_HOME: bad }, '/Users/a');
      expect(list, bad).not.toContain(bad);
    }
  });
});

/**
 * Round 2 (the Audit's read of #666 at 8e8b81c8c), written before its code:
 * 11. A CLI's content folder (~/.claude/skills, commands, agents, ~/.codex/prompts, ~/.gemini/commands,
 *     ~/.qwen/commands) is refused for the wrong reason, "a folder where credentials are kept": it holds none. It stays
 *     refused (L1, the safer default until the owner says), with the real reason: every session of that CLI loads what
 *     is in it, so an agent handed it could leave instructions for all the others.
 * 12. A tool moved by its own variable in Tars's environment is missed: GNUPGHOME, DOCKER_CONFIG, GH_CONFIG_DIR,
 *     CLOUDSDK_CONFIG, the folders of KUBECONFIG's files (`:` on macOS and Linux, `;` on Windows), a CLAUDE_CONFIG_DIR
 *     the user set; or one of them set to the home, the root or above is taken, and every folder is refused.
 * 13. Amp's data folder is missing: ~/.local/share/amp on macOS and Windows, XDG_DATA_HOME/amp on Linux (read in its
 *     0.0.1795752045 binary: its own path code, and a secrets.json beside its CLI account's keys).
 */
describe('11. a CLI\'s content folder, refused for what it is', () => {
  const contentDirs = () => [
    { folder: path.join(home, '.claude', 'skills'), cli: 'Claude Code' },
    { folder: path.join(home, '.codex', 'prompts'), cli: 'codex' },
  ];
  const content = (folder: string) => handedFolderProblem(folder, { privateDir, credentialDirs: creds, contentDirs: contentDirs() } as never);

  it('says every session of that CLI loads it, not that it keeps credentials', () => {
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'mine'), { recursive: true });
    for (const [folder, cli] of [[path.join(home, '.claude', 'skills'), 'Claude Code'], [path.join(home, '.codex', 'prompts'), 'codex']]) {
      const said = content(folder)!;
      expect(said, folder).toMatch(new RegExp(`${cli} loads in every session`));
      expect(said).toMatch(/leave instructions for all the others/);
      expect(said).not.toMatch(/credentials/);
    }
    expect(content(path.join(home, '.claude', 'skills', 'mine'))).toMatch(/inside a folder Claude Code loads in every session/);
  });

  it('keeps the credentials sentence for the CLI\'s own folder and its other folders', () => {
    expect(content(path.join(home, '.codex'))).toMatch(/credentials/);
    expect(content(path.join(home, '.codex', 'sessions'))).toMatch(/inside a folder where credentials are kept/);
  });

  it('the list holds the six, on every system', () => {
    for (const [system, home2] of [['darwin', '/Users/a'], ['linux', '/home/a']] as const) {
      const listed = cliContentFolders(system, {}, home2).map(c => c.folder);
      expect(listed).toEqual(expect.arrayContaining([`${home2}/.claude/skills`, `${home2}/.claude/commands`, `${home2}/.claude/agents`,
        `${home2}/.codex/prompts`, `${home2}/.gemini/commands`, `${home2}/.qwen/commands`]));
    }
    expect(cliContentFolders('win32', {}, 'C:\\Users\\a').map(c => c.folder)).toEqual(expect.arrayContaining(['C:\\Users\\a\\.claude\\skills', 'C:\\Users\\a\\.codex\\prompts']));
  });
});

describe('12. the variables that move a tool\'s folder', () => {
  it('follows GNUPGHOME, DOCKER_CONFIG, GH_CONFIG_DIR, CLOUDSDK_CONFIG, KUBECONFIG\'s folders and CLAUDE_CONFIG_DIR', () => {
    const list = credentialFolders('darwin', {
      GNUPGHOME: '/Volumes/k/gpg', DOCKER_CONFIG: '/Volumes/k/docker', GH_CONFIG_DIR: '/Volumes/k/gh', CLOUDSDK_CONFIG: '/Volumes/k/gcloud',
      KUBECONFIG: '/Volumes/k/kube/config:/srv/clusters/prod.yaml', CLAUDE_CONFIG_DIR: '/Volumes/k/claude',
    }, '/Users/a');
    expect(list).toEqual(expect.arrayContaining(['/Volumes/k/gpg', '/Volumes/k/docker', '/Volumes/k/gh', '/Volumes/k/gcloud', '/Volumes/k/kube', '/srv/clusters', '/Volumes/k/claude']));
  });

  it('reads KUBECONFIG with Windows\'s separator on Windows', () => {
    const list = credentialFolders('win32', { KUBECONFIG: 'C:\\k\\a\\config;D:\\clusters\\b.yaml' }, 'C:\\Users\\a');
    expect(list).toEqual(expect.arrayContaining(['C:\\k\\a', 'D:\\clusters']));
  });

  it('never takes one that is the home, the root, above the home or relative, nor a KUBECONFIG file in the home', () => {
    const list = credentialFolders('darwin', { GNUPGHOME: '/', DOCKER_CONFIG: '/Users/a', GH_CONFIG_DIR: 'gh', CLOUDSDK_CONFIG: '/Users', KUBECONFIG: '/Users/a/kubeconfig' }, '/Users/a');
    for (const wide of ['/', '/Users/a', 'gh', '/Users']) expect(list, wide).not.toContain(wide);
  });
});

describe('13. Amp\'s data folder', () => {
  it('is ~/.local/share/amp on macOS and Windows, whatever XDG_DATA_HOME says, and XDG_DATA_HOME/amp on Linux', () => {
    expect(credentialFolders('darwin', { XDG_DATA_HOME: '/srv/data' }, '/Users/a')).toContain('/Users/a/.local/share/amp');
    expect(credentialFolders('win32', {}, 'C:\\Users\\a')).toContain('C:\\Users\\a\\.local\\share\\amp');
    expect(credentialFolders('linux', { XDG_DATA_HOME: '/srv/data' }, '/home/a')).toContain('/srv/data/amp');
  });
});

describe('9. every path that sets or hands one', () => {
  const ssh = () => path.join(os.homedir(), '.ssh');
  const aws = () => path.join(os.homedir(), '.aws');
  beforeEach(() => {
    for (const d of [ssh(), aws()]) fs.mkdirSync(d, { recursive: true });
  });

  it.each(['claude', 'codex', 'gemini', 'qwen-code'])('the launch line of %s leaves out a secondary and a template folder where credentials are kept', (id) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const line = getProvider(id as AgentStatus['provider']).buildInteractiveCommand({
      binaryPath: '/opt/cli/bin/cli', prompt: '', projectPath: project, secondaryProjectPath: ssh(), obsidianVaultPaths: [aws()], permissionMode: 'bypass',
    } as never);
    warn.mockRestore();
    expect(line).not.toContain(ssh());
    expect(line).not.toContain(aws());
  });

  it('update_agent and the window\'s agent:update refuse it as the secondary folder', async () => {
    const id = `ag-${Math.random().toString(16).slice(2, 8)}`;
    agents.set(id, { id, status: 'idle', projectPath: project, skills: [], output: [], lastActivity: '', provider: 'claude' } as AgentStatus);
    const result = await updateAgent({ id, secondaryProjectPath: ssh() });
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toMatch(/^Not saved: .*credentials/);
    expect(agents.get(id)!.secondaryProjectPath).toBeUndefined();
  });

  it('update_agent and the window\'s agent:update refuse it as a template folder', async () => {
    const id = `ag-${Math.random().toString(16).slice(2, 8)}`;
    agents.set(id, { id, status: 'idle', projectPath: project, skills: [], output: [], lastActivity: '', provider: 'claude' } as AgentStatus);
    const result = await updateAgent({ id, obsidianVaultPaths: [project, aws()] });
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toMatch(/^Not saved: .*credentials/);
    expect(agents.get(id)!.obsidianVaultPaths).toBeUndefined();
  });

  it('a template created or imported with one is refused', async () => {
    handlers.clear();
    registerTemplateHandlers();
    const template = { displayName: 'Keys', provider: 'claude', obsidianVaultPaths: [ssh()] };
    const created = await handlers.get('template:create')!({}, template);
    expect(created).toMatchObject({ success: false });
    expect(String(created.error)).toMatch(/credentials/);
    const imported = await handlers.get('template:import')!({}, { version: 1, kind: 'tars.agent-template', exportedAt: '2026-11-27T00:00:00Z', templates: [template] });
    expect(imported).toMatchObject({ success: false });
  });
});
