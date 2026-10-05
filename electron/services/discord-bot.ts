import * as fs from 'fs';
import { Client, Events, GatewayIntentBits, Partials, type Message, type MessageCreateOptions } from 'discord.js';
import { AgentStatus, AppSettings } from '../types';
import { TG_CHARACTER_FACES } from '../constants';
import { isSuperAgent, getSuperAgentInstructionsPath } from '../utils';
import { orchestratorForMessage, whereToWrite } from './orchestrator-routing';
import { agents, saveAgents, initAgentPty } from '../core/agent-manager';
import { ptyProcesses } from '../core/pty-manager';
import { getMainWindow } from '../core/window-manager';
import { getClaudeStats } from './claude-service';
import {
  findAgent, forwardToOrchestrator, priceUsage, projectsReport, startWithTask, statusDot, statusReport, stopNow,
  type BotFleet, type ClaudeUsageStats, type StatusGroup,
} from './bot-core';

/**
 * The Discord side of the chat bots: Discord's words, over the flows every bot
 * shares (bot-core.ts). Its commands are Slack's words (`status`, `start <agent>
 * <task>`...), in a direct message or after a mention of the bot, and anything
 * else goes to the orchestrator, which answers with send_discord.
 */

let discordClient: Client | null = null;
/** The channel the bot last answered in, where send_discord posts when it names none. */
let discordResponseChannel: string | null = null;
/**
 * The channels an allowed member wrote to the bot from, in this run. With the
 * channel Settings keeps, the only ones send_discord posts to: an agent does not
 * get to pick any channel the bot can see.
 */
const answeredChannels = new Set<string>();

export function getDiscordClient(): Client | null {
  return discordClient;
}

export function getDiscordResponseChannel(): string | null {
  return discordResponseChannel;
}

async function initAgentPtyWithCallbacks(agent: AgentStatus): Promise<string> {
  return initAgentPty(
    agent,
    getMainWindow(),
    (agent: AgentStatus, newStatus: string) => {
      agent.status = newStatus as AgentStatus['status'];
    },
    saveAgents
  );
}

/** The fleet as a Discord command sees it, with the settings it was handed. */
function fleetFor(appSettings: AppSettings): BotFleet {
  return { agents, ptyProcesses, settings: () => appSettings, saveAgents, initAgentPty: initAgentPtyWithCallbacks };
}

/**
 * Whether a Discord user may command Tars through the bot: only the ids in
 * Settings > Discord, and nobody while that list is empty, as for Slack (the
 * audit's lead #15). Read from the settings as they are now.
 */
export function isAllowedDiscordUser(settings: AppSettings, userId: string | undefined): boolean {
  return !!userId && (settings.discordAllowedUserIds ?? []).includes(userId);
}

/** What a sender the bot will not answer is told: why, and the id to add. */
function refusal(userId: string): string {
  return `⛔ This bot only answers the Discord users allowed in Tars Settings > Discord. Your Discord user ID is ${userId}.`;
}

/** Discord takes 2,000 characters a message. */
function cut(text: string): string {
  return text.length > 1900 ? text.slice(0, 1900) + '\n\n*(truncated)*' : text;
}

/**
 * What the bot posts: never a ping. An agent's name, a task or the orchestrator's
 * answer could hold `@everyone`, and the bot would ping a whole server with it.
 */
function post(text: string): MessageCreateOptions {
  return { content: cut(text), allowedMentions: { parse: [] } };
}

type Sendable = { send(options: MessageCreateOptions): Promise<unknown> };

