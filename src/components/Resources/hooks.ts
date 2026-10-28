'use client';

import { useCallback, useEffect, useState } from 'react';
import type { JanitorItem } from '@/types/electron';
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

/** What became of an item the owner approved: gone with the bytes it freed, or kept and why. */
export type JanitorOutcome = { kind: 'deleted'; bytes: number } | { kind: 'kept'; why: string };

/**
 * The disk janitor (PR 542): a scan that proposes, by rule, and deletes nothing; the owner's approval of the ids it
 * showed, each checked again and deleted by its exact path, or kept with why. What this window freed is kept here
 * for the page's log; every deletion is also written to ~/.tars/logs/janitor.log.
 */
export function useDiskJanitor() {
  const system = typeof window === 'undefined' ? undefined : window.electronAPI?.system;
  const missing = !system?.janitorScan || !system?.janitorApprove;
  const [items, setItems] = useState<JanitorItem[] | null>(null);
  const [scanAt, setScanAt] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, JanitorOutcome>>({});
  const [freed, setFreed] = useState<{ at: number; label: string; bytes: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    if (!system?.janitorScan) return;
    setScanning(true);
    setError(null);
    try {
      const res = await system.janitorScan();
      if ('error' in res) setError(res.error);
      else { setItems(res.items); setScanAt(Date.now()); setOutcomes({}); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }, [system]);

  const approve = useCallback(async (ids: string[]) => {
    if (!system?.janitorApprove || !items) return;
    setDeleting(ids.length);
    setError(null);
    try {
      const res = await system.janitorApprove(ids);
      if ('error' in res) { setError(res.error); return; }
      const kept = new Map(res.kept.map((k) => [k.id, k.why]));
      const now = Date.now();
      const next: Record<string, JanitorOutcome> = {};
      const gone: { at: number; label: string; bytes: number }[] = [];
      for (const id of ids) {
        const item = items.find((i) => i.id === id);
        if (!item) continue;
        const why = kept.get(id);
        if (why !== undefined) next[id] = { kind: 'kept', why };
        else { next[id] = { kind: 'deleted', bytes: item.sizeBytes }; gone.push({ at: now, label: item.label, bytes: item.sizeBytes }); }
      }
      setOutcomes((prev) => ({ ...prev, ...next }));
      setFreed((prev) => [...gone, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  }, [system, items]);

  return { missing, items, scanAt, scanning, deleting, outcomes, freed, error, scan, approve };
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
