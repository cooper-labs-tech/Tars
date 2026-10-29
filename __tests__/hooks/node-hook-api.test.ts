import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The hook path end to end, as far as it goes without an agent terminal: the
 * settings Tars writes on win32 are read back the way the CLI reads them, each
 * configured command runs through the shell the CLI would use (Git Bash and
 * PowerShell on Windows), and the real API server, booted here, changes the
 * agent it names.
 *
 * Why not the whole app: an agent's CLAUDE_MGR_API_TOKEN is minted only when
 * its PTY spawns, and this test spawns no terminal. So the token here is
 * minted by the same registry spawnAgentPty uses, for a terminal that is not
 * there; everything after it is real: authentication, ownership contract,
 * routes.
 *
 * How it can fail:
 *  1. The configured command does not start the runner in one of the shells.
 *  2. The runner's posts are refused (403: wrong or missing token, agent_id
 *     not the token's agent) and nothing changes on the agent.
 *  3. SessionStart does not register the session, so every later post is
 *     dropped as stale.
 *  4. UserPromptSubmit does not put the agent in `running` with its task.
 *  5. Stop does not bring it back to idle with its last output.
 *  6. The Gemini wiring (PowerShell, BeforeAgent) does not reach the API.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hook-api-'));
let port = 0;

vi.mock('../../electron/constants', async importOriginal => {
  const actual = await importOriginal<typeof import('../../electron/constants')>();
  return {
    ...actual,
    get API_PORT() { return port; },
    DATA_DIR: tmp,
    dataPath: (...segments: string[]) => path.join(tmp, ...segments),
    AGENTS_FILE: path.join(tmp, 'agents.json'),
    APP_SETTINGS_FILE: path.join(tmp, 'app-settings.json'),
    KANBAN_FILE: path.join(tmp, 'kanban-tasks.json'),
    TELEGRAM_DOWNLOADS_DIR: path.join(tmp, 'telegram-downloads'),
    VAULT_DIR: path.join(tmp, 'vault'),
    VAULT_DB_FILE: path.join(tmp, 'vault.db'),
    API_TOKEN_FILE: path.join(tmp, 'api-token'),
    BUS_FILE: path.join(tmp, 'bus.json'),
  };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import type { AgentStatus } from '../../electron/types';
import { moveTestHome } from '../setup/test-home';

const HOOKS_DIR = path.join(__dirname, '../../hooks');
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const S1 = '11111111-2222-4333-8444-555555555555';
const S2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';

let api: typeof import('../../electron/services/api-server');
let agents: typeof import('../../electron/core/agent-manager')['agents'];
let mintAgentToken: typeof import('../../electron/core/agent-tokens')['mintAgentToken'];
let tarsInstanceId: typeof import('../../electron/core/agent-tokens')['tarsInstanceId'];
const home = path.join(tmp, 'home');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: picked } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(picked));
    });
  });
}

/** The settings the CLIs read, as Tars writes them on win32. */
let claudeHooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> = {};
let geminiHooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> = {};

beforeAll(async () => {
  port = await freePort();
  fs.mkdirSync(home, { recursive: true });
  const restoreHome = moveTestHome(home);
  try {
    const { ClaudeProvider } = await import('../../electron/providers/claude-provider');
    const { GeminiProvider } = await import('../../electron/providers/gemini-provider');
    const c = new ClaudeProvider();
    const g = new GeminiProvider();
    expect(c.configDir.startsWith(home)).toBe(true);
    await (c.configureHooks as (d: string, p?: NodeJS.Platform) => Promise<void>)(HOOKS_DIR, 'win32');
    await (g.configureHooks as (d: string, p?: NodeJS.Platform) => Promise<void>)(HOOKS_DIR, 'win32');
  } finally {
    restoreHome();
  }
  claudeHooks = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8')).hooks;
  geminiHooks = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf-8')).hooks;

  api = await import('../../electron/services/api-server');
  ({ agents } = await import('../../electron/core/agent-manager'));
  ({ mintAgentToken, tarsInstanceId } = await import('../../electron/core/agent-tokens'));
  api.startApiServer(
    null, { notificationsEnabled: false } as never, () => null, null, null,
    () => {}, () => {}, async () => 'pty', () => ({ notificationsEnabled: false } as never),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`never listened: ${api.getApiServerState().phase}`)), 5000);
    const check = () => {
      if (api.getApiServerState().phase !== 'listening') return;
      clearTimeout(timer);
      api.apiServerEmitter.off('state', check);
      resolve();
    };
    api.apiServerEmitter.on('state', check);
    check();
  });
}, 30_000);