export function initDiscordBot(
  getSettings: () => AppSettings,
  onSettingsChanged: (settings: AppSettings) => void,
  mainWindow?: Electron.BrowserWindow | null
): void {
  stopDiscordBot();
  // A new token can be another bot, in other servers: where the last one was
  // written from says nothing about where this one may post.
  discordResponseChannel = null;
  answeredChannels.clear();
  const appSettings = getSettings();
  if (!appSettings.discordEnabled || !appSettings.discordBotToken) {
    console.log('Discord bot disabled or no bot token');
    return;
  }

  const client = new Client({
    // Message Content is a privileged intent: without it switched on in the
    // Developer Portal every message reads empty (Settings > Discord says so).
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    // A direct message's channel is not cached: without this its messages never arrive.
    partials: [Partials.Channel],
  });
  discordClient = client;

  client.once(Events.ClientReady, ready => {
    console.log(`Discord bot signed in as ${ready.user.tag}`);
  });
  // An 'error' nobody listens to is thrown, in the main process.
  client.on(Events.Error, err => {
    console.error('Discord bot error:', err);
  });
  client.on(Events.MessageCreate, message => {
    void onMessage(client, message, getSettings, onSettingsChanged, mainWindow).catch(err => {
      console.error('Discord bot failed on a message:', err);
    });
  });

  client.login(appSettings.discordBotToken.trim()).catch(err => {
    console.error('Failed to start the Discord bot:', err instanceof Error ? err.message : err);
    if (discordClient === client) discordClient = null;
  });
}

async function onMessage(
  client: Client,
  message: Message,
  getSettings: () => AppSettings,
  onSettingsChanged: (settings: AppSettings) => void,
  mainWindow?: Electron.BrowserWindow | null,
): Promise<void> {
  if (message.author.bot) return;
  const settings = getSettings();
  const botId = client.user?.id;
  const mention = botId ? new RegExp(`<@!?${botId}>`, 'g') : null;
  const direct = !message.guildId;
  const mentioned = !!mention && mention.test(message.content);
  // In a server channel, only a message that mentions the bot is for it, unless
  // Settings says every message is. A direct message always is.
  if (!direct && !mentioned && settings.discordRequireMention !== false) return;

  const channel = message.channel as unknown as Sendable;
  const say = async (text: string) => { await channel.send(post(text)); };
  if (!isAllowedDiscordUser(settings, message.author.id)) {
    console.log(`[discord] refused a message from ${message.author.id}: not in Settings > Discord's allowed members`);
    // Told where the bot was addressed, never under every message of a channel.
    if (direct || mentioned) await say(refusal(message.author.id));
    return;
  }

  const text = (mention ? message.content.replace(mention, '') : message.content).trim();
  discordResponseChannel = message.channelId;
  answeredChannels.add(message.channelId);
  if (settings.discordChannelId !== message.channelId) {
    settings.discordChannelId = message.channelId;
    onSettingsChanged(settings);
    mainWindow?.webContents.send('settings:updated', settings);
  }
  await handleDiscordCommand(text, message.channelId, say, settings);
}

// ============== Discord's words ==============

type Say = (text: string) => Promise<unknown>;

const DOTS: Record<StatusGroup, string> = { running: '🟢', waiting: '🟡', error: '🔴', stopped: '⏹', idle: '⚪', asleep: '💤' };
const face = (a: AgentStatus) => TG_CHARACTER_FACES[a.character || ''] || '🤖';
const faceOrCrown = (a: AgentStatus) => isSuperAgent(a) ? '👑' : face(a);

const HELP =
  `👑 **Tars Bot**\n\n` +
  `**Commands:**\n` +
  `• \`status\` - Show all agents status\n` +
  `• \`agents\` - List agents with details\n` +
  `• \`projects\` - List all projects\n` +
  `• \`start <agent> <task>\` - Start an agent\n` +
  `• \`stop <agent>\` - Stop an agent\n` +
  `• \`usage\` - Show usage & cost stats\n` +
  `• \`help\` - Show this help message\n\n` +
  `Or just send a message to talk to the Super Agent!`;

/** One agent: who, where, what it can do, and its task while it runs. */
function agentLine(a: AgentStatus): string {
  let line = `${faceOrCrown(a)} **${a.name}** ${statusDot(a, DOTS)}\n`;
  if (!isSuperAgent(a)) line += `    📁 \`${a.projectPath.split('/').pop() || 'Unknown'}\`\n`;
  if (a.skills.length > 0) line += `    🛠 ${a.skills.slice(0, 3).join(', ')}${a.skills.length > 3 ? '...' : ''}\n`;
  if (a.currentTask && a.status === 'running') {
    line += `    💬 *${a.currentTask.slice(0, 40)}${a.currentTask.length > 40 ? '...' : ''}*\n`;
  }
  return line;
}

