import { ipcMain, shell } from 'electron';
import * as os from 'os';
import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import { broadcastToAllWindows } from '../utils/broadcast';
import {
  DEFAULT_ACCOUNT_ID,
  accountsRoot,
  addAccount,
  readAccountsSettings,
  registryProblem,
  removeAccount,
  renameAccount,
  reorderAccounts,
  setAccountEnabled,
  setEnabled,
  setThresholds,
  writeAccountsSettings,
} from '../services/claude-accounts/registry';
import { accountDirProblem, claudeCredentialOverrides, ensureAccountDir, projectsProblem, provisionAccountDir } from '../services/claude-accounts/provision';
import { claudeAuthLogout, claudeAuthStatus, loginCommand } from '../services/claude-accounts/auth';
import { countersDir, readAccountUsage, usageForView } from '../services/claude-accounts/counters';
import { probeUsage, recordProbe, usageProbeEnv } from '../services/claude-accounts/usage-probe';
import { blockedUntil, deleteAuth, getAuth, hasAuth, setAuth, type AuthState } from '../services/claude-accounts/state';
import * as fs from 'fs';
import type { AgentStatus, AppSettings, ClaudeAccount, ClaudeAccountState, ClaudeAccountsSettings, ClaudeAccountsView } from '../types';
import { refuseWhileQuitting } from '../core/quit-state';
import { killPty } from '../core/pty-kill';

/**
 * The Settings contract for several Claude accounts (DESIGN-COMPTES-CLAUDE.md, B6).
 *
 * This file manages the list, the sign-ins and what the page shows: each
 * account's counters as its status line left them, and the agents on it.
 * Choosing an account when an agent starts is services/claude-accounts/launch.ts.
 */

export const CLAUDE_ACCOUNTS_CHANNELS = [
  'claude-accounts:list',
  'claude-accounts:set-enabled',
  'claude-accounts:set-thresholds',
  'claude-accounts:add',
  'claude-accounts:rename',
  'claude-accounts:set-account-enabled',
  'claude-accounts:reorder',
  'claude-accounts:remove',
  'claude-accounts:refresh',
  'claude-accounts:login-start',
  'claude-accounts:login-write',
  'claude-accounts:login-resize',
  'claude-accounts:login-kill',
  'claude-accounts:set-agent-account',
] as const;

export interface ClaudeAccountsHandlerDeps {
  getAppSettings: () => AppSettings;
  agents: Map<string, AgentStatus>;
  saveAgents: () => void;
  /** Where the login terminals are kept, so that quitting kills them with the rest. */
  loginPtys: Map<string, pty.IPty>;
  /**
   * An agent's pin changed while the option is on: its CLI reads the account
   * at launch, so main.ts restarts it through agent-restart.ts, at a moment
   * that cuts nothing.
   */
  onAgentAccountChanged?: (agentId: string) => void;
}

/**
 * Tells every window an agent's account or pin changed: the list each window
 * holds is otherwise only read again on its own schedule, so a pin set from
 * one window (or cleared by a removal) went unseen in the others.
 */
export function announceAgentAccount(agent: AgentStatus): void {
  broadcastToAllWindows('claude-accounts:agent-changed', {
    agentId: agent.id,
    claudeAccountId: agent.claudeAccountId ?? null,
    claudeAccountPin: agent.claudeAccountPin ?? null,
  });
}

type Result<T extends object = object> = ({ success: true } & T) | { success: false; error: string };

function failure(err: unknown): { success: false; error: string } {
  return { success: false, error: err instanceof Error ? err.message : String(err) };
}

/**
 * Registers the channels. Resolves `idle()` once the checks and post-login
 * work it started in the background have finished: what a caller waits on
 * before reading the result, instead of a delay.
 */
