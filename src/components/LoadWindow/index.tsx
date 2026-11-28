'use client';

import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { StatusSquare } from '@/components/ui';
import { useStore } from '@/store';
import type { LoadProposal, LoadWindowParams } from '@/types/electron';
import { loadApi, useLoadWindow } from '@/hooks/useLoadWindow';
import { Approval } from './Approval';
import { Ended, Nothing, Running } from './RunViews';
import { Projects } from './Projects';
import { MEMORY_LINE } from './bits';

/** How long an ended window stays the card's first view; after it, "nothing to approve" says it in one line. */
const ENDED_SHOWN_MS = 12 * 60 * 60_000;

/**
 * The Load window, a page of More opened as a card (`Shell · Load window card · *`, PR 672's frames) on PR 685's
 * contract. Its views: the window running, else the proposal it shows, else the window that ended last, else nothing to
 * approve; and Projects, behind the switch in the card's head. The proposal shown is the one Approve carries, pinned
 * while it is shown: a pool written since is said, and main's `stale` answer shows the card again as the pool is then.
 * Only a click here approves, says not now, stops a window or sets a grant.
 */
export default function LoadWindowPage() {
  const { state, setState, error: readError } = useLoadWindow();
  const view = useStore(s => s.loadView);
  const setLoadView = useStore(s => s.setLoadView);
  const [shown, setShown] = useState<LoadProposal | null>(null);
  const [staleShown, setStaleShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  // The clock an ended window is measured against, read once a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);

  // The proposal shown is taken once, and kept while main still proposes a pool: a newer snapshot is said, not swapped.
  useEffect(() => {
    if (!state) return;
    if (!state.proposal) { setShown(null); setStaleShown(false); return; }
    setShown(prev => prev ?? state.proposal!);
  }, [state]);

  const approve = async (window: Partial<LoadWindowParams>) => {
    const api = loadApi();
    if (!api || !shown) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.approve({ pool: shown.pool, sha256: shown.sha256, proposalId: shown.id, window });
      if (r.ok) {
        setShown(null);
        setStaleShown(false);
        setState(await api.state());
      } else if ('reason' in r) {
        setState(r.state);
        setShown(r.state.proposal ?? null);
        setStaleShown(!!r.state.proposal);
      } else {
        setError(r.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const notNow = async () => {
    const api = loadApi();
    if (!api || !shown) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.notNow({ pool: shown.pool, sha256: shown.sha256 });
      if (!r.ok) { setError(r.error ?? 'Not set aside.'); return; }
      setShown(null);
      setStaleShown(false);
      setState(await api.state());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (runId: string) => {
    const api = loadApi();
    if (!api) return;
    setStopping(true);
    setStopError(null);
    try {
      const r = await api.stop(runId);
      if (!r.ok) setStopError(r.error);
      setState(await api.state());
    } catch (e) {
      setStopError(e instanceof Error ? e.message : String(e));
    } finally {
      setStopping(false);
    }
  };

  if (view === 'projects') return <Projects />;
  if (!state) {
    return <div className="flex-1 min-h-0 px-[26px] pt-[18px] text-[12.5px] text-muted-foreground">{readError ? <span className="text-status-error">{readError}</span> : 'Reading the load window'}</div>;
  }
  if (state.running) return <Running run={state.running} onStop={() => { void stop(state.running!.runId); }} stopError={stopError} stopping={stopping} />;
  if (shown) {
    return (
      <Approval key={shown.sha256} proposal={shown} changedSince={!!state.proposal && state.proposal.sha256 !== shown.sha256} staleShown={staleShown}
        busy={busy} error={error} onApprove={w => { void approve(w); }} onNotNow={() => { void notNow(); }} onProjects={() => setLoadView('projects')} />
    );
  }
  const last = state.last;
  if (last?.stop && now - last.stop.at < ENDED_SHOWN_MS) return <Ended run={last} />;
  return <Nothing last={last} />;
}

/** The switch in the card's head: Window | Projects, the one shown a box. */
export function LoadViewSwitch() {
  const view = useStore(s => s.loadView);
  const setLoadView = useStore(s => s.setLoadView);
  return (
    <div className="flex items-center gap-1.5">
      {(['window', 'projects'] as const).map(v => (
        <button key={v} type="button" aria-pressed={view === v} onClick={() => setLoadView(v)}
          className={`h-[26px] px-2.5 border text-[11.5px] transition-colors ${view === v ? 'bg-secondary border-border-strong text-foreground' : 'border-border text-text-secondary hover:text-foreground'}`}>
          {v === 'window' ? 'Window' : 'Projects'}
        </button>
      ))}
    </div>
  );
}

/**
 * The sidebar's row while a window waits for the owner or runs (`Shell · Load window · a window waits, in the sidebar`):
 * above More, on every page, the waiting square and "waits", or the running square and the minutes left. It opens the
 * card. Nothing else announces it.
 */
export function LoadSidebarRow({ onOpen }: { onOpen: () => void }) {
  const { state } = useLoadWindow();
  const setLoadView = useStore(s => s.setLoadView);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const running = state?.running;
  if (!running && !state?.proposal) return null;
  const left = running ? Math.max(0, Math.ceil((running.endsAt - now) / 60_000)) : 0;
  return (
    <button type="button" data-load-sidebar onClick={() => { setLoadView('window'); onOpen(); }}
      className="w-full mb-0.5 flex items-center gap-[10px] h-8 px-2.5 border bg-secondary border-border-accent">
      <StatusSquare tone={running ? 'running' : 'waiting'} />
      <span className="text-[13px] flex-1 text-left text-foreground">Load window</span>
      <span className={`font-mono text-[11px] ${running ? 'text-status-running' : 'text-status-waiting'}`}>{running ? `${left} min left` : 'waits'}</span>
      <ChevronRight className="w-3 h-3 text-status-idle" />
    </button>
  );
}

export { MEMORY_LINE };