function usageReport(stats: ClaudeUsageStats): string {
  const usage = priceUsage(stats);
  let text = `📊 **Usage & Cost Summary**\n\n`;
  text += `💰 **Total Cost:** $${usage.cost.toFixed(2)}\n`;
  text += `🔢 **Total Tokens:** ${((usage.input + usage.output) / 1_000_000).toFixed(2)}M\n`;
  text += `📥 Input: ${(usage.input / 1_000_000).toFixed(2)}M\n`;
  text += `📤 Output: ${(usage.output / 1_000_000).toFixed(2)}M\n`;
  text += `💾 Cache: ${(usage.cacheRead / 1_000_000).toFixed(2)}M read\n\n`;
  if (usage.byModel.length > 0) {
    text += `**By Model:**\n`;
    usage.byModel.slice(0, 5).forEach(m => {
      const emoji = m.name.includes('Opus') ? '🟣' : m.name.includes('Sonnet') ? '🔵' : '🟢';
      text += `${emoji} ${m.name}: $${m.cost.toFixed(2)}\n`;
    });
  }
  if (stats.totalSessions || stats.totalMessages) {
    text += `\n**Activity:**\n`;
    if (stats.totalSessions) text += `📝 ${stats.totalSessions} sessions\n`;
    if (stats.totalMessages) text += `💬 ${stats.totalMessages} messages\n`;
  }
  if (stats.firstSessionDate) text += `\n*Since ${new Date(stats.firstSessionDate).toLocaleDateString()}*`;
  return text;
}

// ============== The commands ==============

async function startCommand(text: string, say: Say, appSettings: AppSettings): Promise<void> {
  const parts = text.slice(5).trim().split(' ');
  const agentName = parts[0].toLowerCase();
  const task = parts.slice(1).join(' ');
  if (!task) {
    await say('❌ Usage: `start <agent> <task>`');
    return;
  }
  const agent = findAgent(agents, agentName);
  if (!agent) {
    await say(`❌ Agent "${agentName}" not found.`);
    return;
  }
  if (agent.status === 'running') {
    await say(`⚠️ ${agent.name} is already running.`);
    return;
  }
  try {
    // Resumes the agent's last conversation on its first start after a restart, as Telegram does.
    await startWithTask(fleetFor(appSettings), agent, task, 'Discord', {
      resume: true,
      reply: outcome => {
        if (outcome === 'no-terminal') return say('❌ Failed to initialize agent terminal.');
        if (outcome === 'refused') return say(`❌ ${agent.name} has too many messages waiting for its terminal.`);
        if (outcome === 'held') return say(`⏳ ${agent.name}'s session is open but its field is in use: the task goes in once it is free.\n\nTask: ${task}`);
        if (outcome === 'written') return say(`📨 Sent to **${agent.name}**, whose session is open.\n\nTask: ${task}`);
        return say(`🚀 Started **${agent.name}**\n\n${faceOrCrown(agent)} Task: ${task}`);
      },
    });
  } catch (err) {
    console.error('Failed to start agent from Discord:', err);
    await say(`❌ Failed to start agent: ${err}`);
  }
}

async function stopCommand(text: string, say: Say, appSettings: AppSettings): Promise<void> {
  const agentName = text.slice(5).trim().toLowerCase();
  const agent = findAgent(agents, agentName);
  if (!agent) {
    await say(`❌ Agent "${agentName}" not found.`);
    return;
  }
  if (agent.status !== 'running' && agent.status !== 'waiting') {
    await say(`⚠️ ${agent.name} is not running.`);
    return;
  }
  stopNow(fleetFor(appSettings), agent);
  await say(`🛑 Stopped **${agent.name}**`);
}

