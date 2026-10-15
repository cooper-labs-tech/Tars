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
 * are the real ones. Faked: node-pty, the two chat SDKs (dispatching an update
 * the way node-telegram-bot-api's processUpdate does: `message`, then the
 * message's type, then every onText that matches, none awaited), the window, and
 * Claude's usage stats. Paths are written relative to the sandbox HOME and the
 * repo, and numbers in en-US, so the snapshot is the same on every machine.
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
const tg = vi.hoisted(() => ({
  texts: [] as Array<{ pattern: RegExp; handler: Handler }>,
  on: new Map<string, Handler[]>(),
  sent: [] as Array<{ to: string; text: string; opts?: unknown }>,
  downloads: [] as string[],
}));
/** Faults a scenario can switch on: terminals that fail to open, and Telegram files that download. */
const faults = vi.hoisted(() => ({ spawn: 0, files: false }));
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
vi.mock('https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('https')>();
  const { PassThrough } = await import('node:stream');
  const get = (url: string, callback: (response: unknown) => void) => {
    tg.downloads.push(String(url));
    const response = Object.assign(new PassThrough(), { statusCode: 200 });
    setImmediate(() => { callback(response); response.end('contract bytes'); });
    return { on() { return this; } };
  };
  return { ...actual, get, default: { ...actual, get } };
});
vi.mock('node-telegram-bot-api', () => ({
  default: class {
    on(event: string, handler: Handler) { tg.on.set(event, [...(tg.on.get(event) ?? []), handler]); }
    onText(pattern: RegExp, handler: Handler) { tg.texts.push({ pattern, handler }); }
    getMe() { return Promise.resolve({ username: 'tars_test_bot' }); }
    getFile(fileId: string) {
      return faults.files
        ? Promise.resolve({ file_id: fileId, file_path: `files/${fileId}.bin` })
        : Promise.reject(new Error('no file in the contract'));
    }
    sendMessage(chatId: unknown, text: string, opts?: unknown) {
      tg.sent.push({ to: String(chatId), text, ...(opts === undefined ? {} : { opts }) });
      return Promise.resolve({});
    }
    stopPolling() { return Promise.resolve(); }
  },
}));

import { agents, initAgentPty } from '../../../../electron/core/agent-manager';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';
import { resetLaunches } from '../../../../electron/core/agent-launch';
import { ptyProcesses, writeHumanInput, terminalExited } from '../../../../electron/core/pty-manager';
import { transcriptPath, resetResumeTracking } from '../../../../electron/utils/resume-session';
import { initTelegramBotService, initTelegramBot, stopTelegramBot, sendTelegramMessage, sendSuperAgentResponseToTelegram } from '../../../../electron/services/telegram-bot';
import { initSlackBot, stopSlackBot, setGetClaudeStatsRef, sendSlackMessage } from '../../../../electron/services/slack-bot';
import { getSuperAgent } from '../../../../electron/utils';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

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
    telegramEnabled: true, telegramBotToken: 'tg-bot-token', telegramAuthToken: 'tg-auth-token',
    telegramAuthorizedChatIds: ['42'], telegramChatId: '42', telegramRequireMention: true,
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

/** The order of node-telegram-bot-api's messageTypes, for the types these bots listen to. */
const MESSAGE_TYPES = ['text', 'audio', 'document', 'photo', 'video', 'voice'];

