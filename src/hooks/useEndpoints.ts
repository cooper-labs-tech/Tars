'use client';

import { useCallback, useEffect, useState } from 'react';
import type { EndpointView, EndpointWait, HarnessSupport } from '@/types/electron';
import { reasonOf } from '@/lib/traces-format';

/**
 * The inference endpoints as the main process holds them (endpoints.list), the requests it holds while one is busy
 * (endpoints.waits, pushed on 'endpoints:waiting') and the harnesses it measured (endpoints.harnesses). Read again
 * whenever 'endpoints:changed' says one moved, by the window or by an agent. The window never holds a key: an
 * endpoint says only `keySet`.
 */
export function useEndpoints() {
  const [endpoints, setEndpoints] = useState<EndpointView[] | null>(null);
  const [waits, setWaits] = useState<EndpointWait[]>([]);
  const [harnesses, setHarnesses] = useState<HarnessSupport[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The last change an agent made, per endpoint, as 'endpoints:changed' told it. */
  const [changedBy, setChangedBy] = useState<Record<string, { agentName: string; at: number }>>({});

  const api = typeof window !== 'undefined' ? window.electronAPI?.endpoints : undefined;

  const reload = useCallback(async () => {
    if (!api) return;
    try {
      setEndpoints(await api.list());
      setError(null);
    } catch (e) {
      setError(reasonOf(e));
    }
  }, [api]);

  useEffect(() => {
    if (!api) return;
    void reload();
    void api.waits().then(setWaits).catch(() => undefined);
    void api.harnesses().then(setHarnesses).catch(() => undefined);
    const offChanged = api.onChanged(e => {
      if (e.by) setChangedBy(prev => ({ ...prev, [e.id]: { agentName: e.by?.agentName || e.by?.agentId || 'an agent', at: Date.now() } }));
      void reload();
    });
    const offWaiting = api.onWaiting(setWaits);
    return () => { offChanged(); offWaiting(); };
  }, [api, reload]);

  return { endpoints, waits, harnesses, error, changedBy, reload, api };
}
