/**
 * The Settings contract for Claude accounts (electron/handlers/claude-accounts-handlers.ts),
 * DESIGN-COMPTES-CLAUDE.md B6, driven through the channels the renderer calls.
 *
 * What goes wrong if it is wrong, first:
 * - a channel of the contract missing: the Settings page calls into nothing;
 * - adding an account that cannot be used: no directory, no link to the shared
 *   transcripts, not saved;
 * - the login terminal aimed at the wrong directory (or at account 1 with
 *   CLAUDE_CONFIG_DIR=~/.claude, which is another login), run through a shell,
 *   or not refreshing the account once it closes;
 * - the same Claude account added twice (JeanBrasse: refused). The second directory is
 *   signed out again, by Claude Code, and the page says which account has it;
 * - removing an account leaving a signed-in keychain item behind: the logout
 *   runs first, and a failed logout keeps the account and its directory;
 * - removing, or writing into, a folder that is not Tars's own (the Audit's B2):
 *   a registry edited by an agent cannot point an account elsewhere, and a
 *   folder that fails the checks is refused, with nothing signed out or moved;
 *   a Trash that fails keeps the folder and the account, never a deletion (N7);
 * - the option turned on while Claude Code signs in with one credential for
 *   every folder (the Audit's B3): refused, saying which one, never its value;
 * - the login terminal's traffic (the OAuth URL, a pasted code) in a log (N1);
 *   the e-mail and plan anywhere but in memory (N2);
 * - account 1 removed;
 * - an agent pinned to an account that no longer exists;
 * - bad input (labels, thresholds, orders, ids) saved, or thrown at the renderer
 *   instead of answered with a sentence;
 * - a change the page does not hear about (claude-accounts:changed), or a pin
 *   only the window that set it sees (claude-accounts:agent-changed);
 * - a registry that does not parse, overwritten by the next change (the other
 *   accounts vanish, still signed in): every change refused, and the page told;
 * - an account whose folder was deleted by hand that can never be removed: its
 *   keychain item outlives the folder, so it is signed out with the derived
 *   string all the same, and the folder the logout makes again goes to the Trash.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { claudeAccountsNotPorted } from '../../setup/platform-limits';

// Every test runs the fake binary several times: 5 s is too short under the
// fleet's load (QA, gate of #263).
vi.setConfig({ testTimeout: 30_000 });
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeFakeClaude, signIn, type FakeClaude } from '../claude-accounts/fake-claude';

const { handlers, broadcasts, spawned, trashed, trash } = vi.hoisted(() => ({
  trash: { fails: false },
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  broadcasts: [] as { channel: string; payload: unknown }[],
  spawned: [] as {
    file: string; args: string[]; opts: { env: Record<string, string | undefined>; cwd?: string };
    data: ((d: string) => void)[]; exit: ((e: { exitCode: number }) => void)[]; killed: boolean; written: string[];
  }[],
  trashed: [] as string[],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn); }) },
  shell: { trashItem: vi.fn(async (p: string) => { if (trash.fails) throw new Error('no trash here'); trashed.push(p); }) },
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string, args: string[], opts: { env: Record<string, string | undefined> }) => {
    const p = { file, args, opts, data: [] as ((d: string) => void)[], exit: [] as ((e: { exitCode: number }) => void)[], killed: false, written: [] as string[] };
    spawned.push(p);
    return {
      onData: (cb: (d: string) => void) => { p.data.push(cb); return { dispose() {} }; },
      onExit: (cb: (e: { exitCode: number }) => void) => { p.exit.push(cb); return { dispose() {} }; },
      write: (d: string) => { p.written.push(d); },
      resize: () => {},
      kill: () => { p.killed = true; },
      pid: 1,
    };
  }),
}));

vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { broadcasts.push({ channel, payload }); },
}));

import { registerClaudeAccountsHandlers, CLAUDE_ACCOUNTS_CHANNELS } from '../../../electron/handlers/claude-accounts-handlers';
import { accountsFile } from '../../../electron/services/claude-accounts/registry';
import { resetAccountState } from '../../../electron/services/claude-accounts/state';
import type { ClaudeAccountsView, ClaudeAccountState } from '../../../electron/types';

let fake: FakeClaude;
let agents: Map<string, Record<string, unknown>>;
let saves: number;
let loginPtys: Map<string, unknown>;
let accountChanged: string[];

function call<T = Record<string, unknown>>(channel: string, arg?: unknown): Promise<T> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`${channel} is not registered`);
  return h({}, arg) as Promise<T>;
}

async function view(): Promise<ClaudeAccountsView> {
  const r = await call<{ success: boolean } & ClaudeAccountsView>('claude-accounts:list');
  expect(r.success).toBe(true);
  return r;
}

function lastChanged(): ClaudeAccountsView {
  const c = broadcasts.filter(b => b.channel === 'claude-accounts:changed').at(-1);
  if (!c) throw new Error('no claude-accounts:changed broadcast');
  return c.payload as ClaudeAccountsView;
}

async function add(label: string): Promise<ClaudeAccountState> {
  const r = await call<{ success: boolean; account: ClaudeAccountState; error?: string }>('claude-accounts:add', { label });
  expect(r.error).toBeUndefined();
  return r.account;
}

let idle: () => Promise<void>;

/** Waits for the work the handler started in the background to reach the page. */
async function settle(): Promise<void> {
  await idle();
}

