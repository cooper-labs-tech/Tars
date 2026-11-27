import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Claude Code finds every folder Tars hands an agent already trusted, not only the folder it starts in (27/11).
 *
 * Measured on claude 2.1.332 in a fresh sandbox HOME, the real binary against a stand-in Messages API (eight cases,
 * bench-b4/add-dir-trust/probe.mjs): a folder handed with --add-dir that no projects[] entry of the .claude.json the CLI
 * reads trusts, by itself or by a folder above it, stops the CLI before its first turn on "Adding a new directory:
 * <folder>. This session hasn't worked here before. Is this a directory you created or one you trust?", with "No, exit"
 * preselected: nobody answers in an agent's terminal, and the first Enter Tars types there answers No. Tars wrote the
 * agent's own folder only (ensureProjectTrusted), so on a machine whose home was never trusted every claude agent
 * stopped there, on ~/.tars, which each of them is handed (the Frontend's first run for #653, 27/11).
 *
 * The ways this can fail, each a case below:
 *  1. ~/.tars, handed to every claude agent, is not trusted: the dialog for ~/.tars (measured, c1; trusted, c2 answers).
 *  2. The secondary folder, or a template's folder, handed with --add-dir, is not trusted (measured, c4).
 *  3. An agent on one of the thirteen API-key providers that run the claude binary: ~/.tars is not trusted (measured,
 *     c6, with ANTHROPIC_AUTH_TOKEN as Tars hands their key).
 *  4. An agent on a second Claude account reads <its folder>/.claude.json and not ~/.claude.json: trust written in the
 *     home's file alone does not reach it (measured, c7; written in the account's own, c8 answers). Neither at the launch
 *     that picks the account (4b) nor at a start typed into a terminal already on it (4a).
 *  5. More trusted than the line hands: a folder it does not add. A key provider's secondary folder, which its line
 *     never hands; a codex agent's ~/.tars, which codex is not handed; a template folder that does not exist, which the
 *     line leaves out.
 *  6. Wider than one folder: the home, the root or a folder above the home handed as a secondary folder.
 *  7. A folder trusted under its spelling alone while claude reads its real path (a link on its way).
 *  8. What is trusted drifts from what the line hands: for claude and for each provider on the claude binary, every
 *     folder of its --add-dir is trusted and nothing else is, and the thirteen are the ones the registry has.
 *  9. A secondary folder set after the agent's terminal opened (agent:setSecondaryProject only saves it) reaches the
 *     line typed into that terminal at the next start without being trusted.
 * 10. An account folder that does not exist, or the accounts turned off, and Tars creates or writes a .claude.json
 *     there.
 * 11. Over-correction: a start with no agent yet (agent:create's shell) loses its own folder's trust; a user's entry
 *     loses its other keys; the file is rewritten when nothing is missing.
 *
 * The negative witness is main at 58f2863b4, which writes the agent's folder alone, in ~/.claude.json alone.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '0.0.0', on: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));

import { ensureProjectTrusted, launchIntoTerminal, initAgentPty } from '../../../electron/core/agent-manager';
import { getAllProviders, getProvider } from '../../../electron/providers';
import { toLaunch } from '../../../electron/platform/launch';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { claudeAccountEnvFor } from '../../../electron/services/claude-accounts/launch';
import { setAuth, resetAccountState } from '../../../electron/services/claude-accounts/state';
import { accountsRoot, normalizeAccountsSettings, writeAccountsSettings } from '../../../electron/services/claude-accounts/registry';
import { provisionAccountDir } from '../../../electron/services/claude-accounts/provision';
import { claudeAccountsNotPorted } from '../../setup/platform-limits';
import { DATA_DIR } from '../../../electron/constants';
import type { AgentStatus } from '../../../electron/types';

const home = () => os.homedir();
const claudeJsonOf = (dir: string) => path.join(dir, '.claude.json');
const homeFile = () => claudeJsonOf(home());

function trustedIn(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const config = JSON.parse(fs.readFileSync(file, 'utf-8')) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
  return Object.entries(config.projects ?? {}).filter(([, p]) => p?.hasTrustDialogAccepted === true).map(([k]) => k);
}

/** A folder as spelled and where it really is: both are what claude may read. */
const spellings = (dir: string) => [...new Set([dir, fs.realpathSync.native(dir)])];

const made = (name: string) => fs.mkdtempSync(path.join(home(), `${name}-`));

/** The thirteen API-key providers Tars runs on the claude binary (providers/index.ts). */
const KEY_PROVIDERS = ['custom-openai', 'deepseek', 'mimo', 'minimax', 'moonshot', 'nous-portal', 'nvidia', 'ollama-cloud', 'ollama', 'openrouter', 'qwen', 'venice', 'zhipu'];

let project: string;
let secondary: string;
let vault: string;

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return { id: `ag-${Math.random().toString(16).slice(2, 8)}`, status: 'idle', projectPath: project, skills: [], output: [], lastActivity: '', provider: 'claude', ...over } as AgentStatus;
}

