/**
 * The environment an agent's CLI starts with, per account
 * (electron/services/claude-accounts/launch.ts), DESIGN-COMPTES-CLAUDE.md B3.
 *
 * What goes wrong if it is wrong, first:
 * - anything at all changes while the option is off: no account, no variable;
 * - an agent of another provider (the thirteen that point the claude binary at
 *   another vendor, local, codex…) given an account;
 * - account 1 launched with a CLAUDE_CONFIG_DIR, a CLAUDE_SECURESTORAGE_CONFIG_DIR
 *   or a TARS_CLAUDE_ACCOUNT Tars inherited: measured, CLAUDE_CONFIG_DIR=~/.claude
 *   is another login. Account 1 is launched with them removed and names itself
 *   `default` to its status line;
 * - an account launched in a folder not provisioned for this project: no hooks,
 *   or the trust and approvals dialogs (B1). Provisioned at each launch, with
 *   the working directory's projects[] entry;
 * - a folder that fails its checks (B2), or a credential that makes every
 *   folder one account (B3): the agent starts on account 1, it is not stopped;
 * - an agent started on an account whose projects/ is a folder of its own
 *   holding something (the Audit's gap 5): what it writes would never reach
 *   Usage or resume. It starts on account 1; an empty one is made the link;
 * - the choice not remembered: agent.claudeAccountId is what the card shows and
 *   what the next relaunch keeps;
 * - several agents launched at once all counted as nowhere (N5): a choice is
 *   counted for 60 s, until the agent's terminal is there to be counted;
 * - a move Tars asked for (switching.ts) not made by the launch it restarts,
 *   or made by a delegated run instead, which has no terminal to move; made
 *   over a pin set since, or onto an account that can no longer run; or made
 *   without saying from where, so the card and the move event cannot tell.
 */
import '../../setup/home-guard';
import { describe, it, expect, beforeEach } from 'vitest';
import { claudeAccountsNotPorted } from '../../setup/platform-limits';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeAccountEnvFor, ACCOUNT_ENV_UNSET } from '../../../electron/services/claude-accounts/launch';
import { setAuth, resetAccountState, requestMove, pendingMove, noteMove } from '../../../electron/services/claude-accounts/state';
import { accountsRoot, normalizeAccountsSettings } from '../../../electron/services/claude-accounts/registry';
import type { AgentStatus, ClaudeAccountsSettings } from '../../../electron/types';

const home = () => fs.realpathSync(os.homedir());
const A = 'acct-aaaaaa';
const B = 'acct-bbbbbb';

function settings(over: Partial<ClaudeAccountsSettings> = {}): ClaudeAccountsSettings {
  return {
    ...normalizeAccountsSettings({
      enabled: true,
      accounts: [{ id: 'default', label: 'Account 1', enabled: true }, { id: A, label: 'Max two', enabled: true }, { id: B, label: 'Max three', enabled: true }],
    }),
    ...over,
  };
}

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return { id: `ag-${Math.random().toString(16).slice(2, 8)}`, status: 'idle', projectPath: project, skills: [], output: [], lastActivity: '', provider: 'claude', ...over } as AgentStatus;
}

let project: string;
const NOW = Date.UTC(2026, 8, 28, 20, 0, 0);
const S = (ms: number) => Math.floor(ms / 1000);
const full = { fiveHour: { usedPercentage: 99, resetsAt: S(NOW) + 3600 }, sevenDay: { usedPercentage: 10, resetsAt: S(NOW) + 86400 }, updatedAt: NOW };
const light = (p: number) => ({ fiveHour: { usedPercentage: p, resetsAt: S(NOW) + 3600 }, sevenDay: { usedPercentage: p, resetsAt: S(NOW) + 86400 }, updatedAt: NOW });

