import { projectWord } from './orchestrator-routing';
import { titleOf, type Chat } from './chats';

/**
 * How a message from Telegram (through Hermes), Slack or Discord names one of a
 * project's chats (ORCHESTRATOR-PER-CHAT.md v2.2, 4.6; PR F of 2.0.0). The log
 * of what Tars's own Telegram bot sent went with the bot in 2.0.5.
 *
 * No routing by content: a reply goes to the chat it answers, "#N" at the very
 * start names chat N of the project, and anything else goes to the project's
 * inbox. An "#N" the project has no chat for reaches nobody, and is answered
 * with the numbered list.
 */

/** "#N text": a number of at most 6 digits, no leading zero, glued to the #, then text. */
const ADDRESS = /^#([1-9]\d{0,5})(?:[:,]\s*|\s+)(\S[\s\S]*)$/;

export function parseChatAddress(message: string): { number: number; text: string } | null {
  const found = ADDRESS.exec(message.trim());
  return found ? { number: Number(found[1]), text: found[2].trim() } : null;
}

/**
 * Whether what a chat sends is headed by it: once its project has several
 * chats. With only Main, a project's channels read as they did in 1.9.7
 * (GATE-2.0.0-BULLETS, 2).
 */
export function namesItsChats(chats: Chat[], chat: Pick<Chat, 'projectPath'>): boolean {
  return ofProject(chats, chat.projectPath).length > 1;
}

/** What every outgoing message of a chat starts with: "[<project> #N <title>]". */
export function chatTag(chat: Pick<Chat, 'projectPath' | 'number' | 'title'>): string {
  return `[${projectWord(chat.projectPath)} #${chat.number} ${titleOf(chat.title) ?? ''}]`;
}

/** One spelling of a project's path: a trailing slash is the same folder. */
const sameProject = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

const ofProject = (chats: Chat[], projectPath: string) =>
  chats.filter((c) => sameProject(c.projectPath, projectPath)).sort((a, b) => a.number - b.number);

/** The project's chats, numbered, and how to name one. */
export function chatListFor(projectPath: string, chats: Chat[]): string {
  const lines = ofProject(chats, projectPath).map((c) => `#${c.number} ${titleOf(c.title) ?? ''}`);
  return `Chats of ${projectWord(projectPath)}:\n${lines.join('\n')}\nStart a message with "#N " to write to chat N; without it, it goes to the inbox.`;
}

export type ChatPick =
  | { kind: 'chat'; chat: Chat }
  /** No chat of the project has that number: nobody is reached, and the sender gets the list. */
  | { kind: 'unknown'; list: string }
  /** The project has no chats (no orchestrator yet, or the chats are not loaded): the caller keeps to its orchestrator. */
  | { kind: 'none' };

/** The chat a message is for: chat `number` of the project, or its inbox when it names none. */
export function pickChat(chats: Chat[], projectPath: string, number: number | null): ChatPick {
  const own = ofProject(chats, projectPath);
  if (own.length === 0) return { kind: 'none' };
  if (number === null) {
    const inbox = own.find((c) => c.inbox) ?? own.find((c) => c.number === 1);
    return inbox ? { kind: 'chat', chat: inbox } : { kind: 'none' };
  }
  const named = own.find((c) => c.number === number);
  return named ? { kind: 'chat', chat: named } : { kind: 'unknown', list: chatListFor(projectPath, chats) };
}

export type ChannelRoute =
  /** Main, or a project with no chats: the orchestrator, by the path each bot has always taken. */
  | { kind: 'orchestrator'; text: string }
  /** Another chat: through the chats (chat-runners.ts), within their limit. */
  | { kind: 'chat'; chat: Chat; text: string }
  | { kind: 'unknown'; list: string }
  /** A reply to a chat deleted since: it reaches nobody, and the sender is told. */
  | { kind: 'gone' };

/**
 * Where a message from a channel goes, for a project already named: the chat
 * a reply answers (its words as written), else "#N", else the inbox.
 */
export function routeChannelMessage(input: { chats: Chat[]; projectPath: string; text: string; replyChatId?: string }): ChannelRoute {
  const text = input.text.trim();
  if (input.replyChatId) {
    const answered = input.chats.find((c) => c.id === input.replyChatId);
    if (!answered) return { kind: 'gone' };
    return answered.number === 1 ? { kind: 'orchestrator', text } : { kind: 'chat', chat: answered, text };
  }
  // A project with only Main is as it was in 1.9.7: "#2 " is an issue's
  // number, and the message goes to the orchestrator as typed
  // (GATE-2.0.0-BULLETS, 2). Numbers name chats once it has several.
  if (ofProject(input.chats, input.projectPath).length <= 1) return { kind: 'orchestrator', text };
  const address = parseChatAddress(text);
  const picked = pickChat(input.chats, input.projectPath, address?.number ?? null);
  if (picked.kind === 'none') return { kind: 'orchestrator', text };
  if (picked.kind === 'unknown') return picked;
  const said = address?.text ?? text;
  return picked.chat.number === 1 ? { kind: 'orchestrator', text: said } : { kind: 'chat', chat: picked.chat, text: said };
}

/** A chat as another chat of its project reads it in chat_list. */
export interface ChatListed {
  id: string;
  number: number;
  title: string;
  /** settled; else its runner's: working (in a turn), idle, asleep, or not started (no runner yet). */
  state: 'settled' | 'working' | 'idle' | 'asleep' | 'not started';
  lastActivityAt: string;
}

/**
 * What chat_list shows a chat (4.4 item 5): the other chats of its own
 * project, by number, and of each its id, number, title, state and last
 * activity, nothing else.
 */
export function chatsReadable(reader: Chat, chats: Chat[], stateOf: (chat: Chat) => Exclude<ChatListed['state'], 'settled'>): ChatListed[] {
  return ofProject(chats, reader.projectPath)
    .filter((c) => c.id !== reader.id)
    .map((c) => ({ id: c.id, number: c.number, title: c.title, state: c.settledAt ? 'settled' as const : stateOf(c), lastActivityAt: c.lastActivityAt }));
}
