import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent cut by its Claude account's limit goes on, on another account, by
 * itself (DESIGN-COMPTES-CLAUDE.md B4, with the Audit's N4 and N6), in the
 * real app.
 *
 * The agent's CLI is a stand-in that does what claude does through its hooks,
 * with the agent's own token: it files a transcript through its account's
 * projects/ link, registers its session (SessionStart), and on
 * its first launch starts a turn (UserPromptSubmit), leaves its account's 5 h
 * counter at 100 % as the status line would, and ends the turn on
 * StopFailure `rate_limit` with Claude Code's own sentence. Every launch is
 * written down with its account variables and its arguments, and everything
 * typed into it with the launch it went to. The same script answers
 * `claude auth status` from a marker in each folder.
 *
 * What the run proves, in order:
 * - the agent starts on account 1, which has the most room;
 * - cut by account 1's limit, it is started again, with no one asking, on
 *   account 2, on the same conversation (`--resume <its session>`);
 * - once that session has registered, Tars types "Continue where you left
 *   off..." into it, from Tars, and into no other launch;
 * - the window hears the move (claude-accounts:agent-moved: from account 1 to
 *   2, for the 5 h limit), the record keeps it, and Settings lists account 1
 *   as blocked until its window resets.
 */

type Move = { agentId: string; from: string; to: string; reason: string; window: string; usedPercentage: number | null; at: number };
type Api = {
  electronAPI: {
    claudeAccounts: {
      list(): Promise<{ success: boolean; accounts: { id: string; blockedUntil: number | null; agentIds: string[] }[] }>;
      add(p: { label: string }): Promise<{ success: boolean; account: { id: string; configDir: string }; error?: string }>;
      setEnabled(on: boolean): Promise<{ success: boolean; error?: string }>;
      refresh(): Promise<{ success: boolean }>;
      onAgentMoved(cb: (e: Move) => void): () => void;
    };
    agent: {
      start(p: { id: string; prompt: string }): Promise<unknown>;
      list(): Promise<Array<{ id: string; claudeAccountId?: string; claudeAccountMove?: Move }>>;
    };
  };
};
type Win = Api & { moves?: Move[] };

const AGENT = { id: 'w1', name: 'Worker One' };
const LIMIT = "You've hit your session limit · resets 11:59pm (Asia/Tbilisi)";

function writeStandIn(home: string): string {
  const bin = path.join(home, 'fake-claude.cjs');
  fs.writeFileSync(bin, [
    `#!${process.execPath}`,
    "const fs = require('fs'); const path = require('path'); const crypto = require('crypto');",
    "const args = process.argv.slice(2);",
    "const home = process.env.HOME;",
    "const d = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');",
    "if (args[0] === 'auth' && args[1] === 'status') {",
    "  const m = path.join(d, '.fake-signed-in');",
    "  if (fs.existsSync(m)) { console.log(JSON.stringify({ loggedIn: true, email: fs.readFileSync(m, 'utf8'), subscriptionType: 'max' })); process.exit(0); }",
    "  console.log(JSON.stringify({ loggedIn: false })); process.exit(1);",
    "}",
    "const log = path.join(home, 'launches.jsonl');",
    "const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).length : 0;",
    "const session = crypto.randomUUID();",
    "fs.appendFileSync(log, JSON.stringify({ n, session, args, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, TARS_CLAUDE_ACCOUNT: process.env.TARS_CLAUDE_ACCOUNT ?? null }) + '\\n');",
    // A transcript as claude files it: under the account's projects/, which is ~/.claude/projects shared.
    "const transcripts = path.join(d, 'projects', fs.realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'));",
    "fs.mkdirSync(transcripts, { recursive: true });",
    "fs.writeFileSync(path.join(transcripts, session + '.jsonl'), JSON.stringify({ type: 'user', sessionId: session, message: { role: 'user', content: 'work' } }) + '\\n');",
    "process.stdin.on('data', b => fs.appendFileSync(path.join(home, 'typed.jsonl'), JSON.stringify({ n, text: b.toString('utf8') }) + '\\n'));",
    "const post = body => fetch(process.env.CLAUDE_MGR_API_URL + '/api/hooks/status', {",
    "  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },",
    "  body: JSON.stringify({ agent_id: process.env.CLAUDE_AGENT_ID, session_id: session, ...body }),",
    "}).then(r => r.text()).then(t => fs.appendFileSync(path.join(home, 'posts.log'), n + ' ' + JSON.stringify(body.event || body.source || body.status) + ' ' + t + '\\n'));",
    "const pause = ms => new Promise(r => setTimeout(r, ms));",
    "(async () => {",
    "  process.stdout.write('stand-in ready\\n');",
    "  await post({ status: 'idle', source: 'startup' });",
    "  if (n > 0) return;",
    "  await pause(500);",
    "  await post({ status: 'running', event: 'UserPromptSubmit' });",
    "  const now = Math.floor(Date.now() / 1000);",
    "  fs.writeFileSync(path.join(home, '.dorothy', 'rate-limits.d', 'default.json'), JSON.stringify({ updatedAt: now, rate_limits: { five_hour: { used_percentage: 100, resets_at: now + 3600 }, seven_day: { used_percentage: 12, resets_at: now + 86400 } } }));",
    `  await post({ status: 'error', event: 'StopFailure', error_kind: 'rate_limit', error_message: ${JSON.stringify(LIMIT)} });`,
    "})();",
    "process.stdin.resume();",
    '',
  ].join('\n'), { mode: 0o755 });
  return bin;
}

function lines(file: string): Record<string, unknown>[] {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
}

const ev = (page: Page) => page.evaluate.bind(page);

test.skip(process.platform === 'win32', 'several Claude accounts are off on a Windows build until they are ported; this runs on macOS and Linux');

test('an agent cut by its account\'s limit goes on, on another account', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-accounts-switch-'));
  const resolvedHome = fs.realpathSync(home);
  const dataDir = path.join(home, '.dorothy');
  const project = path.join(resolvedHome, 'projects', 'demo');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'rate-limits.d'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.fake-signed-in'), 'one@example.com');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  const cli = writeStandIn(home);
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify([{
    id: AGENT.id, name: AGENT.name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-09-30T08:00:00.000Z', lastActivity: '2026-09-30T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dataDir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude: cli } }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31485), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI?.claudeAccounts);
    const run = ev(page);

    // Account 2, signed in; the option on; account 1 with the most room.
    const added = await run(() => (window as unknown as Api).electronAPI.claudeAccounts.add({ label: 'Max two' }));
    expect(added.success, added.error).toBe(true);
    const two = added.account;
    fs.writeFileSync(path.join(two.configDir, '.fake-signed-in'), 'two@example.com');
    await run(() => (window as unknown as Api).electronAPI.claudeAccounts.refresh());
    const on = await run(() => (window as unknown as Api).electronAPI.claudeAccounts.setEnabled(true));
    expect(on.success, on.error).toBe(true);
    const now = Math.floor(Date.now() / 1000);
    const limits = (p: number) => JSON.stringify({ updatedAt: now, rate_limits: { five_hour: { used_percentage: p, resets_at: now + 3600 }, seven_day: { used_percentage: 5, resets_at: now + 86400 } } });
    fs.writeFileSync(path.join(dataDir, 'rate-limits.d', 'default.json'), limits(10));
    fs.writeFileSync(path.join(dataDir, 'rate-limits.d', `${two.id}.json`), limits(30));

    await run(() => {
      const w = window as unknown as Win;
      w.moves = [];
      w.electronAPI.claudeAccounts.onAgentMoved(e => w.moves!.push(e));
    });
    await run(id => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), AGENT.id);

    // Started on account 1, cut by its limit, started again on account 2 on the same conversation.
    const launchLog = path.join(home, 'launches.jsonl');
    await expect.poll(() => lines(launchLog).length, { timeout: 30_000, message: 'the stand-in CLI started' }).toBeGreaterThanOrEqual(1);
    const first = lines(launchLog)[0] as { session: string; CLAUDE_CONFIG_DIR: string | null; TARS_CLAUDE_ACCOUNT: string };
    expect(first).toMatchObject({ CLAUDE_CONFIG_DIR: null, TARS_CLAUDE_ACCOUNT: 'default' });
    await expect.poll(() => lines(launchLog).length, { timeout: 60_000, message: 'started again after the limit' }).toBe(2);
    const second = lines(launchLog)[1] as { args: string[]; CLAUDE_CONFIG_DIR: string | null; TARS_CLAUDE_ACCOUNT: string };
    expect(second).toMatchObject({ CLAUDE_CONFIG_DIR: two.configDir, TARS_CLAUDE_ACCOUNT: two.id });
    expect(second.args).toContain('--resume');
    expect(second.args[second.args.indexOf('--resume') + 1]).toBe(first.session);
    expect(second.args).toContain('--fork-session');

    // Told to go on, from Tars, in the new session only.
    const typedLog = path.join(home, 'typed.jsonl');
    await expect.poll(() => lines(typedLog).filter(t => t.n === 1).map(t => t.text).join(''), { timeout: 60_000, message: 'Continue typed into the new session' })
      .toContain('Continue where you left off: your last turn was cut by a usage limit and you are now on another Claude account.');
    const typedSecond = lines(typedLog).filter(t => t.n === 1).map(t => t.text).join('');
    expect(typedSecond).toContain('Message from Tars');
    expect(lines(typedLog).filter(t => t.n === 0)).toEqual([]);

    // The window heard the move, the record keeps it, and account 1 waits for its reset.
    await expect.poll(() => run(() => (window as unknown as Win).moves), { timeout: 10_000 }).toHaveLength(1);
    const moves = await run(() => (window as unknown as Win).moves!);
    expect(moves[0]).toMatchObject({ agentId: AGENT.id, from: 'default', to: two.id, reason: 'limit', window: 'fiveHour', usedPercentage: 100 });
    const record = (await run(() => (window as unknown as Api).electronAPI.agent.list())).find(a => a.id === AGENT.id)!;
    expect(record.claudeAccountId).toBe(two.id);
    expect(record.claudeAccountMove).toMatchObject({ from: 'default', to: two.id, reason: 'limit' });
    const view = await run(() => (window as unknown as Api).electronAPI.claudeAccounts.list());
    const blocked = view.accounts.find(a => a.id === 'default')!.blockedUntil!;
    expect(Math.abs(blocked - (now + 3600))).toBeLessThan(120);
    expect(view.accounts.find(a => a.id === two.id)!.agentIds).toEqual([AGENT.id]);

    recordValues({
      launches: lines(launchLog),
      typed: lines(typedLog),
      posts: fs.existsSync(path.join(home, 'posts.log')) ? fs.readFileSync(path.join(home, 'posts.log'), 'utf8') : '',
      moves,
      accounts: view.accounts,
    });
  } finally {
    await app.close();
    await removeHome(home);
  }
});
