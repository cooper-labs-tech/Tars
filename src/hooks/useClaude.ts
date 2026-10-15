'use client';

import { useState, useEffect, useCallback } from 'react';
import type {
  ClaudeSettings,
  ClaudeStats,
  ClaudeProject,
  ClaudePlugin,
  ClaudeSkill,
  ClaudeSession,
  HistoryEntry,
  ClaudeMessage,
} from '@/lib/claude-code';
import type { ElectronAPI } from '@/types/electron';
import { isElectron } from './useElectron';

type AccountCounters = NonNullable<Awaited<ReturnType<ElectronAPI['claude']['getData']>>>['accountRateLimits'];

interface RateLimits {
  five_hour?: { used_percentage: number; resets_at: number };
  seven_day?: { used_percentage: number; resets_at: number };
}

interface TokenStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  extraCostUsd: number;
  sessionCount: number;
  modelTokens?: Record<string, { in: number; out: number }>;
  dailyCosts?: Record<string, { cost: number; extraCost: number }>;
  providerTotals?: Record<string, { in: number; out: number; cost: number; sessions: number }>;
}

/**
 * The latest day of the transcripts, cheaply: its date, its cost and its
 * tokens. A day's cost grows all day without moving the date the stats were
 * computed for, the session counts or the rate windows, so a poll that compared
 * only those kept the morning's figures until the next session started, and
 * for good on an API key, which has no rate windows. The days come sorted by
 * date, so the last is the newest.
 */
function latestDayOf(stats: ClaudeStats | null | undefined): string {
  const days = stats?.dailyModelTokens;
  const last = days?.[days.length - 1];
  if (!last) return '';
  const tokens = Object.values(last.tokensByModel ?? {}).reduce((sum, n) => sum + n, 0);
  return `${last.date}|${last.costUSD ?? ''}|${tokens}`;
}

/** The same for token-stats.json, whose over-quota share the Usage page reads. */
function tokenStatsOf(stats: TokenStats | null | undefined): string {
  return stats ? `${stats.totalCostUsd}|${stats.extraCostUsd}|${stats.sessionCount}` : '';
}

/**
 * What Extensions and Settings show of the skills and plugins, and Claude's
 * settings, which say which plugins are on. The store keeps its data from one
 * page to the next, so a comparison that skipped these kept an install or a
 * plugin turned off out of every page until something else moved.
 */
function extensionsOf(skills: unknown, plugins: unknown, settings: unknown): string {
  const s = ((skills || []) as ClaudeSkill[]).map(k => `${k.source}:${k.name}:${k.path}:${k.description ?? ''}`).join('|');
  const p = ((plugins || []) as ClaudePlugin[]).map(k => `${k.fullName}:${k.enabled}:${k.version}:${k.installPath}`).join('|');
  return `${s}#${p}#${JSON.stringify(settings ?? null)}`;
}

interface ClaudeData {
  settings: ClaudeSettings | null;
  stats: ClaudeStats | null;
  projects: ClaudeProject[];
  plugins: ClaudePlugin[];
  skills: ClaudeSkill[];
  history: HistoryEntry[];
  activeSessions: string[];
  rateLimits: RateLimits | null;
  /**
   * Each Claude account's own 5 h and weekly counters (#277), empty while the
   * accounts option is off.
   */
  accountRateLimits: AccountCounters;
  tokenStats: TokenStats | null;
}

/** A project as main sends it: `lastAccessed` in ms, sessions stamped the same way. */
interface ElectronProject {
  id: string;
  path: string;
  name: string;
  sessions: Array<{ id: string; timestamp: number }>;
  lastAccessed: number;
}

/**
 * claude:getData's answer as the pages read it, or the data they already have
 * when nothing they show has changed, so an idle poll re-renders no page.
 */
function fromPayload(prev: ClaudeData | null, result: Record<string, unknown>): ClaudeData {
  // Electron returns lastAccessed as number (ms timestamp), frontend expects lastActivity as Date
  const rawProjects = (result.projects || []) as ElectronProject[];
  const activeSessions = (result.activeSessions || []) as string[];
  const rateLimits = (result.rateLimits || null) as RateLimits | null;
  const accountRateLimits = (result.accountRateLimits || []) as AccountCounters;

  // The comparison runs against the *raw* IPC payload first. Building
  // `transformedProjects` eagerly allocated one object plus two Date
  // instances per session on every 10s tick, then threw them away
  // whenever the comparison decided nothing had changed.
  const unchanged =
    !!prev &&
    prev.projects.length === rawProjects.length &&
    prev.activeSessions.join('\u0000') === activeSessions.join('\u0000') &&
    // Check if any project changed: its sessions, and their times too. A
    // project continued in a session it already had keeps its count, and only
    // its lastAccessed and that session's time say so. Those are a file's
    // mtimeMs, which on APFS carries a fraction (1790820026452.6458), while a
    // Date keeps the whole milliseconds: truncated the same way, or every idle
    // poll would find them changed.
    !rawProjects.some((p, i) => {
      const prevP = prev.projects[i];
      const sessions = p.sessions || [];
      return prevP?.id !== p.id
        || prevP.lastActivity.getTime() !== Math.trunc(p.lastAccessed)
        || prevP.sessions.length !== sessions.length
        || sessions.some((s, j) => prevP.sessions[j].lastActivity.getTime() !== Math.trunc(s.timestamp));
    }) &&
    // Check if rateLimits changed
    JSON.stringify(prev.rateLimits) === JSON.stringify(rateLimits) &&
    // And each account's, which move without anything else moving.
    JSON.stringify(prev.accountRateLimits) === JSON.stringify(accountRateLimits) &&
    // And the figures themselves. Without this the poll kept the
    // first stats it ever saw for as long as no project or session
    // count moved, so a cost that grew, or a transcript that stopped
    // being readable, never reached the page. Compared on what the
    // Usage page reads, cheaply, rather than on the whole object,
    // which carries a per-day array that is expensive to stringify
    // every ten seconds: the date, the unreadable count, and the
    // latest day and token-stats.json as latestDayOf and
    // tokenStatsOf sum them up.
    extensionsOf(prev.skills, prev.plugins, prev.settings) === extensionsOf(result.skills, result.plugins, result.settings) &&
    prev.stats?.lastComputedDate === (result.stats as ClaudeStats | null)?.lastComputedDate &&
    prev.stats?.unreadable === (result.stats as ClaudeStats | null)?.unreadable &&
    latestDayOf(prev.stats) === latestDayOf(result.stats as ClaudeStats | null) &&
    tokenStatsOf(prev.tokenStats) === tokenStatsOf(result.tokenStats as TokenStats | null);
  // No significant changes
  if (unchanged) return prev;

  // Transform the raw projects only now that we know they are needed.
  const transformedProjects = rawProjects.map((p) => ({
    id: p.id,
    name: p.name,
    path: p.path,
    sessions: (p.sessions || []).map(s => ({
      id: s.id,
      projectPath: p.path,
      messages: [] as ClaudeMessage[],
      startTime: new Date(s.timestamp),
      lastActivity: new Date(s.timestamp),
    })),
    lastActivity: new Date(p.lastAccessed),
  }));

  return {
    settings: result.settings as ClaudeSettings | null,
    stats: result.stats as ClaudeStats | null,
    projects: transformedProjects,
    plugins: (result.plugins || []) as ClaudePlugin[],
    skills: (result.skills || []) as ClaudeSkill[],
    history: (result.history || []) as HistoryEntry[],
    activeSessions,
    rateLimits,
    accountRateLimits,
    tokenStats: (result.tokenStats || null) as TokenStats | null,
  };
}

