import * as os from 'os';
import type { AgentStatus, ClaudeAccountsSettings } from '../../types';
import type { AccountEnv, AccountEnvPurpose } from '../../core/account-env';
import { DEFAULT_ACCOUNT_ID, readAccountsSettings } from './registry';
import { accountDirProblem, claudeCredentialOverrides, projectsProblem, provisionAccountDir } from './provision';
import { readAccountUsage } from './counters';
import { chooseAccount, type AccountUsage, type Choice } from './choose';
import { blockedUntil, getAuth, noteMove, recentMoves, takeMove } from './state';

/**
 * The environment an agent's CLI starts with, per account
 * (DESIGN-COMPTES-CLAUDE.md B3). Called at every spawn of an agent process,
 * through the resolver main.ts registers (core/account-env.ts).
 *
 * - The option off, or an agent of another provider: null, and the launch is
 *   exactly what it was.
 * - Account 1: the variables that would aim Claude Code elsewhere are removed
 *   from what the process inherits (measured, CLAUDE_CONFIG_DIR=~/.claude is
 *   another login), and the status line is told it reports for `default`.
 * - Another account: its folder is provisioned for the folder the CLI starts
 *   in (hooks, MCP servers, the bypass acceptance, that project's trust and
 *   approvals, the Audit's B1), then named. A folder that fails its checks
 *   (B2), or a credential that would sign every folder in as one (B3), and
 *   the agent starts on account 1 rather than not at all.
 *
 * The choice is recorded on the agent (what its card shows, and what the next
 * relaunch keeps while it has room) and counted for a minute, so that agents
 * launched together spread out before their terminals exist (N5).
 *
 * A move switching.ts asked for is made by the agent's next terminal launch,
 * and said on the env it returns (`move`), for main.ts to tell the windows.
 * Not by a delegated run, which has no terminal to move; not over a pin set
 * since; not onto an account that can no longer run, where the choice
 * decides as it would have.
 */

export const ACCOUNT_ENV_UNSET = ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'TARS_CLAUDE_ACCOUNT'] as const;

export interface LaunchContext {
  /** The fleet, to count who runs where. */
  agents: Iterable<AgentStatus>;
  /** A terminal (the default), or a delegated run. */
  purpose?: AccountEnvPurpose;
  /** The folder the CLI starts in. */
  cwd?: string;
  now?: number;
  home?: string;
  settings?: ClaudeAccountsSettings;
  usage?: Record<string, AccountUsage>;
  overrides?: string[];
}

export function isClaudeSubscription(agent: AgentStatus): boolean {
  return !agent.provider || agent.provider === 'claude';
}

