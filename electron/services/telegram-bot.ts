import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { BrowserWindow } from 'electron';
import TelegramBot from 'node-telegram-bot-api';
import * as pty from 'node-pty';
import { AgentStatus, AppSettings } from '../types';
import { TG_CHARACTER_FACES, TELEGRAM_DOWNLOADS_DIR, dataPath } from '../constants';
import { redactSecrets } from '../utils/redact-secrets';
import { isSuperAgent, formatAgentStatus, getSuperAgentInstructions, getSuperAgentInstructionsPath, getTelegramInstructions } from '../utils';
import { orchestratorForMessage, whereToWrite } from './orchestrator-routing';
import {
  findAgent, forwardToOrchestrator, priceUsage, projectsReport, startWithTask, statusReport, stopNow,
  type BotFleet, type ClaudeUsageStats, type StatusGroup,
} from './bot-core';

/**
 * The Telegram side of the chat bots: Telegram's commands, words and files,
 * over the flows every bot shares (bot-core.ts).
 */

// ============== Telegram Bot State ==============
let telegramBot: TelegramBot | null = null;
let botUsername: string | null = null; // Cached bot username for mention detection
let currentResponseChatId: string | null = null; // Track which chat to respond to

/**
 * How many wrong tokens /auth takes: five from one chat and twenty from all
 * chats together in any fifteen minutes (the Audit's gate of #176). Past
 * either, a token is neither compared nor counted: the refusal says the same
 * to a right guess as to a wrong one, and the list never holds more than
 * twenty misses. A restart of the bot starts the count again.
 */
const AUTH_WINDOW_MS = 15 * 60_000;
const AUTH_MISSES_PER_CHAT = 5;
const AUTH_MISSES_IN_ALL = 20;
let authMisses: Array<{ chatId: string; at: number }> = [];

/**
 * When /auth compares this chat's token again, rounded up to the minute, or 0
 * when it may now. The refusal names that time and the one way to lift the
 * limit sooner, which a lock-out from the global count needs: twenty misses
 * from anywhere keep every new chat out, JeanBrasse's included (the Audit's gate of
 * #200). Turning Telegram off and on in Settings restarts the bot, which starts
 * the count again; nothing outside Settings can.
 */
function authWait(chatId: string, now: number): number {
  authMisses = authMisses.filter(m => now - m.at < AUTH_WINDOW_MS);
  const mine = authMisses.filter(m => m.chatId === chatId);
  const since = mine.length >= AUTH_MISSES_PER_CHAT ? mine[0].at
    : authMisses.length >= AUTH_MISSES_IN_ALL ? authMisses[0].at
    : undefined;
  return since === undefined ? 0 : Math.ceil((since + AUTH_WINDOW_MS) / 60_000) * 60_000;
}

/**
 * The settings as they are now. A getter, not the object the bot was started
 * with: app:saveSettings replaces main's object on every save, and the bot kept
 * checking chats and /auth tokens against the old one, so a chat removed or a
 * token regenerated in Settings stayed good until a restart (the audit's lead
 * #19). Every read goes through here.
 */
let getSettings: () => AppSettings = () => ({} as AppSettings);
/** What `/usage` reads out of Claude Code's own usage data (bot-core.ts). */
type ClaudeStats = ClaudeUsageStats;

let fleet: BotFleet;
let mainWindow: BrowserWindow | null;
let getClaudeStats: () => Promise<ClaudeStats | null>;
let saveAppSettings: (settings: AppSettings) => void;

/**
 * Initialize Telegram bot service with external dependencies
 */
export function initTelegramBotService(
  agentsMap: Map<string, AgentStatus>,
  ptyMap: Map<string, pty.IPty>,
  settings: () => AppSettings,
  window: BrowserWindow | null,
  // No longer read: a message names its project (orchestrator-routing.ts).
  // Kept so that the callers' arguments keep their places until the bot goes.
  _getSuperAgentFn: () => AgentStatus | undefined,
  saveAgentsFn: () => void,
  getClaudeStatsFn: () => Promise<ClaudeStats | null>,
  initAgentPtyFn: (agent: AgentStatus) => Promise<string>,
  saveAppSettingsFn: (settings: AppSettings) => void
) {
  fleet = { agents: agentsMap, ptyProcesses: ptyMap, settings, saveAgents: saveAgentsFn, initAgentPty: initAgentPtyFn };
  getSettings = settings;
  mainWindow = window;
  getClaudeStats = getClaudeStatsFn;
  saveAppSettings = saveAppSettingsFn;
}

/**
 * Send message to Telegram
 * @param text - Message text
 * @param parseMode - Markdown or HTML
 * @param targetChatId - Specific chat ID to send to (if not provided, sends to current response chat or all authorized)
 */
