'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TraceFilter, TraceSessionSummary, TraceStats } from '@/types/electron';

/** The traces channel, or nothing in a browser without the desktop app. */
export const tracesApi = () => (typeof window !== 'undefined' ? window.electronAPI?.traces : undefined);

/** Read again on every 'traces:changed' (main throttles it to once a second). */
function useTracesChanged(onChange: () => void) {
  const latest = useRef(onChange);
  useEffect(() => { latest.current = onChange; });
  useEffect(() => tracesApi()?.onChanged(() => latest.current()), []);
}

/** traces.stats: storage against the cap, retention, the oldest session, whether bodies are being dropped. */
export function useTraceStats() {
  const [stats, setStats] = useState<TraceStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(async () => {
    const api = tracesApi();
    if (!api) return;
    try { setStats(await api.stats()); setError(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void read(); }, [read]);
  useTracesChanged(read);
  return { stats, error, read };
}

/**
 * traces.list for a filter, newest first, a page at a time: `more` reads the next page from the cursor main gave.
 * A change resets to the first page, so a page never shows a session twice.
 */
export function useTraceSessions(filter: TraceFilter) {
  const [sessions, setSessions] = useState<TraceSessionSummary[] | null>(null);
  const [total, setTotal] = useState<{ sessions: number; bytes: number } | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(filter);

  const first = useCallback(async () => {
    const api = tracesApi();
    if (!api) return;
    try {
      const res = await api.list({ ...filter, limit: 50 });
      setSessions(res.sessions);
      setCursor(res.nextCursor);
      setTotal({ sessions: res.totals.count, bytes: res.totals.bytes });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const more = useCallback(async () => {
    const api = tracesApi();
    if (!api || !cursor) return;
    try {
      const res = await api.list({ ...filter, cursor, limit: 50 });
      setSessions(prev => [...(prev ?? []), ...res.sessions]);
      setCursor(res.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cursor]);

  useEffect(() => { setSessions(null); void first(); }, [first]);
  useTracesChanged(first);
  return { sessions, total, hasMore: !!cursor, more, error, reload: first };
}
