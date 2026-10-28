'use client';

import { useCallback, useEffect, useState } from 'react';
import { channel, type FleetResources, type HeavySlotStatus } from './contract';

/**
 * One data hook per view of the Resources page, each over its backend's channel (contract.ts): what it read, whether
 * this Tars has the channel at all, and why the last read failed. A channel that is not there is `missing`, which the
 * view says; it never shows an empty list in its place.
 */
export interface Reading<T> {
  state: T | null;
  missing: boolean;
  error: string | null;
  reload: () => void;
}

function useReading<T>(read: (() => Promise<T>) | undefined, onChanged: ((cb: (s: T) => void) => () => void) | undefined): Reading<T> {
  const [state, setState] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const missing = !read;

  useEffect(() => {
    if (!read) return;
    let live = true;
    read().then((s) => { if (live) { setState(s); setError(null); } }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    const off = onChanged?.((s) => { if (live) { setState(s); setError(null); } });
    return () => { live = false; off?.(); };
  }, [read, onChanged, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { state, missing, error, reload };
}

export function useHeavyRuns(): Reading<HeavySlotStatus> & { giveBack: (ticketId: string) => Promise<boolean> } {
  const api = typeof window === 'undefined' ? undefined : window.electronAPI?.heavySlot;
  const reading = useReading(api?.status, api?.onChanged);
  const giveBack = useCallback(async (ticketId: string) => (api ? api.giveBack(ticketId) : false), [api]);
  return { ...reading, giveBack };
}

export function useFleetResources(): Reading<FleetResources> & { measureDisk: () => Promise<string | null> } {
  const api = channel('resources');
  const reading = useReading(api?.read, api?.onChanged);
  const measureDisk = useCallback(async () => {
    const res = await api?.measureDisk();
    return res && !res.success ? res.error ?? 'The disk could not be measured.' : null;
  }, [api]);
  return { ...reading, measureDisk };
}

/**
 * The disk janitor (PR 542): its state as main keeps it (the scan, what an approval is doing, the never list, the log
 * read back, the scans agents asked for), and its two actions. A scan proposes and deletes nothing; an approval
 * takes the ids the owner ticked, and main checks each again before it goes.
 */
export function useDiskJanitor() {
  const api = typeof window === 'undefined' ? undefined : window.electronAPI?.diskJanitor;
  const reading = useReading(api?.state, api?.onChanged);
  const [actionError, setActionError] = useState<string | null>(null);
  const act = useCallback(async (call: () => Promise<{ success: boolean; error?: string }>, fallback: string) => {
    setActionError(null);
    try {
      const res = await call();
      if (!res.success) setActionError(res.error ?? fallback);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const scan = useCallback(() => (api ? act(() => api.scan(), 'The scan could not start.') : Promise.resolve()), [api, act]);
  const approve = useCallback((ids: string[]) => (api ? act(() => api.approve(ids), 'Nothing was deleted.') : Promise.resolve()), [api, act]);
  return { ...reading, actionError, scan, approve };
}

/** The free space of the disk Tars runs on, which main already reads (Settings · System): the one machine figure the
 * window has before the slot's backend. */
export function useDiskSpace(): { freeBytes: number; totalBytes: number; floorBytes: number } | null {
  const [disk, setDisk] = useState<{ freeBytes: number; totalBytes: number; floorBytes: number } | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => window.electronAPI?.system?.disk?.().then((d) => { if (live) setDisk(d ?? null); }, () => {});
    read();
    const timer = setInterval(read, 60_000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  return disk;
}
