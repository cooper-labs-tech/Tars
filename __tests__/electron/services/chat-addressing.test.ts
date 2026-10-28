import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  chatTag, chatListFor, parseChatAddress, pickChat, routeChannelMessage, chatsReadable, namesItsChats,
} from '../../../electron/services/chat-addressing';
import type { Chat } from '../../../electron/services/chats';

/**
 * How a message from Telegram, Slack or Discord names one of a project's chats, and how Tars remembers which chat each
 * message it sent there came from (ORCHESTRATOR-PER-CHAT.md v2.2, 4.6; PR F of 2.0.0). No routing by content: a reply
 * goes to the chat it answers, "#N" at the start names chat N, anything else goes to the inbox.
 *
 * How this can fail, written before the code:
 * 1. "#N" read where the user did not write an address: in the middle of a sentence ("see #3"), glued to a word
 *    ("#3rd"), with a space after the # ("# 3"), as a fullwidth sign ("＃3"), signed or with leading zeros ("#-1",
 *    "#03"), absurdly long ("#9999999"), or with nothing after it ("#3", "#3 "): a message then reaches a chat it was
 *    not for, or an empty one is sent.
 * 2. The text that goes on loses or keeps the wrong part: the "#N" left in, the separator (":" or ",") left in, or the
 *    lines after the first dropped.
 * 3. No "#N", and the message goes to chat 1 rather than to the inbox when another chat is the inbox; or to a chat of
 *    another project; or nowhere when the project has chats.
 * 4. An "#N" no chat of the project has reaches some chat anyway (the inbox, the nearest number), where it should reach
 *    nobody and get the numbered list; or the list names another project's chats, or is out of order.
 * 5. The prefix of an outgoing message does not name the project, the number and the title, in that form, or carries a
 *    title's line break or bidi control into the channel.
 * 6. (Gone with Tars's own Telegram bot in 2.0.5, and its tests with it.) The sent log: a reply to a message of one Telegram chat is matched with the same message id in another (Telegram
 *    numbers messages per chat); an entry older than 7 days still routes; an unreadable or foreign file throws or routes;
 *    the file grows without bound; it is written readable by others; it holds the message's text.
 * 7. A channel's message for Main, or for a project with no chats, leaves today's path to the orchestrator (the bots'
 *    own forward, its context and its launch); or a message for another chat takes that path, which starts a CLI
 *    outside the chats' limit.
 * 8. A reply to a chat's message goes by its "#N" or to the inbox instead of to the chat it answers, or loses its
 *    "#N"-looking first word; a reply to a chat since deleted reaches another chat, or vanishes without a word.
 * 9. A trailing slash in the project's path, as one sender spells it, finds no chat, and the message goes to the
 *    orchestrator rather than to the inbox.
 * 11. (GATE-2.0.0-BULLETS, 2) A project that has only Main changes for everyone, the new interface off: a message
 *    that starts with "#2 " (an issue's number) reaches nobody, where 1.9.7 delivered it to the orchestrator as it
 *    was typed, and what the orchestrator sends is headed "[tars #1 Main]". While a project has only Main, it
 *    behaves as 1.9.7 did; with several chats, the rules above stand.
 * 10. chat_list (4.4 item 5, the cross-chat reading option) hands a runner another project's chats, the caller's own
 *    chat, or more of a chat than its id, number, title, state and last activity (its runner's id, its sessions, its
 *    project's path).
 */

const at = '2026-10-13T08:00:00.000Z';
const chat = (over: Partial<Chat>): Chat => ({
  id: 'c1', projectPath: '/work/tars', number: 1, title: 'Main', titleSource: 'user', runnerId: 'lead',
  sessionIds: [], pinned: false, snoozedUntil: null, settledAt: null, inbox: true,
  createdAt: at, updatedAt: at, lastActivityAt: at, ...over,
});

describe('1, 2. "#N" at the start names a chat', () => {
  it('reads the number and the text after it, whatever separates them', () => {
    expect(parseChatAddress('#3 ship it')).toEqual({ number: 3, text: 'ship it' });
    expect(parseChatAddress('#3: ship it')).toEqual({ number: 3, text: 'ship it' });
    expect(parseChatAddress('#12, ship it')).toEqual({ number: 12, text: 'ship it' });
    expect(parseChatAddress('  #3   ship it  ')).toEqual({ number: 3, text: 'ship it' });
    expect(parseChatAddress('#3\nfirst line\nsecond line')).toEqual({ number: 3, text: 'first line\nsecond line' });
  });

  it.each([
    'see #3 ship it', '#3rd time', '# 3 ship it', '＃3 ship it', '#-1 ship it', '#03 ship it', '#9999999 ship it',
    '#3', '#3 ', '#3:', '#', 'ship it', '',
  ])('reads no address in %j', (text) => {
    expect(parseChatAddress(text)).toBeNull();
  });
});