beforeEach(() => {
  handlers.clear();
  broadcasts.length = 0;
  spawned.length = 0;
  trashed.length = 0;
  trash.fails = false;
  if (fs.existsSync(accountsFile())) fs.unlinkSync(accountsFile());
  // What Claude Code said about the sign-ins is kept in memory, across registrations.
  resetAccountState();
  fake = makeFakeClaude();
  agents = new Map();
  saves = 0;
  loginPtys = new Map();
  accountChanged = [];
  ({ idle } = registerClaudeAccountsHandlers({
    getAppSettings: () => ({ cliPaths: { claude: fake.bin } }) as never,
    agents: agents as never,
    saveAgents: () => { saves++; },
    loginPtys: loginPtys as never,
    onAgentAccountChanged: (agentId: string) => { accountChanged.push(agentId); },
  }));
});

afterEach(async () => {
  // Nothing a test started may land in the next one's broadcasts.
  await idle();
  for (const p of loginPtys.keys()) loginPtys.delete(p);
});

describe.skipIf(claudeAccountsNotPorted())('the contract', () => {
  it('registers every channel of DESIGN-COMPTES-CLAUDE.md B6', () => {
    const expected = [
      'claude-accounts:list', 'claude-accounts:set-enabled', 'claude-accounts:set-thresholds', 'claude-accounts:add',
      'claude-accounts:rename', 'claude-accounts:set-account-enabled', 'claude-accounts:reorder', 'claude-accounts:remove',
      'claude-accounts:refresh', 'claude-accounts:login-start', 'claude-accounts:login-write', 'claude-accounts:login-resize',
      'claude-accounts:login-kill', 'claude-accounts:set-agent-account',
    ];
    expect([...CLAUDE_ACCOUNTS_CHANNELS].sort()).toEqual([...expected].sort());
    for (const c of expected) expect(handlers.has(c)).toBe(true);
  });

  it('lists the option off and account 1 alone when nothing was ever set, with every field of the state', async () => {
    const v = await view();
    expect(v.settings.enabled).toBe(false);
    expect(v.accounts).toHaveLength(1);
    const a = v.accounts[0];
    expect(a).toMatchObject({ id: 'default', configDir: null, enabled: true, fiveHour: null, sevenDay: null, models: [], updatedAt: null, blockedUntil: null, agentIds: [], error: null });
    expect(Object.keys(a).sort()).toEqual(['agentIds', 'blockedUntil', 'configDir', 'email', 'enabled', 'error', 'fiveHour', 'id', 'label', 'models', 'sevenDay', 'signedIn', 'subscriptionType', 'updatedAt'].sort());
  });

  it('asks Claude Code about accounts it has not asked yet, and tells the page', async () => {
    signIn(path.join(os.homedir(), '.claude'), 'one@example.com');
    const first = await view();
    expect(first.accounts[0].signedIn).toBeNull();
    await settle();
    expect(lastChanged().accounts[0]).toMatchObject({ signedIn: true, email: 'one@example.com', subscriptionType: 'max' });
    expect((await view()).accounts[0].email).toBe('one@example.com');
    expect(fake.calls()).toEqual(['<unset>|<unset>|auth status']);
  });
});