export function sendTelegramMessage(text: string, parseMode: 'Markdown' | 'HTML' = 'Markdown', targetChatId?: string) {
  if (!telegramBot) return;

  // Telegram has a 4096 char limit, truncate if needed
  const maxLen = 4000;
  const truncated = text.length > maxLen ? text.slice(0, maxLen) + '\n\n_(truncated)_' : text;

  // If specific target provided, send only to that chat
  if (targetChatId) {
    sendToChat(targetChatId, truncated, parseMode, text);
    return;
  }

  // A chat removed in Settings since it asked is forgotten here, and what it
  // would have received goes where a notice goes. It was checked when it
  // wrote in and never again, so it went on receiving the super agent's
  // replies, its errors and main's notices (the audit's gate of #137).
  if (currentResponseChatId && !sendableChats().has(currentResponseChatId)) {
    currentResponseChatId = null;
  }

  // If we have a current response chat (from an active Telegram task), send there
  if (currentResponseChatId) {
    sendToChat(currentResponseChatId, truncated, parseMode, text);
    return;
  }

  // Fallback: send to all authorized users (for notifications not from a specific chat)
  const chatIds = getSettings().telegramAuthorizedChatIds?.length > 0
    ? getSettings().telegramAuthorizedChatIds
    : (getSettings().telegramChatId ? [getSettings().telegramChatId] : []);

  if (chatIds.length === 0) return;

  for (const chatId of chatIds) {
    sendToChat(chatId, truncated, parseMode, text);
  }
}

/**
 * The chats this bot may send to, as the settings are now: the ones JeanBrasse
 * authorized and the default chat, the set the send route and mcp-telegram
 * accept. Read at every send.
 */
function sendableChats(): Set<string> {
  const settings = getSettings();
  return new Set([settings.telegramChatId, ...(settings.telegramAuthorizedChatIds ?? [])].filter(Boolean).map(String));
}

/**
 * Helper to send to a specific chat with error handling
 */