export function registerClaudeAccountsHandlers(deps: ClaudeAccountsHandlerDeps): { idle: () => Promise<void>; refreshAll: () => Promise<void> } {
  const { getAppSettings, agents, saveAgents, loginPtys, onAgentAccountChanged } = deps;

  const background = new Set<Promise<unknown>>();
  function inBackground(p: Promise<unknown>): void {
    background.add(p);
    void p.finally(() => background.delete(p));
  }
  async function idle(): Promise<void> {
    while (background.size) await Promise.allSettled([...background]);
  }

  // What Claude Code last said about each account lives in
  // services/claude-accounts/state.ts, in memory only, where the launch reads it.
  const checking = new Map<string, Promise<void>>();
  /** Login terminal → the account it signs in. */
  const loginFor = new Map<string, string>();

  const binary = (): string => getAppSettings().cliPaths?.claude || 'claude';

  function stateOf(account: ClaudeAccount, usage: ReturnType<typeof readAccountUsage>, blocked: Record<string, number>, now: number): ClaudeAccountState {
    const a = getAuth(account.id);
    const counters = usageForView(usage[account.id], now);
    const until = blocked[account.id];
    return {
      ...account,
      signedIn: a?.signedIn ?? null,
      email: a?.email ?? null,
      subscriptionType: a?.subscriptionType ?? null,
      fiveHour: counters.fiveHour,
      sevenDay: counters.sevenDay,
      models: counters.models ?? [],
      updatedAt: counters.updatedAt,
      blockedUntil: until !== undefined && until * 1000 > now ? until : null,
      agentIds: [...agents.values()]
        .filter(agent => agent.ptyId && (agent.claudeAccountId ?? DEFAULT_ACCOUNT_ID) === account.id)
        .map(agent => agent.id),
      // A sign-in problem first; then a projects/ folder that keeps the
      // account's usage out of the page, why its agents start on account 1.
      error: a?.error ?? (account.configDir ? projectsProblem(account.configDir) : null),
    };
  }

  function view(settings: ClaudeAccountsSettings = readAccountsSettings()): ClaudeAccountsView {
    const usage = readAccountUsage();
    const blocked = blockedUntil();
    const now = Date.now();
    return { settings, accounts: settings.accounts.map(a => stateOf(a, usage, blocked, now)), registryError: registryProblem() };
  }

  function announce(settings?: ClaudeAccountsSettings): ClaudeAccountsView {
    const v = view(settings);
    broadcastToAllWindows('claude-accounts:changed', v);
    return v;
  }

  function save(settings: ClaudeAccountsSettings): ClaudeAccountsView {
    writeAccountsSettings(settings);
    return announce(settings);
  }

  function check(account: ClaudeAccount): Promise<void> {
    const running = checking.get(account.id);
    if (running) return running;
    const p = claudeAuthStatus(binary(), account.configDir)
      .then(info => {
        setAuth(account.id, { signedIn: info.signedIn, email: info.email, subscriptionType: info.subscriptionType, error: null });
      })
      .catch(err => {
        setAuth(account.id, { signedIn: null, email: null, subscriptionType: null, error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => checking.delete(account.id));
    checking.set(account.id, p);
    return p;
  }

  async function checkAll(ids?: string[]): Promise<void> {
    const settings = readAccountsSettings();
    await Promise.all(settings.accounts.filter(a => !ids || ids.includes(a.id)).map(check));
  }

  /**
   * Each signed-in account's windows from Claude Code itself (usage-probe.ts),
   * one account at a time, while the option is on: the chooser and the Usage
   * page then read them with the status lines' (counters.ts). A probe that
   * fails leaves the account as its status line left it.
   */
  let probing: Promise<void> | null = null;
  function probeAll(): Promise<void> {
    if (probing) return probing;
    probing = (async () => {
      const settings = readAccountsSettings();
      if (!settings.enabled) return;
      for (const account of settings.accounts) {
        if (!account.enabled || getAuth(account.id)?.signedIn !== true) continue;
        try {
          recordProbe(account.id, await probeUsage(binary(), usageProbeEnv(account.configDir)));
        } catch (err) {
          console.warn(`[claude-accounts] the usage of ${account.id} was not read: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      announce();
    })().finally(() => { probing = null; });
    return probing;
  }

  /**
   * After a login: the same Claude account in two directories is refused
   * (JeanBrasse, 28/09). The directory just signed in is signed out again, by Claude
   * Code, and the page is told which account already has it.
   */
  async function afterLogin(accountId: string): Promise<void> {
    await checkAll();
    const settings = readAccountsSettings();
    const account = settings.accounts.find(a => a.id === accountId);
    const mine = getAuth(accountId);
    if (!account || !mine?.signedIn || !mine.email) return;
    const other = settings.accounts.find(a => a.id !== accountId
      && getAuth(a.id)?.signedIn
      && getAuth(a.id)?.email?.toLowerCase() === mine.email!.toLowerCase());
    if (!other) return;
    let why = `This Claude account is already added as "${other.label}", and was signed out here.`;
    try {
      await claudeAuthLogout(binary(), account.configDir);
    } catch (err) {
      why = `This Claude account is already added as "${other.label}". Signing it out here failed too: ${err instanceof Error ? err.message : String(err)}`;
    }
    await check(account);
    setAuth(accountId, { ...(getAuth(accountId) as AuthState), error: why });
  }

  ipcMain.handle('claude-accounts:list', async (): Promise<Result<ClaudeAccountsView>> => {
    try {
      const settings = readAccountsSettings();
      const unknown = settings.accounts.filter(a => !hasAuth(a.id)).map(a => a.id);
      if (unknown.length) inBackground(checkAll(unknown).then(() => announce()));
      return { success: true, ...view(settings) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:refresh', async (_e, id?: unknown): Promise<Result<ClaudeAccountsView>> => {
    try {
      if (id !== undefined && id !== null && typeof id !== 'string') throw new Error('An account id is a string.');
      await checkAll(typeof id === 'string' ? [id] : undefined);
      inBackground(probeAll());
      return { success: true, ...announce() };
    } catch (err) {
      return failure(err);
    }
  });

  /**
   * On only when each folder's own login is what Claude Code would use: an API
   * key, a token or a key helper in ~/.claude/settings.json or in Tars's own
   * environment signs every folder in as that one credential, and switching
   * would change nothing the cards say it did (the Audit's B3). Named, never
   * quoted.
   */
  ipcMain.handle('claude-accounts:set-enabled', async (_e, enabled: unknown): Promise<Result<ClaudeAccountsView>> => {
    try {
      if (enabled === true) {
        const overrides = claudeCredentialOverrides();
        if (overrides.length) {
          throw new Error(`Claude Code is set to sign in with ${overrides.join(', ')}, so every account would run on that one credential. Remove it to use several accounts.`);
        }
      }
      return { success: true, ...save(setEnabled(readAccountsSettings(), enabled)) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:set-thresholds', async (_e, p: unknown): Promise<Result<ClaudeAccountsView>> => {
    try {
      const { fiveHour, weekly } = (p ?? {}) as { fiveHour?: unknown; weekly?: unknown };
      return { success: true, ...save(setThresholds(readAccountsSettings(), fiveHour, weekly)) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:add', async (_e, p: unknown): Promise<Result<{ account: ClaudeAccountState }>> => {
    try {
      const { label } = (p ?? {}) as { label?: unknown };
      // Before the folder is made: the save would refuse, and leave it behind.
      const problem = registryProblem();
      if (problem) throw new Error(problem);
      const { settings, account } = addAccount(readAccountsSettings(), label, accountsRoot());
      provisionAccountDir(account.configDir as string);
      // A directory nobody has signed in yet: no need to ask Claude Code.
      setAuth(account.id, { signedIn: false, email: null, subscriptionType: null, error: null });
      const v = save(settings);
      return { success: true, account: v.accounts.find(a => a.id === account.id) as ClaudeAccountState };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:rename', async (_e, p: unknown): Promise<Result<ClaudeAccountsView>> => {
    try {
      const { id, label } = (p ?? {}) as { id?: unknown; label?: unknown };
      return { success: true, ...save(renameAccount(readAccountsSettings(), id, label)) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:set-account-enabled', async (_e, p: unknown): Promise<Result<ClaudeAccountsView>> => {
    try {
      const { id, enabled } = (p ?? {}) as { id?: unknown; enabled?: unknown };
      return { success: true, ...save(setAccountEnabled(readAccountsSettings(), id, enabled)) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:reorder', async (_e, ids: unknown): Promise<Result<ClaudeAccountsView>> => {
    try {
      return { success: true, ...save(reorderAccounts(readAccountsSettings(), ids)) };
    } catch (err) {
      return failure(err);
    }
  });

  /**
   * The folder is checked first: one that is not Tars's own (a link, open to
   * others, not this user's) is refused, with nothing signed out or moved.
   * Then signed out by Claude Code, with the folder's exact string (another
   * spelling is another keychain item), so that no signed-in item is left
   * behind with nobody able to see it; a logout that fails keeps the account.
   * Then the folder goes to the Trash, never deleted: it holds the account's
   * own sessions and history, and a Trash that fails keeps it, and the
   * account, and says so.
   *
   * A folder deleted by hand is made again, empty and owner-only, and signed
   * out whatever it says: its keychain item outlives it, and Claude Code's
   * logout makes the folder again anyway (measured on 2.1.285, open to
   * others), which would then fail the check before the Trash.
   */
  ipcMain.handle('claude-accounts:remove', async (_e, id: unknown): Promise<Result<ClaudeAccountsView>> => {
    try {
      const current = readAccountsSettings();
      const next = removeAccount(current, id);
      const account = current.accounts.find(a => a.id === id) as ClaudeAccount;
      const dir = account.configDir as string;
      let gone = false;
      try {
        fs.lstatSync(dir);
      } catch {
        gone = true;
      }
      let problem: string | null;
      try {
        if (gone) ensureAccountDir(dir);
        problem = accountDirProblem(dir);
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err);
      }
      if (problem) throw new Error(`${problem} Nothing was signed out or moved.`);

      for (const [ptyId, forId] of loginFor) {
        if (forId !== account.id) continue;
        const term = loginPtys.get(ptyId);
        if (term) killPty(term);
        loginPtys.delete(ptyId);
        loginFor.delete(ptyId);
      }

      let signedIn: boolean | null = null;
      if (!gone) {
        try {
          signedIn = (await claudeAuthStatus(binary(), account.configDir)).signedIn;
        } catch {
          signedIn = null;
        }
      }
      if (signedIn !== false) await claudeAuthLogout(binary(), account.configDir);

      try {
        await shell.trashItem(account.configDir as string);
      } catch (err) {
        deleteAuth(account.id);
        throw new Error(`Signed out, but its folder could not go to the Trash (${err instanceof Error ? err.message : String(err)}). Nothing was deleted, and the account stays until its folder can be moved.`);
      }

      const unpinned: AgentStatus[] = [];
      for (const agent of agents.values()) {
        if (agent.claudeAccountPin !== account.id) continue;
        delete agent.claudeAccountPin;
        unpinned.push(agent);
      }
      if (unpinned.length) {
        saveAgents();
        unpinned.forEach(announceAgentAccount);
      }
      deleteAuth(account.id);
      return { success: true, ...save(next) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:login-start', async (_e, p: unknown): Promise<Result<{ ptyId: string }>> => {
    try {
      const { id, cols, rows } = (p ?? {}) as { id?: unknown; cols?: unknown; rows?: unknown };
      const account = readAccountsSettings().accounts.find(a => a.id === id);
      if (!account) throw new Error('There is no such account.');
      if (account.configDir) provisionAccountDir(account.configDir);

      const command = loginCommand(binary(), account.configDir);
      const ptyId = uuidv4();
      // Not once the quit has begun: it would be in no map the quit ends. The
      // terminal lives in pluginPtyProcesses (main.ts), which the quit does end.
      refuseWhileQuitting('login terminal');
      const term = pty.spawn(command.file, command.args, {
        name: 'xterm-256color',
        cols: typeof cols === 'number' && cols > 0 ? cols : 100,
        rows: typeof rows === 'number' && rows > 0 ? rows : 30,
        cwd: os.homedir(),
        // loginCommand wrote the PATH a packaged Tars lacks, once, under Windows's own spelling there.
        env: command.env as Record<string, string>,
      });
      loginPtys.set(ptyId, term);
      loginFor.set(ptyId, account.id);
      term.onData(data => broadcastToAllWindows('claude-accounts:login-data', { ptyId, data }));
      term.onExit(({ exitCode }) => {
        loginPtys.delete(ptyId);
        loginFor.delete(ptyId);
        broadcastToAllWindows('claude-accounts:login-exit', { ptyId, exitCode });
        inBackground(afterLogin(account.id).then(() => announce()));
      });
      return { success: true, ptyId };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:login-write', async (_e, p: unknown): Promise<Result> => {
    const { ptyId, data } = (p ?? {}) as { ptyId?: unknown; data?: unknown };
    const term = typeof ptyId === 'string' && loginFor.has(ptyId) ? loginPtys.get(ptyId) : undefined;
    if (!term || typeof data !== 'string') return { success: false, error: 'There is no such login terminal.' };
    term.write(data);
    return { success: true };
  });

  ipcMain.handle('claude-accounts:login-resize', async (_e, p: unknown): Promise<Result> => {
    const { ptyId, cols, rows } = (p ?? {}) as { ptyId?: unknown; cols?: unknown; rows?: unknown };
    const term = typeof ptyId === 'string' && loginFor.has(ptyId) ? loginPtys.get(ptyId) : undefined;
    if (!term || typeof cols !== 'number' || typeof rows !== 'number' || cols < 1 || rows < 1) {
      return { success: false, error: 'There is no such login terminal.' };
    }
    term.resize(cols, rows);
    return { success: true };
  });

  ipcMain.handle('claude-accounts:login-kill', async (_e, p: unknown): Promise<Result> => {
    const { ptyId } = (p ?? {}) as { ptyId?: unknown };
    const term = typeof ptyId === 'string' && loginFor.has(ptyId) ? loginPtys.get(ptyId) : undefined;
    if (!term) return { success: false, error: 'There is no such login terminal.' };
    killPty(term);
    loginPtys.delete(ptyId as string);
    loginFor.delete(ptyId as string);
    return { success: true };
  });

  /**
   * Holds an agent to one account, or gives it back to the automatic choice
   * (null). Read by the launch path; saved here, and pushed to every window.
   */
  ipcMain.handle('claude-accounts:set-agent-account', async (_e, p: unknown): Promise<Result> => {
    try {
      const { agentId, accountId } = (p ?? {}) as { agentId?: unknown; accountId?: unknown };
      const agent = typeof agentId === 'string' ? agents.get(agentId) : undefined;
      if (!agent) throw new Error('There is no such agent.');
      // A chat's runner starts on its orchestrator's account, read at each launch (the Audit's L3 on #379).
      if (agent.kind === 'chat') throw new Error(`${agent.name || agent.id} runs a chat: its account is the project's orchestrator's. Change it there.`);
      const before = agent.claudeAccountPin;
      if (accountId === null) {
        delete agent.claudeAccountPin;
      } else {
        const account = readAccountsSettings().accounts.find(a => a.id === accountId);
        if (!account) throw new Error('There is no such account.');
        agent.claudeAccountPin = account.id;
      }
      saveAgents();
      announceAgentAccount(agent);
      if (agent.claudeAccountPin !== before && readAccountsSettings().enabled) onAgentAccountChanged?.(agent.id);
      return { success: true };
    } catch (err) {
      return failure(err);
    }
  });

  // The counters move whenever a status line renders: the page hears of it
  // without asking. A folder that cannot be watched (not made yet, a
  // filesystem without events) only means the page sees them at its next list.
  let countersTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    fs.mkdirSync(countersDir(), { recursive: true });
    const watcher = fs.watch(countersDir(), () => {
      if (countersTimer) return;
      countersTimer = setTimeout(() => {
        countersTimer = undefined;
        if (readAccountsSettings().enabled) announce();
      }, 1000);
      countersTimer.unref?.();
    });
    watcher.unref?.();
  } catch {
    /* seen at the next list */
  }

  // Within the chooser's STALE_AFTER_MS (30 min), so an account no agent runs
  // on, or one used on claude.ai meanwhile, is still read. The first a little
  // after start, once the sign-ins have been checked.
  const PROBE_EVERY_MS = 10 * 60_000;
  const firstProbe = setTimeout(() => {
    inBackground(checkAll().then(() => probeAll()));
    const every = setInterval(() => inBackground(probeAll()), PROBE_EVERY_MS);
    every.unref?.();
  }, 30_000);
  firstProbe.unref?.();

  return { idle, refreshAll: () => checkAll() };

}
