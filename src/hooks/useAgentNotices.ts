'use client';

import { useCallback, useSyncExternalStore } from 'react';
import type { AgentNotice, AgentNoticeSeen } from '@/types/electron';

/**
 * Tars's notices about each agent, for its panel and for Logs (2.0.7). Frame: `Agent notices (2.0.7) · in its panel
 * and in Logs`.
 *
 * The shape of useRestartPending, for the same reasons: one subscription for the window; `agent.notices()` read once
 * at the start, because a push reaches only a window that was already listening; and a notice an event has spoken for
 * keeps what the event said over a read that lands after it. `agent:notice-seen` is told to every window, this one
 * included, so a notice marked seen anywhere leaves every panel.
 *
 * Each agent's list is newest first, and keeps its identity until a notice of that agent changes, so a notice about
 * one agent re-renders that agent's panel and leaves the others alone.
 */
const NONE: readonly AgentNotice[] = [];

let byAgent: ReadonlyMap<string, readonly AgentNotice[]> = new Map();
let all: readonly AgentNotice[] = NONE;
const listeners = new Set<() => void>();
let started = false;

const newestFirst = (a: AgentNotice, b: AgentNotice) => b.at - a.at;

function emit(next: Map<string, readonly AgentNotice[]>): void {
  byAgent = next;
  all = [...next.values()].flat().sort(newestFirst);
  for (const listener of listeners) listener();
}

/** Put notices in, by id: a seen time already known is kept over a list read before it. */
function put(notices: readonly AgentNotice[]): void {
  const next = new Map(byAgent);
  for (const n of notices) {
    if (!n || typeof n.id !== 'string' || typeof n.agentId !== 'string') continue;
    const list = next.get(n.agentId) ?? NONE;
    const had = list.find(o => o.id === n.id);
    const kept = had?.seenAt !== undefined && n.seenAt === undefined ? { ...n, seenAt: had.seenAt } : n;
    next.set(n.agentId, [...list.filter(o => o.id !== n.id), kept].sort(newestFirst));
  }
  emit(next);
}

function onSeen(event: AgentNoticeSeen): void {
  if (!event || typeof event.agentId !== 'string' || !Array.isArray(event.ids)) return;
  const list = byAgent.get(event.agentId);
  if (!list) return;
  const ids = new Set(event.ids);
  const next = new Map(byAgent);
  next.set(event.agentId, list.map(n => (ids.has(n.id) && n.seenAt === undefined ? { ...n, seenAt: event.seenAt } : n)));
  emit(next);
}

function start(): void {
  if (started) return;
  started = true;
  const agent = typeof window === 'undefined' ? undefined : window.electronAPI?.agent;
  if (!agent) return;
  agent.onNotice?.(notice => put([notice]));
  agent.onNoticeSeen?.(onSeen);
  agent.notices?.()
    .then(list => { if (Array.isArray(list)) put(list); })
    .catch(() => {});
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** This agent's notices, newest first, seen ones included. */
export function useAgentNotices(agentId: string | undefined): readonly AgentNotice[] {
  const snapshot = useCallback(() => (agentId ? byAgent.get(agentId) ?? NONE : NONE), [agentId]);
  return useSyncExternalStore(subscribe, snapshot, onServer);
}

/** Every agent's notices, newest first, for Logs. */
export function useAllAgentNotices(): readonly AgentNotice[] {
  return useSyncExternalStore(subscribe, allSnapshot, onServer);
}

/** Mark notices seen: those ids, or every notice of the agent not seen yet. Every window is told, this one included. */
export function markNoticesSeen(agentId: string, ids?: string[]): void {
  void window.electronAPI?.agent?.markNoticesSeen?.(agentId, ids)?.catch(() => {});
}

function allSnapshot(): readonly AgentNotice[] {
  return all;
}

function onServer(): readonly AgentNotice[] {
  return NONE;
}