describe.skipIf(claudeAccountsNotPorted())('adding and signing in', () => {
  it('creates, provisions and saves the account, signed out', async () => {
    const a = await add('Max two');
    expect(a.signedIn).toBe(false);
    expect(a.configDir).toBe(path.join(fs.realpathSync(os.homedir()), '.claude-accounts', a.id));
    expect(fs.lstatSync(path.join(a.configDir!, 'projects')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(accountsFile(), 'utf-8')).accounts.map((x: { id: string }) => x.id)).toEqual(['default', a.id]);
    expect(lastChanged().accounts.map(x => x.id)).toEqual(['default', a.id]);
  });

  it("says in Settings why an account whose projects/ is a folder of its own gets no agent (the Audit's gap 5)", async () => {
    const a = await add('Max two');
    const projects = path.join(a.configDir!, 'projects');
    fs.unlinkSync(projects);
    fs.mkdirSync(path.join(projects, '-work'), { recursive: true });
    fs.writeFileSync(path.join(projects, '-work', 'kept.jsonl'), 'kept');

    const listed = (await view()).accounts.find(x => x.id === a.id)!;

    expect(listed.error).toMatch(/~\/\.claude\/projects/);
    expect(listed.error).toMatch(/account 1/);
    expect((await view()).accounts.find(x => x.id === 'default')!.error).toBeNull();
  });

  it('answers a bad label, or a sixth account, with a sentence', async () => {
    expect(await call('claude-accounts:add', { label: '' })).toMatchObject({ success: false, error: expect.stringMatching(/label/i) });
    for (let i = 2; i <= 5; i++) await add(`Max ${i}`);
    expect(await call('claude-accounts:add', { label: 'Six' })).toMatchObject({ success: false, error: expect.stringMatching(/5/) });
    expect(await call('claude-accounts:add', undefined)).toMatchObject({ success: false });
  });

  it("runs the binary's own login in a terminal aimed at the account's directory, then reads the result", async () => {
    const a = await add('Max two');
    const r = await call<{ success: boolean; ptyId: string }>('claude-accounts:login-start', { id: a.id, cols: 100, rows: 30 });
    expect(r.success).toBe(true);
    const p = spawned.at(-1)!;
    expect(p.file).toBe(fake.bin);
    expect(p.args).toEqual(['auth', 'login', '--claudeai']);
    expect(p.opts.env.CLAUDE_CONFIG_DIR).toBe(a.configDir);
    expect(p.opts.env.DISABLE_AUTOUPDATER).toBe('1');

    p.data.forEach(cb => cb('Opening browser'));
    expect(broadcasts).toContainEqual({ channel: 'claude-accounts:login-data', payload: { ptyId: r.ptyId, data: 'Opening browser' } });
    await call('claude-accounts:login-write', { ptyId: r.ptyId, data: 'x' });
    expect(p.written).toEqual(['x']);

    signIn(a.configDir!, 'two@example.com');
    p.exit.forEach(cb => cb({ exitCode: 0 }));
    await settle();
    expect(broadcasts).toContainEqual({ channel: 'claude-accounts:login-exit', payload: { ptyId: r.ptyId, exitCode: 0 } });
    expect(lastChanged().accounts.find(x => x.id === a.id)).toMatchObject({ signedIn: true, email: 'two@example.com', error: null });
    expect(loginPtys.has(r.ptyId)).toBe(false);
  });

  it('signs account 1 in again without CLAUDE_CONFIG_DIR', async () => {
    await call('claude-accounts:login-start', { id: 'default' });
    expect('CLAUDE_CONFIG_DIR' in spawned.at(-1)!.opts.env).toBe(false);
  });

  it('refuses the same Claude account twice: signs the new directory out and says who has it', async () => {
    signIn(path.join(os.homedir(), '.claude'), 'one@example.com');
    await call('claude-accounts:refresh');
    const a = await add('Max two');
    const r = await call<{ ptyId: string }>('claude-accounts:login-start', { id: a.id });
    signIn(a.configDir!, 'ONE@example.com');
    spawned.at(-1)!.exit.forEach(cb => cb({ exitCode: 0 }));
    await settle();
    const state = lastChanged().accounts.find(x => x.id === a.id)!;
    expect(state.signedIn).toBe(false);
    expect(state.error).toMatch(/Account 1/);
    expect(fake.calls()).toContain(`${a.configDir}|<unset>|auth logout`);
    expect(r.ptyId).toBeTruthy();
  });

  it('kills a login terminal on request, and refuses an unknown one', async () => {
    const a = await add('Max two');
    const r = await call<{ ptyId: string }>('claude-accounts:login-start', { id: a.id });
    expect(await call('claude-accounts:login-kill', { ptyId: r.ptyId })).toMatchObject({ success: true });
    expect(spawned.at(-1)!.killed).toBe(true);
    expect(await call('claude-accounts:login-kill', { ptyId: 'nope' })).toMatchObject({ success: false });
    expect(await call('claude-accounts:login-start', { id: 'acct-ffffff' })).toMatchObject({ success: false });
  });
});

