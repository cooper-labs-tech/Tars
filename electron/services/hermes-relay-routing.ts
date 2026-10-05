import * as fs from 'fs';
import { forwardToOrchestrator, type BotFleet } from './bot-core';
import { onRelayProjectMessage, onRelayReply, receiptFor, setRelayProjects, tellUser } from './hermes-relay';
import { orchestratorForProject, orchestratorOf, projectName, projectNames, whereToWrite } from './orchestrator-routing';
import { getSuperAgentInstructionsPath } from '../utils';
import type { AgentStatus } from '../types';

/**
 * Where the user's messages through the relay go (DESIGN-RELAIS-HERMES-V2.md, step 2; JeanBrasse's rule of 2026-10-01:
 * only a project's orchestrator talks to Hermes, and gets the user's replies).
 *
 * - A reply to a report, or to a message a project's orchestrator sent the user, goes to that project's orchestrator.
 * - "@project text" goes to that project's orchestrator; a name no project has, one two projects share, or a project
 *   with no orchestrator gets the user the list, or a word, and reaches nobody. The plugin keeps "@name" only for the
 *   fleet's projects, which the relay registers with it at every change.
 * - A reply to a word from Tars reaches nobody: the user is told how to reach an orchestrator.
 * - A reply to a question goes to the agent that asked (user-questions.ts registers it); to a Sentry request, to
 *   Tars itself (its handler, when one is registered).
 *
 * Each goes after the line "Message from the user via Telegram:", which only Tars writes, and holds the user's own
 * words: never the report or the message they answer, written from agents' output and page titles. A worker is
 * never typed a message under that line.
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

/** A reply to something of a project: to its orchestrator, or a word to the user when it has none. */
async function toProject(fleet: BotFleet, projectPath: string, text: string, now: number): Promise<void> {
  const orchestrator = orchestratorOf(fleet.agents, projectPath);
  if (!orchestrator) {
    await tellUser(`Project ${projectName(projectPath)} has no orchestrator in Tars, so your reply reached nobody.`, projectPath, now);
    return;
  }
  await toOrchestrator(fleet, orchestrator, projectPath, text, now);
}

export function startRelayRouting(fleet: BotFleet): void {
  setRelayProjects(() => projectNames(fleet.agents));
  onRelayReply('report', (reply, now) =>
    toProject(fleet, reply.projectPath, `Reply to Tars's report of ${clock(reply.sentAt)} on this project:\n${reply.text}`, now));
  onRelayReply('message', (reply, now) =>
    toProject(fleet, reply.projectPath, `Reply to your message of ${clock(reply.sentAt)}:\n${reply.text}`, now));
  onRelayReply('notice', async (reply, now) => {
    await tellUser('That was a word from Tars, so your reply reached nobody. To write to a project\'s orchestrator, start your message with "@" and the project\'s name.', reply.projectPath || undefined, now);
  });
  onRelayProjectMessage(async (message, now) => {
    const target = orchestratorForProject(fleet.agents, message.project, message.text);
    if (target.kind !== 'found') {
      await tellUser(whereToWrite(target), target.kind === 'no-orchestrator' ? target.projectPath : undefined, now);
      return;
    }
    await toOrchestrator(fleet, target.orchestrator, target.projectPath, target.text, now);
  });
}