function defaultEnv(): AccountEnv {
  return { accountId: DEFAULT_ACCOUNT_ID, set: { TARS_CLAUDE_ACCOUNT: DEFAULT_ACCOUNT_ID }, unset: ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'] };
}

function record(agent: AgentStatus, env: AccountEnv, now: number): AccountEnv {
  agent.claudeAccountId = env.accountId;
  noteMove(agent.id, env.accountId, now);
  return env;
}

/** Whether an account can take an agent now: enabled and signed in (account 1 until it says otherwise). */
export function accountCanRun(settings: ClaudeAccountsSettings, id: string): boolean {
  const account = settings.accounts.find(a => a.id === id);
  const signedIn = getAuth(id)?.signedIn ?? null;
  return !!account && account.enabled && (id === DEFAULT_ACCOUNT_ID ? signedIn !== false : signedIn === true);
}

/**
 * The account the choice gives this agent now, from the registry, the counters,
 * the sign-ins, the blocks and who runs where. `ignorePin` for a move, which
 * never applies to a pinned agent anyway.
 */
export function choiceFor(agent: AgentStatus, settings: ClaudeAccountsSettings, ctx: Pick<LaunchContext, 'agents' | 'usage'> & { now: number; ignorePin?: boolean }): Choice {
  const now = ctx.now;
  // Who runs where: agents with a terminal, and choices made a moment ago for
  // agents whose terminal is not there yet. Not this agent.
  const load: Record<string, number> = {};
  const counted = new Set<string>();
  for (const other of ctx.agents) {
    if (other.id === agent.id || !other.ptyId || !other.claudeAccountId) continue;
    load[other.claudeAccountId] = (load[other.claudeAccountId] ?? 0) + 1;
    counted.add(other.id);
  }
  for (const [agentId, accountId] of recentMoves(now)) {
    if (agentId === agent.id || counted.has(agentId)) continue;
    load[accountId] = (load[accountId] ?? 0) + 1;
  }

  return chooseAccount({
    accounts: settings.accounts.map(a => ({ id: a.id, enabled: a.enabled, signedIn: getAuth(a.id)?.signedIn ?? null })),
    fiveHourThreshold: settings.fiveHourThreshold,
    weeklyThreshold: settings.weeklyThreshold,
    usage: ctx.usage ?? readAccountUsage(),
    blockedUntil: blockedUntil(),
    load,
    pin: ctx.ignorePin ? undefined : agent.claudeAccountPin,
    last: agent.claudeAccountId,
    now,
  });
}

/** What `claude auth status` answered for an account, as the first run reads it. */
export type SignInAnswer = 'signed-in' | 'signed-out' | 'cli-missing' | 'unknown';

interface NewAgentOptions {
  /** claudeCredentialOverrides(), unless a test names them. */
  overrides?: string[];
  /** Why an account's folder cannot be used (envFor's checks), unless a test says. */
  folderProblem?: (configDir: string) => string | null;
}

/**
 * The accounts a new Claude agent may start on now, as its launch would choose (claudeAccountEnvFor for an agent with
 * no pin and no account yet), in the order of the list: account 1 with the option off or a credential override; else
 * each account the chooser can give it (enabled and signed in, account 1 until it says signed out), account 1 in the
 * place of one whose folder cannot be used; account 1 when none can run. Reads the sign-ins the launch reads (state.ts).
 */
export function accountsANewAgentMayStartOn(settings: ClaudeAccountsSettings, opts: NewAgentOptions = {}): string[] {
  if (!settings.enabled) return [DEFAULT_ACCOUNT_ID];
  if ((opts.overrides ?? claudeCredentialOverrides()).length) return [DEFAULT_ACCOUNT_ID];
  const problem = opts.folderProblem ?? ((dir: string) => accountDirProblem(dir) ?? projectsProblem(dir));
  const may = settings.accounts
    .filter(a => accountCanRun(settings, a.id))
    .map(a => (a.id !== DEFAULT_ACCOUNT_ID && (!a.configDir || problem(a.configDir)) ? DEFAULT_ACCOUNT_ID : a.id));
  return may.length ? [...new Set(may)] : [DEFAULT_ACCOUNT_ID];
}

/**
 * Whether a new Claude agent would start signed in, from what each account answered just now: what teams:deploy
 * checks its Claude members against (QA's B3; the Audit's I1 on #584: any one account signed in was taken as enough).
 * `signedOut` names, with the option on, the accounts they may start on that are signed out.
 */
export function newAgentSignIn(settings: ClaudeAccountsSettings, answers: Record<string, SignInAnswer>, opts: NewAgentOptions = {}): { state: SignInAnswer; signedOut: string[] } {
  if (Object.values(answers).includes('cli-missing')) return { state: 'cli-missing', signedOut: [] };
  const may = accountsANewAgentMayStartOn(settings, opts);
  const out = may.filter(id => answers[id] === 'signed-out');
  if (out.length) {
    const label = (id: string) => settings.accounts.find(a => a.id === id)?.label ?? id;
    return { state: 'signed-out', signedOut: settings.enabled ? out.map(label) : [] };
  }
  return { state: may.every(id => answers[id] === 'signed-in') ? 'signed-in' : 'unknown', signedOut: [] };
}

export function claudeAccountEnvFor(agent: AgentStatus, ctx: LaunchContext): AccountEnv | null {
  const settings = ctx.settings ?? readAccountsSettings();
  if (!settings.enabled || !isClaudeSubscription(agent)) return null;
  const now = ctx.now ?? Date.now();
  const name = agent.name || agent.id;

  const overrides = ctx.overrides ?? claudeCredentialOverrides();
  if (overrides.length) {
    console.warn(`[claude-accounts] ${name}: on account 1, since Claude Code would sign every account in with ${overrides.join(', ')}`);
    return record(agent, defaultEnv(), now);
  }

  const move = (ctx.purpose ?? 'terminal') === 'terminal' ? takeMove(agent.id) : undefined;
  const moveTo = move && !agent.claudeAccountPin && accountCanRun(settings, move.to) ? move.to : undefined;
  const choice: Choice = moveTo ? { accountId: moveTo, reason: 'moved' } : choiceFor(agent, settings, { agents: ctx.agents, usage: ctx.usage, now });
  const from = agent.claudeAccountId ?? DEFAULT_ACCOUNT_ID;

  const env = envFor(agent, settings, choice, ctx, name);
  // The move is made only when the launch did land on its account.
  if (move && moveTo && env.accountId === moveTo) {
    env.move = { agentId: agent.id, from, to: moveTo, reason: move.reason, window: move.window, usedPercentage: move.usedPercentage, at: now };
  }
  return record(agent, env, now);
}

function envFor(agent: AgentStatus, settings: ClaudeAccountsSettings, choice: Choice, ctx: LaunchContext, name: string): AccountEnv {
  const account = settings.accounts.find(a => a.id === choice.accountId);
  if (!account || !account.configDir) return defaultEnv();

  try {
    const home = ctx.home ?? os.homedir();
    provisionAccountDir(account.configDir, home, { projectPath: ctx.cwd });
    if (ctx.cwd !== agent.projectPath && agent.projectPath) provisionAccountDir(account.configDir, home, { projectPath: agent.projectPath });
  } catch (err) {
    console.warn(`[claude-accounts] ${name}: on account 1, since ${account.label} cannot be used: ${err instanceof Error ? err.message : String(err)}`);
    return defaultEnv();
  }
  const lost = projectsProblem(account.configDir);
  if (lost) {
    console.warn(`[claude-accounts] ${name}: on account 1, since ${account.label} cannot be used: ${lost}`);
    return defaultEnv();
  }
  console.log(`[claude-accounts] ${name}: on ${account.label} (${choice.reason})`);
  return {
    accountId: account.id,
    set: { CLAUDE_CONFIG_DIR: account.configDir, TARS_CLAUDE_ACCOUNT: account.id },
    unset: ['CLAUDE_SECURESTORAGE_CONFIG_DIR'],
  };
}