/** The words Discord answers to, the first that matches; anything else goes to the orchestrator. */
const COMMANDS: Array<[(lowerText: string) => boolean, (text: string, say: Say, appSettings: AppSettings) => Promise<unknown>]> = [
  [lowerText => lowerText === 'help' || lowerText === '', (_text, say) => say(HELP)],
  [lowerText => lowerText === 'status', (_text, say) => {
    const list = Array.from(agents.values());
    if (list.length === 0) return say('📭 No agents created yet.');
    return say(statusReport(list, { title: `📊 **Agents Status**\n\n`, dot: DOTS, item: agentLine, orchestratorFirst: true, strong: '**' }));
  }],
  [lowerText => lowerText === 'agents', (_text, say) => {
    const list = Array.from(agents.values());
    if (list.length === 0) return say('📭 No agents created yet.');
    return say(`🤖 **All Agents**\n\n` + list.map(a => agentLine(a) + '\n').join(''));
  }],
  [lowerText => lowerText === 'projects', (_text, say) => say(projectsReport(agents, {
    title: `📂 **Projects**\n\n`, folder: '📁', indent: '    ', people: '👥', face, dot: DOTS, strong: '**',
  }) ?? '📭 No projects with agents yet.')],
  [lowerText => lowerText === 'usage', async (_text, say) => {
    try {
      const stats = await getClaudeStats();
      if (!stats) {
        await say('📊 No usage data available yet.');
        return;
      }
      await say(usageReport(stats as ClaudeUsageStats));
    } catch (err) {
      console.error('Failed to get usage stats:', err);
      await say(`❌ Error fetching usage data: ${err}`);
    }
  }],
  [lowerText => lowerText.startsWith('start '), startCommand],
  [lowerText => lowerText.startsWith('stop '), stopCommand],
];

export async function handleDiscordCommand(text: string, channelId: string, say: Say, appSettings: AppSettings): Promise<void> {
  const lowerText = text.toLowerCase().trim();
  const command = COMMANDS.find(([matches]) => matches(lowerText));
  if (command) {
    await command[1](text, say, appSettings);
    return;
  }
  await sendToSuperAgentFromDiscord(channelId, text, say, appSettings);
}

export async function sendToSuperAgentFromDiscord(channelId: string, message: string, say: Say, appSettings: AppSettings): Promise<void> {
  // The orchestrator the message names with "@project", or the fleet's only
  // one: never the first found, which may be another project's (point E).
  const target = orchestratorForMessage(agents, message);
  if (target.kind !== 'found') {
    await say(`👑 ${whereToWrite(target)}`);
    return;
  }
  const superAgent = target.orchestrator;

  // One line: the terminal takes a newline as Enter.
  const sanitizedMessage = target.text.replace(/\r?\n/g, ' ').trim();

  try {
    await forwardToOrchestrator(fleetFor(appSettings), superAgent, 'Discord', {
      message: sanitizedMessage,
      context: `[FROM DISCORD channel_id=${channelId} - Use send_discord MCP tool with channel_id="${channelId}" to respond!]`,
      // Its own mode, as from Slack: Discord is no reason to lift its permissions.
      permissionMode: superAgent.permissionMode ?? (superAgent.skipPermissions ? 'bypass' : 'normal'),
      resume: true,
      systemPromptFile: () => {
        const superAgentInstructionsPath = getSuperAgentInstructionsPath();
        return fs.existsSync(superAgentInstructionsPath) ? superAgentInstructionsPath : undefined;
      },
      reply: outcome => {
        if (outcome === 'no-terminal') return say('❌ Failed to connect to Super Agent terminal.');
        if (outcome === 'typed') return say('👑 Super Agent is processing...');
        return say('👑 Super Agent is processing your request...');
      },
    });
  } catch (err) {
    console.error('Failed to send to Super Agent:', err);
    await say(`❌ Error: ${err}`);
  }
}

// ============== What Tars posts on its own ==============