describe.skipIf(claudeAccountsNotPorted())('removing', () => {
  it('signs out through Claude Code, moves the directory to the trash, forgets the account and its pins', async () => {
    const a = await add('Max two');
    signIn(a.configDir!, 'two@example.com');
    await call('claude-accounts:refresh', a.id);
    agents.set('ag1', { id: 'ag1', claudeAccountPin: a.id });
    const r = await call<{ success: boolean } & ClaudeAccountsView>('claude-accounts:remove', a.id);
    expect(r.success).toBe(true);
    expect(fake.calls()).toContain(`${a.configDir}|<unset>|auth logout`);
    expect(trashed).toEqual([a.configDir]);
    expect(r.accounts.map(x => x.id)).toEqual(['default']);
    expect(agents.get('ag1')!.claudeAccountPin).toBeUndefined();
    expect(saves).toBeGreaterThan(0);
  });

  it('keeps the account and its directory when the logout fails', async () => {
    const a = await add('Max two');
    signIn(a.configDir!, 'two@example.com');
    fs.writeFileSync(path.join(a.configDir!, '.fake-logout-fails'), '');
    await call('claude-accounts:refresh', a.id);
    const r = await call('claude-accounts:remove', a.id);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/log out/i) });
    expect(trashed).toEqual([]);
    expect((await view()).accounts.map(x => x.id)).toContain(a.id);
  });

  it('does not ask for a logout when the account is not signed in', async () => {
    const a = await add('Max two');
    await call('claude-accounts:remove', a.id);
    expect(fake.calls().filter(c => c.endsWith('auth logout'))).toEqual([]);
    expect(trashed).toEqual([a.configDir]);
  });

  it('refuses a folder that fails the checks: nothing signed out, nothing moved, the account kept', async () => {
    const a = await add('Max two');
    signIn(a.configDir!, 'two@example.com');
    fs.chmodSync(a.configDir!, 0o755);
    const r = await call('claude-accounts:remove', a.id);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/other users/) });
    expect(fake.calls().filter(c => c.endsWith('auth logout'))).toEqual([]);
    expect(trashed).toEqual([]);
    expect((await view()).accounts.map(x => x.id)).toContain(a.id);
    fs.chmodSync(a.configDir!, 0o700);
  });

  it('keeps the folder and the account when the Trash fails, and deletes nothing', async () => {
    const a = await add('Max two');
    trash.fails = true;
    const r = await call('claude-accounts:remove', a.id);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/Trash/) });
    expect(fs.existsSync(path.join(a.configDir!, '.claude.json'))).toBe(true);
    expect((await view()).accounts.map(x => x.id)).toContain(a.id);
  });

  it('signs out with the folder derived from the id, whatever an agent wrote into the registry', async () => {
    const a = await add('Max two');
    const file = accountsFile();
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const decoy = fs.mkdtempSync(path.join(os.homedir(), 'Documents-'));
    saved.accounts[1].configDir = decoy;
    fs.writeFileSync(file, JSON.stringify(saved));
    signIn(a.configDir!, 'two@example.com');
    expect((await view()).accounts[1].configDir).toBe(a.configDir);
    await call('claude-accounts:login-start', { id: a.id });
    expect(spawned.at(-1)!.opts.env.CLAUDE_CONFIG_DIR).toBe(a.configDir);
    await call('claude-accounts:remove', a.id);
    expect(fake.calls()).toContain(`${a.configDir}|<unset>|auth logout`);
    expect(trashed).toEqual([a.configDir]);
    expect(fs.readdirSync(decoy)).toEqual([]);
  });

  it('refuses account 1', async () => {
    expect(await call('claude-accounts:remove', 'default')).toMatchObject({ success: false });
  });
});

