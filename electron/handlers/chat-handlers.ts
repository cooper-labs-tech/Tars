import { hasClaudeHooks } from '../core/end-of-turn';
import { ipcMain } from 'electron';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { agentStatusEmitter } from '../services/agent-events';
import { chatSeq, followChats, historyOf, noteChatSnapshot, publishChatEvent, queueOf, readChatItems } from '../services/chat-history';
import { broadcastToAllWindows } from '../utils/broadcast';
import { ownerWords } from '../services/owner-words';
import { chatLimitOf, createChatStore, workOutOf, type Chat, type ChatError, type ChatLimit, type ChatStore, type OrchestratorFacts } from '../services/chats';
import { chatsWorking, isLive, removeRunnerOf, renameRunner, runnerOf, sendToChat, settleRunner, startChatRunners, stopRunnerOf } from '../services/chat-runners';
import { setOrchestratorFollower } from '../core/chat-identity';
import type { AgentStatus } from '../types';
import { isSuperAgent } from '../utils';

/**
 * The window's channels for the chats' records (ORCHESTRATOR-PER-CHAT.md
 * v2.2, 4.5, the records' part; PR C of 2.0.0), over services/chats.ts.
 *
 * Registered at launch, which runs the migration first: each project's
 * orchestrator's conversation is its chat #1, Main. A chat's runner is read
 * from the fleet as it is (Main's is the orchestrator); every session that
 * runner registers is added to its chats' sessions. Nothing in the window
 * calls these yet: the Frontend builds the chat pages on them behind the
 * "new interface" switch. A send reaches the chat's runner, made at its first
 * send (services/chat-runners.ts, PR D). A chat's conversation is read from
 * its runner's transcripts (`chat:history`), then followed live (`chat:events`,
 * services/chat-history.ts, PR E); a worker's queue is `agent:queue`.
 */

export const CHATS_FILE = path.join(DATA_DIR, 'chats.json');

export const CHAT_CHANNELS = [
  'chat:list', 'chat:create', 'chat:rename', 'chat:pin', 'chat:snooze', 'chat:settle', 'chat:delete', 'chat:setInbox', 'chat:send',
  'system:chatLimit', 'chat:history', 'agent:queue',
] as const;

/** What the window learns of a chat's runner: the agent as it is now. */
export interface ChatRunnerView {
  id: string;
  name: string;
  status: AgentStatus['status'];
  waking: boolean;
  /** Its CLI holds a terminal: it counts in the limit. */
  live: boolean;
  lastActivity: string;
  /** A permission its CLI asked Tars, shown in the chat that runs it (#318). */
  permissionAsk: AgentStatus['permissionAsk'] | null;
}

export type ChatView = Chat & { runner: ChatRunnerView | null };

let live: ChatStore | null = null;

/** The store, once main.ts has registered the channels; null before that and in the tests of everything else. */
export function liveChatStore(): ChatStore | null {
  return live;
}

const argsOf = (raw: unknown): Record<string, unknown> => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {});