function sendToChat(chatId: string, truncated: string, parseMode: 'Markdown' | 'HTML', originalText: string) {
  if (!telegramBot) return;
  // Every send that is not a reply to a message passes here, so a chat
  // Settings does not allow is refused here, whoever named it.
  if (!sendableChats().has(String(chatId))) {
    console.warn(`Telegram: not sending to chat ${chatId}, which Settings does not authorize`);
    return;
  }
  try {
    telegramBot.sendMessage(chatId, truncated, { parse_mode: parseMode });
  } catch (err) {
    console.error(`Failed to send Telegram message to ${chatId}:`, err);
    // Try without markdown if it fails (in case of formatting issues)
    try {
      telegramBot.sendMessage(chatId, originalText.replace(/[*_`\[\]]/g, ''));
    } catch {
      // Give up
    }
  }
}

/**
 * Extract meaningful response from Super Agent output and send to Telegram
 */
export function sendSuperAgentResponseToTelegram(agent: AgentStatus) {
  const rawOutput = agent.output.slice(-100).join('');

  // Remove ANSI escape codes, then take the secrets out.
  //
  // This is the last thing that touches the text before it leaves the machine,
  // and it used to be ANSI-stripping alone. An agent's PTY environment carries
  // ANTHROPIC_API_KEY, which for every provider except the local ones is the
  // user's real vendor key, so one `env`, one verbose curl, or one stack trace
  // that prints its config put it in a chat.
  const cleanOutput = redactSecrets(
    rawOutput
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\x1b\[\?[0-9]*[hl]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '') // OSC sequences
      .replace(/[\x00-\x09\x0B-\x1F]/g, ''), // Control chars except newline
  );

  const lines = cleanOutput.split('\n');

  // The response usually comes after the tool results: collect the lines that
  // follow one, leaving out the TUI's own (tool markers, rules, prompts, boxes).
  const responseLines: string[] = [];
  let foundToolResult = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.includes('⎿') || trimmed.includes('(MCP)')) {
      foundToolResult = true;
      continue;
    }
    if (trimmed.startsWith('●') || trimmed.startsWith('⏺') ||
        trimmed.includes('ctrl+') || trimmed.startsWith('---') ||
        trimmed.startsWith('>') || trimmed.startsWith('$') ||
        trimmed.includes('╭') || trimmed.includes('╰') ||
        trimmed.includes('│') && trimmed.length < 5) {
      continue;
    }
    if (foundToolResult && trimmed.length > 3) responseLines.push(trimmed);
  }

  if (responseLines.length > 0) {
    // The last portion, likely the summary.
    const response = responseLines.slice(-40).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (response.length > 10) {
      sendTelegramMessage(`👑 ${response}`);
      return;
    }
  }

  // Fallback: the last meaningful lines we can find
  const fallbackLines = lines
    .map(l => l.trim())
    .filter(l => l.length > 10 &&
      !l.includes('(MCP)') &&
      !l.includes('⎿') &&
      !l.startsWith('●') &&
      !l.startsWith('⏺') &&
      !l.includes('ctrl+'))
    .slice(-20);

  if (fallbackLines.length > 0) {
    sendTelegramMessage(`👑 ${fallbackLines.join('\n')}`);
  } else {
    sendTelegramMessage(`✅ Super Agent completed the task.`);
  }
}

/**
 * Check if a chat ID is authorized
 */
function isAuthorized(chatId: string): boolean {
  return getSettings().telegramAuthorizedChatIds?.includes(chatId) || false;
}

/**
 * Check if the bot should respond to a message
 * Returns true if:
 * - It's a private/direct message (always respond)
 * - telegramRequireMention is disabled (respond to all)
 * - telegramRequireMention is enabled AND the bot is @mentioned
 */
function shouldRespondToMessage(msg: TelegramBot.Message): boolean {
  const chatType = msg.chat.type;
  const text = msg.text || msg.caption || '';

  // Always respond to private/direct messages
  if (chatType === 'private') {
    console.log(`Telegram: Private chat, responding`);
    return true;
  }

  // If require mention is disabled, always respond
  if (!getSettings().telegramRequireMention) {
    console.log(`Telegram: Mention not required, responding to group message`);
    return true;
  }

  console.log(`Telegram: Checking for mention in ${chatType} chat. Bot username: @${botUsername || 'NOT_LOADED'}`);
  console.log(`Telegram: Message text: "${text.substring(0, 100)}"`);

  // If botUsername isn't loaded yet, we can't detect mentions properly
  // In this case, don't respond (user will need to retry after bot fully initializes)
  if (!botUsername) {
    console.log(`Telegram: Bot username not loaded yet, skipping message`);
    return false;
  }

  // Check for @username mention (case insensitive)
  const mentionPattern = `@${botUsername}`;
  if (text.toLowerCase().includes(mentionPattern.toLowerCase())) {
    console.log(`Telegram: Found mention in text`);
    return true;
  }

  // Check entities for bot mention (more reliable for formatted mentions)
  const entities = msg.entities || msg.caption_entities || [];
  for (const entity of entities) {
    if (entity.type === 'mention') {
      const mention = text.substring(entity.offset, entity.offset + entity.length);
      console.log(`Telegram: Found mention entity: "${mention}"`);
      if (mention.toLowerCase() === mentionPattern.toLowerCase()) {
        console.log(`Telegram: Mention matches bot username`);
        return true;
      }
    }
    // Also check text_mention (for users without public username mentioned by ID)
    if (entity.type === 'text_mention' && (entity as { user?: { is_bot?: boolean } }).user?.is_bot) {
      console.log(`Telegram: Found text_mention for bot`);
      return true;
    }
  }

  console.log(`Telegram: No mention found, not responding`);
  return false;
}

/**
 * Remove bot mention from message text for cleaner prompts
 */
function removeBotMention(text: string): string {
  if (!botUsername) return text;
  return text.replace(new RegExp(`@${botUsername}\\s*`, 'gi'), '').trim();
}

/**
 * Send unauthorized message
 */
function sendUnauthorizedMessage(chatId: string | number) {
  telegramBot?.sendMessage(chatId,
    `🔒 *Authentication Required*\n\n` +
    `You are not authorized to use this bot.\n\n` +
    `Use \`/auth <token>\` with your secret token to authenticate.\n\n` +
    `_Get the token from Tars Settings → Telegram_`,
    { parse_mode: 'Markdown' }
  );
}

/**
 * Download a file from Telegram servers
 */
async function downloadTelegramFile(fileId: string, fileName: string): Promise<string> {
  if (!telegramBot || !getSettings().telegramBotToken) {
    throw new Error('Telegram bot not initialized');
  }

  if (!fs.existsSync(TELEGRAM_DOWNLOADS_DIR)) {
    fs.mkdirSync(TELEGRAM_DOWNLOADS_DIR, { recursive: true });
  }

  // Get file info from Telegram
  const file = await telegramBot.getFile(fileId);
  if (!file.file_path) {
    throw new Error('Could not get file path from Telegram');
  }

  // Generate unique filename with timestamp
  const timestamp = Date.now();
  const ext = path.extname(fileName) || path.extname(file.file_path) || '';
  const baseName = path.basename(fileName, ext) || 'file';
  const uniqueFileName = `${timestamp}-${baseName}${ext}`;
  const localPath = path.join(TELEGRAM_DOWNLOADS_DIR, uniqueFileName);

  // Download file from Telegram
  const fileUrl = `https://api.telegram.org/file/bot${getSettings().telegramBotToken}/${file.file_path}`;

  return new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(localPath);
    // A write stream reports a file it cannot create or write, a full disk or
    // a folder it may not write in, with 'error'. Nothing listened, and an
    // 'error' nobody hears is thrown: in the main process, the "Uncaught
    // Exception" window, while the chat waited for an answer that never came.
    fileStream.on('error', (err) => {
      fs.unlink(localPath, () => {});
      reject(err);
    });
    https.get(fileUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download file: HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        console.log(`Downloaded Telegram file to: ${localPath}`);
        resolve(localPath);
      });
    }).on('error', (err) => {
      fs.unlink(localPath, () => {}); // Clean up partial file
      reject(err);
    });
  });
}

