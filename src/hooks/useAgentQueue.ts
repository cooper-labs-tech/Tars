'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AgentQueue } from '@/types/electron';

/**
 * An agent's queue (2.0.5, lot 2, item I; frames `Agent queue (2.0.5) · in its panel` and `· states`, design PR 535),
 * on the Database Engineer's agentQueue (PR 536): the items in the order they run, who sent each, when, how it came in
 * and its first line; whether the queue is paused, since when and why; pause, resume, cancel, move and drop. Without
 * the channel (a Tars before it), `has` is false and the banner keeps the list it had, with no control.
 */
export function useAgentQueue(agentId: string) {
  const api = typeof window === 'undefined' ? undefined : window.electronAPI?.agentQueue;
  const [queue, setQueue] = useState<AgentQueue | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let live = true;
    api.get(agentId).then((next) => { if (live && 'items' in next) setQueue(next); }, () => {});
    const off = api.onChanged((view) => { if (live && view.agentId === agentId) setQueue(view); });
    return () => { live = false; off(); };
  }, [api, agentId]);

  /** Runs one action; its refusal, as a sentence, is what the list says. */
  const act = useCallback(async (call: () => Promise<{ success: boolean; error?: string; code?: string; view?: AgentQueue }>) => {
    setError(null);
    try {
      const res = await call();
      if (res.success && res.view) setQueue(res.view);
      if (!res.success) {
        setError(res.code === 'already_started'
          ? 'That task has started: stop it from the banner with stop task.'
          : res.error ?? 'The queue did not change.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return {
    has: Boolean(api),
    queue,
    error,
    pause: () => (api ? act(() => api.pause(agentId)) : Promise.resolve()),
    resume: () => (api ? act(() => api.resume(agentId)) : Promise.resolve()),
    cancel: (ref: string) => (api ? act(() => api.cancel(ref)) : Promise.resolve()),
    /** Before `before`, or to the head when it is null. */
    move: (ref: string, before: string | null) => (api ? act(() => api.move(ref, before ?? undefined)) : Promise.resolve()),
    drop: () => (api ? act(() => api.drop(agentId)) : Promise.resolve()),
  };
}