export function registerChatHandlers(deps: {
  agents: Map<string, AgentStatus>;
  file?: string;
  /** Whether a window can show chats (the new interface): the follower reads nothing otherwise. */
  chatsShown?: () => boolean;
}): ChatStore {
  const { agents } = deps;
  const store = createChatStore({ file: deps.file ?? CHATS_FILE });
  live = store;

  const orchestrators = (): OrchestratorFacts[] => [...agents.values()].filter((a) => isSuperAgent(a) && a.kind !== 'chat').map((a) => ({
    id: a.id, projectPath: a.projectPath, createdAt: a.createdAt, lastActivity: a.lastActivity, resumableSessionId: a.resumableSessionId,
    // A chat other than Main resumes its conversation at each launch: claude only, for now.
    resumable: hasClaudeHooks(a),
  }));
  const view = (chat: Chat): ChatView => {
    // Only an agent the fleet confirms as the chat's runner (runnerOf): chats.json is agents' to write.
    const runner = runnerOf(chat);
    return {
      ...chat,
      runner: runner ? {
        id: runner.id, name: runner.name || runner.id, status: runner.status, waking: !!runner.waking, live: isLive(runner),
        lastActivity: runner.lastActivity, permissionAsk: runner.permissionAsk ?? null,
      } : null,
    };
  };
  /** A chat changed: answered, and told to every window as a `meta` event (services/chat-history.ts). */
  const answer = (result: Chat | ChatError): ChatView | ChatError => {
    if ('error' in result) return result;
    const shown = view(result);
    publishChatEvent({ type: 'meta', chatId: result.id, chat: shown });
    return shown;
  };
  const tellChat = (chatId: string): void => {
    const chat = store.get(chatId);
    if (chat) publishChatEvent({ type: 'meta', chatId, chat: view(chat) });
  };
  const nameOf = (agentId: string): string | undefined => agents.get(agentId)?.name;
  /** The session a runner registered, added to its chats (hooks-routes.ts records it as resumableSessionId). */
  const mirror = (agentId: string): void => {
    const agent = agents.get(agentId);
    // With the folder its CLI runs in: its worktree, else its project (as every launch picks it).
    if (agent?.resumableSessionId && store.noteSession(agent.id, agent.resumableSessionId, agent.worktreePath || agent.projectPath)) {
      for (const chat of store.list().chats.filter((c) => c.runnerId === agent.id)) tellChat(chat.id);
    }
  };
  /** Each worker's queue, as last told: a change is told as an `agent:queue` event. */
  const queues = new Map<string, string>();
  const tellQueue = (agentId: string): void => {
    const agent = agents.get(agentId);
    if (!agent) { queues.delete(agentId); return; }
    const shown = queueOf(agent, nameOf);
    const key = JSON.stringify(shown);
    const before = queues.get(agentId);
    if (before === key) return;
    queues.set(agentId, key);
    // An agent seen for the first time (the fleet may load after this) is told
    // when it holds anything: an empty queue is no change.
    if (before !== undefined || shown.current || shown.queue.length) broadcastToAllWindows('agent:queue', shown);
  };

  // Main is the project's persistent orchestrator: when the role moves to
  // another agent, Main's record moves with it, its sessions kept as history
  // (the orchestrator's decision of 2026-10-13). Logged, each one.
  const followTheOrchestrators = (): void => {
    for (const moved of store.followOrchestrators(orchestrators())) {
      const name = (id: string | null) => (id ? agents.get(id)?.name || id : 'nobody');
      console.log(`[chats] Main of ${moved.projectPath} follows the project's orchestrator: ${name(moved.from)} to ${name(moved.to)}`);
      tellChat(moved.chatId);
    }
  };
  setOrchestratorFollower(followTheOrchestrators);

  // The migration, at the launch (4.6), then any session registered while
  // Tars was not running to see it: both write only what is new.
  store.ensureMains(orchestrators());
  followTheOrchestrators();
  for (const id of agents.keys()) { mirror(id); tellQueue(id); }
  agentStatusEmitter.on('fleet-change', mirror);
  agentStatusEmitter.on('fleet-change', tellQueue);
  // A request queued or delivered is saved, not announced as a fleet change:
  // every queue is looked at each second as well.
  const queueTimer = setInterval(() => { for (const id of agents.keys()) tellQueue(id); }, 1_000);
  queueTimer.unref?.();
  startChatRunners(store);
  followChats({
    chats: () => store.list().chats,
    // Only the runner the fleet confirms: chats.json is agents' to write.
    runnerOf: (chat) => runnerOf(chat),
    isLive: (agent) => isLive(agent),
    nameOf,
    enabled: deps.chatsShown ?? (() => true),
  });

  ipcMain.handle('chat:list', () => {
    // A project whose orchestrator was set since the launch gets its Main now.
    for (const made of store.ensureMains(orchestrators())) tellChat(made.id);
    followTheOrchestrators();
    const { chats } = store.list();
    // The seq of chat:events (services/chat-history.ts): this list is a snapshot at it.
    return { seq: chatSeq(), chats: chats.map(view), problem: store.problem() };
  });
  ipcMain.handle('chat:create', (_e, raw: unknown) => {
    const args = argsOf(raw);
    return answer(store.create({ projectPath: args.projectPath, title: args.title }, orchestrators()));
  });
  ipcMain.handle('chat:rename', (_e, raw: unknown) => {
    const renamed = store.rename(argsOf(raw).chatId, argsOf(raw).title);
    if (!('error' in renamed)) renameRunner(renamed);
    return answer(renamed);
  });
  ipcMain.handle('chat:pin', (_e, raw: unknown) => answer(store.pin(argsOf(raw).chatId, argsOf(raw).pinned)));
  ipcMain.handle('chat:snooze', (_e, raw: unknown) => answer(store.snooze(argsOf(raw).chatId, argsOf(raw).until)));
  ipcMain.handle('chat:settle', (_e, raw: unknown) => {
    const settled = store.settle(argsOf(raw).chatId, argsOf(raw).settled);
    // Its runner sleeps at once, or as soon as the rule allows it; Main's never does.
    if (!('error' in settled) && settled.settledAt) settleRunner(settled);
    return answer(settled);
  });
  ipcMain.handle('chat:setInbox', (_e, raw: unknown) => answer(store.setInbox(argsOf(raw).chatId)));
  // Refused for the inbox and while the chat's runner has a request out at the
  // team (PR A's queue); then its own runner is stopped and removed with its
  // worktree, its work saved first, and the record goes. Main's runner, the
  // orchestrator, stays.
  ipcMain.handle('chat:delete', async (_e, raw: unknown) => {
    const chatId = argsOf(raw).chatId;
    const workOut = (chat: Chat) => workOutOf(runnerOf(chat)?.id ?? null, agents.values());
    const refused = store.removalRefusal(chatId, workOut);
    if (refused) return refused;
    // Stopped first, then checked again: what it asked for while it stopped
    // would stay filed by a requester that is gone (the Audit's L6 on #379).
    await stopRunnerOf(store.get(chatId)!);
    const late = store.removalRefusal(chatId, workOut);
    if (late) return late;
    const torn = await removeRunnerOf(store.get(chatId)!);
    const removed = store.remove(chatId, workOut);
    if ('error' in removed) return removed;
    if (typeof chatId === 'string') publishChatEvent({ type: 'deleted', chatId });
    return { ...removed, ...torn };
  });
  // A chat's conversation, from its runner's transcripts, and the seq it is a snapshot at.
  ipcMain.handle('chat:history', async (_e, raw: unknown) => {
    const args = argsOf(raw);
    const chat = store.get(args.chatId);
    if (!chat) return { error: 'not_found', reason: 'No chat has this id.', seq: chatSeq() };
    const items = await readChatItems(chat, { runner: runnerOf(chat), nameOf });
    noteChatSnapshot(chat.id, items);
    return historyOf(items, { before: args.before, limit: args.limit });
  });
  // A worker's work in hand and its queue (core/task-requests.ts).
  ipcMain.handle('agent:queue', (_e, agentId: unknown) => {
    const agent = typeof agentId === 'string' ? agents.get(agentId) : undefined;
    return agent ? queueOf(agent, nameOf) : { error: 'not_found', reason: 'No agent has this id.' };
  });
  // The user's words into the chat's runner, made at its first send, within the limit.
  // clientRequestId and the send modes come with PR B's receipts.
  // What the window sends is the owner's own words, for the chat's project: recorded once it is taken, what its
  // orchestrator may relay under Tars's mark (services/owner-words.ts, SECURITY.md §8).
  ipcMain.handle('chat:send', async (_e, raw: unknown) => {
    const { chatId, text } = argsOf(raw);
    const answer = await sendToChat(chatId, text);
    const chat = store.get(chatId);
    if (!('error' in answer) && chat && typeof text === 'string') ownerWords.record({ text, via: 'window', projectPath: chat.projectPath });
    return answer;
  });

  ipcMain.handle('system:chatLimit', (): ChatLimit & { working: number } => (
    { ...chatLimitOf(os.totalmem(), process.env), working: chatsWorking() }
  ));

  return store;
}
