import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Who the Slack bot answers (the audit's lead #15).
 *
 * The bot acted on any human sender: anyone who could mention it or message
 * it (a workspace member, a guest, a Slack Connect user in a shared channel)
 * could list agents and project paths, start and stop agents, brief the super
 * agent, and move the channel agents' send_slack posts to. It now answers the
 * Slack user ids allowed in Settings > Slack, and nobody while that list is
 * empty, like the Telegram bot's authorized chats. The list is read at each
 * event, so an id added or removed in Settings counts without a restart.
 *
 * The bot, its command handling and the agent map are the real ones; Slack's
 * client is a recorder of the handlers the bot registers.
 */

type Say = (text: string) => Promise<void>;
type MentionHandler = (args: { event: Record<string, unknown>; say: Say }) => Promise<void>;
type MessageHandler = (args: { message: Record<string, unknown>; say: Say }) => Promise<void>;
const slack = vi.hoisted(() => ({ mention: null as MentionHandler | null, message: null as MessageHandler | null }));

vi.mock('@slack/bolt', () => ({
  App: class {
    event(name: string, handler: MentionHandler) { if (name === 'app_mention') slack.mention = handler; }
    message(handler: MessageHandler) { slack.message = handler; }
    use() {}
    start() { return Promise.resolve(); }
    stop() { return Promise.resolve(); }
  },
  LogLevel: { DEBUG: 'debug', INFO: 'info' },
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.7.9' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));

import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { initSlackBot } from '../../../electron/services/slack-bot';
import type { AgentStatus, AppSettings } from '../../../electron/types';

let live: AppSettings;
const saved: AppSettings[] = [];
const terminal = { write: vi.fn() };

function settings(allowed: string[]): AppSettings {
  return {
    slackEnabled: true, slackBotToken: 'xoxb-test', slackAppToken: 'xapp-test', slackChannelId: 'D_OWNER',
    slackAllowedUserIds: allowed,
  } as AppSettings;
}

async function mention(user: string, text: string) {
  const said: string[] = [];
  await slack.mention!({ event: { user, channel: 'C_SHARED', ts: '1', text: `<@UBOT> ${text}` }, say: async t => { said.push(t); } });
  return said;
}

async function message(user: string, text: string, channelType = 'im') {
  const said: string[] = [];
  await slack.message!({ message: { user, channel: `D_${user}`, channel_type: channelType, ts: '2', text }, say: async t => { said.push(t); } });
  return said;
}

beforeEach(() => {
  agents.clear();
  ptyProcesses.clear();
  terminal.write.mockClear();
  saved.length = 0;
  agents.set('w1', {
    id: 'w1', name: 'Worker', status: 'running', provider: 'claude', projectPath: '/tmp/project', skills: [],
    output: [], lastActivity: new Date().toISOString(), ptyId: 'pty-w1',
  } as AgentStatus);
  ptyProcesses.set('pty-w1', terminal as never);
  live = settings([]);
  initSlackBot(() => live, s => { live = s; saved.push(s); }, null);
});

describe('a mention', () => {
  it('commands nothing while no Slack user is allowed, and says which id to add', async () => {
    const said = await mention('U_OWNER', 'stop worker');

    expect(terminal.write).not.toHaveBeenCalled();
    expect(agents.get('w1')!.status).toBe('running');
    expect(said.join()).toContain('U_OWNER');
    expect(saved, 'the channel agents post to moved').toEqual([]);
  });

  it('commands nothing from a user who is not allowed, and still obeys one who is', async () => {
    live = settings(['U_OWNER']);

    await mention('U_OTHER', 'stop worker');
    expect(terminal.write).not.toHaveBeenCalled();
    expect(live.slackChannelId).toBe('D_OWNER');

    await mention('U_OWNER', 'stop worker');
    expect(terminal.write).toHaveBeenCalledWith('\x03');
  });

  it('follows the list as Settings has it now, without a restart', async () => {
    // app:saveSettings replaces main's object: the bot must read the new one.
    live = settings(['U_OWNER']);
    await mention('U_OTHER', 'stop worker');
    expect(terminal.write).not.toHaveBeenCalled();

    live = settings(['U_OWNER', 'U_OTHER']);
    await mention('U_OTHER', 'stop worker');
    expect(terminal.write).toHaveBeenCalledWith('\x03');
  });
});

describe('a message', () => {
  it('from a user who is not allowed reaches no agent and moves no channel; told so in a DM, silent in a channel', async () => {
    live = settings(['U_OWNER']);

    const inDm = await message('U_OTHER', 'hello');
    const inChannel = await message('U_OTHER', 'hello', 'channel');

    expect(inDm.join()).toContain('U_OTHER');
    expect(inChannel).toEqual([]);
    expect(saved).toEqual([]);
    expect(live.slackChannelId).toBe('D_OWNER');
  });

  it('from an allowed user is taken, and its channel becomes the one agents answer in', async () => {
    live = settings(['U_OWNER']);

    await message('U_OWNER', 'hello');

    expect(live.slackChannelId).toBe('D_U_OWNER');
    expect(saved).toHaveLength(1);
  });
});