/**
 * Get file type description for the agent
 */
function getFileTypeDescription(mimeType?: string, fileName?: string): string {
  if (mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType === 'application/pdf') return 'PDF document';
    if (mimeType.includes('document') || mimeType.includes('word')) return 'document';
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'spreadsheet';
  }
  if (fileName) {
    const ext = path.extname(fileName).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image';
    if (['.mp4', '.mov', '.avi', '.webm', '.mkv'].includes(ext)) return 'video';
    if (['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(ext)) return 'audio';
    if (ext === '.pdf') return 'PDF document';
    if (['.doc', '.docx', '.odt', '.rtf'].includes(ext)) return 'document';
    if (['.xls', '.xlsx', '.csv', '.ods'].includes(ext)) return 'spreadsheet';
    if (['.ppt', '.pptx', '.odp'].includes(ext)) return 'presentation';
    if (['.zip', '.tar', '.gz', '.rar', '.7z'].includes(ext)) return 'archive';
    if (['.js', '.ts', '.py', '.java', '.cpp', '.c', '.h', '.go', '.rs', '.rb'].includes(ext)) return 'code file';
    if (['.json', '.xml', '.yaml', '.yml', '.toml'].includes(ext)) return 'data file';
    if (['.md', '.txt', '.log'].includes(ext)) return 'text file';
  }
  return 'file';
}

// ============== Telegram's words ==============
//
// Every send gets an options object of its own: the SDK writes chat_id and
// text into the one it is given, so a shared one would carry the last send's.

const DOTS: Record<StatusGroup, string> = { running: '🟢', waiting: '🟡', error: '🔴', stopped: '⏹', idle: '⚪', asleep: '💤' };
const face = (a: AgentStatus) => TG_CHARACTER_FACES[a.character || ''] || '🤖';
const faceOrCrown = (a: AgentStatus) => isSuperAgent(a) ? '👑' : face(a);

const WELCOME =
  `👑 *Tars Bot Connected!*\n\n` +
  `I'll help you manage your agents remotely.\n\n` +
  `*Commands:*\n` +
  `/status - Show all agents status\n` +
  `/agents - List agents with details\n` +
  `/projects - List all projects\n` +
  `/start\\_agent <name> <task> - Start an agent\n` +
  `/stop\\_agent <name> - Stop an agent\n` +
  `/ask <message> - Send to Super Agent\n` +
  `/usage - Show usage & cost stats\n` +
  `/help - Show this help message\n\n` +
  `Or just type a message to talk to the Super Agent!`;

const HELP =
  `📖 *Available Commands*\n\n` +
  `/status - Quick overview of all agents\n` +
  `/agents - Detailed list of all agents\n` +
  `/projects - List all projects with their agents\n` +
  `/start\\_agent <name> <task> - Start an agent with a task\n` +
  `/stop\\_agent <name> - Stop a running agent\n` +
  `/ask <message> - Send a message to Super Agent\n` +
  `/usage - Show usage & cost stats\n` +
  `/help - Show this help message\n\n` +
  `💡 *Tips:*\n` +
  `• Just type a message to talk directly to Super Agent\n` +
  `• Super Agent can manage other agents for you\n` +
  `• Use /status to monitor progress`;

/** One line of /status: the agent, its project and skills, and its task while it runs. */
function statusLine(a: AgentStatus): string {
  const isSuper = isSuperAgent(a);
  const skills = a.skills.length > 0 ? a.skills.slice(0, 2).join(', ') + (a.skills.length > 2 ? '...' : '') : '';
  let line = `  ${faceOrCrown(a)} *${a.name}*\n`;
  // Don't show project for Super Agent
  if (!isSuper) {
    const project = a.projectPath.split('/').pop() || 'Unknown';
    line += `      📁 \`${project}\``;
    if (skills) line += ` | 🛠 ${skills}`;
  } else if (skills) {
    line += `      🛠 ${skills}`;
  }
  if (a.currentTask && a.status === 'running') {
    line += `\n      💬 _${a.currentTask.slice(0, 40)}${a.currentTask.length > 40 ? '...' : ''}_`;
  }
  return line + '\n';
}

// ============== /usage ==============

function usageReport(stats: ClaudeStats): string {
  const { cost: totalCost, input: totalInput, output: totalOutput, cacheRead: totalCacheRead, byModel: modelBreakdown } = priceUsage(stats);

  let text = `📊 *Usage & Cost Summary*\n\n`;
  text += `💰 *Total Cost:* $${totalCost.toFixed(2)}\n`;
  text += `🔢 *Total Tokens:* ${((totalInput + totalOutput) / 1_000_000).toFixed(2)}M\n`;
  text += `📥 Input: ${(totalInput / 1_000_000).toFixed(2)}M\n`;
  text += `📤 Output: ${(totalOutput / 1_000_000).toFixed(2)}M\n`;
  text += `💾 Cache: ${(totalCacheRead / 1_000_000).toFixed(2)}M read\n\n`;
  if (modelBreakdown.length > 0) {
    text += `*By Model:*\n`;
    modelBreakdown.slice(0, 5).forEach(m => {
      const emoji = m.name.includes('Opus') ? '🟣' : m.name.includes('Sonnet') ? '🔵' : '🟢';
      text += `${emoji} ${m.name}: $${m.cost.toFixed(2)}\n`;
    });
  }
  if (stats.totalSessions || stats.totalMessages) {
    text += `\n*Activity:*\n`;
    if (stats.totalSessions) text += `📝 ${stats.totalSessions} sessions\n`;
    if (stats.totalMessages) text += `💬 ${stats.totalMessages} messages\n`;
  }
  if (stats.firstSessionDate) {
    text += `\n_Since ${new Date(stats.firstSessionDate).toLocaleDateString()}_`;
  }
  return text;
}

// ============== The commands ==============

type Command = (msg: TelegramBot.Message, match: RegExpExecArray | null, chatId: string) => unknown;

async function startAgentCommand(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
  if (!match) return;
  const input = match[1].trim();
  const firstSpaceIndex = input.indexOf(' ');
  if (firstSpaceIndex === -1) {
    telegramBot?.sendMessage(msg.chat.id, '⚠️ Usage: /start\\_agent <agent name> <task>', { parse_mode: 'Markdown' });
    return;
  }
  const agentName = input.substring(0, firstSpaceIndex).toLowerCase();
  const task = input.substring(firstSpaceIndex + 1).trim();
  const agent = findAgent(fleet.agents, agentName);
  if (!agent) {
    telegramBot?.sendMessage(msg.chat.id, `❌ Agent "${agentName}" not found.`);
    return;
  }
  if (agent.status === 'running') {
    telegramBot?.sendMessage(msg.chat.id, `⚠️ ${agent.name} is already running.`);
    return;
  }
  try {
    await startWithTask(fleet, agent, task, 'Telegram', {
      resume: true,
      reply: outcome => {
        if (outcome === 'no-terminal') telegramBot?.sendMessage(msg.chat.id, '❌ Failed to initialize agent terminal.');
        else if (outcome === 'refused') telegramBot?.sendMessage(msg.chat.id, `❌ ${agent.name} has too many messages waiting for its terminal.`);
        else if (outcome === 'held') telegramBot?.sendMessage(msg.chat.id, `⏳ ${agent.name}'s session is open but its field is in use: the task goes in once it is free.\n\nTask: ${task}`);
        else if (outcome === 'written') telegramBot?.sendMessage(msg.chat.id, `📨 Sent to ${agent.name}, whose session is open.\n\nTask: ${task}`);
        else telegramBot?.sendMessage(msg.chat.id, `🚀 Started *${agent.name}*\n\n${faceOrCrown(agent)} Task: ${task}`, { parse_mode: 'Markdown' });
      },
    });
  } catch (err) {
    console.error('Failed to start agent from Telegram:', err);
    telegramBot?.sendMessage(msg.chat.id, `❌ Failed to start agent: ${err}`);
  }
}

function stopAgentCommand(msg: TelegramBot.Message, match: RegExpExecArray | null): void {
  if (!match) return;
  const agentName = match[1].trim().toLowerCase();
  const agent = findAgent(fleet.agents, agentName);
  if (!agent) {
    telegramBot?.sendMessage(msg.chat.id, `❌ Agent "${agentName}" not found.`);
    return;
  }
  if (agent.status !== 'running' && agent.status !== 'waiting') {
    telegramBot?.sendMessage(msg.chat.id, `⚠️ ${agent.name} is not running.`);
    return;
  }
  stopNow(fleet, agent);
  telegramBot?.sendMessage(msg.chat.id, `🛑 Stopped *${agent.name}*`, { parse_mode: 'Markdown' });
}

async function usageCommand(msg: TelegramBot.Message): Promise<void> {
  try {
    const stats = await getClaudeStats();
    if (!stats) {
      telegramBot?.sendMessage(msg.chat.id, '📊 No usage data available yet.');
      return;
    }
    telegramBot?.sendMessage(msg.chat.id, usageReport(stats), { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error getting usage stats:', err);
    telegramBot?.sendMessage(msg.chat.id, `❌ Error fetching usage data: ${err}`);
  }
}

/** Every command but /auth, in the order they are registered: several can match one message, and all do. */
const COMMANDS: Array<[RegExp, Command]> = [
  [/\/start$/, (_msg, _match, chatId) => telegramBot?.sendMessage(chatId, WELCOME, { parse_mode: 'Markdown' })],
  [/\/help/, msg => telegramBot?.sendMessage(msg.chat.id, HELP, { parse_mode: 'Markdown' })],
  [/\/projects/, msg => {
    const text = projectsReport(fleet.agents, { title: `📂 *Projects*\n\n`, folder: '📁', indent: '   ', people: '👥', face, dot: DOTS });
    if (!text) telegramBot?.sendMessage(msg.chat.id, '📭 No projects with agents yet.');
    else telegramBot?.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  }],
  [/\/status/, msg => {
    const list = Array.from(fleet.agents.values());
    if (list.length === 0) telegramBot?.sendMessage(msg.chat.id, '📭 No agents created yet.');
    else telegramBot?.sendMessage(msg.chat.id, statusReport(list, { title: `📊 *Agents Status*\n\n`, dot: DOTS, item: statusLine, orchestratorFirst: true }), { parse_mode: 'Markdown' });
  }],
  [/\/agents/, msg => {
    const list = Array.from(fleet.agents.values());
    if (list.length === 0) telegramBot?.sendMessage(msg.chat.id, '📭 No agents created yet.');
    else telegramBot?.sendMessage(msg.chat.id, `🤖 *All Agents*\n\n` + list.map(a => formatAgentStatus(a) + '\n\n').join(''), { parse_mode: 'Markdown' });
  }],
  [/\/start_agent\s+(.+)/, startAgentCommand],
  [/\/stop_agent\s+(.+)/, stopAgentCommand],
  [/\/usage/, usageCommand],
  [/\/ask\s+(.+)/, async (_msg, match, chatId) => {
    if (!match) return;
    await sendToSuperAgent(chatId, match[1].trim());
  }],
];

/** The files Telegram sends, each downloaded and handed to the orchestrator with what it is. */
const FILES: Array<{
  event: 'photo' | 'document' | 'video' | 'audio';
  file: (msg: TelegramBot.Message) => { id: string; name: string; downloading: string; kind: string } | undefined;
  missing: string;
  failure: string;
}> = [
  {
    event: 'photo',
    file: msg => {
      const photo = msg.photo?.[msg.photo.length - 1];
      const name = `photo_${msg.message_id}.jpg`;
      return photo && { id: photo.file_id, name, downloading: '📥 Downloading image...', kind: getFileTypeDescription(undefined, name) };
    },
    missing: 'Please analyze or use this image as needed.',
    failure: 'image',
  },
  {
    event: 'document',
    file: msg => {
      const doc = msg.document;
      if (!doc) return undefined;
      const name = doc.file_name || `document_${msg.message_id}`;
      return { id: doc.file_id, name, downloading: `📥 Downloading ${doc.file_name || 'document'}...`, kind: `${getFileTypeDescription(doc.mime_type, name)} "${name}"` };
    },
    missing: 'Please analyze or use this file as needed.',
    failure: 'document',
  },
  {
    event: 'video',
    file: msg => {
      const video = msg.video;
      const name = (video as { file_name?: string } | undefined)?.file_name || `video_${msg.message_id}.mp4`;
      return video && { id: video.file_id, name, downloading: '📥 Downloading video...', kind: `video "${name}"` };
    },
    missing: 'A video file has been downloaded for reference.',
    failure: 'video',
  },
  {
    event: 'audio',
    file: msg => {
      const audio = msg.audio;
      const name = (audio as { file_name?: string } | undefined)?.file_name || `audio_${msg.message_id}.mp3`;
      return audio && { id: audio.file_id, name, downloading: '📥 Downloading audio...', kind: `audio "${name}"` };
    },
    missing: 'An audio file has been downloaded for reference.',
    failure: 'audio',
  },
];

/**
 * Initialize Telegram bot and set up handlers
 */
export function initTelegramBot() {
  // Stop existing bot if any
  if (telegramBot) {
    telegramBot.stopPolling();
    telegramBot = null;
  }

  if (!getSettings().telegramEnabled || !getSettings().telegramBotToken) {
    console.log('Telegram bot disabled or no bot token');
    return;
  }

  if (!getSettings().telegramAuthToken) {
    console.log('Telegram bot disabled: no auth token configured (security requirement)');
    return;
  }

  authMisses = [];

  try {
    telegramBot = new TelegramBot(getSettings().telegramBotToken, { polling: true });
    console.log('Telegram bot started');

    // Fetch and cache bot username for mention detection
    telegramBot.getMe().then((me) => {
      botUsername = me.username || null;
      console.log(`Telegram bot username: @${botUsername}`);
    }).catch((err) => {
      console.error('Failed to get bot info:', err);
    });

    // Handle /auth command - ALWAYS accessible (for authentication)
    telegramBot.onText(/\/auth\s+(.+)/, (msg, match) => {
      const chatId = msg.chat.id.toString();
      const providedToken = match?.[1]?.trim();

      if (!providedToken) {
        telegramBot?.sendMessage(chatId, '⚠️ Usage: /auth <token>');
        return;
      }

      // Check if auth token is configured
      const live = getSettings();
      if (!live.telegramAuthToken) {
        telegramBot?.sendMessage(chatId,
          '⚠️ No authentication token configured.\n\n' +
          '_Generate one in Tars Settings → Telegram_',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const until = authWait(chatId, Date.now());
      if (until) {
        // The Mac's own clock: the owner reads it where Tars runs.
        const at = new Date(until).toTimeString().slice(0, 5);
        telegramBot?.sendMessage(chatId,
          '⛔ *Too many attempts*\n\n' +
          `_Try again at ${at}, or turn Telegram off and on in Tars's Settings._`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Verify the token
      if (providedToken === live.telegramAuthToken) {
        // Add to authorized list if not already there. Onto the live settings:
        // writing the bot's old object back would restore what Settings had
        // removed since, on disk as well.
        if (!live.telegramAuthorizedChatIds) {
          live.telegramAuthorizedChatIds = [];
        }
        if (!live.telegramAuthorizedChatIds.includes(chatId)) {
          live.telegramAuthorizedChatIds.push(chatId);
          // Also update legacy field for backwards compatibility
          live.telegramChatId = chatId;
          saveAppSettings(live);
          mainWindow?.webContents.send('settings:updated', live);
        }

        telegramBot?.sendMessage(chatId,
          `✅ *Authentication Successful!*\n\n` +
          `Your chat ID \`${chatId}\` has been authorized.\n\n` +
          `You can now use all bot commands. Type /help to see available commands.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        authMisses.push({ chatId, at: Date.now() });
        telegramBot?.sendMessage(chatId,
          '❌ *Invalid token*\n\n' +
          '_Check your token in Tars Settings → Telegram_',
          { parse_mode: 'Markdown' }
        );
      }
    });

    // Every other command answers an authorized chat only.
    for (const [pattern, run] of COMMANDS) {
      telegramBot.onText(pattern, (msg, match) => {
        const chatId = msg.chat.id.toString();
        if (!isAuthorized(chatId)) {
          sendUnauthorizedMessage(chatId);
          return;
        }
        return run(msg, match, chatId);
      });
    }

    for (const { event, file: fileOf, missing, failure } of FILES) {
      telegramBot.on(event, async (msg) => {
        const chatId = msg.chat.id.toString();
        if (!isAuthorized(chatId)) {
          sendUnauthorizedMessage(chatId);
          return;
        }
        // Check if we should respond (mention required in groups)
        if (!shouldRespondToMessage(msg)) return;
        try {
          const file = fileOf(msg);
          if (!file) return;
          telegramBot?.sendMessage(chatId, file.downloading);
          const localPath = await downloadTelegramFile(file.id, file.name);
          const caption = removeBotMention(msg.caption || '');
          await sendToSuperAgent(chatId, `[FILE ATTACHED - ${file.kind} saved to: ${localPath}] ${caption || missing}`, [localPath]);
        } catch (err) {
          console.error(`Failed to download ${event}:`, err);
          telegramBot?.sendMessage(chatId, `❌ Failed to download ${failure}: ${err}`);
        }
      });
    }

    // Handle voice messages
    telegramBot.on('voice', async (msg) => {
      const chatId = msg.chat.id.toString();
      if (!isAuthorized(chatId)) {
        sendUnauthorizedMessage(chatId);
        return;
      }

      // Voice messages carry no caption to mention the bot in: in a group that
      // requires a mention, they are ignored.
      if (msg.chat.type !== 'private' && getSettings().telegramRequireMention) {
        return;
      }

      try {
        const voice = msg.voice;
        if (!voice) return;

        telegramBot?.sendMessage(chatId, '📥 Downloading voice message...');

        const fileName = `voice_${msg.message_id}.ogg`;
        const localPath = await downloadTelegramFile(voice.file_id, fileName);

        const message = `[FILE ATTACHED - voice message saved to: ${localPath}] A voice message has been downloaded. Note: You may need to transcribe this audio file to understand its content.`;

        await sendToSuperAgent(chatId, message, [localPath]);
      } catch (err) {
        console.error('Failed to download voice:', err);
        telegramBot?.sendMessage(chatId, `❌ Failed to download voice message: ${err}`);
      }
    });

    // Handle regular text messages (forward to Super Agent)
    telegramBot.on('message', async (msg) => {
      // Ignore commands
      if (msg.text?.startsWith('/')) return;
      // Ignore messages already handled by specific handlers (photo, document, video, audio, voice)
      if (msg.photo || msg.document || msg.video || msg.audio || msg.voice) return;
      if (!msg.text) return;

      const chatId = msg.chat.id.toString();

      // Check authorization
      if (!isAuthorized(chatId)) {
        sendUnauthorizedMessage(chatId);
        return;
      }

      // Check if we should respond (mention required in groups)
      if (!shouldRespondToMessage(msg)) {
        return;
      }

      // Remove bot mention from message for cleaner prompt
      const cleanedText = removeBotMention(msg.text);
      if (!cleanedText) return; // Don't process if message was just the mention

      await sendToSuperAgent(chatId, cleanedText);
    });

    // Handle polling errors
    telegramBot.on('polling_error', (error) => {
      console.error('Telegram polling error:', error);
    });

  } catch (err) {
    console.error('Failed to initialize Telegram bot:', err);
  }
}

/**
 * Send message to Super Agent
 * @param chatId - Telegram chat ID
 * @param message - Message text
 * @param attachedFiles - Optional array of local file paths that were downloaded
 */
export async function sendToSuperAgent(chatId: string, message: string, attachedFiles?: string[]) {
  // The orchestrator the message names with "@project", or the fleet's only
  // one: never the first found, which may be another project's (point E).
  const target = orchestratorForMessage(fleet.agents, message);
  if (target.kind !== 'found') {
    telegramBot?.sendMessage(chatId, `👑 ${whereToWrite(target)}`);
    return;
  }
  const superAgent = target.orchestrator;
  message = target.text;

  // Track which chat to respond to - this is crucial for multi-chat support
  currentResponseChatId = chatId;
  console.log(`Telegram: Setting response chat ID to ${chatId}`);

  // Build message with file information if files are attached
  let fullMessage = message;
  if (attachedFiles && attachedFiles.length > 0) {
    const filesList = attachedFiles.map(f => `  - ${f}`).join('\n');
    fullMessage += `\n\nDownloaded files available at:\n${filesList}\n\nYou can read/analyze these files using your tools.`;
  }

  // Sanitize message - replace newlines with spaces for terminal compatibility
  const sanitizedMessage = fullMessage.replace(/\r?\n/g, ' ').trim();

  try {
    await forwardToOrchestrator(fleet, superAgent, 'Telegram', {
      message: sanitizedMessage,
      context: `[FROM TELEGRAM chat_id=${chatId} - Use send_telegram MCP tool with chat_id="${chatId}" to respond!]`,
      // Started from a phone, nobody is there to answer a permission question.
      permissionMode: 'bypass',
      resume: true,
      systemPromptFile: telegramSystemPromptFile,
      reply: outcome => {
        if (outcome === 'no-terminal') telegramBot?.sendMessage(chatId, '❌ Failed to connect to Super Agent terminal.');
        else if (outcome === 'typed') telegramBot?.sendMessage(chatId, `👑 Super Agent is processing...`);
        else telegramBot?.sendMessage(chatId, `👑 Super Agent is processing your request...`);
      },
    });
  } catch (err) {
    console.error('Failed to send to Super Agent:', err);
    telegramBot?.sendMessage(chatId, `❌ Error: ${err}`);
  }
}

/**
 * The orchestrator's instructions for a launch from Telegram, as a file: its
 * own, with Telegram's appended when there are any, in a file of this Tars's
 * data folder (which follows HOME; Electron's home does not on macOS, so a
 * sandboxed Tars wrote it into the real ~/.dorothy).
 */
function telegramSystemPromptFile(): string | undefined {
  let systemPromptFile: string | undefined;
  const superAgentInstructionsPath = getSuperAgentInstructionsPath();
  if (fs.existsSync(superAgentInstructionsPath)) {
    systemPromptFile = superAgentInstructionsPath;
  }
  const telegramInstructions = getTelegramInstructions();
  if (telegramInstructions) {
    const combined = [getSuperAgentInstructions(), telegramInstructions].filter(Boolean).join('\n\n');
    const combinedPath = dataPath('telegram-combined-prompt.md');
    try {
      fs.mkdirSync(path.dirname(combinedPath), { recursive: true });
      fs.writeFileSync(combinedPath, combined, 'utf-8');
      systemPromptFile = combinedPath;
    } catch {
      // Fall back to super agent instructions file only
    }
  }
  return systemPromptFile;
}

/**
 * Stop Telegram bot
 */
export function stopTelegramBot() {
  if (telegramBot) {
    telegramBot.stopPolling();
    telegramBot = null;
    console.log('Telegram bot stopped');
  }
}

/**
 * Get Telegram bot instance
 */
export function getTelegramBot(): TelegramBot | null {
  return telegramBot;
}
