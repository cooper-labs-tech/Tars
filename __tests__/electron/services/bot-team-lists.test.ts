import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The bots' fleet listings leave the chats' runners out (ORCHESTRATOR-PER-CHAT.md
 * v2.2, 4.2, "Team lists", PR D).
 *
 * A runner runs one chat's conversation with the orchestrator, and is stored as
 * a worker with `kind: 'chat'`. Listed with the team, it reads as one more
 * worker the user could hand work to, called after the orchestrator, and every
 * chat opened adds another.
 *
 * How it fails, written before the code (2026-10-12):
 * 1. Telegram's /status, /agents or /projects lists a runner.
 * 2. Slack's status, agents or projects lists one.
 * 3. Discord's status, agents or projects lists one.
 * 4. A listing leaves out more than the runners: the orchestrator, or a worker
 *    of the same project.
 * (Item 1 went with Tars's own Telegram bot in 2.0.5.)
 *
 * The bots, their shared core and the agents map are the real ones. Faked: the
 * two chat SDKs, the terminal and the window.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.0' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));
vi.mock('@slack/bolt', () => ({
  App: class { event() {} message() {} use() {} start() { return Promise.resolve(); } stop() { return Promise.resolve(); } },
  LogLevel: { DEBUG: 'debug', INFO: 'info' },
}));
vi.mock('discord.js', () => ({
  Client: class { on() { return this; } once() { return this; } login() { return Promise.resolve(''); } destroy() { return Promise.resolve(); } },
  Events: { ClientReady: 'ready', Error: 'error', MessageCreate: 'messageCreate' },
  GatewayIntentBits: { Guilds: 1, GuildMessages: 512, MessageContent: 32768, DirectMessages: 4096 },
  Partials: { Channel: 1 },
}));

import { agents } from '../../../electron/core/agent-manager';
import { handleSlackCommand } from '../../../electron/services/slack-bot';
import { handleDiscordCommand } from '../../../electron/services/discord-bot';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const settings = {} as AppSettings;

/** What only a runner's line has: the title of its chat. */
const RUNNER = 'Release 1.9.4';

function put(id: string, fields: Partial<AgentStatus>): void {
  agents.set(id, {
    id, status: 'idle', projectPath: '/projects/atlas', skills: [], output: [], lastActivity: '2026-10-12T09:00:00.000Z', ...fields,
  } as AgentStatus);
}

beforeEach(() => {
  agents.clear();
  put('lead', { name: 'Atlas-Lead', role: 'orchestrator', orchestratorMode: true, status: 'waiting' });
  put('backend', { name: 'Backend', role: 'worker', status: 'running', currentTask: 'Fix the build' });
  put('runner', { name: `Atlas-Lead · ${RUNNER}`, role: 'worker', kind: 'chat', chatId: 'c-2', teamOrchestratorId: 'lead', status: 'running' });
});

async function slack(text: string): Promise<string> {
  const said: string[] = [];
  await handleSlackCommand(text, 'C1', async t => { said.push(t); }, settings);
  return said.join('\n');
}

async function discord(text: string): Promise<string> {
  const said: string[] = [];
  await handleDiscordCommand(text, 'C1', async t => { said.push(t); }, settings);
  return said.join('\n');
}

/** The team in, the runner out. /projects leaves the orchestrator out as it always has. */
function expectTheTeamOnly(said: string, command: string): void {
  expect(said, command).toContain('Backend');
  if (!command.endsWith('projects')) expect(said, command).toContain('Atlas-Lead');
  expect(said, command).not.toContain(RUNNER);
}

describe("2. Slack's lists", () => {
  it.each(['status', 'agents', 'projects'])("%s leaves the chats' runners out", async command => {
    expectTheTeamOnly(await slack(command), command);
  });
});

describe("3. Discord's lists", () => {
  it.each(['status', 'agents', 'projects'])("%s leaves the chats' runners out", async command => {
    expectTheTeamOnly(await discord(command), command);
  });
});

// PR D, written with its code and shown to bite by a mutant: a command that
// names part of a name reaches the team, never a chat (the sub-agent's note).
describe('4. a command naming an agent', () => {
  it("finds the orchestrator by part of its name, never one of its chats; a chat's runner only by its exact id", async () => {
    const { findAgent } = await import('../../../electron/services/bot-core');
    expect(findAgent(agents, 'atlas-lead')?.id).toBe('lead');
    expect(findAgent(agents, 'release')).toBeUndefined();
    expect(findAgent(agents, 'runner')?.id).toBe('runner');
  });
});
