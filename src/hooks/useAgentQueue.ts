'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * An agent's queue (2.0.5, lot 2, item I; frames `Agent queue (2.0.5) · in its panel` and `· states`, design PR 535),
 * read from the Database Engineer's channel as the frames' notes ask for it: the items in the order they run, each with
 * its task id, who sent it, when, how it came in and its first line; whether the queue is paused, since when and why;
 * and pause, resume, cancel, move and drop. Until that channel and its type are in preload.ts and electron.d.ts the
 * hook says `has: false`, and the banner keeps the list it had without its controls.
 */

export interface QueueItem {
  taskId: string;
  from: string;
  /** ISO. */
  queuedAt: string;
  /** How it came in: delegate_task, send_message, start_agent, Telegram... */
  via: string;
  firstLine: string;
}

export interface AgentQueue {
  /** Null while the queue runs; else since when (ISO) and why: you, a stop, or a restart of Tars. */
  paused: null | { since: string; by: 'you' | 'stop' | 'restart'; orchestratorTold?: boolean };
  items: QueueItem[];
}

type Result = { success: boolean; error?: string };
interface AgentQueueApi {
  read: (agentId: string) => Promise<AgentQueue>;
  pause: (agentId: string) => Promise<Result>;
  resume: (agentId: string) => Promise<Result>;
  cancel: (agentId: string, taskId: string) => Promise<Result>;
  /** Before `beforeTaskId`, or to the head when it is null. */
  move: (agentId: string, taskId: string, beforeTaskId: string | null) => Promise<Result>;
  drop: (agentId: string) => Promise<Result>;
  onChanged: (cb: (event: { agentId: string; queue: AgentQueue }) => void) => () => void;
}

const api = (): AgentQueueApi | undefined =>
  typeof window === 'undefined' ? undefined : (window.electronAPI as unknown as { agentQueue?: AgentQueueApi } | undefined)?.agentQueue;

export function useAgentQueue(agentId: string) {
  const [queue, setQueue] = useState<AgentQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const has = Boolean(api());

  useEffect(() => {
    const q = api();
    if (!q) return;
    let live = true;
    q.read(agentId).then((next) => { if (live) setQueue(next); }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    const off = q.onChanged((event) => { if (live && event.agentId === agentId) setQueue(event.queue); });
    return () => { live = false; off(); };
  }, [agentId]);

  /** Runs one action; its refusal, a sentence, is what the list says. */
  const act = useCallback(async (call: (q: AgentQueueApi) => Promise<Result>) => {
    const q = api();
    if (!q) return;
    setError(null);
    try {
      const res = await call(q);
      if (!res.success) setError(res.error ?? 'The queue did not change.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return {
    has,
    queue,
    error,
    clearError: () => setError(null),
    pause: () => act((q) => q.pause(agentId)),
    resume: () => act((q) => q.resume(agentId)),
    cancel: (taskId: string) => act((q) => q.cancel(agentId, taskId)),
    move: (taskId: string, beforeTaskId: string | null) => act((q) => q.move(agentId, taskId, beforeTaskId)),
    drop: () => act((q) => q.drop(agentId)),
  };
}