describe.skipIf(claudeAccountsNotPorted())('settings', () => {
  it('refuses to turn the option on while Claude Code signs in with one credential for every folder, and says which', async () => {
    const claudeDir = path.join(os.homedir(), '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-never-shown' } }));
    const r = await call<{ success: boolean; error?: string }>('claude-accounts:set-enabled', true);
    expect(r.success).toBe(false);
    expect(r.error).toContain('ANTHROPIC_API_KEY');
    expect(r.error).not.toContain('sk-ant-never-shown');
    expect(fs.existsSync(accountsFile()) ? JSON.parse(fs.readFileSync(accountsFile(), 'utf-8')).enabled : false).toBe(false);

    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({}));
    const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'never-shown-either';
    try {
      const again = await call<{ success: boolean; error?: string }>('claude-accounts:set-enabled', true);
      expect(again.success).toBe(false);
      expect(again.error).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(again.error).not.toContain('never-shown-either');
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
    }
    expect(await call('claude-accounts:set-enabled', true)).toMatchObject({ success: true });
    expect(await call('claude-accounts:set-enabled', false)).toMatchObject({ success: true });
  });

  it('turns the option on and off, saved', async () => {
    expect(await call('claude-accounts:set-enabled', true)).toMatchObject({ success: true, settings: { enabled: true } });
    expect(JSON.parse(fs.readFileSync(accountsFile(), 'utf-8')).enabled).toBe(true);
    expect(await call('claude-accounts:set-enabled', 'yes')).toMatchObject({ success: false });
  });

  it('sets thresholds, renames, disables and reorders, answering bad input with a sentence', async () => {
    const a = await add('Max two');
    expect(await call('claude-accounts:set-thresholds', { fiveHour: 80, weekly: 97 })).toMatchObject({ success: true, settings: { fiveHourThreshold: 80, weeklyThreshold: 97 } });
    expect(await call('claude-accounts:set-thresholds', { fiveHour: 10, weekly: 97 })).toMatchObject({ success: false });
    expect(await call('claude-accounts:rename', { id: a.id, label: 'Work' })).toMatchObject({ success: true });
    expect(await call('claude-accounts:set-account-enabled', { id: a.id, enabled: false })).toMatchObject({ success: true });
    const r = await call<ClaudeAccountsView & { success: boolean }>('claude-accounts:reorder', [a.id, 'default']);
    expect(r.accounts.map(x => [x.id, x.label, x.enabled])).toEqual([[a.id, 'Work', false], ['default', 'Account 1', true]]);
    expect(await call('claude-accounts:reorder', [a.id])).toMatchObject({ success: false });
    expect(lastChanged().accounts.map(x => x.id)).toEqual([a.id, 'default']);
  });
});

describe.skipIf(claudeAccountsNotPorted())('what stays in memory', () => {
  it('never logs what goes through the login terminal', async () => {
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); }));
    try {
      const a = await add('Max two');
      const r = await call<{ ptyId: string }>('claude-accounts:login-start', { id: a.id });
      spawned.at(-1)!.data.forEach(cb => cb('https://claude.ai/oauth/authorize?code=LOGIN-URL-SECRET'));
      await call('claude-accounts:login-write', { ptyId: r.ptyId, data: 'PASTED-CODE-SECRET' });
      signIn(a.configDir!, 'two@example.com');
      spawned.at(-1)!.exit.forEach(cb => cb({ exitCode: 0 }));
      await settle();
    } finally {
      spies.forEach(s => s.mockRestore());
    }
    expect(logged.join('\n')).not.toMatch(/LOGIN-URL-SECRET|PASTED-CODE-SECRET|two@example\.com/);
  });

  it('keeps the e-mail and the plan out of the registry file', async () => {
    const a = await add('Max two');
    signIn(a.configDir!, 'two@example.com');
    await call('claude-accounts:refresh');
    await call('claude-accounts:rename', { id: a.id, label: 'Work' });
    const onDisk = fs.readFileSync(accountsFile(), 'utf-8');
    expect(onDisk).not.toContain('two@example.com');
    expect(onDisk).not.toMatch(/subscriptionType|"max"/);
  });
});