export type DiscordSendResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Post to Discord: to `channelId`, else where the bot last answered, else the
 * channel Settings keeps. Only to that channel or one an allowed member wrote
 * from in this run, whoever asks (send_discord is an agent's tool).
 */
export async function sendDiscordMessage(text: string, settings: AppSettings, channelId?: string): Promise<DiscordSendResult> {
  const client = discordClient;
  if (!client) return { ok: false, status: 400, error: 'Discord is not connected: switch the bot on in Settings > Discord.' };
  const target = channelId || discordResponseChannel || settings.discordChannelId;
  if (!target) return { ok: false, status: 400, error: 'No Discord channel yet: mention the bot or send it a direct message first.' };
  if (target !== settings.discordChannelId && !answeredChannels.has(target)) {
    return { ok: false, status: 403, error: `Tars posts only to the channel Settings > Discord detected, or one an allowed member wrote from: not to ${target}.` };
  }
  try {
    const channel = await client.channels.fetch(target);
    if (!channel || !('send' in channel)) return { ok: false, status: 400, error: `Discord channel ${target} cannot be written to.` };
    await (channel as unknown as Sendable).send(post(text));
    return { ok: true };
  } catch (err) {
    return { ok: false, status: 502, error: `Discord refused: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * View Channels, Send Messages and Send Messages in Threads (1024 + 2048 +
 * 2^38): all the bot does in a server is read what it is sent and answer with
 * channel.send, in the channel or the thread it was mentioned in. A mention in
 * a thread or a forum post reaches it, and without the third Discord refuses
 * the answer there, and send_discord to that thread (the Audit's gate of #200).
 * It fetches no history and replies to no message, so Read Message History
 * (65536), which it asked for until the gate of #195, is not requested. Past
 * 31 bits, so written out, never with a shift.
 */
export const DISCORD_BOT_PERMISSIONS = 274877910016;

/** The link that adds the bot to a server. A bot's application id is its user id. */
export function discordInviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot&permissions=${DISCORD_BOT_PERMISSIONS}`;
}

/**
 * The same link, from a bot token as Settings > Discord has it while it is
 * typed, before any test has asked Discord: so the page shows main's link
 * rather than building its own. A token is three dot-separated parts, the
 * first the bot's id in base64url; a value that does not carry one gives no
 * link, and only the id goes into it, never the rest, which is the secret.
 */
export function inviteUrlFromToken(token: unknown): string | null {
  // A bot token is about seventy characters. Anything much longer is not one,
  // and splitting it is work the renderer can ask of the main process: 50 MB
  // of dots held it 3.3 s (the Audit's gate of #200).
  if (typeof token !== 'string' || token.length > 200) return null;
  const [first, ...rest] = token.split('.');
  // A token has its three parts: a blank field, or an id pasted alone, invites nobody.
  if (!rest.length) return null;
  let id: string;
  try {
    // atob is forgiving about what a paste brings (spaces, the padding
    // base64url leaves off), and refuses base64url's own `-` and `_`, which an
    // id's encoding never holds: ASCII digits never reach index 62 or 63.
    id = atob(first);
  } catch {
    return null;
  }
  return /^\d{17,20}$/.test(id) ? discordInviteUrl(id) : null;
}

export type DiscordTokenCheck =
  | { success: true; botName: string; inviteUrl: string }
  | { success: false; error: string };

/** Asks Discord who the token is, without opening the gateway: the bot's name and the link to invite it. */
export async function testDiscordToken(token: string | undefined): Promise<DiscordTokenCheck> {
  const bot = token?.trim();
  if (!bot) return { success: false, error: 'Set the bot token first.' };
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${bot}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return { success: false, error: 'Discord refused the token: reset it in the Developer Portal and paste the new one.' };
    if (!res.ok) return { success: false, error: `Discord answered HTTP ${res.status}.` };
    const me = await res.json() as { id?: string; username?: string };
    if (!me.id) return { success: false, error: 'Discord answered without the bot\'s id.' };
    return { success: true, botName: me.username || 'the bot', inviteUrl: discordInviteUrl(me.id) };
  } catch (err) {
    return { success: false, error: `Discord did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function stopDiscordBot(): void {
  if (discordClient) {
    const client = discordClient;
    discordClient = null;
    void client.destroy().catch(err => console.error('Error stopping the Discord bot:', err));
    console.log('Discord bot stopped');
  }
}