/** The folders a built line hands with --add-dir, unquoted as the shell reads them. */
function addDirsOf(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/--add-dir ('(?:[^']|'\\'')*'|\S+)/g)) {
    const word = m[1];
    out.push(word.startsWith("'") ? word.slice(1, -1).replace(/'\\''/g, "'") : word);
  }
  return out;
}

beforeEach(() => {
  resetAccountState();
  fs.writeFileSync(homeFile(), JSON.stringify({ numStartups: 3, projects: {} }), { mode: 0o600 });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  project = made('project');
  secondary = made('secondary');
  vault = made('vault');
});

describe('the folders a claude agent is handed are trusted with its own', () => {
  it('the sandbox is what it should be: ~/.tars under the throwaway home', () => {
    expect(DATA_DIR.startsWith(home())).toBe(true);
  });

  it('1. ~/.tars, handed to every claude agent, is trusted with the agent\'s folder', () => {
    ensureProjectTrusted(project, agent());
    const trusted = trustedIn(homeFile());
    for (const dir of [...spellings(project), ...spellings(DATA_DIR)]) expect(trusted).toContain(dir);
  });

  it('2. the secondary folder and a template\'s folders are trusted', () => {
    ensureProjectTrusted(project, agent({ secondaryProjectPath: secondary, obsidianVaultPaths: [vault] }));
    const trusted = trustedIn(homeFile());
    for (const dir of [...spellings(secondary), ...spellings(vault)]) expect(trusted).toContain(dir);
  });

  it.each(KEY_PROVIDERS)('3. an agent on %s has ~/.tars trusted', (provider) => {
    ensureProjectTrusted(project, agent({ provider: provider as AgentStatus['provider'] }));
    const trusted = trustedIn(homeFile());
    for (const dir of [...spellings(project), ...spellings(DATA_DIR)]) expect(trusted).toContain(dir);
  });
});

describe('nothing is trusted that the line does not hand', () => {
  it.each(KEY_PROVIDERS)('5. %s: its secondary folder, which its line never hands, is not trusted', (provider) => {
    ensureProjectTrusted(project, agent({ provider: provider as AgentStatus['provider'], secondaryProjectPath: secondary, obsidianVaultPaths: [vault] }));
    const trusted = trustedIn(homeFile());
    for (const dir of [...spellings(secondary), ...spellings(vault)]) expect(trusted).not.toContain(dir);
  });

  it('5. a codex agent: its folder as before, and neither ~/.tars nor its secondary folder in claude\'s file', () => {
    ensureProjectTrusted(project, agent({ provider: 'codex', secondaryProjectPath: secondary }));
    expect(trustedIn(homeFile()).sort()).toEqual(spellings(project).sort());
  });

  it('5. a template folder that does not exist, which the line leaves out, is not trusted', () => {
    const missing = path.join(home(), 'no-such-vault');
    ensureProjectTrusted(project, agent({ obsidianVaultPaths: [missing] }));
    expect(trustedIn(homeFile())).not.toContain(missing);
  });

  it.each([
    ['the home', () => home()],
    ['the root', () => path.parse(home()).root],
    ['the folder above the home', () => path.dirname(home())],
  ])('6. %s as a secondary folder is never trusted, and the rest still is', (_what, dir) => {
    ensureProjectTrusted(project, agent({ secondaryProjectPath: dir() }));
    const trusted = trustedIn(homeFile());
    for (const wide of [home(), path.parse(home()).root, path.dirname(home())]) {
      expect(trusted).not.toContain(wide);
      expect(trusted).not.toContain(fs.realpathSync.native(wide));
    }
    for (const d of [...spellings(project), ...spellings(DATA_DIR)]) expect(trusted).toContain(d);
  });

  it('7. a folder reached through a link is trusted where it really is too', () => {
    const target = made('target');
    const link = path.join(home(), `link-${path.basename(target)}`);
    fs.symlinkSync(target, link);
    ensureProjectTrusted(project, agent({ secondaryProjectPath: link }));
    const trusted = trustedIn(homeFile());
    expect(trusted).toContain(link);
    expect(trusted).toContain(fs.realpathSync.native(target));
  });
});

describe('8. what is trusted is what the line hands', () => {
  it('the providers on the claude binary are claude and the thirteen', () => {
    const onClaude = getAllProviders().filter(p => p.binaryName === 'claude').map(p => p.id).sort();
    expect(onClaude).toEqual(['claude', ...KEY_PROVIDERS].sort());
  });

  it.each(['claude', ...KEY_PROVIDERS])('%s: every folder of its --add-dir is trusted, and nothing beyond them and its own folder', (id) => {
    const params = { binaryPath: '/opt/claude/bin/claude', prompt: '', projectPath: project, secondaryProjectPath: secondary, obsidianVaultPaths: [vault], permissionMode: 'bypass' };
    const handed = addDirsOf(getProvider(id as AgentStatus['provider']).buildInteractiveCommand(params as never));
    expect(handed).toContain(DATA_DIR);
    ensureProjectTrusted(project, agent({ provider: id as AgentStatus['provider'], secondaryProjectPath: secondary, obsidianVaultPaths: [vault] }));
    const trusted = trustedIn(homeFile());
    const expected = new Set([...spellings(project), ...handed.flatMap(spellings)]);
    for (const dir of expected) expect(trusted).toContain(dir);
    for (const dir of trusted) expect(expected.has(dir), `${dir} is trusted but the line does not hand it`).toBe(true);
  });
});

describe('9. a start typed into a terminal already open', () => {
  it('trusts the secondary folder set since the terminal opened, before the line is typed', async () => {
    const terminal = { pid: 4242, process: 'bash', write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
    const a = agent({ secondaryProjectPath: secondary });
    const launch = toLaunch(`'/opt/claude/bin/claude' --add-dir '${secondary}' --add-dir '${DATA_DIR}'`, project, process.env);
    // Windows types no line into a shell: its CLI replaces the shell (spawnCli), the case of the spawn.
    if (launch.platform === 'win32') return;
    await launchIntoTerminal(a, terminal as never, launch, { ptyProcesses, initAgentPty });
    const trusted = trustedIn(homeFile());
    for (const dir of [...spellings(project), ...spellings(secondary), ...spellings(DATA_DIR)]) expect(trusted).toContain(dir);
  });
});

describe.skipIf(claudeAccountsNotPorted())('4. an agent on a second Claude account', () => {
  const A = 'acct-aaaaaa';
  const B = 'acct-bbbbbb';
  const settings = (enabled = true) => normalizeAccountsSettings({
    enabled,
    accounts: [{ id: 'default', label: 'Account 1', enabled: true }, { id: A, label: 'Two', enabled: true }, { id: B, label: 'Three', enabled: true }],
  });
  const accountDir = (id: string) => path.join(accountsRoot(), id);

  beforeEach(() => {
    fs.mkdirSync(path.join(home(), '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home(), '.claude', 'settings.json'), '{}');
    for (const id of ['default', A, B]) setAuth(id, { signedIn: true, email: `${id}@example.com`, subscriptionType: 'max', error: null });
    writeAccountsSettings(settings());
    provisionAccountDir(accountDir(A));
  });

  it('4a. a start on the account the agent is on writes that account\'s .claude.json', () => {
    ensureProjectTrusted(project, agent({ claudeAccountId: A, secondaryProjectPath: secondary }));
    const trusted = trustedIn(claudeJsonOf(accountDir(A)));
    for (const dir of [...spellings(project), ...spellings(DATA_DIR), ...spellings(secondary)]) expect(trusted).toContain(dir);
  });

  it('4b. the launch that picks the account trusts the agent\'s folders in that account\'s .claude.json', () => {
    const env = claudeAccountEnvFor(agent({ claudeAccountPin: A, secondaryProjectPath: secondary }), {
      agents: [], cwd: project, now: Date.now(), settings: settings(), usage: {}, overrides: [],
    });
    expect(env?.set.CLAUDE_CONFIG_DIR).toBe(accountDir(A));
    const trusted = trustedIn(claudeJsonOf(accountDir(A)));
    for (const dir of [...spellings(project), ...spellings(DATA_DIR), ...spellings(secondary)]) expect(trusted).toContain(dir);
  });

  it('10. an account whose folder is not there is not created', () => {
    ensureProjectTrusted(project, agent({ claudeAccountId: B }));
    expect(fs.existsSync(accountDir(B))).toBe(false);
  });

  it('10. with the accounts off, nothing is written in an account\'s folder', () => {
    writeAccountsSettings(settings(false));
    // The folder outlives each case: what the cases before wrote there is read before, and must stay as it was.
    const file = claudeJsonOf(accountDir(A));
    const before = fs.readFileSync(file, 'utf-8');
    ensureProjectTrusted(project, agent({ claudeAccountId: A }));
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });
});

describe('11. what was right stays right', () => {
  it('a start with no agent yet trusts its own folder, as before', () => {
    ensureProjectTrusted(project);
    expect(trustedIn(homeFile()).sort()).toEqual(spellings(project).sort());
  });

  it('a user\'s entry keeps its other keys', () => {
    fs.writeFileSync(homeFile(), JSON.stringify({ projects: { [DATA_DIR]: { allowedTools: ['Bash(ls)'], mcpContextUris: ['u'] } } }), { mode: 0o600 });
    ensureProjectTrusted(project, agent());
    const entry = (JSON.parse(fs.readFileSync(homeFile(), 'utf-8')) as { projects: Record<string, Record<string, unknown>> }).projects[DATA_DIR];
    expect(entry).toMatchObject({ allowedTools: ['Bash(ls)'], mcpContextUris: ['u'], hasTrustDialogAccepted: true });
  });

  it('the file is not rewritten when every folder is already trusted', () => {
    ensureProjectTrusted(project, agent({ secondaryProjectPath: secondary }));
    const before = fs.statSync(homeFile());
    const text = fs.readFileSync(homeFile(), 'utf-8');
    ensureProjectTrusted(project, agent({ secondaryProjectPath: secondary }));
    expect(fs.statSync(homeFile()).ino).toBe(before.ino);
    expect(fs.readFileSync(homeFile(), 'utf-8')).toBe(text);
  });
});