/**
 * One store of Claude Code's data for the whole window. Every page used to
 * mount its own copy of this hook, so each visit to Usage, Projects,
 * Extensions or Agents asked main again, showed its loading state until the
 * answer came, and polled on its own. Main keeps its answer a minute
 * (claude-service's STATS_TTL_MS, the transcript scan's CACHE_TTL); past that,
 * the next read is a whole transcript scan, 2656 to 3270 ms on JeanBrasse's machine,
 * and it was the page being opened that waited for it.
 *
 * Now there is one read in flight at a time, what is known shows at once, and
 * it is read again behind it when it is older than a poll. One poll serves
 * every page, every ten seconds while one is open and the window visible:
 * each tick drives claude:getData, which does blocking fs work on the
 * Electron main process and stalls PTY output.
 */
const POLL_MS = 10_000;
let known: { data: ClaudeData | null; error: string | null; at: number } = { data: null, error: null, at: 0 };
let reading: Promise<void> | null = null;
const listeners = new Set<() => void>();
let stopPolling: (() => void) | null = null;

function read(): Promise<void> {
  reading ??= (async () => {
    try {
      if (!isElectron() || !window.electronAPI?.claude?.getData) {
        // The web build's /api/claude route is gone: the main process is the
        // one reader of Claude Code's files now.
        throw new Error('Claude Code data is read by the desktop app');
      }
      const result = await window.electronAPI.claude.getData();
      if (!result) throw new Error('Failed to get Claude data from Electron');
      known = { data: fromPayload(known.data, result), error: null, at: Date.now() };
    } catch (err) {
      // A read that fails keeps what the pages already show.
      known = { ...known, error: err instanceof Error ? err.message : 'Unknown error' };
    } finally {
      reading = null;
      for (const listener of listeners) listener();
    }
  })();
  return reading;
}

const stale = () => !known.data || Date.now() - known.at >= POLL_MS;

/**
 * A read that starts after the call: what a page asks for once it changed
 * something (SkillsTab when an install's terminal closes). A read already in
 * flight may have been answered before the change, so a refresh then waits for
 * it and reads again. Refreshes asked during the same read share the next one,
 * as read() lets every caller share the read in flight.
 */
function refresh(): Promise<void> {
  return reading ? reading.then(read) : read();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    const tick = () => { if (document.visibilityState === 'visible') void read(); };
    const interval = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    stopPolling = () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopPolling?.();
      stopPolling = null;
    }
  };
}

/** Claude's data for a caller that draws no page of it: what is known while fresh, else the read the pages share. */
export async function readClaudeData(): Promise<ClaudeData | null> {
  if (stale()) await read();
  return known.data;
}

/** Forgets what is known: for tests that mount a page on new data each time. */
export function forgetClaudeData(): void {
  known = { data: null, error: null, at: 0 };
  reading = null;
}

export function useClaude() {
  const [data, setData] = useState(known.data);
  const [error, setError] = useState(known.error);

  useEffect(() => {
    const update = () => {
      setData(known.data);
      setError(known.error);
    };
    const unsubscribe = subscribe(update);
    // What is known was shown by the first render; it is read again behind
    // it when there is none, or when it is older than a poll.
    if (stale()) void read();
    else update();
    return unsubscribe;
  }, []);

  return { data, loading: !data && !error, error, refresh };
}

export function useSessionMessages(projectId: string | null, sessionId: string | null) {
  const [messages, setMessages] = useState<ClaudeMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMessages = useCallback(async () => {
    if (!projectId || !sessionId) {
      setMessages([]);
      return;
    }

    try {
      setLoading(true);
      const response = await fetch(`/api/claude/sessions/${projectId}/${sessionId}`);
      if (!response.ok) throw new Error('Failed to fetch');
      const result = await response.json();
      setMessages(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  return { messages, loading, error, refresh: fetchMessages };
}
