import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';

/**
 * What a chat is handed by Slack and Discord (the Audit's L2 on #386): the
 * user's words after the channel's line, with the same context the
 * orchestrator gets, so its runner knows where and how to answer (send_slack;
 * send_discord with the channel's id). Telegram's is held by the E2E
 * (e2e/chat-senders.spec.ts). Written after the wiring, as the Audit's
 * question was whether it was there.
 *
 * How it fails:
 * 1. A chat gets the words alone, and its runner cannot tell it must answer
 *    with send_slack, or in which Discord channel.
 * 2. It gets them as the user's own words, with no channel's line.
 * 3. The receipt on the channel does not name the chat.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.0' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('@slack/bolt', () => ({ App: class {}, LogLevel: { INFO: 'info' } }));
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));

const at = '2026-10-13T08:00:00.000Z';
const chat = (id: string, number: number, title: string, inbox: boolean) => ({
  id, projectPath: '/work/tars', number, title, titleSource: 'user', runnerId: `r-${id}`, sessionIds: [], pinned: false,
  snoozedUntil: null, settledAt: null, inbox, createdAt: at, updatedAt: at, lastActivityAt: at,
});
const CHATS = [chat('main', 1, 'Main', true), chat('rel', 3, 'Release', false)];
const toChat = vi.hoisted(() => [] as Array<{ chatId: unknown; text: unknown; opts: unknown }>);
vi.mock('../../../electron/services/chat-runners', () => ({
  allChats: () => CHATS,
  chatById: (id: string) => CHATS.find((c) => c.id === id),
  chatRunBy: () => undefined,
  sendToChat: async (chatId: string, text: string, opts: unknown) => {
    toChat.push({ chatId, text, opts });
    return { success: true, chatId, runnerId: 'r-rel', how: 'typed' };
  },
}));

import { agents } from '../../../electron/core/agent-manager';
import { sendToSuperAgentFromSlack } from '../../../electron/services/slack-bot';
import { sendToSuperAgentFromDiscord } from '../../../electron/services/discord-bot';
import type { AgentStatus, AppSettings } from '../../../electron/types';

beforeEach(() => {
  toChat.length = 0;
  agents.clear();
  agents.set('lead', { id: 'lead', name: 'Lead', role: 'orchestrator', status: 'idle', projectPath: '/work/tars', skills: [], output: [], lastActivity: at } as unknown as AgentStatus);
});

describe('a chat named from Slack or Discord', () => {
  it('1, 2, 3. gets the words after the channel\'s line, with where to answer, and the receipt names it', async () => {
    const saidSlack: string[] = [];
    await sendToSuperAgentFromSlack('C1', '#3 ship it', async (m: string) => { saidSlack.push(m); }, {} as AppSettings);
    const saidDiscord: string[] = [];
    await sendToSuperAgentFromDiscord('D42', '#3 ship it', async (m: string) => { saidDiscord.push(m); }, {} as AppSettings);
    expect(toChat).toEqual([
      { chatId: 'rel', text: '[FROM SLACK - Use send_slack MCP tool to respond!] ship it', opts: { sender: { kind: 'channel', channel: 'Slack' } } },
      { chatId: 'rel', text: '[FROM DISCORD channel_id=D42 - Use send_discord MCP tool with channel_id="D42" to respond!] ship it', opts: { sender: { kind: 'channel', channel: 'Discord' } } },
    ]);
    expect(saidSlack.at(-1)).toMatch(/^:crown: \[tars #3 Release\] Passed to chat #3 "Release"\.$/);
    expect(saidDiscord.at(-1)).toMatch(/^👑 \[tars #3 Release\] Passed to chat #3 "Release"\.$/);
  });
});