afterAll(() => {
  api?.stopApiServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Run = { status: number | null; stdout: string; stderr: string };
type Shell = { name: string; run: (command: string, env: NodeJS.ProcessEnv, stdin: string) => Promise<Run> };

/** Asynchronous on purpose: the API server answering the hook lives in this process's event loop. */
function exec(exe: string, args: string[], env: NodeJS.ProcessEnv, stdin: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const killer = setTimeout(() => child.kill(), 30_000);
    child.on('error', reject);
    child.on('close', status => { clearTimeout(killer); resolve({ status, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}

function shells(): Shell[] {
  if (process.platform !== 'win32') {
    return [{ name: 'sh', run: (c, e, s) => exec('/bin/sh', ['-c', c], e, s) }];
  }
  const out: Shell[] = [];
  if (fs.existsSync(GIT_BASH)) out.push({ name: 'git-bash', run: (c, e, s) => exec(GIT_BASH, ['-c', c], e, s) });
  out.push({ name: 'powershell', run: (c, e, s) => exec('powershell.exe', ['-NoProfile', '-Command', `${c}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`], e, s) });
  return out;
}

function commandFor(hooks: typeof claudeHooks, type: string): string {
  const cmd = hooks[type]?.[0]?.hooks?.[0]?.command;
  expect(cmd, `${type} is not wired`).toBeTruthy();
  return cmd;
}

function agentEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE_|DOROTHY_)/.test(k)) env[k] = v;
  return {
    ...env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`,
    // Beside the token, as spawnAgentPty hands it: a hook sends the token only
    // to the Tars that proves it knows this id (upstream #212).
    TARS_INSTANCE_ID: tarsInstanceId(),
    ...extra,
  };
}

function putAgent(id: string, provider: string): AgentStatus {
  const agent = {
    id, name: id, status: 'idle', provider, projectPath: tmp, skills: [], output: [],
    lastActivity: new Date().toISOString(),
  } as unknown as AgentStatus;
  agents.set(id, agent);
  return agent;
}

beforeEach(() => { agents.clear(); });

describe.each(shells().map(s => [s.name, s] as const))('Claude hooks through %s', (_name, shell) => {
  it('SessionStart registers, UserPromptSubmit runs, Stop settles, all with the agent\'s own token', async () => {
    const agent = putAgent('agent-e2e', 'claude');
    const env = agentEnv({ CLAUDE_AGENT_ID: agent.id, CLAUDE_MGR_API_TOKEN: mintAgentToken(agent.id), CLAUDE_PROJECT_PATH: tmp });

    const start = await shell.run(commandFor(claudeHooks, 'SessionStart'), env, JSON.stringify({ session_id: S1, cwd: tmp, source: 'startup', hook_event_name: 'SessionStart' }));
    expect(start.status, start.stderr).toBe(0);
    expect(JSON.parse(start.stdout)).toHaveProperty('continue', true);
    expect(agents.get(agent.id)?.currentSessionId).toBe(S1);
    expect(agents.get(agent.id)?.status).toBe('idle');

    const prompt = await shell.run(commandFor(claudeHooks, 'UserPromptSubmit'), env, JSON.stringify({ session_id: S1, prompt: 'rebase onto main' }));
    expect(prompt.status, prompt.stderr).toBe(0);
    expect(agents.get(agent.id)?.status).toBe('running');
    expect(agents.get(agent.id)?.currentTask).toBe('rebase onto main\n');

    const stop = await shell.run(commandFor(claudeHooks, 'Stop'), env, JSON.stringify({ session_id: S1, last_assistant_message: 'Rebased, 3 commits.' }));
    expect(stop.status, stop.stderr).toBe(0);
    expect(agents.get(agent.id)?.status).not.toBe('running');
    expect(agents.get(agent.id)?.lastCleanOutput).toBe('Rebased, 3 commits.');
  }, 60_000);

  it('changes nothing with another agent\'s token', async () => {
    const agent = putAgent('agent-e2e', 'claude');
    putAgent('intruder', 'claude');
    const env = agentEnv({ CLAUDE_AGENT_ID: agent.id, CLAUDE_MGR_API_TOKEN: mintAgentToken('intruder') });
    const start = await shell.run(commandFor(claudeHooks, 'SessionStart'), env, JSON.stringify({ session_id: S1, cwd: tmp }));
    expect(start.status).toBe(0);
    expect(agents.get(agent.id)?.currentSessionId).toBeUndefined();
  }, 60_000);
});

describe('Gemini hooks through PowerShell (the shell Gemini CLI uses on Windows)', () => {
  const ps = shells().find(s => s.name === 'powershell') ?? shells()[0];

  it('SessionStart registers, BeforeAgent runs, AfterAgent ends the turn: idle (it said waiting, a turn still asking, until 2.0.4)', async () => {
    const agent = putAgent('gem-e2e', 'gemini');
    const env = agentEnv({ DOROTHY_AGENT_ID: agent.id, CLAUDE_AGENT_ID: agent.id, CLAUDE_MGR_API_TOKEN: mintAgentToken(agent.id), DOROTHY_PROJECT_PATH: tmp });

    expect((await ps.run(commandFor(geminiHooks, 'SessionStart'), env, JSON.stringify({ session_id: S2, cwd: tmp }))).status).toBe(0);
    expect(agents.get(agent.id)?.currentSessionId).toBe(S2);

    expect((await ps.run(commandFor(geminiHooks, 'BeforeAgent'), env, JSON.stringify({ session_id: S2, prompt: 'go' }))).status).toBe(0);
    expect(agents.get(agent.id)?.status).toBe('running');

    expect((await ps.run(commandFor(geminiHooks, 'AfterAgent'), env, JSON.stringify({ session_id: S2 }))).status).toBe(0);
    expect(agents.get(agent.id)?.status).toBe('idle');
  }, 60_000);
});
