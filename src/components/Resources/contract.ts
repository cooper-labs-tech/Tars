'use client';

/**
 * What the Resources page reads from the main process (2.0.5, lots 2 and 3 of the resources plan), as the frame
 * `Resources (2.0.5) · notes` (design PR 535) asks each backend for it. The slot is Tars-Backend's, typed in
 * electron.d.ts since PR 537; the fleet's resources and the disk janitor are the Database Engineer's, read here by
 * the shapes the notes ask for until their channels and types are in preload.ts and electron.d.ts. A view whose
 * channel is not there says it cannot read it: the window never makes a figure up.
 */

/** The heavy-run slot, Tars-Backend's channel (PR 537), typed in electron.d.ts. */
export type HeavySlotApi = NonNullable<NonNullable<Window['electronAPI']>['heavySlot']>;
export type HeavySlotStatus = Awaited<ReturnType<HeavySlotApi['status']>>;
export type HeavySlotHolder = HeavySlotStatus['holders'][number];
export type HeavySlotTicket = HeavySlotStatus['waiting'][number];
export type HeavySlotAlert = HeavySlotStatus['alerts'][number];

export type { AgentProcess, MeasuredPath, AgentResources, ProjectResources, FleetResources } from '@/types/electron';
import type { FleetResources } from '@/types/electron';

export interface FleetApi {
  read: () => Promise<FleetResources>;
  measureDisk: () => Promise<{ success: boolean; error?: string }>;
  onChanged: (cb: (state: FleetResources) => void) => () => void;
}

export interface JanitorItem {
  id: string;
  /** Exact and absolute. */
  path: string;
  bytes: number | null;
  /** The rule it matched, as a sentence; the items come grouped by it. */
  rule: string;
  why: string;
  /** After an approval: gone, kept (and why), failed (and the error). */
  outcome?: { kind: 'deleted' | 'kept' | 'failed'; bytes?: number | null; why?: string | null } | null;
}

export interface JanitorState {
  scan: null | {
    at: number;
    /** An agent's name when an agent asked for it; null when the window did. */
    askedBy: string | null;
    running: boolean;
    progress?: { what: string; done: number; total: number; foundBytes: number } | null;
    items: JanitorItem[];
  };
  deleting?: { done: number; total: number; freedBytes: number } | null;
  /** What is never proposed nor deleted, as words. */
  never: string[];
  log: { at: number; what: string; bytes: number | null }[];
  error?: string | null;
}

export interface JanitorApi {
  state: () => Promise<JanitorState>;
  scan: () => Promise<{ success: boolean; error?: string }>;
  approve: (ids: string[]) => Promise<{ success: boolean; error?: string }>;
  onChanged: (cb: (state: JanitorState) => void) => () => void;
}

interface ResourcesChannels { resources?: FleetApi; diskJanitor?: JanitorApi }

/** A backend's channel, or undefined while this Tars has none. */
export function channel<K extends keyof ResourcesChannels>(name: K): ResourcesChannels[K] | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window.electronAPI as unknown as ResourcesChannels | undefined)?.[name];
}