beforeEach(() => {
  resetAccountState();
  project = fs.mkdtempSync(path.join(home(), 'project-'));
  fs.writeFileSync(path.join(home(), '.claude.json'), JSON.stringify({
    bypassPermissionsModeAccepted: true,
    projects: { [project]: { hasTrustDialogAccepted: true, enabledMcpjsonServers: ['s'] } },
  }));
  fs.mkdirSync(path.join(home(), '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home(), '.claude', 'settings.json'), '{}');
  for (const id of ['default', A, B]) setAuth(id, { signedIn: true, email: `${id}@example.com`, subscriptionType: 'max', error: null });
});

const ctx = (over: Record<string, unknown> = {}) => ({ agents: [] as AgentStatus[], cwd: project, now: NOW, settings: settings(), usage: {}, overrides: [] as string[], ...over });

describe.skipIf(claudeAccountsNotPorted())('with the option off', () => {
  it('gives nothing, so the launch is what it was', () => {
    expect(claudeAccountEnvFor(agent(), ctx({ settings: settings({ enabled: false }) }))).toBeNull();
  });
});

describe.skipIf(claudeAccountsNotPorted())('other providers', () => {
  it.each(['openrouter', 'deepseek', 'local', 'codex', 'gemini'])('gives %s nothing', (provider) => {
    expect(claudeAccountEnvFor(agent({ provider: provider as never }), ctx())).toBeNull();
  });
});

describe.skipIf(claudeAccountsNotPorted())('account 1', () => {
  it('is launched with the account variables removed, and names itself to its status line', () => {
    const a = agent();
    const env = claudeAccountEnvFor(a, ctx({ usage: { [A]: full, [B]: full } }))!;
    expect(env.accountId).toBe('default');
    expect(env.set).toEqual({ TARS_CLAUDE_ACCOUNT: 'default' });
    expect(env.unset).toEqual(expect.arrayContaining(['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']));
    expect(ACCOUNT_ENV_UNSET).toEqual(expect.arrayContaining(['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'TARS_CLAUDE_ACCOUNT']));
    expect(a.claudeAccountId).toBe('default');
  });
});

describe.skipIf(claudeAccountsNotPorted())('another account', () => {
  it('is provisioned for the working directory, then named in the environment', () => {
    const a = agent();
    const env = claudeAccountEnvFor(a, ctx({ usage: { default: full, [B]: full } }))!;
    const dir = path.join(accountsRoot(), A);
    expect(env).toEqual({ accountId: A, set: { CLAUDE_CONFIG_DIR: dir, TARS_CLAUDE_ACCOUNT: A }, unset: ['CLAUDE_SECURESTORAGE_CONFIG_DIR'] });
    expect(a.claudeAccountId).toBe(A);
    const own = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf-8'));
    expect(own.projects[project]).toEqual({ hasTrustDialogAccepted: true, enabledMcpjsonServers: ['s'] });
    expect(own.bypassPermissionsModeAccepted).toBe(true);
    expect(fs.readlinkSync(path.join(dir, 'projects'))).toBe(path.join(os.homedir(), '.claude', 'projects'));
  });

  it('follows the pin', () => {
    const env = claudeAccountEnvFor(agent({ claudeAccountPin: B }), ctx())!;
    expect(env.accountId).toBe(B);
  });

  it("starts on account 1 when the account's projects/ is a folder holding transcripts, and leaves them", () => {
    const dir = path.join(accountsRoot(), A);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'projects', '-work'), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(dir), 0o700);
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(path.join(dir, 'projects', '-work', 'kept.jsonl'), 'kept');

    const a = agent({ claudeAccountPin: A });
    const env = claudeAccountEnvFor(a, ctx())!;

    expect(env.accountId).toBe('default');
    expect(a.claudeAccountId).toBe('default');
    expect(fs.readFileSync(path.join(dir, 'projects', '-work', 'kept.jsonl'), 'utf-8')).toBe('kept');
  });

  it('makes an empty projects/ folder the link, and starts the agent on that account', () => {
    const dir = path.join(accountsRoot(), A);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(dir), 0o700);
    fs.chmodSync(dir, 0o700);

    const env = claudeAccountEnvFor(agent({ claudeAccountPin: A }), ctx())!;

    expect(env.accountId).toBe(A);
    expect(fs.readlinkSync(path.join(dir, 'projects'))).toBe(path.join(os.homedir(), '.claude', 'projects'));
  });

  it('falls back to account 1 when the folder fails its checks, and leaves the folder as it is', () => {
    const dir = path.join(accountsRoot(), A);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
    try {
      const a = agent({ claudeAccountPin: A });
      const env = claudeAccountEnvFor(a, ctx())!;
      expect(env.accountId).toBe('default');
      expect(a.claudeAccountId).toBe('default');
      expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
      expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(false);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it('falls back to account 1 while a credential would sign every folder in as one', () => {
    const env = claudeAccountEnvFor(agent({ claudeAccountPin: A }), ctx({ overrides: ['ANTHROPIC_API_KEY in the environment Tars was started with'] }))!;
    expect(env.accountId).toBe('default');
  });
});

describe.skipIf(claudeAccountsNotPorted())('the gaps QA found at the gate of #267', () => {
  it('does not count the agent being launched in the load (L7)', () => {
    // Its own launch a moment ago, on A: counted, it would push it off A onto B.
    const a = agent({ claudeAccountId: 'default' });
    noteMove(a.id, A, NOW - 1_000);
    const env = claudeAccountEnvFor(a, ctx({ usage: { default: full, [A]: light(10), [B]: light(10) } }))!;
    expect(env.accountId).toBe(A);
  });

  it('provisions the project folder too when the CLI starts in a worktree (L9)', () => {
    const worktree = fs.mkdtempSync(path.join(home(), 'worktree-'));
    const claudeJson = JSON.parse(fs.readFileSync(path.join(home(), '.claude.json'), 'utf-8'));
    claudeJson.projects[worktree] = { hasTrustDialogAccepted: true };
    fs.writeFileSync(path.join(home(), '.claude.json'), JSON.stringify(claudeJson));

    const env = claudeAccountEnvFor(agent({ claudeAccountPin: A }), ctx({ cwd: worktree }))!;

    const own = JSON.parse(fs.readFileSync(path.join(accountsRoot(), A, '.claude.json'), 'utf-8'));
    expect(env.accountId).toBe(A);
    expect(own.projects[worktree]).toEqual({ hasTrustDialogAccepted: true });
    expect(own.projects[project]).toEqual({ hasTrustDialogAccepted: true, enabledMcpjsonServers: ['s'] });
  });
});

describe.skipIf(claudeAccountsNotPorted())('counting agents that are moving', () => {
  it('counts a choice made a moment ago, so agents launched together spread out', () => {
    const usage = { default: light(10), [A]: light(11), [B]: light(60) };
    const first = agent();
    const second = agent();
    expect(claudeAccountEnvFor(first, ctx({ usage }))!.accountId).toBe('default');
    // `first` has no terminal yet, but its choice counts.
    expect(claudeAccountEnvFor(second, ctx({ usage, agents: [first] }))!.accountId).toBe(A);
  });

  it('forgets such a choice after 60 s', () => {
    const usage = { default: light(10), [A]: light(11), [B]: light(60) };
    const first = agent();
    claudeAccountEnvFor(first, ctx({ usage }));
    expect(claudeAccountEnvFor(agent(), ctx({ usage, now: NOW + 61_000 }))!.accountId).toBe('default');
  });
});

describe.skipIf(claudeAccountsNotPorted())('a move Tars asked for', () => {
  const asked = (a: AgentStatus, to: string) => requestMove(a.id, { to, reason: 'limit', window: 'fiveHour', usedPercentage: 100 });

  it('is made by the next terminal launch, which says from where, and only once', () => {
    const a = agent({ claudeAccountId: 'default' });
    asked(a, B);
    const env = claudeAccountEnvFor(a, ctx({ usage: { default: light(99) } }))!;
    expect(env.accountId).toBe(B);
    expect(env.move).toEqual({ agentId: a.id, from: 'default', to: B, reason: 'limit', window: 'fiveHour', usedPercentage: 100, at: NOW });
    expect(pendingMove(a.id)).toBeUndefined();
    expect(claudeAccountEnvFor(a, ctx())!.move).toBeUndefined();
  });

  it('says the account the agent was on, not account 1', () => {
    const a = agent({ claudeAccountId: A });
    asked(a, B);
    expect(claudeAccountEnvFor(a, ctx())!.move).toMatchObject({ from: A, to: B });
  });

  it('is left for the terminal by a delegated run', () => {
    const a = agent({ claudeAccountId: 'default' });
    asked(a, B);
    expect(claudeAccountEnvFor(a, ctx({ purpose: 'delegation' }))!.move).toBeUndefined();
    expect(pendingMove(a.id)).toMatchObject({ to: B });
  });

  it('gives way to a pin set since, and to an account that can no longer run', () => {
    const pinned = agent({ claudeAccountId: 'default', claudeAccountPin: A });
    asked(pinned, B);
    const env = claudeAccountEnvFor(pinned, ctx())!;
    expect(env.accountId).toBe(A);
    expect(env.move).toBeUndefined();
    expect(pendingMove(pinned.id)).toBeUndefined();

    const b = agent({ claudeAccountId: 'default' });
    asked(b, B);
    setAuth(B, { signedIn: false, email: null, subscriptionType: null, error: null });
    const other = claudeAccountEnvFor(b, ctx({ usage: { default: light(10), [A]: light(50) } }))!;
    expect(other.accountId).toBe('default');
    expect(other.move).toBeUndefined();
  });
});
