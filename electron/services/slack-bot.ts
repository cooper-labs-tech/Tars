import * as fs from 'fs';
import { App as SlackApp, LogLevel } from '@slack/bolt';
import { AgentStatus, AppSettings } from '../types';
import { SLACK_CHARACTER_FACES } from '../constants';
import { formatSlackAgentStatus, isSuperAgent, getSuperAgentInstructionsPath } from '../utils';
import { orchestratorForMessage, whereToWrite } from './orchestrator-routing';
import { agents, saveAgents, initAgentPty } from '../core/agent-manager';
import { ptyProcesses } from '../core/pty-manager';
import { getMainWindow } from '../core/window-manager';
import { getClaudeStats as readClaudeStats } from './claude-service';
import {
  findAgent, forwardToOrchestrator, projectsReport, startWithTask, statusReport, stopNow,
  type BotFleet, type StatusGroup,
} from './bot-core';

/**
 * The Slack side of the chat bots: Slack's words and command syntax, over the
 * flows every bot shares (bot-core.ts).
 */

// Slack bot state
let slackApp: SlackApp | null = null;
let slackResponseChannel: string | null = null;
let slackResponseThreadTs: string | null = null; // Track thread timestamp for replies

// Export references for external access
export function getSlackApp(): SlackApp | null {
  return slackApp;
}

export function getSlackResponseChannel(): string | null {
  return slackResponseChannel;
}

export function getSlackResponseThreadTs(): string | null {
  return slackResponseThreadTs;
}

// Helper to initialize agent PTY with proper callbacks
async function initAgentPtyWithCallbacks(agent: AgentStatus): Promise<string> {
  return initAgentPty(
    agent,
    getMainWindow(),
    (agent: AgentStatus, newStatus: string) => {
      // Simple status change handler - just update the agent
      agent.status = newStatus as AgentStatus['status'];
    },
    saveAgents
  );
}

/** The fleet as a Slack command sees it, with the settings it was handed. */
function fleetFor(appSettings: AppSettings): BotFleet {
  return { agents, ptyProcesses, settings: () => appSettings, saveAgents, initAgentPty: initAgentPtyWithCallbacks };
}

// Send message to Slack
export async function sendSlackMessage(
  text: string,
  appSettings: AppSettings,
  channel?: string
): Promise<void> {
  if (!slackApp || (!channel && !appSettings.slackChannelId)) return;

  const targetChannel = channel || appSettings.slackChannelId;
  try {
    // Slack has a 4000 char limit for text, truncate if needed
    const maxLen = 3900;
    const truncated =
      text.length > maxLen ? text.slice(0, maxLen) + '\n\n_(truncated)_' : text;
    await slackApp.client.chat.postMessage({
      channel: targetChannel,
      text: `:crown: ${truncated}`,
      mrkdwn: true,
    });
  } catch (err) {
    console.error('Failed to send Slack message:', err);
  }
}

// Initialize Slack bot
/**
 * Whether a Slack user may command Tars through the bot: only the ids in
 * Settings > Slack, and nobody while that list is empty. Before it, the bot
 * acted on any human sender (the audit's lead #15). Read from the settings as
 * they are now, so an id added or removed in Settings counts at once.
 */
export function isAllowedSlackUser(settings: AppSettings, userId: string | undefined): boolean {
  return !!userId && (settings.slackAllowedUserIds ?? []).includes(userId);
}

/** What a sender the bot will not answer is told: why, and the id to add. */
function refusal(userId: string | undefined): string {
  return `:no_entry: This bot only answers the Slack users allowed in Tars Settings > Slack.`
    + (userId ? ` Your Slack user ID is ${userId}.` : '');
}

