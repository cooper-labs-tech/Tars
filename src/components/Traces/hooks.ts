'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TraceFilter, TraceSessionSummary, TraceStats, UploadState } from '@/types/electron';
import { reasonOf } from '@/lib/traces-format';

/** The traces channel, or nothing in a browser without the desktop app. */
export const tracesApi = () => (typeof window !== 'undefined' ? window.electronAPI?.traces : undefined);

/** Read again on every 'traces:changed' (main throttles it to once a second). */
function useTracesChanged(onChange: () => void) {
  const latest = useRef(onChange);
  useEffect(() => { latest.current = onChange; });
  useEffect(() => tracesApi()?.onChanged(() => latest.current()), []);
}

/**
 * A revoke main holds in memory but could not write yet (its answer's `unsaved`, the same words as the upload state's):
 * said beside the control that asked it, word for word, until main has written it. 'traces:changed' comes when the
 * note goes; the upload state then has no `unsaved`, and the note is dropped. A state that cannot be read keeps it.
 */
export function useUnsavedNote<T = string>() {
  const [note, setNote] = useState<T | null>(null);
  const check = useCallback(async () => {
    const api = tracesApi();
    if (!api) return;
    const s = await api.uploadState().catch((e: unknown) => {
      console.warn('[traces] reading the upload state for a revoke not yet written failed:', e);
      return null;
    });
    if (s && !s.unsaved) setNote(null);
  }, []);
  useTracesChanged(() => { void check(); });
  return [note, setNote] as const;
}

/**
 * traces.uploadState, read again on every change: null until read, and kept as it was when a read fails (said in the
 * console), so a line built on it never claims what it could not read.
 */
export function useUploadState() {
  const [state, setState] = useState<UploadState | null>(null);
  const read = useCallback(async () => {
    const api = tracesApi();
    if (!api) return;
    try { setState(await api.uploadState()); } catch (e) { console.warn('[traces] reading the upload state failed:', e); }
  }, []);
  useEffect(() => { void read(); }, [read]);
  useTracesChanged(read);
  return state;
}

/** traces.stats: storage against the cap, retention, the oldest session, whether bodies are being dropped. */
export function useTraceStats() {
  const [stats, setStats] = useState<TraceStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(async () => {
    const api = tracesApi();
    if (!api) return;
    try { setStats(await api.stats()); setError(null); } catch (e) { setError(reasonOf(e)); }
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
      setError(reasonOf(e));
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
      setError(reasonOf(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cursor]);

  useEffect(() => { setSessions(null); void first(); }, [first]);
  useTracesChanged(first);
  return { sessions, total, hasMore: !!cursor, more, error, reload: first };
}
