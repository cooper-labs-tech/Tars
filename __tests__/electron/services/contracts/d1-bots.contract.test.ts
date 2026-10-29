import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The Telegram and Slack bots, as they answer before the D1 refactor.
 *
 * Recorded first, on main, before any line of the bots moves (refacto-rules: a
 * group's first commit snapshots its contracts, its last proves them
 * byte-identical). What is recorded is what crosses the bots' edges, so that it
 * holds whatever shape the code takes behind them:
 * - every reply each bot sends, to whom, with its options, per command and flow;
 * - every keystroke typed into an agent's terminal (a message, or a launch
 *   command line);
 * - the settings each bot writes (/auth, the Slack channel it answers from);
 * - who may command it (#137): Telegram's authorized chats and /auth, Slack's
 *   allowed users, answered and refused.
 *
 * The bots, the provider builders, initAgentPty, spawnAgentPty and the writer
 * are the real ones. Faked: node-pty, Slack's SDK, the window, and Claude's
 * usage stats. Paths are written relative to the sandbox HOME and the
 * repo, and numbers in en-US, so the snapshot is the same on every machine.
 *
 * (Telegram's cases went with Tars's own Telegram bot in 2.0.5, and their
 * snapshots with them; the three that set the two bots side by side keep their
 * Slack half. Slack's snapshots are byte-identical to the ones recorded before
 * D1: each still records an empty `telegram`.)
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-d1-contract-${process.pid}-${Date.now()}`),
}));

type FakePty = {
  pid: number; process: string; write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn>; say: (data: string) => void;
};
const spawned = vi.hoisted(() => [] as FakePty[]);
type Handler = (...args: unknown[]) => unknown;
/** Faults a scenario can switch on: terminals that fail to open. */
const faults = vi.hoisted(() => ({ spawn: 0 }));
const sl = vi.hoisted(() => ({
  events: new Map<string, Handler>(),
  message: null as Handler | null,
  posted: [] as unknown[],
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string): FakePty => {
    if (faults.spawn > 0) {
      faults.spawn--;
      throw new Error('no terminal in the contract');
    }
    const listeners: Array<(data: string) => void> = [];
    const terminal: FakePty = {
      pid: 7000 + spawned.length, process: file, write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onExit: vi.fn(),
      onData: vi.fn((listener: (data: string) => void) => { listeners.push(listener); return { dispose() {} }; }),
      say: (data: string) => { for (const listener of listeners) listener(data); },
    };
    spawned.push(terminal);
    setTimeout(() => terminal.say('bash-3.2$ '), 20);
    return terminal;
  }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.8.0' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('../../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));
vi.mock('@slack/bolt', () => ({
  LogLevel: { DEBUG: 'debug', INFO: 'info' },
  App: class {
    client = { chat: { postMessage: (m: unknown) => { sl.posted.push(m); return Promise.resolve({}); } } };
    event(name: string, handler: Handler) { sl.events.set(name, handler); }
    message(handler: Handler) { sl.message = handler; }
    use() {}
    start() { return Promise.resolve(); }
    stop() { return Promise.resolve(); }
  },
}));
import { agents } from '../../../../electron/core/agent-manager';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';
import { resetLaunches } from '../../../../electron/core/agent-launch';
import { ptyProcesses, writeHumanInput, terminalExited } from '../../../../electron/core/pty-manager';
import { transcriptPath, resetResumeTracking } from '../../../../electron/utils/resume-session';
import { initSlackBot, stopSlackBot, setGetClaudeStatsRef, sendSlackMessage } from '../../../../electron/services/slack-bot';
import type { AgentStatus, AppSettings } from '../../../../electron/types';
import { withLaunchScripts } from '../../../setup/launch-script';

// The launch these hold is darwin and linux's: a line typed into the shell, or
// `bash -l -c`. On a Windows host they read it as linux; the win32 launch (the
// CLI as the terminal's process) is held by launch-call-sites.test.ts and
// agent-terminal-win32.test.ts.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });


// ── The fleet and the settings every scenario starts from ─────────────────

// Joined the way the linux this file pins spells a path. On a Windows host
// path.join writes a backslash, which a linux reader of the path keeps as part
// of a folder name; darwin and linux get the same string either way.
const P1 = path.posix.join(tmpHome, 'projects', 'atlas');
const P2 = path.posix.join(tmpHome, 'projects', 'orion');

function baseSettings(): AppSettings {
  return {
    slackEnabled: true, slackBotToken: 'xoxb-test', slackAppToken: 'xapp-test', slackAllowedUserIds: ['U1'], slackChannelId: 'C0',
    cliPaths: { claude: '/opt/tars-contract/bin/claude' },
  } as unknown as AppSettings;
}
let settings = baseSettings();
const saved: unknown[] = [];

const STATS = {
  modelUsage: {
    'claude-opus-4-5-20251101': { inputTokens: 1_200_000, outputTokens: 310_000, cacheReadInputTokens: 5_400_000, cacheCreationInputTokens: 220_000 },
    'claude-sonnet-4-5': { inputTokens: 800_000, outputTokens: 150_000, cacheReadInputTokens: 2_000_000, cacheCreationInputTokens: 90_000 },
    'claude-haiku-4-5': { inputTokens: 300_000, outputTokens: 40_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    'claude-opus-4-1': { inputTokens: 100_000, outputTokens: 20_000, cacheReadInputTokens: 10_000, cacheCreationInputTokens: 5_000 },
    'mystery-model-x': { inputTokens: 5_000, outputTokens: 1_000 },
  },
  totalSessions: 42,
  totalMessages: 1234,
};
let stats: typeof STATS | null = STATS;

function seedFleet(): void {
  const now = new Date().toISOString();
  const base = { provider: 'claude', skills: [], output: [], lastActivity: now, permissionMode: 'bypass', model: 'claude-opus-5-5', effort: 'medium' };
  const fleet: Array<Partial<AgentStatus>> = [
    { id: 'agent-orch', name: 'Lead', role: 'orchestrator', status: 'running', projectPath: P1, currentTask: 'Plan the release', skills: ['planning'] },
    { id: 'agent-dune', name: 'Dune', role: 'worker', status: 'running', projectPath: P1, character: 'robot',
      currentTask: 'Rebase onto main and fix the conflicts in the settings page', skills: ['react', 'typescript', 'testing'] },
    { id: 'agent-dove', name: 'Dove', role: 'worker', status: 'waiting', projectPath: P1, character: 'ninja' },
    { id: 'agent-rest', name: 'Rest', role: 'worker', status: 'idle', projectPath: P2, character: 'frog' },
    { id: 'agent-err', name: 'Err', role: 'worker', status: 'error', projectPath: P2, character: 'viking' },
    { id: 'agent-done', name: 'Done', role: 'worker', status: 'completed', projectPath: P2 },
  ];
  for (const f of fleet) agents.set(f.id!, { ...base, ...f } as AgentStatus);
}

/** A terminal where the CLI already runs: a message goes in as a message. */
function liveCli(agentId: string): FakePty {
  const agent = agents.get(agentId)!;
  const terminal = spawnAgentPty({
    binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: agent.projectPath, cols: 120, rows: 30,
    env: { CLAUDE_AGENT_ID: agentId },
  }) as unknown as FakePty;
  terminal.process = '2.1.280';
  ptyProcesses.set(`pty-${agentId}`, terminal as never);
  agent.ptyId = `pty-${agentId}`;
  (agent as { ptyCwd?: string }).ptyCwd = agent.projectPath;
  return terminal;
}

// ── Driving the bots the way their SDKs do ────────────────────────────────

const settle = () => new Promise(resolve => setTimeout(resolve, 450));

const said: Array<{ in: string; text: string }> = [];
const say = (where: string) => async (text: string) => { said.push({ in: where, text }); };
async function slackMention(user: string, text: string, channel = 'C1'): Promise<void> {
  await sl.events.get('app_mention')!({ event: { user, text: `<@UBOT> ${text}`, channel, ts: '1700000000.000100' }, say: say(channel) });
  await settle();
}
async function slackMessage(user: string, text: string, channelType: 'im' | 'channel' = 'im', channel = 'D1'): Promise<void> {
  await sl.message!({ message: { user, text, channel, channel_type: channelType, ts: '1700000000.000200' }, say: say(channel) });
  await settle();
}

// ── What a scenario did, the same on every machine ────────────────────────

function normalize(value: unknown): unknown {
  const repo = process.cwd();
  return JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'string'
    ? posixUnder(posixUnder(v.split(tmpHome).join('<HOME>').split(repo).join('<REPO>'), '<HOME>'), '<REPO>')
    : v));
}

/**
 * A path under `root` spelled with `/`, as the snapshot was recorded on macOS.
 * The fixture's paths are joined that way already (see P1), but what the
 * product joins itself, ~/.tars for one, comes out of Node's own path
 * module, which on a Windows host writes `\` whatever platform the file pins.
 * Only the run of path characters right after the root, so a shell quote's
 * own `\` stays as it is.
 */
function posixUnder(text: string, root: string): string {
  if (path.sep === '/') return text;
  return text.replace(new RegExp(`${root}(?:[\\\\/][^\\\\/\\s\`'"*|]+)+`, 'g'), found => found.split('\\').join('/'));
}

