'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { AgentChangeBy, AgentRetuned } from '@/types/electron';

/**
 * The retunes the window has heard of (agent:retuned, 2.0.7), kept for the window's life: the last event per agent,
 * which carries the values before and after that an agent's `lastRetune` does not, and the notices still shown (a
 * change asked by an agent, never one made in the window). One subscription for the whole window, made by the first
 * hook that mounts.
 */
type Store = { byAgent: Record<string, AgentRetuned>; notices: AgentRetuned[] };
let store: Store = { byAgent: {}, notices: [] };
const listeners = new Set<() => void>();
let subscribed = false;

function emit(next: Store) {
  store = next;
  for (const l of listeners) l();
}

function subscribeOnce() {
  if (subscribed || typeof window === 'undefined') return;
  const on = window.electronAPI?.agent?.onRetuned;
  if (!on) return;
  subscribed = true;
  on(e => {
    const byAgent = { ...store.byAgent, [e.agentId]: e };
    // One notice per change: its later state (queued, then applied) replaces the earlier.
    const others = store.notices.filter(n => n.changeId !== e.changeId);
    const notices = e.by.kind === 'agent' ? [e, ...others].slice(0, 3) : others;
    emit({ byAgent, notices });
  });
}

export function dismissRetune(changeId: string) {
  emit({ ...store, notices: store.notices.filter(n => n.changeId !== changeId) });
}

export function useRetunes(): Store {
  useEffect(() => { subscribeOnce(); }, []);
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => store,
    () => store,
  );
}

/** "Lead B (project-b)", "you", "Tars". */
export function byWords(by: AgentChangeBy): string {
  if (by.kind === 'window') return 'you';
  if (by.kind === 'tars') return 'Tars';
  const project = by.projectPath.split(/[\\/]/).filter(Boolean).pop();
  return project ? `${by.name} (${project})` : by.name;
}

/**
 * A setting's value as the change log keeps it: null is the CLI's own default (no model or effort set); a worktree is
 * { worktreePath, branchName }, or null for the project's folder; skills are a list of names.
 */
function valueWords(field: string, v: unknown): string {
  if (field === 'worktree') {
    if (v === null || v === undefined) return "the project's folder";
    const w = v as { branchName?: string; worktreePath?: string };
    return w.branchName ? `worktree ${w.branchName}` : w.worktreePath ?? 'a worktree';
  }
  if (v === undefined || v === null || v === '') return "the CLI's default";
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/**
 * The settings a line about a change names: the ones its caller asked for (`asked`), never the resets they implied
 * (a provider change also clears the model and CLI path it was not given). A record written before `asked` existed
 * has none: its fields stand in.
 */
export const askedOf = (c: { fields: string[]; asked?: string[] }): string[] => c.asked ?? c.fields;
/** The settings a change reset on its own, as a consequence of what was asked: shown apart, in the panel's detail. */
export const impliedOf = (c: { fields: string[]; asked?: string[] }): string[] => (c.asked ? c.fields.filter(f => !c.asked!.includes(f)) : []);

/** "model glm-4.6 to kimi-k2, effort medium to high", or the fields alone when the values are not known. */
export function whatWords(fields: string[], before?: Record<string, unknown>, after?: Record<string, unknown>): string {
  return fields.map(f => (before && after && (f in before || f in after) ? `${f} ${valueWords(f, before[f])} to ${valueWords(f, after[f])}` : f)).join(', ');
}

/** 14:02 */
export function clockOfIso(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