export function initSlackBot(
  getSettings: () => AppSettings,
  onSettingsChanged: (settings: AppSettings) => void,
  mainWindow?: Electron.BrowserWindow | null
): void {
  // The settings as they are now, at each event: a save replaces main's object,
  // and the bot kept its own (the audit's lead #19, the Slack side of it).
  const appSettings = getSettings();
  // Stop existing bot if any
  if (slackApp) {
    slackApp.stop().catch(err => console.error('Error stopping Slack app:', err));
    slackApp = null;
  }

  if (!appSettings.slackEnabled || !appSettings.slackBotToken || !appSettings.slackAppToken) {
    console.log('Slack bot disabled or missing tokens');
    return;
  }

  try {
    slackApp = new SlackApp({
      token: appSettings.slackBotToken,
      appToken: appSettings.slackAppToken,
      socketMode: true,
      logLevel: LogLevel.DEBUG,
    });

    // Handle app mentions
    slackApp.event('app_mention', async ({ event, say }) => {
      console.log('Slack app_mention event received:', JSON.stringify(event, null, 2));
      const settings = getSettings();
      // Before anything else, the channel included: an unknown sender does not
      // get to choose where agents' send_slack goes.
      if (!isAllowedSlackUser(settings, event.user)) {
        console.log(`[slack] refused a mention from ${event.user ?? 'an unknown user'}: not in Settings > Slack's allowed users`);
        await say(refusal(event.user));
        return;
      }
      // Remove the bot mention from the text
      const text = event.text.replace(/<@[A-Z0-9]+>/gi, '').trim();
      slackResponseChannel = event.channel;
      // Use thread_ts if replying in a thread, otherwise use the message ts to start a thread
      slackResponseThreadTs =
        (event as { thread_ts?: string; ts?: string }).thread_ts ||
        (event as { ts?: string }).ts ||
        null;

      // Save channel ID
      if (settings.slackChannelId !== event.channel) {
        settings.slackChannelId = event.channel;
        onSettingsChanged(settings);
        mainWindow?.webContents.send('settings:updated', settings);
      }

      await handleSlackCommand(text, event.channel, say, settings, mainWindow);
    });

    // Handle direct messages - use 'message' event with subtype filter
    slackApp.message(async ({ message, say }) => {
      // Cast to any for flexibility with Slack's complex message types
      const msg = message as {
        bot_id?: string;
        subtype?: string;
        text?: string;
        user?: string;
        channel: string;
        channel_type?: string;
        ts?: string;
        thread_ts?: string;
      };
      console.log('Slack message event received:', JSON.stringify(msg, null, 2));

      // Skip bot messages and message changes/deletions
      if (msg.bot_id) return;
      if (msg.subtype) return; // Skip edited, deleted, etc.
      if (!msg.text) return;

      const settings = getSettings();
      if (!isAllowedSlackUser(settings, msg.user)) {
        console.log(`[slack] refused a message from ${msg.user ?? 'an unknown user'}: not in Settings > Slack's allowed users`);
        // Told in a direct message, where the bot was addressed; not in every
        // channel message it happens to receive.
        if (msg.channel_type === 'im') await say(refusal(msg.user));
        return;
      }

      const channel = msg.channel;
      slackResponseChannel = channel;
      // Use thread_ts if replying in a thread, otherwise use the message ts to start a thread
      slackResponseThreadTs = msg.thread_ts || msg.ts || null;

      // Save channel for responses
      if (settings.slackChannelId !== channel) {
        settings.slackChannelId = channel;
        onSettingsChanged(settings);
        mainWindow?.webContents.send('settings:updated', settings);
      }

      await sendToSuperAgentFromSlack(channel, msg.text, say, settings, mainWindow);
    });

    // Log all events for debugging
    slackApp.use(async ({ next, payload }) => {
      console.log('Slack event payload type:', payload?.type || 'unknown');
      await next();
    });

    // Start the app
    slackApp
      .start()
      .then(() => {
        console.log('Slack bot started (Socket Mode)');
      })
      .catch(err => {
        console.error('Failed to start Slack bot:', err);
        slackApp = null;
      });
  } catch (err) {
    console.error('Failed to initialize Slack bot:', err);
    slackApp = null;
  }
}

// ============== Slack's words ==============

type Say = (msg: string) => Promise<unknown>;

const DOTS: Record<StatusGroup, string> = {
  running: ':large_green_circle:', waiting: ':large_yellow_circle:', error: ':red_circle:', stopped: ':black_square_for_stop:', idle: ':white_circle:', asleep: ':zzz:',
};
const face = (a: AgentStatus) => SLACK_CHARACTER_FACES[a.character || ''] || ':robot_face:';

const HELP =
  `:crown: *Tars Bot*\n\n` +
  `*Commands:*\n` +
  `• \`status\` - Show all agents status\n` +
  `• \`agents\` - List agents with details\n` +
  `• \`projects\` - List all projects\n` +
  `• \`start <agent> <task>\` - Start an agent\n` +
  `• \`stop <agent>\` - Stop an agent\n` +
  `• \`usage\` - Show usage & cost stats\n` +
  `• \`help\` - Show this help message\n\n` +
  `Or just send a message to talk to the Super Agent!`;

// ============== `usage`, with Slack's own price table ==============

/** The part of Claude's stats `usage` reads, each field of it defensively. */
interface SlackClaudeStats {
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }>;
}

// Another reader of Claude's stats, for tests; the app uses the Usage page's own.
let getClaudeStatsRef: (() => Promise<SlackClaudeStats | undefined>) | null = null;

export function setGetClaudeStatsRef(fn: () => Promise<SlackClaudeStats | undefined>): void {
  getClaudeStatsRef = fn;
}

