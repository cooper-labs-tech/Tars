'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LoadProjectsView, LoadWindowState } from '@/types/electron';

/** The load window's channel (PR 685), or nothing in a browser without the desktop app. */
export const loadApi = () => (typeof window !== 'undefined' ? window.electronAPI?.load : undefined);

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The load window as main says it (`load.state`), read on mount and again on every `load:changed` (main reads it every
 * 5 s and tells the window when it changed). A read that fails keeps the last state and says why.
 */
export function useLoadWindow() {
  const [state, setState] = useState<LoadWindowState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(async () => {
    const api = loadApi();
    if (!api) return;
    try {
      setState(await api.state());
      setError(null);
    } catch (e) {
      setError(said(e));
    }
  }, []);
  useEffect(() => {
    void read();
    const off = loadApi()?.onChanged(next => { setState(next); setError(null); });
    return () => off?.();
  }, [read]);
  return { state, setState, error, read };
}

/** The Projects view (`load.projects`): every project with its state, and the endpoints a grant may name. */
export function useLoadProjects() {
  const [view, setView] = useState<LoadProjectsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(async () => {
    const api = loadApi();
    if (!api) return;
    try {
      setView(await api.projects());
      setError(null);
    } catch (e) {
      setError(said(e));
    }
  }, []);
  useEffect(() => {
    void read();
    const off = loadApi()?.onChanged(() => { void read(); });
    return () => off?.();
  }, [read]);
  return { view, setView, error, read };
}