async function telegram(msg: Record<string, unknown>): Promise<void> {
  const pending: unknown[] = [];
  const type = MESSAGE_TYPES.find(t => msg[t] !== undefined);
  for (const h of tg.on.get('message') ?? []) pending.push(h(msg, { type }));
  if (type) for (const h of tg.on.get(type) ?? []) pending.push(h(msg, { type }));
  if (typeof msg.text === 'string') {
    for (const r of tg.texts) {
      const m = r.pattern.exec(msg.text);
      if (!m) continue;
      r.pattern.lastIndex = 0;
      pending.push(r.handler(msg, m));
    }
  }
  await Promise.all(pending);
  await settle();
}
const dm = (text: string, chat = 42) => ({ message_id: 7, chat: { id: chat, type: 'private' }, text });

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
 * product joins itself, ~/.dorothy for one, comes out of Node's own path
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
    telegram: tg.sent.splice(0),
    slack: said.splice(0),
    slackPosted: sl.posted.splice(0),
    typed: spawned.map((t, i) => ({ terminal: i, text: t.write.mock.calls.map(c => String(c[0])).join('') })).filter(t => t.text),
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
  tg.texts.length = 0; tg.on.clear(); tg.sent.length = 0; tg.downloads.length = 0;
  faults.spawn = 0; faults.files = false;
  sl.events.clear(); sl.message = null; sl.posted.length = 0;
  said.length = 0; saved.length = 0;
  settings = baseSettings();
  stats = STATS;
  seedFleet();
  initTelegramBotService(
    agents, ptyProcesses, () => settings, null,
    () => getSuperAgent(agents), () => {}, async () => stats,
    (a: AgentStatus) => initAgentPty(a, null, vi.fn(), vi.fn()),
    (s: AppSettings) => { saved.push({ telegramAuthorizedChatIds: s.telegramAuthorizedChatIds, telegramChatId: s.telegramChatId }); },
  );
  initTelegramBot();
  setGetClaudeStatsRef(async () => stats ?? undefined);
  initSlackBot(() => settings, s => { saved.push({ slackChannelId: s.slackChannelId }); }, null);
});

afterEach(() => {
  stopTelegramBot();
  stopSlackBot();
});

// ── Telegram ──────────────────────────────────────────────────────────────

/**
 * The cases that resume a conversation read its transcript under Claude's
 * folder for the project, named as darwin and linux name it (resume-session.ts:
 * `/` and `.` to `-`). This file runs as linux on any host; on a Windows
 * host the project is a Windows path, whose `:` and `\` no folder name can
 * hold, so the transcript those cases resume from has nowhere to go. They run
 * on macOS and Linux; the Windows name is held by resume-session.test.ts.
 */
const NO_POSIX_TRANSCRIPT_FOLDER = process.platform === 'win32';