async function getClaudeStats(): Promise<SlackClaudeStats | undefined> {
  if (!getClaudeStatsRef) {
    // The stats the Usage page and Telegram's /usage read. Nothing in the app
    // set a reader, and `usage` said "No usage data" whatever the data (#176).
    return ((await readClaudeStats()) ?? undefined) as SlackClaudeStats | undefined;
  }
  return getClaudeStatsRef();
}

// Fewer models than Telegram's: every model but Opus 4.5 is priced as Sonnet 4.
const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number; cacheHitsPerMTok: number; cache5mWritePerMTok: number }> = {
  'claude-opus-4-5-20251101': { inputPerMTok: 5, outputPerMTok: 25, cacheHitsPerMTok: 0.5, cache5mWritePerMTok: 6.25 },
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25, cacheHitsPerMTok: 0.5, cache5mWritePerMTok: 6.25 },
  'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.3, cache5mWritePerMTok: 3.75 },
};

function modelPricing(modelId: string) {
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId];
  const lower = modelId.toLowerCase();
  if (lower.includes('opus-4-5') || lower.includes('opus-4.5')) return MODEL_PRICING['claude-opus-4-5'];
  return MODEL_PRICING['claude-sonnet-4'];
}

function usageReport(stats: SlackClaudeStats): string {
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  Object.entries(stats.modelUsage ?? {}).forEach(([modelId, usageUnknown]) => {
    const usage = usageUnknown as Record<string, unknown>;
    const input = (usage.inputTokens as number) || 0;
    const output = (usage.outputTokens as number) || 0;
    const cacheRead = (usage.cacheReadInputTokens as number) || 0;
    const cacheWrite = (usage.cacheCreationInputTokens as number) || 0;
    totalInput += input;
    totalOutput += output;
    const pricing = modelPricing(modelId);
    const inputCost = (input * pricing.inputPerMTok) / 1000000;
    const outputCost = (output * pricing.outputPerMTok) / 1000000;
    const cacheReadCost = (cacheRead * pricing.cacheHitsPerMTok) / 1000000;
    const cacheWriteCost = (cacheWrite * pricing.cache5mWritePerMTok) / 1000000;
    totalCost += inputCost + outputCost + cacheReadCost + cacheWriteCost;
  });

  let statsText = ':bar_chart: *Usage Stats*\n\n';
  statsText += `Input Tokens: ${totalInput.toLocaleString()}\n`;
  statsText += `Output Tokens: ${totalOutput.toLocaleString()}\n`;
  statsText += `Total Cost: $${totalCost.toFixed(2)}\n`;
  return statsText;
}

// ============== The commands ==============

async function startCommand(text: string, say: Say, appSettings: AppSettings): Promise<void> {
  const parts = text.slice(5).trim().split(' ');
  const agentName = parts[0].toLowerCase();
  const task = parts.slice(1).join(' ');
  if (!task) {
    await say(':x: Usage: `start <agent> <task>`');
    return;
  }
  const agent = findAgent(agents, agentName);
  if (!agent) {
    await say(`:x: Agent "${agentName}" not found.`);
    return;
  }
  if (agent.status === 'running') {
    await say(`:warning: ${agent.name} is already running.`);
    return;
  }
  try {
    // A new conversation each time: unlike Telegram, Slack never resumes one.
    await startWithTask(fleetFor(appSettings), agent, task, 'Slack', {
      resume: false,
      reply: outcome => {
        if (outcome === 'no-terminal') return say(':x: Failed to initialize agent terminal.');
        if (outcome === 'refused') return say(`:x: ${agent.name} has too many messages waiting for its terminal.`);
        if (outcome === 'held') return say(`:hourglass: ${agent.name}'s session is open but its field is in use: the task goes in once it is free.\n\nTask: ${task}`);
        if (outcome === 'written') return say(`:incoming_envelope: Sent to *${agent.name}*, whose session is open\n\nTask: ${task}`);
        const emoji = isSuperAgent(agent) ? ':crown:' : face(agent);
        return say(`:rocket: Started *${agent.name}*\n\n${emoji} Task: ${task}`);
      },
    });
  } catch (err) {
    console.error('Failed to start agent from Slack:', err);
    await say(`:x: Failed to start agent: ${err}`);
  }
}

async function stopCommand(text: string, say: Say, appSettings: AppSettings): Promise<void> {
  const agentName = text.slice(5).trim().toLowerCase();
  const agent = findAgent(agents, agentName);
  if (!agent) {
    await say(`:x: Agent "${agentName}" not found.`);
    return;
  }
  if (agent.status !== 'running' && agent.status !== 'waiting') {
    await say(`:warning: ${agent.name} is not running.`);
    return;
  }
  stopNow(fleetFor(appSettings), agent);
  await say(`:octagonal_sign: Stopped *${agent.name}*`);
}