describe('3, 4. which chat a message is for', () => {
  const main = chat({ id: 'main', number: 1, inbox: false });
  const release = chat({ id: 'rel', number: 3, title: 'Release 1.9.7', runnerId: 'r3', inbox: true });
  const other = chat({ id: 'other', projectPath: '/work/other', number: 2, title: 'Other', inbox: true });
  const all = [other, release, main];

  it('with no number, the inbox of the project, even when it is not chat 1', () => {
    expect(pickChat(all, '/work/tars', null)).toEqual({ kind: 'chat', chat: release });
    expect(pickChat([chat({ id: 'm' })], '/work/tars', null)).toEqual({ kind: 'chat', chat: chat({ id: 'm' }) });
  });

  it('with a number, that chat of the project and no other project\'s', () => {
    expect(pickChat(all, '/work/tars', 1)).toEqual({ kind: 'chat', chat: main });
    expect(pickChat(all, '/work/tars', 3)).toEqual({ kind: 'chat', chat: release });
  });

  it('a number the project has not: nobody, and the list of its chats in order', () => {
    const answer = pickChat(all, '/work/tars', 2);
    expect(answer.kind).toBe('unknown');
    expect(answer.kind === 'unknown' && answer.list).toBe(chatListFor('/work/tars', all));
    expect(pickChat(all, '/work/tars', 9).kind).toBe('unknown');
  });

  it('a project with no chats: none, so the caller keeps to the orchestrator', () => {
    expect(pickChat(all, '/work/empty', null)).toEqual({ kind: 'none' });
    expect(pickChat(all, '/work/empty', 3)).toEqual({ kind: 'none' });
  });

  it('the list names the project\'s chats only, by number, and how to name one', () => {
    const list = chatListFor('/work/tars', all);
    expect(list).toContain('#1 Main');
    expect(list).toContain('#3 Release 1.9.7');
    expect(list).not.toContain('Other');
    expect(list.indexOf('#1 Main')).toBeLessThan(list.indexOf('#3 Release'));
    expect(list).toMatch(/#N/);
  });
});

describe('5. the prefix of what a chat sends', () => {
  it('names the project as it is written after @, the number and the title', () => {
    expect(chatTag(chat({ projectPath: '/work/my project', number: 3, title: 'Release 1.9.7' }))).toBe('[my-project #3 Release 1.9.7]');
  });

  it('carries no break and no bidi control from a title', () => {
    expect(chatTag(chat({ title: 'a\nb\u202Ec' }))).toBe('[tars #1 a bc]');
  });
});

describe('7, 8, 9. the way a channel\'s message goes', () => {
  const main = chat({ id: 'main', number: 1, inbox: false });
  const inbox = chat({ id: 'in', number: 2, title: 'Inbox', runnerId: 'r2', inbox: true });
  const release = chat({ id: 'rel', number: 3, title: 'Release', runnerId: 'r3', inbox: false });
  const chats = [main, inbox, release];
  const route = (text: string, replyChatId?: string, projectPath = '/work/tars', list = chats) =>
    routeChannelMessage({ chats: list, projectPath, text, replyChatId });

  it('Main, and a project with no chats, keep the path to the orchestrator', () => {
    expect(route('#1 hello')).toEqual({ kind: 'orchestrator', text: 'hello' });
    expect(route('hello', undefined, '/work/none')).toEqual({ kind: 'orchestrator', text: 'hello' });
    expect(route('#3 hello', undefined, '/work/none')).toEqual({ kind: 'orchestrator', text: '#3 hello' });
    expect(route('hello', undefined, '/work/tars', [chat({ id: 'm' })])).toEqual({ kind: 'orchestrator', text: 'hello' });
  });

  it('another chat, by its number or as the inbox, through the chats', () => {
    expect(route('#3 hello')).toEqual({ kind: 'chat', chat: release, text: 'hello' });
    expect(route('hello')).toEqual({ kind: 'chat', chat: inbox, text: 'hello' });
    expect(route('hello', undefined, '/work/tars/')).toEqual({ kind: 'chat', chat: inbox, text: 'hello' });
  });

  it('an unknown number reaches nobody', () => {
    expect(route('#9 hello')).toEqual({ kind: 'unknown', list: chatListFor('/work/tars', chats) });
  });

  it('a reply goes to the chat it answers, its words as written', () => {
    expect(route('#2 not an address here', 'rel')).toEqual({ kind: 'chat', chat: release, text: '#2 not an address here' });
    expect(route('thanks', 'main')).toEqual({ kind: 'orchestrator', text: 'thanks' });
    expect(route('thanks', 'gone-chat')).toEqual({ kind: 'gone' });
  });
});

describe('10. what chat_list shows a chat of its project\'s other chats', () => {
  const mine = chat({ id: 'mine', number: 3, title: 'Release', runnerId: 'r3', inbox: false, sessionIds: ['s1'] });
  const main = chat({ id: 'main', number: 1 });
  const settled = chat({ id: 'old', number: 2, title: 'Old', runnerId: 'r2', inbox: false, settledAt: at });
  const other = chat({ id: 'other', projectPath: '/work/other', number: 4, title: 'Elsewhere' });
  const states: Record<string, string> = { main: 'idle', old: 'asleep', other: 'working', mine: 'working' };

  it('the others of its project, by number, with five fields', () => {
    const listed = chatsReadable(mine, [other, settled, mine, main], (c) => states[c.id] as never);
    expect(listed).toEqual([
      { id: 'main', number: 1, title: 'Main', state: 'idle', lastActivityAt: at },
      { id: 'old', number: 2, title: 'Old', state: 'settled', lastActivityAt: at },
    ]);
  });
});

describe('11. a project that has only Main, as 1.9.7 was', () => {
  const main = chat({ id: 'main', number: 1 });
  const other = chat({ id: 'o', projectPath: '/work/other', number: 1 });

  it('takes "#N" as text and gives it to the orchestrator as typed', () => {
    expect(routeChannelMessage({ chats: [main, other], projectPath: '/work/tars', text: '#2 fix the login issue' }))
      .toEqual({ kind: 'orchestrator', text: '#2 fix the login issue' });
    expect(routeChannelMessage({ chats: [main], projectPath: '/work/tars', text: '#1 hello' }))
      .toEqual({ kind: 'orchestrator', text: '#1 hello' });
  });

  it('names no chat on what it sends, until it has another', () => {
    expect(namesItsChats([main, other], main)).toBe(false);
    const two = chat({ id: 'two', number: 2, inbox: false });
    expect(namesItsChats([main, two, other], main)).toBe(true);
    expect(namesItsChats([main, two, other], two)).toBe(true);
  });
});