describe.skipIf(claudeAccountsNotPorted())('the counters', () => {
  it("shows each account's 5 h and weekly counters, as its status line last left them, and drops a window that has reset", async () => {
    const a = await add('Max two');
    const now = Math.floor(Date.now() / 1000);
    const dir = path.join(os.homedir(), '.dorothy', 'rate-limits.d');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${a.id}.json`), JSON.stringify({ updatedAt: now - 30, rate_limits: { five_hour: { used_percentage: 42, resets_at: now + 3600 }, seven_day: { used_percentage: 61, resets_at: now + 86400 } } }));
    fs.writeFileSync(path.join(dir, 'default.json'), JSON.stringify({ updatedAt: now - 30, rate_limits: { five_hour: { used_percentage: 97, resets_at: now - 5 }, seven_day: { used_percentage: 20, resets_at: now + 86400 } } }));
    const v = await view();
    expect(v.accounts.find(x => x.id === a.id)).toMatchObject({ fiveHour: { usedPercentage: 42, resetsAt: now + 3600 }, sevenDay: { usedPercentage: 61, resetsAt: now + 86400 }, updatedAt: (now - 30) * 1000 });
    expect(v.accounts.find(x => x.id === 'default')).toMatchObject({ fiveHour: null, sevenDay: { usedPercentage: 20 } });
  });
});

describe.skipIf(claudeAccountsNotPorted())("an agent's account", () => {
  it('asks for a restart when a pin changes and the option is on, and only then', async () => {
    const a = await add('Max two');
    agents.set('ag1', { id: 'ag1' });
    await call('claude-accounts:set-agent-account', { agentId: 'ag1', accountId: a.id });
    expect(accountChanged).toEqual([]);
    await call('claude-accounts:set-enabled', true);
    await call('claude-accounts:set-agent-account', { agentId: 'ag1', accountId: a.id });
    expect(accountChanged).toEqual([]);
    await call('claude-accounts:set-agent-account', { agentId: 'ag1', accountId: null });
    expect(accountChanged).toEqual(['ag1']);
  });

  // The Audit's L3 on #379, written before the fix (2026-10-13): a chat's
  // runner takes its account from the project's orchestrator at each launch,
  // so a pin of its own was undone there; it is refused, as every other edit
  // of a runner is (M2).
  it("refuses to pin a chat's runner: its account is its orchestrator's", async () => {
    const a = await add('Max two');
    agents.set('runner', { id: 'runner', name: 'Lead · Release', kind: 'chat', chatId: 'c-2' } as never);
    const answer = await call('claude-accounts:set-agent-account', { agentId: 'runner', accountId: a.id });
    expect(answer).toMatchObject({ success: false });
    expect(JSON.stringify(answer)).toMatch(/runs a chat/);
    expect(agents.get('runner')!.claudeAccountPin).toBeUndefined();
    expect(saves).toBe(0);
  });

  it('pins and unpins an agent, and refuses an unknown agent or account', async () => {
    const a = await add('Max two');
    agents.set('ag1', { id: 'ag1' });
    expect(await call('claude-accounts:set-agent-account', { agentId: 'ag1', accountId: a.id })).toMatchObject({ success: true });
    expect(agents.get('ag1')!.claudeAccountPin).toBe(a.id);
    expect(saves).toBe(1);
    expect(await call('claude-accounts:set-agent-account', { agentId: 'ag1', accountId: null })).toMatchObject({ success: true });
    expect(agents.get('ag1')!.claudeAccountPin).toBeUndefined();
    expect(await call('claude-accounts:set-agent-account', { agentId: 'nope', accountId: null })).toMatchObject({ success: false });
    expect(await call('claude-accounts:set-agent-account', { agentId: 'ag1', accountId: 'acct-ffffff' })).toMatchObject({ success: false });
  });
});

describe.skipIf(claudeAccountsNotPorted())('a registry that does not parse', () => {
  it('is left alone: every change is refused, and the page is told why', async () => {
    fs.mkdirSync(path.dirname(accountsFile()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(accountsFile(), '{ "accounts": [ broken');
    const root = path.join(fs.realpathSync(os.homedir()), '.claude-accounts');
    const seenBefore = new Set(fs.existsSync(root) ? fs.readdirSync(root) : []);
    const v = await view();
    expect(v.registryError).toMatch(/claude-accounts\.json/);
    expect(await call('claude-accounts:add', { label: 'Max two' })).toMatchObject({ success: false, error: expect.stringMatching(/claude-accounts\.json/) });
    expect(await call('claude-accounts:set-thresholds', { fiveHour: 80, weekly: 90 })).toMatchObject({ success: false });
    expect(fs.readFileSync(accountsFile(), 'utf-8')).toBe('{ "accounts": [ broken');
    expect((fs.existsSync(root) ? fs.readdirSync(root) : []).filter(n => !seenBefore.has(n))).toEqual([]);
  });

  it('is not a problem when absent or readable', async () => {
    expect((await view()).registryError).toBeNull();
    await add('Max two');
    expect((await view()).registryError).toBeNull();
  });
});

describe.skipIf(claudeAccountsNotPorted())('an account whose folder was deleted by hand', () => {
  it('is signed out with the derived folder all the same, its folder made again goes to the Trash, and it is gone', async () => {
    const a = await add('Max two');
    fs.rmSync(a.configDir!, { recursive: true, force: true });
    const r = await call<{ success: boolean; error?: string } & ClaudeAccountsView>('claude-accounts:remove', a.id);
    expect(r.error).toBeUndefined();
    expect(fake.calls()).toContain(`${a.configDir}|<unset>|auth logout`);
    expect(trashed).toEqual([a.configDir]);
    expect(r.accounts.map(x => x.id)).toEqual(['default']);
  });
});

describe.skipIf(claudeAccountsNotPorted())('a pin every window hears about', () => {
  it('pushes the agent\'s account and pin when it is pinned or unpinned', async () => {
    const a = await add('Max two');
    agents.set('ag1', { id: 'ag1', claudeAccountId: 'default' });
    await call('claude-accounts:set-agent-account', { agentId: 'ag1', accountId: a.id });
    await call('claude-accounts:set-agent-account', { agentId: 'ag1', accountId: null });
    expect(broadcasts.filter(b => b.channel === 'claude-accounts:agent-changed').map(b => b.payload)).toEqual([
      { agentId: 'ag1', claudeAccountId: 'default', claudeAccountPin: a.id },
      { agentId: 'ag1', claudeAccountId: 'default', claudeAccountPin: null },
    ]);
  });

  it('pushes the pins a removal clears', async () => {
    const a = await add('Max two');
    agents.set('ag1', { id: 'ag1', claudeAccountPin: a.id });
    agents.set('ag2', { id: 'ag2' });
    expect(await call('claude-accounts:remove', a.id)).toMatchObject({ success: true });
    expect(broadcasts.filter(b => b.channel === 'claude-accounts:agent-changed').map(b => b.payload)).toEqual([
      { agentId: 'ag1', claudeAccountId: null, claudeAccountPin: null },
    ]);
  });
});

// QA's gate of #263: each kills a mutant the tests above let through.
describe.skipIf(claudeAccountsNotPorted())('what QA found the tests above let through', () => {
  it('removing signs out even when Claude Code could not say whether the account is signed in', async () => {
    const a = await add('Max two');
    signIn(a.configDir!, 'two@example.com');
    fs.writeFileSync(path.join(a.configDir!, '.fake-broken'), '');
    fs.rmSync(path.join(a.configDir!, '.fake-signed-in'));
    const r = await call('claude-accounts:remove', a.id);
    expect(r).toMatchObject({ success: true });
    expect(fake.calls()).toContain(`${a.configDir}|<unset>|auth logout`);
  });

  it('removing an account kills its open login terminal', async () => {
    const a = await add('Max two');
    const r = await call<{ ptyId: string }>('claude-accounts:login-start', { id: a.id });
    const term = spawned.at(-1)!;
    expect(r.ptyId).toBeTruthy();
    expect(await call('claude-accounts:remove', a.id)).toMatchObject({ success: true });
    expect(term.killed).toBe(true);
  });

  it('the login channels reach login terminals only, never another terminal of the same map', async () => {
    const other = { written: [] as string[], killed: false, resized: false,
      write(d: string) { this.written.push(d); }, kill() { this.killed = true; }, resize() { this.resized = true; } };
    loginPtys.set('plugin-1', other);
    expect(await call('claude-accounts:login-write', { ptyId: 'plugin-1', data: 'y\r' })).toMatchObject({ success: false });
    expect(await call('claude-accounts:login-resize', { ptyId: 'plugin-1', cols: 80, rows: 24 })).toMatchObject({ success: false });
    expect(await call('claude-accounts:login-kill', { ptyId: 'plugin-1' })).toMatchObject({ success: false });
    expect(other).toMatchObject({ written: [], killed: false, resized: false });
  });

  it('a login provisions the folder again when it was removed by hand', async () => {
    const a = await add('Max two');
    fs.rmSync(a.configDir!, { recursive: true, force: true });
    expect(await call('claude-accounts:login-start', { id: a.id })).toMatchObject({ success: true });
    expect(fs.lstatSync(path.join(a.configDir!, 'projects')).isSymbolicLink()).toBe(true);
  });
});