describe('Telegram, as recorded before D1', () => {
  it('/start and /help', async () => {
    await telegram(dm('/start'));
    await telegram(dm('/help'));
    expect(outcome()).toMatchSnapshot();
  });

  it('/status, /agents and /projects on a fleet of six', async () => {
    await telegram(dm('/status'));
    await telegram(dm('/agents'));
    await telegram(dm('/projects'));
    expect(outcome()).toMatchSnapshot();
  });

  it('/status, /agents and /projects on an empty fleet', async () => {
    agents.clear();
    await telegram(dm('/status'));
    await telegram(dm('/agents'));
    await telegram(dm('/projects'));
    expect(outcome()).toMatchSnapshot();
  });

  it('/usage, with stats and without', async () => {
    await telegram(dm('/usage'));
    stats = null;
    await telegram(dm('/usage'));
    expect(outcome()).toMatchSnapshot();
  });

  it('/start_agent: no task, unknown, already running', async () => {
    await telegram(dm('/start_agent rest'));
    await telegram(dm('/start_agent nobody Do something'));
    await telegram(dm('/start_agent dune Do something'));
    expect(outcome()).toMatchSnapshot();
  });

  it('/start_agent: an agent whose CLI is up gets the task as a message', async () => {
    liveCli('agent-rest');
    await telegram(dm('/start_agent rest Measure the Usage page'));
    expect(outcome()).toMatchSnapshot();
  });

  it('/start_agent: a cold start types the launch command', async () => {
    await telegram(dm('/start_agent rest Measure the Usage page'));
    expect(outcome()).toMatchSnapshot();
  });

  it('/stop_agent: running, not running, unknown', async () => {
    liveCli('agent-dune');
    await telegram(dm('/stop_agent dune'));
    await telegram(dm('/stop_agent rest'));
    await telegram(dm('/stop_agent nobody'));
    expect(outcome()).toMatchSnapshot();
  });

  it('a message and /ask go to the orchestrator whose CLI is up', async () => {
    liveCli('agent-orch');
    await telegram(dm('what is everyone doing?'));
    await telegram(dm('/ask plan tomorrow'));
    expect(outcome()).toMatchSnapshot();
  });

  it('a message cold-starts the orchestrator when its CLI is not up', async () => {
    await telegram(dm('what is everyone doing?'));
    expect(outcome()).toMatchSnapshot();
  });

  it('a message with no orchestrator in the fleet', async () => {
    agents.delete('agent-orch');
    await telegram(dm('anyone there?'));
    expect(outcome()).toMatchSnapshot();
  });

  it('in a group: without a mention nothing, with one the message without it', async () => {
    liveCli('agent-orch');
    await telegram({ message_id: 8, chat: { id: 42, type: 'group' }, text: 'just chatting' });
    await telegram({ message_id: 9, chat: { id: 42, type: 'group' }, text: '@tars_test_bot status of the release?' });
    expect(outcome()).toMatchSnapshot();
  });

  it('files: a photo, a document, a video, an audio and a voice message', async () => {
    await telegram({ message_id: 10, chat: { id: 42, type: 'private' }, photo: [{ file_id: 'p-small' }, { file_id: 'p-large' }], caption: 'what is this?' });
    await telegram({ message_id: 11, chat: { id: 42, type: 'private' }, document: { file_id: 'd1', file_name: 'report.pdf', mime_type: 'application/pdf' } });
    await telegram({ message_id: 12, chat: { id: 42, type: 'private' }, video: { file_id: 'v1' } });
    await telegram({ message_id: 13, chat: { id: 42, type: 'private' }, audio: { file_id: 'a1' } });
    await telegram({ message_id: 14, chat: { id: 42, type: 'private' }, voice: { file_id: 'o1' } });
    expect(outcome()).toMatchSnapshot();
  });

  it('who may command: an unknown chat, then /auth wrong and right', async () => {
    await telegram(dm('/status', 99));
    await telegram(dm('hello', 99));
    await telegram(dm('/auth wrong-token', 99));
    await telegram(dm('/auth tg-auth-token', 99));
    await telegram(dm('/status', 99));
    expect(outcome()).toMatchSnapshot();
  });

  it("the orchestrator's answer, sent back to the chat that asked, with every way it is read", async () => {
    liveCli('agent-orch');
    await telegram(dm('what is everyone doing?'));
    const orch = agents.get('agent-orch')!;
    // After a tool result: the lines that follow it, without the TUI's own.
    orch.output = ['\x1b[1m● \x1b[0mcalling list_agents\n', '  ⎿  (MCP) 6 agents\n', 'Dune is rebasing onto main.\n', 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n', 'Dove waits on a question from you.\n'];
    sendSuperAgentResponseToTelegram(orch);
    // No tool result: the last long lines.
    orch.output = ['● thinking\n', 'Nothing is running right now, everyone is idle.\n'];
    sendSuperAgentResponseToTelegram(orch);
    // Nothing worth reading.
    orch.output = ['● \n', 'ok\n'];
    sendSuperAgentResponseToTelegram(orch);
    await settle();
    expect(outcome()).toMatchSnapshot();
  });

  it('what Tars sends on its own: to the authorized chats, cut at 4000 characters', async () => {
    sendTelegramMessage('A notice from Tars.');
    sendTelegramMessage('x'.repeat(4100));
    await settle();
    expect(outcome()).toMatchSnapshot();
  });
});

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
  it('the orchestrator last in the fleet: Telegram lists it first in its group, Slack in fleet order', async () => {
    const orch = agents.get('agent-orch')!;
    agents.delete('agent-orch');
    agents.set('agent-orch', orch);
    await telegram(dm('/status'));
    await slackMention('U1', 'status');
    expect(outcome()).toMatchSnapshot();
  });

  it.skipIf(NO_POSIX_TRANSCRIPT_FOLDER)('Telegram: a worker cold-started resumes its conversation, in its own mode, from its worktree', async () => {
    workerWithHistory();
    await telegram(dm('/start_agent rest Measure the Usage page'));
    expect(outcome()).toMatchSnapshot();
  });

  it.skipIf(NO_POSIX_TRANSCRIPT_FOLDER)('Slack: a worker cold-started begins a new conversation, in its own mode, from its worktree, and leaves the old one to resume', async () => {
    workerWithHistory();
    await slackMention('U1', 'start rest Measure the Usage page');
    // Slack did not take the conversation: the next start, from Telegram, still resumes it.
    agents.get('agent-rest')!.status = 'idle';
    resetLaunches();
    await telegram(dm('/start_agent rest Measure the Usage page'));
    expect(outcome()).toMatchSnapshot();
  });

  it.skipIf(NO_POSIX_TRANSCRIPT_FOLDER)('Telegram: the orchestrator cold-started by a message resumes its conversation, in bypass', async () => {
    orchestratorWithHistory();
    await telegram(dm('what is everyone doing?'));
    expect(outcome()).toMatchSnapshot();
  });

  it.skipIf(NO_POSIX_TRANSCRIPT_FOLDER)('Slack: the orchestrator cold-started by a message begins a new conversation, in its own mode, and leaves the old one to resume', async () => {
    orchestratorWithHistory();
    await slackMessage('U1', 'what is everyone doing?');
    // No CLI came up in its terminal: the next message, from Telegram, starts it again and resumes.
    resetLaunches();
    await telegram(dm('what is everyone doing?'));
    expect(outcome()).toMatchSnapshot();
  });

  it('Telegram: /start_agent on the orchestrator itself starts it with its instructions', async () => {
    agents.get('agent-orch')!.status = 'idle';
    await telegram(dm('/start_agent lead Plan the release'));
    expect(outcome()).toMatchSnapshot();
  });

  it('Slack: start on the orchestrator itself starts it with its instructions', async () => {
    agents.get('agent-orch')!.status = 'idle';
    await slackMention('U1', 'start lead Plan the release');
    expect(outcome()).toMatchSnapshot();
  });

  it('Telegram: a task held while somebody types, and one refused by a terminal that exited', async () => {
    const terminal = liveCli('agent-rest');
    writeHumanInput(terminal as never, 'a');
    goneCli('agent-err');
    await telegram(dm('/start_agent rest Measure the Usage page'));
    await telegram(dm('/start_agent err Read the logs'));
    // The held task would go in once the typing pauses: dropped here, so that
    // nothing of this scenario is written after it.
    terminalExited(terminal as never);
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

/** A downloaded file is named after the time it came in: the same on every run once that is taken out. */
const untimed = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/\/\d{13}-/g, '/<TIME>-'));

/** Telegram's service again, with another way to open a terminal. */
function telegramService(open: (a: AgentStatus) => Promise<string>): void {
  initTelegramBotService(
    agents, ptyProcesses, () => settings, null,
    () => getSuperAgent(agents), () => {}, async () => stats, open,
    (s: AppSettings) => { saved.push({ telegramAuthorizedChatIds: s.telegramAuthorizedChatIds, telegramChatId: s.telegramChatId }); },
  );
}

describe('Files, launches and replies that fail, recorded before D1', () => {
  it('Telegram: files downloaded, each handed to the orchestrator with what it is', async () => {
    faults.files = true;
    liveCli('agent-orch');
    await telegram({ message_id: 20, chat: { id: 42, type: 'private' }, photo: [{ file_id: 'p-small' }, { file_id: 'p-large' }], caption: '@tars_test_bot what is this?' });
    await telegram({ message_id: 21, chat: { id: 42, type: 'private' }, document: { file_id: 'd1', file_name: 'report.pdf', mime_type: 'application/pdf' } });
    await telegram({ message_id: 22, chat: { id: 42, type: 'private' }, video: { file_id: 'v1' }, caption: 'the demo' });
    await telegram({ message_id: 23, chat: { id: 42, type: 'private' }, audio: { file_id: 'a1', file_name: 'memo.m4a' } });
    await telegram({ message_id: 24, chat: { id: 42, type: 'private' }, voice: { file_id: 'o1' } });
    const seen = untimed({ ...outcome(), downloads: tg.downloads.splice(0) });
    // The orchestrator's task is its message cut at 100 characters, and where the
    // cut falls in the file's path depends on the machine's temporary folder.
    seen.fleet = seen.fleet.map((a: { currentTask: string | null }) => ({ ...a, currentTask: a.currentTask?.split(' saved to: ')[0] ?? null }));
    expect(seen).toMatchSnapshot();
  });

  it('Telegram: a terminal that fails to open is said, and the launch given up, so the next try starts at once', async () => {
    faults.spawn = 1;
    await telegram(dm('/start_agent rest Measure the Usage page'));
    await telegram(dm('/start_agent rest Measure the Usage page'));
    faults.spawn = 1;
    await telegram(dm('what is everyone doing?'));
    await telegram(dm('what is everyone doing?'));
    expect(outcome()).toMatchSnapshot();
  });

  it('Slack: a terminal that fails to open is said, and the launch given up, so the next try starts at once', async () => {
    faults.spawn = 1;
    await slackMention('U1', 'start rest Measure the Usage page');
    await slackMention('U1', 'start rest Measure the Usage page');
    faults.spawn = 1;
    await slackMessage('U1', 'what is everyone doing?');
    await slackMessage('U1', 'what is everyone doing?');
    expect(outcome()).toMatchSnapshot();
  });

  it('Telegram: an agent given no terminal is told so, and the launch given up', async () => {
    telegramService(async () => 'pty-nowhere');
    await telegram(dm('/start_agent rest Measure the Usage page'));
    await telegram(dm('what is everyone doing?'));
    telegramService((a: AgentStatus) => initAgentPty(a, null, vi.fn(), vi.fn()));
    await telegram(dm('/start_agent rest Measure the Usage page'));
    await telegram(dm('what is everyone doing?'));
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

// ── A chat removed mid-flight, and /auth again and again ─────────────────
//
// Asked by the Audit's gate of #176 before part 3 moves the adapters: two
// guards the contract did not hold, recorded on main's bots like the rest.

describe('Chats removed and /auth repeated, recorded before D1 part 3', () => {
  it('Telegram: a chat removed while the orchestrator works on its message is forgotten, and the answer goes where a notice goes', async () => {
    settings.telegramAuthorizedChatIds = ['42', '77'];
    liveCli('agent-orch');
    await telegram(dm('what is everyone doing?', 77));
    // JeanBrasse removes chat 77 in Settings while the orchestrator works.
    settings.telegramAuthorizedChatIds = ['42'];
    const orch = agents.get('agent-orch')!;
    orch.output = ['  ⎿  (MCP) 6 agents\n', 'Dune is rebasing onto main, Dove waits on you.\n'];
    sendSuperAgentResponseToTelegram(orch);
    sendTelegramMessage('A notice from Tars.');
    await telegram(dm('and now?', 77));
    await settle();
    expect(outcome()).toMatchSnapshot();
  });

  it('Telegram: /auth tried again and again: each wrong token refused, the right one saves the chat once', async () => {
    for (const token of ['wrong-1', 'wrong-2', 'wrong-3']) await telegram(dm(`/auth ${token}`, 99));
    await telegram(dm('/auth', 99));
    await telegram(dm('/auth tg-auth-token', 99));
    await telegram(dm('/auth tg-auth-token', 99));
    await telegram(dm('/auth wrong-4', 99));
    await telegram(dm('/status', 99));
    expect(outcome()).toMatchSnapshot();
  });
});
