import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

/**
 * Claude Code's own files, as the renderer's types describe them.
 *
 * The readers that filled these types lived here for the web build, behind the
 * Next.js routes under `src/app/api/claude`. The desktop app reads the same
 * files in the main process (`claude:getData`), and those routes are gone. What
 * is left is the one reader a page still calls: the Projects page's session
 * panel, through `/api/claude/sessions/:projectId/:sessionId`, which only
 * `next dev` serves.
 */
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClaudeSettings {
  enabledPlugins: Record<string, boolean>;
  env: Record<string, string>;
  hooks: Record<string, unknown>;
  includeCoAuthoredBy: boolean;
  permissions: {
    allow: string[];
    deny: string[];
  };
}

export interface ClaudeStats {
  version: number;
  lastComputedDate: string;
  /**
   * How many transcripts the main process could not read on the pass that
   * produced these figures, and which therefore contributed nothing.
   *
   * Set alongside the numbers it qualifies, in `getClaudeStats`. A transcript
   * that fails to open used to be skipped in silence, which surfaces as a
   * smaller bill rather than as a gap: the one error that looks like good news.
   * When this is not zero the figures are correct for what was read and lower
   * than the truth, and the page has to say so.
   */
  unreadable?: number;
  dailyActivity: Array<{
    date: string;
    messageCount: number;
    sessionCount: number;
    toolCallCount: number;
  }>;
  dailyModelTokens: Array<{
    date: string;
    /** input+output only: not enough to price a day, see costUSD */
    tokensByModel: Record<string, number>;
    /** Per model, split the way the bill is. Absent on the legacy
     *  stats-cache.json shape, which never carried it. */
    breakdownByModel?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
    /** How many replies each model sent that day, counted off the same message
     *  id the token dedup uses so a multi-line response counts once. Absent on
     *  the legacy stats-cache.json shape, which never carried it. */
    messagesByModel?: Record<string, number>;
    /** The day priced from its own tokens, cache included. Absent on the
     *  legacy stats-cache.json shape, which carries no per-day cost at all. */
    costUSD?: number;
    /** The same price per model, 1h and 5m cache writes apart, so it adds up
     *  to `costUSD` over the models and to `modelUsage[m].costUSD` over the
     *  days. What every cost on the Usage page is summed from. Absent on the
     *  legacy stats-cache.json shape. */
    costByModel?: Record<string, number>;
    /** The same cost per Claude account, as the status line filed each
     *  session (TARS_CLAUDE_ACCOUNT); '' holds the sessions that named none. */
    costByAccount?: Record<string, number>;
  }>;
  /** The last 48 hours, by the hour, the shape of a day with `hour` (its
   *  start, ms since the epoch, floored to the hour) for `date` (#275). What
   *  the Usage page's 24 hours view is summed from. */
  hourlyModelTokens?: Array<{
    hour: number;
    tokensByModel: Record<string, number>;
    breakdownByModel?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
    messagesByModel?: Record<string, number>;
    costUSD?: number;
    costByModel?: Record<string, number>;
    costByAccount?: Record<string, number>;
  }>;
  /** For each model, the provider its sessions ran under, as the status line
   *  wrote them in token-stats.json; a model no session speaks for is absent. */
  providerByModel?: Record<string, string>;
  modelUsage: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    webSearchRequests: number;
    costUSD: number;
    contextWindow: number;
    maxOutputTokens: number;
  }>;
  totalSessions: number;
  totalMessages: number;
  longestSession: {
    sessionId: string;
    duration: number;
    messageCount: number;
    timestamp: string;
  };
  firstSessionDate: string;
  hourCounts: Record<string, number>;
}

export interface ClaudeProject {
  id: string;
  name: string;
  path: string;
  sessions: ClaudeSession[];
  lastActivity: Date;
}

export interface ClaudeSession {
  id: string;
  projectPath: string;
  messages: ClaudeMessage[];
  startTime: Date;
  lastActivity: Date;
  model?: string;
  version?: string;
}

export interface ClaudeMessage {
  uuid: string;
  parentUuid: string | null;
  type: 'user' | 'assistant';
  timestamp: string;
  content: string | MessageContent[];
  model?: string;
  toolCalls?: ToolCall[];
}

interface MessageContent {
  type: string;
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  content?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudePlugin {
  name: string;
  marketplace: string;
  fullName: string;
  enabled: boolean;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
}

export interface ClaudeSkill {
  name: string;
  source: 'project' | 'user' | 'plugin';
  path: string;
  description?: string;
  projectName?: string;
}

export interface HistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId?: string;
  pastedContents?: Record<string, unknown>;
}

// Get session messages
export async function getSessionMessages(projectId: string, sessionId: string): Promise<ClaudeMessage[]> {
  // Both values come from the URL. A session is a UUID, and its file has to
  // sit in a project folder directly under ~/.claude/projects: an encoded `../`
  // in either one used to walk out of that folder.
  const sessionPath = path.resolve(PROJECTS_DIR, projectId, `${sessionId}.jsonl`);
  if (!SESSION_ID.test(sessionId) || path.dirname(path.dirname(sessionPath)) !== PROJECTS_DIR) return [];
  try {
    const content = await fs.readFile(sessionPath, 'utf-8');
    const lines = content.trim().split('\n');

    const messages: ClaudeMessage[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        if (entry.type === 'user' || entry.type === 'assistant') {
          const msg: ClaudeMessage = {
            uuid: entry.uuid,
            parentUuid: entry.parentUuid,
            type: entry.type,
            timestamp: entry.timestamp,
            content: '',
            model: entry.message?.model,
          };

          // Extract content
          if (entry.message?.content) {
            if (typeof entry.message.content === 'string') {
              msg.content = entry.message.content;
            } else if (Array.isArray(entry.message.content)) {
              msg.content = entry.message.content;

              // Extract tool calls
              const toolUses = entry.message.content.filter(
                (c: MessageContent) => c.type === 'tool_use'
              );
              if (toolUses.length > 0) {
                msg.toolCalls = toolUses.map((t: MessageContent) => ({
                  id: t.tool_use_id || '',
                  name: t.name || '',
                  input: t.input || {},
                }));
              }
            }
          }

          messages.push(msg);
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    return messages;
  } catch {
    return [];
  }
}
