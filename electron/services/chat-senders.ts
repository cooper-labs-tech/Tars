import type { MessageSender } from '../core/pty-manager';
import { agents } from '../core/agent-manager';
import { allChats, chatById, namedChatRunBy, sendToChat } from './chat-runners';
import { chatTag, routeChannelMessage } from './chat-addressing';
import type { Chat } from './chats';

/**
 * Who writes to "the project's orchestrator" reaches the project's inbox chat
 * (ORCHESTRATOR-PER-CHAT.md v2.2, 4.6; PR F of 2.0.0): the bots, the Hermes
 * relay, the kanban's and the error triage's notes, the stall reports. The
 * inbox is chat 1, Main, unless the user made another chat the inbox; Main is
 * the orchestrator itself, and a message for it keeps the path it has always
 * taken. A project with no chats has its orchestrator alone, as before.
 */

/**
 * The head of what an agent sends to a channel: "[<project> #N <title>] " for
 * an agent that runs a chat (Main's orchestrator, a runner), nothing for one
 * that runs none.
 */
export function chatHeadOf(agentId: string | undefined): string {
  const agent = agentId ? agents.get(agentId) : undefined;
  const chat = agent ? namedChatRunBy(agent) : undefined;
  return chat ? `${chatTag(chat)} ` : '';
}

/** What the sender is told once a message is in a chat. */
function receiptOf(chat: Chat, how: 'typed' | 'held' | 'launched'): string {
  const which = `chat #${chat.number} "${chat.title}"`;
  if (how === 'held') return `Passed to ${which}: it waits for what holds its terminal (a dialog, or what is typed there).`;
  if (how === 'launched') return `Passed to ${which}: its conversation was resumed with your message.`;
  return `Passed to ${which}.`;
}

/**
 * A message from a channel, for a project already named (or for the chat a
 * reply answers): Main by the bot's own path, another chat through the chats
 * (their limit, a settled or asleep one woken), an unknown "#N" answered with
 * the list. `tell` answers on the channel, with the chat it is about.
 */
export async function deliverFromChannel(args: {
  projectPath: string;
  text: string;
  replyChatId?: string;
  sender: MessageSender;
  toOrchestrator: (text: string) => Promise<void>;
  tell: (text: string, chat?: Chat) => unknown;
  /** Before a chat's message, as the bot puts its context before the orchestrator's (where to answer). */
  context?: string;
}): Promise<void> {
  const route = routeChannelMessage({ chats: allChats(), projectPath: args.projectPath, text: args.text, replyChatId: args.replyChatId });
  if (route.kind === 'orchestrator') {
    await args.toOrchestrator(route.text);
    return;
  }
  if (route.kind === 'unknown') {
    await args.tell(`No chat of this project has that number, so your message reached nobody.\n${route.list}`);
    return;
  }
  if (route.kind === 'gone') {
    await args.tell('The chat you replied to was deleted, so your reply reached nobody.');
    return;
  }
  const answer = await sendToChat(route.chat.id, args.context ? `${args.context} ${route.text}` : route.text, { sender: args.sender });
  if ('error' in answer) await args.tell(`Not delivered: ${answer.reason}`, route.chat);
  else await args.tell(receiptOf(chatById(route.chat.id) ?? route.chat, answer.how), route.chat);
}
