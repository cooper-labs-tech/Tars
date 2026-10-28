'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Lock, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui';
import type { JanitorItem } from '@/types/electron';
import { Box, Empty, Figure, Figures, Notice, Unread } from './bits';
import { bytes, diskGb, gb, stamp, sum } from './format';
import { useDiskJanitor, useDiskSpace } from './hooks';

/** Each kind of item, one group, under the window's own title; the items' line is the rule they matched. */
const KINDS: Record<JanitorItem['kind'], string> = {
  'closed-worktree': 'Worktrees of merged branches',
  'next-cache': 'Build caches of idle worktrees',
  'test-artefacts': 'Test artefacts',
  'npx-cache': 'The npx cache',
  'docker-image': 'Docker images',
  'docker-vm-trim': 'The Docker VM',
  'agent-tmp': 'Temporary folders of removed agents',
};
const ORDER = Object.keys(KINDS) as JanitorItem['kind'][];
const INK = { deleted: 'text-status-running', kept: 'text-status-waiting', failed: 'text-status-error' } as const;
const PHASE = { checking: 'checking again', deleted: 'deleted', kept: 'kept', failed: 'failed' } as const;

/** A tick box: 14 px, the accent when ticked. */
function Tick({ on, label, onChange, disabled = false }: { on: boolean; label: string; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={`w-3.5 h-3.5 shrink-0 flex items-center justify-center border ${on ? 'bg-primary border-primary' : 'border-border-accent'} disabled:opacity-40`}>
      {on && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
    </button>
  );
}

const outcomeWords = (o: NonNullable<JanitorItem['outcome']>) =>
  o.kind === 'deleted' ? `deleted · ${bytes(o.bytes ?? null)} freed` : o.kind === 'kept' ? `kept: ${o.why ?? 'it no longer matches its rule'}` : `failed: ${o.why ?? 'it could not be deleted'}`;

/** A worktree's details: its branch, whether merged, its idle days, clean. */
function detailsOf(d: NonNullable<JanitorItem['details']>): string {
  return [d.branch ?? 'no branch', d.merged === null ? null : d.merged ? 'merged' : 'not merged', `idle ${d.idleDays} ${d.idleDays === 1 ? 'day' : 'days'}`, d.clean ? 'clean' : 'uncommitted work']
    .filter(Boolean).join(' · ');
}

/**
 * Disk: what a scan proposes, by kind and only from the list, each item with its size and the rule it matched; it
 * comes unticked, the owner ticks what goes, by item or by group, and delete asks once since it cannot be undone.
 * Tars checks each again, deletes it by its exact path and logs the bytes freed. What is never proposed is said
 * plainly; a scan never deletes (frames `Resources (2.0.5) · disk` and `· disk · states`), on Tars-Backend's
 * diskJanitor (PR 542).
 */
export function DiskView() {
  const { state, missing, error, reload, actionError, scan, approve } = useDiskJanitor();
  const disk = useDiskSpace();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  /** This week, from when the page opened. */
  const [weekStart] = useState(() => Date.now() - 7 * 86_400_000);
  const items = useMemo(() => state?.scan?.items ?? [], [state]);
  const open = items.filter((i) => !i.outcome);
  const scanAt = state?.scan?.at ?? null;

  // A new scan comes unticked: the owner ticks what goes. An outcome coming in keeps what was ticked.
  const seenScan = useRef<number | null>(null);
  useEffect(() => {
    if (scanAt === seenScan.current) return;
    seenScan.current = scanAt;
    setTicked(new Set());
    setConfirming(false);
  }, [scanAt]);

  const groups = useMemo(() => {
    const byKind = new Map<JanitorItem['kind'], JanitorItem[]>();
    for (const item of items) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
    return ORDER.filter((k) => byKind.has(k)).map((k) => [k, byKind.get(k)!] as const);
  }, [items]);
  const tickedItems = open.filter((i) => ticked.has(i.id));
  const tickedBytes = sum(tickedItems.map((i) => i.bytes ?? 0)) ?? 0;
  const proposedBytes = sum(open.map((i) => i.bytes ?? 0)) ?? 0;
  const freedWeek = (state?.log ?? []).filter((l) => l.at > weekStart && (l.bytes ?? 0) > 0);
  const freedBytes = sum(freedWeek.map((l) => l.bytes ?? 0)) ?? 0;
  const diskFree = disk ? diskGb(disk.freeBytes) : null;
  const deleting = state?.deleting ?? null;
  const scanning = Boolean(state?.scan?.running);
  const busy = scanning || deleting !== null;
  const lastRequest = state?.requests.length ? state.requests[state.requests.length - 1] : null;
  const count = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

  const toggle = (ids: string[], on: boolean) => setTicked((prev) => {
    const next = new Set(prev);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });
  const scanButton = (label: string, Icon = Search) => (
    <Button size="sm" className="font-mono shrink-0" disabled={busy} onClick={() => void scan()}><Icon className="w-3 h-3" />{label}</Button>
  );
  const go = () => { setConfirming(false); void approve(tickedItems.map((i) => i.id)); };

  return (
    <section role="region" aria-label="Disk" className="flex flex-col gap-3 min-h-0 flex-1">
      <Figures>
        <Figure volatile caption="FREE DISK" value={gb(diskFree)} tone={diskFree == null ? undefined : diskFree < 6 ? 'error' : diskFree < 10 ? 'waiting' : undefined}
          sub={disk ? `of ${gb(diskGb(disk.totalBytes))} · floor ${Math.round(diskGb(disk.floorBytes))} GB` : 'cannot be read'} />
        <Figure caption="PROPOSED" value={state?.scan ? bytes(proposedBytes) : '0 B'} sub={state?.scan ? `${count(open.length)} in ${groups.length} ${groups.length === 1 ? 'group' : 'groups'}` : 'no scan yet'} />
        <Figure caption="TICKED" value={bytes(tickedBytes)} sub={count(tickedItems.length)} />
        <Figure caption="FREED THIS WEEK" value={bytes(freedBytes)} sub={`${count(freedWeek.length)}, each in the log`} />
      </Figures>
      {!missing && diskFree != null && diskFree < 10 && (
        <Notice tone={diskFree < 6 ? 'error' : 'waiting'} actions={scanButton('scan')}>
          {`${gb(diskFree)} free on this computer. A scan finds what the list allows; you choose what goes.`}
        </Notice>
      )}
      {state?.scan?.askedBy && (
        <Notice tone="idle">{`${state.scan.askedBy} asked for a scan at ${stamp(state.scan.at)}: ${count(open.length)} are proposed, none ticked. Only you approve; an agent cannot.`}</Notice>
      )}
      {lastRequest && !state?.scan?.askedBy && (
        <Notice tone="idle">{`${lastRequest.by} asked for a scan of ${lastRequest.project} at ${stamp(lastRequest.at)}: ${count(lastRequest.items)}. Only you approve; an agent cannot.`}</Notice>
      )}
      {(actionError || state?.error) && <Unread text="The disk janitor could not finish:" detail={actionError ?? state?.error} onRetry={actionError ? undefined : reload} />}
      <div className="flex gap-3 items-stretch min-h-0 flex-1 min-w-0">
        <Box name="Proposed" fill className="flex-1"
          caption={deleting ? `DELETING · ${deleting.done} OF ${deleting.total} · ${bytes(deleting.freedBytes)} FREED` : scanning ? 'SCANNING' : state?.scan ? (open.length ? `PROPOSED · ${count(open.length).toUpperCase()} IN ${groups.length} ${groups.length === 1 ? 'GROUP' : 'GROUPS'}` : 'PROPOSED · NOTHING') : 'PROPOSED'}
          note={state?.scan && !scanning ? `scanned ${stamp(state.scan.at)} · a scan deletes nothing` : undefined}
          actions={state?.scan && !busy ? scanButton('scan again', RefreshCw) : undefined}>
          {missing ? (
            <div className="px-3.5 pb-3.5"><Unread text="This Tars cannot read the disk janitor yet: the window gets it with its backend." /></div>
          ) : error ? (
            <div className="px-3.5 pb-3.5"><Unread text="Tars cannot read the disk janitor:" detail={error} onRetry={reload} /></div>
          ) : !state ? (
            <Empty>Reading the disk janitor</Empty>
          ) : scanning ? (
            <div className="flex flex-col gap-1.5 px-3.5 pb-3.5">
              {state.scan?.progress ? (
                <>
                  <p className="font-mono text-[11px] text-foreground">{`${state.scan.progress.what} · ${state.scan.progress.done} of ${state.scan.progress.total}`}</p>
                  <p className="font-mono text-[10.5px] text-muted-foreground">{`${bytes(state.scan.progress.foundBytes)} found so far`}</p>
                  <div className="h-1 bg-secondary"><div className="h-1 bg-primary" style={{ width: `${Math.round((100 * state.scan.progress.done) / Math.max(1, state.scan.progress.total))}%` }} /></div>
                </>
              ) : <p className="text-[11.5px] text-muted-foreground">Scanning. Nothing is deleted.</p>}
            </div>
          ) : !state.scan ? (
            <div className="flex flex-col items-start gap-2.5 px-3.5 pb-3.5">
              <p className="text-[11.5px] leading-[1.5] text-text-secondary">No scan yet. A scan looks only for what the list allows and deletes nothing: you tick what goes, then approve.</p>
              {scanButton('scan')}
            </div>
          ) : items.length === 0 ? (
            <Empty>{`Nothing on this computer matches the list.${diskFree != null ? ` ${gb(diskFree)} free.` : ''}`}</Empty>
          ) : (
            <>
              <div className="flex-1 min-h-0 overflow-y-auto" aria-label="Proposed items">
                {groups.map(([kind, kindItems]) => {
                  const openOfKind = kindItems.filter((i) => !i.outcome);
                  const all = openOfKind.length > 0 && openOfKind.every((i) => ticked.has(i.id));
                  return (
                    <div key={kind} data-rule={kind}>
                      <div className="flex items-center gap-2.5 px-3.5 pt-[9px] pb-[5px] border-t border-border">
                        <Tick on={all} label={KINDS[kind]} disabled={!openOfKind.length || busy} onChange={(on) => toggle(openOfKind.map((i) => i.id), on)} />
                        <span className="flex-1 min-w-0 text-[11.5px] font-medium text-foreground">{KINDS[kind]}</span>
                        <span className="font-mono text-[11px] text-text-secondary">{bytes(sum(kindItems.map((i) => i.bytes ?? 0)))}</span>
                      </div>
                      {kindItems.map((item) => {
                        const at = deleting?.current?.path === item.path ? deleting.current.phase : null;
                        return (
                          <div key={item.id} data-item={item.path} title={item.why} className="flex items-center gap-2.5 pl-[38px] pr-3.5 py-1.5">
                            <Tick on={!item.outcome && ticked.has(item.id)} label={item.label} disabled={Boolean(item.outcome) || busy} onChange={(on) => toggle([item.id], on)} />
                            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                              <span className="font-mono text-[11px] text-foreground break-all">{item.label}</span>
                              {item.outcome ? (
                                <span className={`font-mono text-[10px] ${INK[item.outcome.kind]}`}>{outcomeWords(item.outcome)}</span>
                              ) : at ? (
                                <span className="font-mono text-[10px] text-text-secondary">{PHASE[at]}</span>
                              ) : (
                                <>
                                  <span className="font-mono text-[10px] text-muted-foreground">{item.rule}</span>
                                  {item.details && <span className="font-mono text-[10px] text-muted-foreground">{detailsOf(item.details)}</span>}
                                </>
                              )}
                            </span>
                            <span className="font-mono text-[11px] text-foreground">{item.bytes != null ? bytes(item.bytes) : ''}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              {confirming ? (
                <div role="alertdialog" aria-label="Delete the ticked items" className="flex items-center gap-2 px-3.5 py-2.5 border-t border-border-accent bg-secondary shrink-0">
                  <p className="flex-1 min-w-0 text-[11.5px] leading-[1.45] text-foreground">{`Delete ${count(tickedItems.length)}, ${bytes(tickedBytes)}? Each is checked again just before it goes; this cannot be undone.`}</p>
                  <Button size="sm" variant="primary" className="font-mono" onClick={go}><Trash2 className="w-3 h-3" />delete them</Button>
                  <Button size="sm" className="font-mono" onClick={() => setConfirming(false)}>keep</Button>
                </div>
              ) : (
                <div className="flex items-center gap-2 px-3.5 py-2.5 border-t border-border bg-secondary shrink-0">
                  <span className="font-mono text-[11.5px] text-foreground">{`${tickedItems.length} ticked · ${bytes(tickedBytes)}`}</span>
                  <span className="flex-1 min-w-0 text-[11px] text-muted-foreground">Checked again before it goes, kept if something runs in it now, deleted by its exact path.</span>
                  <Button size="sm" className="font-mono" disabled={!tickedItems.length || busy} onClick={() => setTicked(new Set())}>untick all</Button>
                  <Button size="sm" variant="primary" className="font-mono" disabled={!tickedItems.length || busy} onClick={() => setConfirming(true)}>
                    <Trash2 className="w-3 h-3" />{`delete ${count(tickedItems.length)}`}
                  </Button>
                </div>
              )}
            </>
          )}
        </Box>
        <div className="w-[380px] max-xl:w-[292px] shrink-0 flex flex-col gap-3 min-h-0">
          <Box name="Never proposed" caption="NEVER PROPOSED, NEVER DELETED">
            {state?.never.length ? (
              <ul className="pb-2.5">
                {state.never.map((n) => (
                  <li key={n} className="flex items-center gap-2 px-3.5 py-1"><Lock className="w-3 h-3 shrink-0 text-muted-foreground" /><span className="text-[11.5px] text-text-secondary">{n}</span></li>
                ))}
              </ul>
            ) : <Empty>{missing ? 'Said by the disk janitor, once this Tars has it.' : 'Reading'}</Empty>}
          </Box>
          <Box name="Freed" caption={`FREED · THIS WEEK ${bytes(freedBytes)}`} note="from ~/.tars/logs/janitor.log">
            {state?.log.length ? (
              <ul className="pb-2 overflow-y-auto">
                {[...state.log].reverse().slice(0, 50).map((l, i) => (
                  <li key={`${l.at}-${l.what}-${i}`} className="flex items-center gap-2 px-3.5 py-[5px]">
                    <span className="font-mono text-[10px] text-muted-foreground">{stamp(l.at)}</span>
                    <span className="flex-1 min-w-0 font-mono text-[10.5px] text-text-secondary truncate" title={l.what}>{l.what}</span>
                    <span className="font-mono text-[10.5px] text-foreground">{l.bytes != null ? bytes(l.bytes) : ''}</span>
                  </li>
                ))}
              </ul>
            ) : <Empty>Nothing freed yet.</Empty>}
          </Box>
        </div>
      </div>
    </section>
  );
}