/** The words Slack answers to, the first that matches; anything else goes to the orchestrator. */
const COMMANDS: Array<[(lowerText: string) => boolean, (text: string, say: Say, appSettings: AppSettings) => Promise<unknown>]> = [
  [lowerText => lowerText === 'help' || lowerText === '', (_text, say) => say(HELP)],
  [lowerText => lowerText === 'status', (_text, say) => {
    const list = Array.from(agents.values());
    if (list.length === 0) return say(':package: No agents created yet.');
    return say(statusReport(list, { title: `:bar_chart: *Agents Status*\n\n`, dot: DOTS, item: formatSlackAgentStatus, orchestratorFirst: false }));
  }],
  [lowerText => lowerText === 'agents', (_text, say) => {
    const list = Array.from(agents.values());
    if (list.length === 0) return say(':package: No agents created yet.');
    return say(`:robot_face: *All Agents*\n\n` + list.map(a => formatSlackAgentStatus(a) + '\n').join(''));
  }],
  [lowerText => lowerText === 'projects', (_text, say) => say(projectsReport(agents, {
    title: `:file_folder: *Projects*\n\n`, folder: ':open_file_folder:', indent: '    ', people: ':busts_in_silhouette:', face, dot: DOTS,
  }) ?? ':package: No projects with agents yet.')],
  [lowerText => lowerText === 'usage', async (_text, say) => {
    try {
      const stats = await getClaudeStats();
      if (!stats) {
        await say(':bar_chart: No usage data available yet.');
        return;
      }
      await say(usageReport(stats));
    } catch (err) {
      console.error('Failed to get usage stats:', err);
      await say(':x: Failed to get usage stats');
    }
  }],
  [lowerText => lowerText.startsWith('start '), startCommand],
  [lowerText => lowerText.startsWith('stop '), stopCommand],
];

// Handle Slack commands
export async function handleSlackCommand(
  text: string,
  channel: string,
  say: (msg: string) => Promise<unknown>,
  appSettings: AppSettings,
  mainWindow?: Electron.BrowserWindow | null
): Promise<void> {
  const lowerText = text.toLowerCase().trim();
  const command = COMMANDS.find(([matches]) => matches(lowerText));
  if (command) {
    await command[1](text, say, appSettings);
    return;
  }

  // Default: forward to Super Agent
  await sendToSuperAgentFromSlack(channel, text, say, appSettings, mainWindow);
}

// Send message to Super Agent from Slack
export async function sendToSuperAgentFromSlack(
  channel: string,
  message: string,
  say: (msg: string) => Promise<unknown>,
  appSettings: AppSettings,
  mainWindow?: Electron.BrowserWindow | null
): Promise<void> {
  // The orchestrator the message names with "@project", or the fleet's only
  // one: never the first found, which may be another project's (point E).
  const target = orchestratorForMessage(agents, message);
  if (target.kind !== 'found') {
    await say(`:crown: ${whereToWrite(target)}`);
    return;
  }
  const superAgent = target.orchestrator;

  // Sanitize message - replace newlines with spaces for terminal compatibility
  const sanitizedMessage = target.text.replace(/\r?\n/g, ' ').trim();

  try {
    await forwardToOrchestrator(fleetFor(appSettings), superAgent, 'Slack', {
      message: sanitizedMessage,
      // Simple prompt with Slack context: the detail comes from the file.
      context: '[FROM SLACK - Use send_slack MCP tool to respond!]',
      permissionMode: superAgent.permissionMode ?? (superAgent.skipPermissions ? 'bypass' : 'normal'),
      resume: false,
      // The instructions travel as a FILE: inlined into a double-quoted shell
      // word, the ~124 markdown backticks in super-agent-instructions.md became
      // command substitutions, so `whoami` really ran, every backticked MCP
      // tool name was executed and its text deleted from the prompt.
      systemPromptFile: () => {
        const superAgentInstructionsPath = getSuperAgentInstructionsPath();
        return fs.existsSync(superAgentInstructionsPath) ? superAgentInstructionsPath : undefined;
      },
      reply: outcome => {
        if (outcome === 'no-terminal') return say(':x: Failed to connect to Super Agent terminal.');
        if (outcome === 'typed') return say(':crown: Super Agent is processing...');
        return say(':crown: Super Agent is processing your request...');
      },
    });
  } catch (err) {
    console.error('Failed to send to Super Agent:', err);
    await say(`:x: Error: ${err}`);
  }
}

// Stop Slack bot
export function stopSlackBot(): void {
  if (slackApp) {
    slackApp.stop().catch(err => console.error('Error stopping Slack app:', err));
    slackApp = null;
    console.log('Slack bot stopped');
  }
}
