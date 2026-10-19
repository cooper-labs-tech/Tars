import * as fs from 'fs';
import { forwardToOrchestrator, type BotFleet } from './bot-core';
import { onRelayProjectMessage, onRelayReply, receiptFor, setRelayProjects, tellUser } from './hermes-relay';
import { orchestratorForProject, orchestratorOf, projectName, projectNames, whereToWrite } from './orchestrator-routing';
import { getSuperAgentInstructionsPath } from '../utils';
import { chatTag } from './chat-addressing';
import { deliverFromChannel } from './chat-senders';
import { DEFAULT_GATEWAY, gatewayById, gatewayReaches } from './hermes-gateways';
import type { AgentStatus } from '../types';

/**
 * Where the user's messages through the relay go (DESIGN-RELAIS-HERMES-V2.md, step 2; JeanBrasse's rule of 2026-10-01:
 * only a project's orchestrator talks to Hermes, and gets the user's replies).
 *
 * - A reply to a message one of a project's chats sent the user goes to that chat, exactly (its runner, or the
 *   orchestrator for Main); a reply to a report, or to a message no chat sent, to the project's inbox chat (PR F).
 * - "@project #N text" goes to chat N of that project, an "#N" it has not gets the user the list of its chats and
 *   reaches nobody; "@project text" goes to its inbox chat. The inbox is Main, the orchestrator, unless the user made
 *   another chat the inbox. A name no project has, one two projects share, or a project with no orchestrator gets
 *   the user the list, or a word, and reaches nobody. The plugin keeps "@name" only for the fleet's projects, which
 *   the relay registers with it at every change.
 * - A reply to a word from Tars reaches nobody: the user is told how to reach an orchestrator.
 * - A reply to a question goes to the agent that asked (user-questions.ts registers it); to a Sentry request, to
 *   Tars itself: the error triage takes the user's go-ahead (error-triage.ts registers it).
 * - "@project" is a message the user starts through Hermes, as a Hermes job's webhook is: it reaches only a project
 *   the user allowed Hermes to reach in Settings, Hermes (#469, none by default). A reply answers a message Tars sent,
 *   and goes where that message came from.
 *
 * Each goes after the line "Message from the user via Telegram:", which only Tars writes, and holds the user's own
 * words: never the report or the message they answer, written from agents' output and page titles. A worker is
 * never typed a message under that line: a chat's runner is stored as one, and is the orchestrator of its chat.
 */

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

/** The user's words to a project's orchestrator: typed when its CLI runs, started with them otherwise. */
async function toOrchestrator(fleet: BotFleet, orchestrator: AgentStatus, projectPath: string, text: string, now: number): Promise<void> {
  await forwardToOrchestrator(fleet, orchestrator, 'Telegram', {
    message: text,
    context: '',
    sender: { kind: 'user', via: 'Telegram' },
    permissionMode: orchestrator.permissionMode ?? (orchestrator.skipPermissions ? 'bypass' : 'normal'),
    resume: true,
    systemPromptFile: () => (fs.existsSync(getSuperAgentInstructionsPath()) ? getSuperAgentInstructionsPath() : undefined),
    // A short receipt, whatever became of it (JeanBrasse's answer 24 of 2026-10-05).
    reply: async (outcome, detail) => {
      if (outcome === 'no-terminal') await tellUser(`Not delivered: the terminal of ${orchestrator.name} could not be opened.`, projectPath, now);
      else if (outcome === 'refused') await tellUser(`Not delivered: ${orchestrator.name}'s terminal is not taking messages.`, projectPath, now);
      else if (outcome === 'started') await tellUser(`Passed to ${orchestrator.name}, which was not running: it was started with your message.`, projectPath, now);
      else await tellUser(receiptFor(orchestrator.name || orchestrator.id, detail?.heldBy), projectPath, now);
    },
  });
}

/**
 * The user's words for a project: the chat a reply answers, the chat "#N"
 * names, or the inbox; Main, the orchestrator, by the path above (PR F). A
 * word back about a chat is headed by it, so a reply to it goes there too.
 */
async function toProject(fleet: BotFleet, projectPath: string, text: string, now: number, replyChatId?: string): Promise<void> {
  await deliverFromChannel({
    projectPath, text, replyChatId,
    sender: { kind: 'user', via: 'Telegram' },
    tell: (said, chat) => tellUser(said, projectPath, now, chat ? { id: chat.id, tag: chatTag(chat) } : undefined),
    toOrchestrator: async (said) => {
      const orchestrator = orchestratorOf(fleet.agents, projectPath);
      if (!orchestrator) {
        await tellUser(`Project ${projectName(projectPath)} has no orchestrator in Tars, so your message reached nobody.`, projectPath, now);
        return;
      }
      await toOrchestrator(fleet, orchestrator, projectPath, said, now);
    },
  });
}

export function startRelayRouting(fleet: BotFleet): void {
  setRelayProjects(() => projectNames(fleet.agents));
  onRelayReply('report', (reply, now) =>
    toProject(fleet, reply.projectPath, `Reply to Tars's report of ${clock(reply.sentAt)} on this project:\n${reply.text}`, now));
  onRelayReply('message', (reply, now) =>
    toProject(fleet, reply.projectPath, `Reply to your message of ${clock(reply.sentAt)}:\n${reply.text}`, now, reply.chatId));
  onRelayReply('notice', async (reply, now) => {
    await tellUser('That was a word from Tars, so your reply reached nobody. To write to a project\'s orchestrator, start your message with "@" and the project\'s name.', reply.projectPath || undefined, now);
  });
  onRelayProjectMessage(async (message, now) => {
    const target = orchestratorForProject(fleet.agents, message.project, message.text);
    if (target.kind !== 'found') {
      await tellUser(whereToWrite(target), target.kind === 'no-orchestrator' ? target.projectPath : undefined, now);
      return;
    }
    const hermes = gatewayById(DEFAULT_GATEWAY);
    if (!hermes || !gatewayReaches(hermes, target.projectPath)) {
      await tellUser(`Hermes may not reach project ${projectName(target.projectPath)}, so your message reached nobody. Allow it in Tars, Settings, Hermes.`, undefined, now);
      return;
    }
    await toProject(fleet, target.projectPath, target.text, now);
  });
}