function outcome() {
  return normalize({
    // Tars's own Telegram bot is gone (2.0.5): kept empty, as every Slack case recorded it.
    telegram: [],
    slack: said.splice(0),
    slackPosted: sl.posted.splice(0),
    typed: spawned.map((t, i) => ({ terminal: i, text: withLaunchScripts(t.write.mock.calls.map(c => String(c[0])).join('')) })).filter(t => t.text),
    saved: saved.splice(0),
    fleet: [...agents.values()].map(a => ({ id: a.id, status: a.status, currentTask: a.currentTask ?? null })),
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────

let restoreLocale: () => void;
beforeAll(() => {
  const original = Number.prototype.toLocaleString;
  // Numbers in en-US whatever the machine's locale: the snapshot is the same everywhere.
  Number.prototype.toLocaleString = function (this: number, locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
    return original.call(this, locales ?? 'en-US', options);
  };
  restoreLocale = () => { Number.prototype.toLocaleString = original; };
  return () => restoreLocale();
});

beforeEach(() => {
  resetLaunches();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(P1, { recursive: true });
  fs.mkdirSync(P2, { recursive: true });
  agents.clear();
  ptyProcesses.clear();
  spawned.length = 0;
  faults.spawn = 0;
  sl.events.clear(); sl.message = null; sl.posted.length = 0;
  said.length = 0; saved.length = 0;
  settings = baseSettings();
  stats = STATS;
  seedFleet();
  setGetClaudeStatsRef(async () => stats ?? undefined);
  initSlackBot(() => settings, s => { saved.push({ slackChannelId: s.slackChannelId }); }, null);
});

afterEach(() => {
  stopSlackBot();
});

/**
 * The cases that resume a conversation read its transcript under Claude's
 * folder for the project, named as darwin and linux name it (resume-session.ts:
 * `/` and `.` to `-`). This file runs as linux on any host; on a Windows
 * host the project is a Windows path, whose `:` and `\` no folder name can
 * hold, so the transcript those cases resume from has nowhere to go. They run
 * on macOS and Linux; the Windows name is held by resume-session.test.ts.
 */
const NO_POSIX_TRANSCRIPT_FOLDER = process.platform === 'win32';

// ── Slack ─────────────────────────────────────────────────────────────────

describe('Slack, as recorded before D1', () => {
  it('help, and the channel it answers from saved', async () => {
    await slackMention('U1', 'help');
    await slackMention('U1', '');
    expect(outcome()).toMatchSnapshot();
  });

  it('status, agents and projects on a fleet of six', async () => {
    await slackMention('U1', 'status');
    await slackMention('U1', 'agents');
    await slackMention('U1', 'projects');
    expect(outcome()).toMatchSnapshot();
  });

  it('status, agents and projects on an empty fleet', async () => {
    agents.clear();
    await slackMention('U1', 'status');
    await slackMention('U1', 'agents');
    await slackMention('U1', 'projects');
    expect(outcome()).toMatchSnapshot();
  });

  it('usage, with stats and without', async () => {
    await slackMention('U1', 'usage');
    stats = null;
    await slackMention('U1', 'usage');
    expect(outcome()).toMatchSnapshot();
  });

  it('start: no task, unknown, already running', async () => {
    await slackMention('U1', 'start rest');
    await slackMention('U1', 'start nobody Do something');
    await slackMention('U1', 'start dune Do something');
    expect(outcome()).toMatchSnapshot();
  });

  it('start: an agent whose CLI is up gets the task as a message', async () => {
    liveCli('agent-rest');
    await slackMention('U1', 'start rest Measure the Usage page');
    expect(outcome()).toMatchSnapshot();
  });

  it('start: a cold start types the launch command', async () => {
    await slackMention('U1', 'start rest Measure the Usage page');
    expect(outcome()).toMatchSnapshot();
  });

  it('stop: running, not running, unknown', async () => {
    liveCli('agent-dune');
    await slackMention('U1', 'stop dune');
    await slackMention('U1', 'stop rest');
    await slackMention('U1', 'stop nobody');
    expect(outcome()).toMatchSnapshot();
  });

  it('a mention and a direct message go to the orchestrator whose CLI is up', async () => {
    liveCli('agent-orch');
    await slackMention('U1', 'what is everyone doing?');
    await slackMessage('U1', 'plan tomorrow\nplease');
    expect(outcome()).toMatchSnapshot();
  });

  it('a message cold-starts the orchestrator when its CLI is not up', async () => {
    await slackMessage('U1', 'what is everyone doing?');
    expect(outcome()).toMatchSnapshot();
  });

  it('a message with no orchestrator in the fleet', async () => {
    agents.delete('agent-orch');
    await slackMessage('U1', 'anyone there?');
    expect(outcome()).toMatchSnapshot();
  });

  it('who may command: a mention and a direct message from users not allowed, and a channel message', async () => {
    await slackMention('U9', 'status');
    await slackMessage('U9', 'hello', 'im');
    await slackMessage('U9', 'hello', 'channel', 'C2');
    await slackMention('U9', 'status', 'C3');
    expect(outcome()).toMatchSnapshot();
  });

  it('what Tars sends on its own, cut at 3900 characters', async () => {
    await sendSlackMessage('A notice from Tars.', settings);
    await sendSlackMessage('y'.repeat(4000), settings, 'C7');
    expect(outcome()).toMatchSnapshot();
  });
});

// ── What sets the two bots apart ──────────────────────────────────────────
//
// Added before the refactor too, and recorded on the same code: where the two
// bots' copies of a flow differed, the shared flow takes a parameter, and each
// difference is pinned here so that a parameter given to the wrong bot shows.

const WORKER_SESSION = '0b7f3c1e-5d2a-4e8b-9c6f-1a2b3c4d5e6f';
const ORCHESTRATOR_SESSION = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';

/**
 * A conversation Claude Code could resume: its id on the agent, its transcript
 * on disk, and this the agent's first start in the run (a later one starts a
 * new conversation, and earlier scenarios started every agent already).
 */
function resumable(agentId: string, sessionId: string): void {
  resetResumeTracking();
  const agent = agents.get(agentId)!;
  agent.resumableSessionId = sessionId;
  const transcript = transcriptPath(agent.projectPath, sessionId);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '{"type":"user"}\n');
}

/** A worker with a conversation to resume, a permission mode of its own, in a worktree whose path has a quote. */
function workerWithHistory(): void {
  const rest = agents.get('agent-rest')!;
  rest.worktreePath = path.posix.join(tmpHome, 'projects', "o'rion-wt");
  fs.mkdirSync(rest.worktreePath, { recursive: true });
  rest.permissionMode = 'auto';
  resumable('agent-rest', WORKER_SESSION);
}

/** The orchestrator with a conversation to resume and a permission mode that is not bypass. */
function orchestratorWithHistory(): void {
  agents.get('agent-orch')!.permissionMode = 'normal';
  resumable('agent-orch', ORCHESTRATOR_SESSION);
}

/** A second terminal whose process has exited: whatever is written to it is refused. */
function goneCli(agentId: string): void {
  const terminal = liveCli(agentId);
  writeHumanInput(terminal as never, 'b');
  terminalExited(terminal as never);
}

describe('What sets the two bots apart, recorded before D1', () => {
  it('the orchestrator last in the fleet: Slack lists it in fleet order', async () => {
    const orch = agents.get('agent-orch')!;
    agents.delete('agent-orch');
    agents.set('agent-orch', orch);
    await slackMention('U1', 'status');
    expect(outcome()).toMatchSnapshot();
  });

  it.skipIf(NO_POSIX_TRANSCRIPT_FOLDER)('Slack: a worker cold-started begins a new conversation, in its own mode, from its worktree', async () => {
    workerWithHistory();
    await slackMention('U1', 'start rest Measure the Usage page');
    expect(outcome()).toMatchSnapshot();
  });

  it.skipIf(NO_POSIX_TRANSCRIPT_FOLDER)('Slack: the orchestrator cold-started by a message begins a new conversation, in its own mode', async () => {
    orchestratorWithHistory();
    await slackMessage('U1', 'what is everyone doing?');
    expect(outcome()).toMatchSnapshot();
  });

  it('Slack: start on the orchestrator itself starts it with its instructions', async () => {
    agents.get('agent-orch')!.status = 'idle';
    await slackMention('U1', 'start lead Plan the release');
    expect(outcome()).toMatchSnapshot();
  });

  it('Slack: a task held while somebody types, and one refused by a terminal that exited', async () => {
    const terminal = liveCli('agent-rest');
    writeHumanInput(terminal as never, 'a');
    goneCli('agent-err');
    await slackMention('U1', 'start rest Measure the Usage page');
    await slackMention('U1', 'start err Read the logs');
    terminalExited(terminal as never);
    expect(outcome()).toMatchSnapshot();
  });
});

// ── Files, launches that fail, and replies that fail ──────────────────────

describe('Files, launches and replies that fail, recorded before D1', () => {
  it('Slack: a terminal that fails to open is said, and the launch given up, so the next try starts at once', async () => {
    faults.spawn = 1;
    await slackMention('U1', 'start rest Measure the Usage page');
    await slackMention('U1', 'start rest Measure the Usage page');
    faults.spawn = 1;
    await slackMessage('U1', 'what is everyone doing?');
    await slackMessage('U1', 'what is everyone doing?');
    expect(outcome()).toMatchSnapshot();
  });

  it('Slack: a reply that fails to post fails the start, and gives the launch up', async () => {
    let failed = false;
    const flaky = (where: string) => async (text: string) => {
      if (!failed && text.startsWith(':rocket:')) {
        failed = true;
        throw new Error('slack is down');
      }
      said.push({ in: where, text });
    };
    await sl.events.get('app_mention')!({ event: { user: 'U1', text: '<@UBOT> start rest Measure the Usage page', channel: 'C1', ts: '1700000000.000300' }, say: flaky('C1') });
    await settle();
    // Given up: the next start does not wait for a launch that told nobody it began.
    agents.get('agent-rest')!.status = 'idle';
    await slackMention('U1', 'start rest Measure the Usage page');
    expect(outcome()).toMatchSnapshot();
  });
});
