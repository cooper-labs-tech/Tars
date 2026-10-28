'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Lock, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui';
import { Box, Empty, Figure, Figures, Notice, Unread } from './bits';
import type { JanitorItem } from './contract';
import { bytes, gb, stamp, sum } from './format';
import { useDiskJanitor, useDiskSpace } from './hooks';

/** A tick box: 14 px, the accent when ticked. */
function Tick({ on, label, onChange, disabled = false }: { on: boolean; label: string; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={`w-3.5 h-3.5 shrink-0 flex items-center justify-center border ${on ? 'bg-primary border-primary' : 'border-border-accent'} disabled:opacity-40`}>
      {on && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
    </button>
  );
}

const INK = { running: 'text-status-running', waiting: 'text-status-waiting', error: 'text-status-error' } as const;

function outcomeWords(item: JanitorItem): { text: string; tone: keyof typeof INK } | null {
  const o = item.outcome;
  if (!o) return null;
  if (o.kind === 'deleted') return { text: `deleted · ${bytes(o.bytes ?? item.bytes)} freed`, tone: 'running' };
  if (o.kind === 'kept') return { text: `kept: ${o.why ?? 'it no longer matches its rule'}`, tone: 'waiting' };
  return { text: `failed: ${o.why ?? 'it could not be deleted'}`, tone: 'error' };
}

/**
 * Disk: what a scan proposes, by rule and only from the list, each item with its size and why; the owner ticks and
 * approves, and Tars checks each again, deletes it by its exact path and logs the bytes freed. What is never proposed is
 * said plainly; a scan never deletes (frames `Resources (2.0.5) · disk` and `· disk · states`).
 */
export function DiskView() {
  const { state, missing, error, reload, scan, approve } = useDiskJanitor();
  const disk = useDiskSpace();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  /** This week, from when the page opened. */
  const [weekStart] = useState(() => Date.now() - 7 * 86_400_000);
  const [actionError, setActionError] = useState<string | null>(null);
  const items = useMemo(() => state?.scan?.items ?? [], [state]);
  const open = items.filter((i) => !i.outcome);
  const scanAt = state?.scan?.at;

  // A new scan ticks what it proposes, but Docker images, which the frame leaves for the owner to tick. Only a new
  // scan: an outcome coming in keeps what the owner ticked.
  const seenScan = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (scanAt === seenScan.current) return;
    seenScan.current = scanAt;
    setTicked(new Set(items.filter((i) => !i.outcome && !/docker/i.test(i.rule)).map((i) => i.id)));
  }, [scanAt, items]);

  const rules = useMemo(() => {
    const byRule = new Map<string, JanitorItem[]>();
    for (const item of items) byRule.set(item.rule, [...(byRule.get(item.rule) ?? []), item]);
    return [...byRule.entries()];
  }, [items]);
  const tickedItems = open.filter((i) => ticked.has(i.id));
  const tickedBytes = sum(tickedItems.map((i) => i.bytes)) ?? 0;
  const proposedBytes = sum(open.map((i) => i.bytes)) ?? 0;
  const freedWeek = state?.log.filter((l) => l.at > weekStart) ?? [];
  const diskFree = disk ? disk.freeBytes / 1e9 : null;
  const deleting = state?.deleting ?? null;
  const scanning = Boolean(state?.scan?.running);

  const toggle = (ids: string[], on: boolean) => setTicked((prev) => {
    const next = new Set(prev);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });
  const run = async (what: () => Promise<string | null>) => {
    setBusy(true);
    setActionError(null);
    try { setActionError(await what()); } finally { setBusy(false); }
  };

  return (
    <section role="region" aria-label="Disk" className="flex flex-col gap-3 min-h-0 flex-1">
      <Figures>
        <Figure volatile caption="FREE DISK" value={gb(diskFree)} tone={diskFree == null ? undefined : diskFree < 6 ? 'error' : diskFree < 10 ? 'waiting' : undefined}
          sub={disk ? `of ${gb(disk.totalBytes / 1e9)} · floor ${Math.round(disk.floorBytes / 1e9)} GB` : 'cannot be read'} />
        <Figure caption="PROPOSED" value={state?.scan ? bytes(proposedBytes) : '0 B'} sub={state?.scan ? `${open.length} items by ${rules.length} rules` : 'no scan yet'} />
        <Figure caption="TICKED" value={bytes(tickedBytes)} sub={`${tickedItems.length} items`} />
        <Figure caption="FREED THIS WEEK" value={bytes(sum(freedWeek.map((l) => l.bytes)) ?? 0)} sub={`${freedWeek.length} items, each in the log`} />
      </Figures>
      {diskFree != null && diskFree < 10 && (
        <Notice tone={diskFree < 6 ? 'error' : 'waiting'} actions={!missing && <Button size="sm" className="font-mono" disabled={busy || scanning} onClick={() => void run(scan)}><Search className="w-3 h-3" />scan</Button>}>
          {`${gb(diskFree)} free on this computer. A scan finds what the list allows; you choose what goes.`}
        </Notice>
      )}
      {state?.scan?.askedBy && <Notice tone="idle">{`${state.scan.askedBy} asked for a scan at ${stamp(state.scan.at)}: ${open.length} items are proposed. Only you approve; an agent cannot.`}</Notice>}
      {(actionError || state?.error) && <Unread text={actionError ?? 'Tars could not finish:'} detail={actionError ? null : state?.error} onRetry={actionError ? undefined : reload} />}
      <div className="flex gap-3 items-stretch min-h-0 flex-1 min-w-0">
        <Box name="Proposed" fill className="flex-1"
          caption={deleting ? `DELETING · ${deleting.done} OF ${deleting.total} · ${bytes(deleting.freedBytes)} FREED` : scanning ? 'SCANNING' : state?.scan ? (open.length ? `PROPOSED · ${open.length} ITEMS BY ${rules.length} RULES` : 'PROPOSED · NOTHING') : 'PROPOSED'}
          note={state?.scan && !scanning ? `scanned ${stamp(state.scan.at)} · a scan deletes nothing` : undefined}
          actions={state?.scan && !scanning ? <Button size="sm" className="font-mono shrink-0" disabled={busy || Boolean(deleting)} onClick={() => void run(scan)}><RefreshCw className="w-3 h-3" />scan again</Button> : undefined}>
          {missing ? (
            <div className="px-3.5 pb-3.5"><Unread text="This Tars cannot read the disk janitor yet: the window gets it with its backend." /></div>
          ) : error ? (
            <div className="px-3.5 pb-3.5"><Unread text="Tars cannot read the disk janitor:" detail={error} onRetry={reload} /></div>
          ) : !state ? (
            <Empty>Reading the disk janitor</Empty>
          ) : scanning ? (
            <div className="flex flex-col gap-1.5 px-3.5 pb-3.5">
              {state.scan?.progress && (
                <>
                  <p className="font-mono text-[11px] text-foreground">{`${state.scan.progress.what} · ${state.scan.progress.done} of ${state.scan.progress.total}`}</p>
                  <p className="font-mono text-[10.5px] text-muted-foreground">{`${bytes(state.scan.progress.foundBytes)} found so far`}</p>
                  <div className="h-1 bg-secondary"><div className="h-1 bg-primary" style={{ width: `${Math.round((100 * state.scan.progress.done) / Math.max(1, state.scan.progress.total))}%` }} /></div>
                </>
              )}
            </div>
          ) : !state.scan ? (
            <div className="flex flex-col items-start gap-2.5 px-3.5 pb-3.5">
              <p className="text-[11.5px] leading-[1.5] text-text-secondary">No scan yet. A scan looks only for what the list allows and deletes nothing: you tick what goes, then approve.</p>
              <Button size="sm" className="font-mono" disabled={busy} onClick={() => void run(scan)}><Search className="w-3 h-3" />scan</Button>
            </div>
          ) : items.length === 0 ? (
            <Empty>{`Nothing on this computer matches the list.${diskFree != null ? ` ${gb(diskFree)} free.` : ''}`}</Empty>
          ) : (
            <>
              <div className="flex-1 min-h-0 overflow-y-auto" aria-label="Proposed items">
                {rules.map(([rule, ruleItems]) => {
                  const openOfRule = ruleItems.filter((i) => !i.outcome);
                  const all = openOfRule.length > 0 && openOfRule.every((i) => ticked.has(i.id));
                  return (
                    <div key={rule} data-rule={rule}>
                      <div className="flex items-center gap-2.5 px-3.5 pt-[9px] pb-[5px] border-t border-border">
                        <Tick on={all} label={rule} disabled={!openOfRule.length || Boolean(deleting)} onChange={(on) => toggle(openOfRule.map((i) => i.id), on)} />
                        <span className="flex-1 min-w-0 text-[11.5px] font-medium text-foreground">{rule}</span>
                        <span className="font-mono text-[11px] text-text-secondary">{bytes(sum(ruleItems.map((i) => i.bytes)))}</span>
                      </div>
                      {ruleItems.map((item) => {
                        const done = outcomeWords(item);
                        return (
                          <div key={item.id} data-item={item.path} className="flex items-center gap-2.5 pl-[38px] pr-3.5 py-1.5">
                            <Tick on={!item.outcome && ticked.has(item.id)} label={item.path} disabled={Boolean(item.outcome) || Boolean(deleting)} onChange={(on) => toggle([item.id], on)} />
                            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                              <span className="font-mono text-[11px] text-foreground break-all">{item.path}</span>
                              <span className={`font-mono text-[10px] ${done ? INK[done.tone] : 'text-muted-foreground'}`}>{done ? done.text : item.why}</span>
                            </span>
                            <span className="font-mono text-[11px] text-foreground">{item.bytes != null ? bytes(item.bytes) : ''}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center gap-2 px-3.5 py-2.5 border-t border-border bg-secondary shrink-0">
                <span className="font-mono text-[11.5px] text-foreground">{`${tickedItems.length} ticked · ${bytes(tickedBytes)}`}</span>
                <span className="flex-1 min-w-0 text-[11px] text-muted-foreground">Checked again before it goes, kept if something runs in it now, deleted by its exact path.</span>
                <Button size="sm" className="font-mono" disabled={!tickedItems.length || Boolean(deleting)} onClick={() => setTicked(new Set())}>untick all</Button>
                <Button size="sm" variant="primary" className="font-mono" disabled={!tickedItems.length || busy || Boolean(deleting)} onClick={() => void run(() => approve(tickedItems.map((i) => i.id)))}>
                  <Trash2 className="w-3 h-3" />{`delete ${tickedItems.length} ${tickedItems.length === 1 ? 'item' : 'items'}`}
                </Button>
              </div>
            </>
          )}
        </Box>
        <div className="w-[380px] max-xl:w-[292px] shrink-0 flex flex-col gap-3">
          <Box name="Never proposed" caption="NEVER PROPOSED, NEVER DELETED">
            {state?.never.length ? (
              <ul className="pb-2.5">
                {state.never.map((n) => (
                  <li key={n} className="flex items-center gap-2 px-3.5 py-1"><Lock className="w-3 h-3 shrink-0 text-muted-foreground" /><span className="text-[11.5px] text-text-secondary">{n}</span></li>
                ))}
              </ul>
            ) : <Empty>{missing ? 'Said by the disk janitor, once this Tars has it.' : 'Reading'}</Empty>}
          </Box>
          <Box name="Freed" caption={`FREED · THIS WEEK ${bytes(sum(freedWeek.map((l) => l.bytes)) ?? 0)}`}>
            {state?.log.length ? (
              <ul className="pb-2">
                {state.log.slice(0, 20).map((l) => (
                  <li key={`${l.at}-${l.what}`} className="flex items-center gap-2 px-3.5 py-[5px]">
                    <span className="font-mono text-[10px] text-muted-foreground">{stamp(l.at)}</span>
                    <span className="flex-1 min-w-0 font-mono text-[10.5px] text-text-secondary truncate" title={l.what}>{l.what}</span>
                    <span className="font-mono text-[10.5px] text-foreground">{bytes(l.bytes)}</span>
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
