'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Lock, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui';
import type { JanitorItem } from '@/types/electron';
import { Box, Empty, Figure, Figures, Notice, Unread } from './bits';
import { bytes, gb, stamp, sum } from './format';
import { useDiskJanitor, useDiskSpace, type JanitorOutcome } from './hooks';

/**
 * What the janitor never proposes nor deletes (PR 542's janitor-rules.ts, said in the window as the frame draws it):
 * the scan cannot answer it, so the words are the window's, kept to that list.
 */
const NEVER = [
  'the uv cache',
  'anything under ~/.tars-private or ~/Documents',
  'the Trash',
  'Xcode, the iOS runtimes and simulators',
  'any Docker volume, Supabase\'s among them',
  'a project\'s own folder',
  'a worktree an agent of the fleet works in',
  'a worktree with uncommitted work',
  'a worktree a process works in',
  'anything the list does not name',
];

const INK = { deleted: 'text-status-running', kept: 'text-status-waiting' } as const;

/** A tick box: 14 px, the accent when ticked. */
function Tick({ on, label, onChange, disabled = false }: { on: boolean; label: string; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={`w-3.5 h-3.5 shrink-0 flex items-center justify-center border ${on ? 'bg-primary border-primary' : 'border-border-accent'} disabled:opacity-40`}>
      {on && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
    </button>
  );
}

const outcomeWords = (o: JanitorOutcome) => (o.kind === 'deleted' ? `deleted · ${bytes(o.bytes)} freed` : `kept: ${o.why}`);
/** Docker's two kinds are left for the owner to tick, as the frame draws them; the rest come ticked. */
const tickedAtFirst = (i: JanitorItem) => i.kind !== 'docker-image' && i.kind !== 'docker-vm-trim';

/**
 * Disk: what a scan proposes, by rule and only from the list, each item with its size and the rule it matched; the
 * owner ticks and approves, and Tars checks each again, deletes it by its exact path and logs the bytes freed. What
 * is never proposed is said plainly; a scan never deletes (frames `Resources (2.0.5) · disk` and `· disk · states`),
 * on Tars-Backend's janitor (PR 542).
 */
export function DiskView() {
  const { missing, items, scanAt, scanning, deleting, outcomes, freed, error, scan, approve } = useDiskJanitor();
  const disk = useDiskSpace();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const list = useMemo(() => items ?? [], [items]);
  const open = list.filter((i) => !outcomes[i.id]);

  // A new scan ticks what it proposes but Docker's; an outcome coming in keeps what the owner ticked.
  const seenScan = useRef<number | null>(null);
  useEffect(() => {
    if (scanAt === seenScan.current) return;
    seenScan.current = scanAt;
    setTicked(new Set(list.filter(tickedAtFirst).map((i) => i.id)));
  }, [scanAt, list]);

  const rules = useMemo(() => {
    const byRule = new Map<string, JanitorItem[]>();
    for (const item of list) byRule.set(item.rule, [...(byRule.get(item.rule) ?? []), item]);
    return [...byRule.entries()];
  }, [list]);
  const tickedItems = open.filter((i) => ticked.has(i.id));
  const tickedBytes = sum(tickedItems.map((i) => i.sizeBytes)) ?? 0;
  const proposedBytes = sum(open.map((i) => i.sizeBytes)) ?? 0;
  const freedBytes = sum(freed.map((f) => f.bytes)) ?? 0;
  const diskFree = disk ? disk.freeBytes / 1e9 : null;
  const busy = scanning || deleting !== null;

  const toggle = (ids: string[], on: boolean) => setTicked((prev) => {
    const next = new Set(prev);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });
  const scanButton = (label: string, Icon = Search) => (
    <Button size="sm" className="font-mono shrink-0" disabled={busy} onClick={() => void scan()}><Icon className="w-3 h-3" />{label}</Button>
  );

  return (
    <section role="region" aria-label="Disk" className="flex flex-col gap-3 min-h-0 flex-1">
      <Figures>
        <Figure volatile caption="FREE DISK" value={gb(diskFree)} tone={diskFree == null ? undefined : diskFree < 6 ? 'error' : diskFree < 10 ? 'waiting' : undefined}
          sub={disk ? `of ${gb(disk.totalBytes / 1e9)} · floor ${Math.round(disk.floorBytes / 1e9)} GB` : 'cannot be read'} />
        <Figure caption="PROPOSED" value={items ? bytes(proposedBytes) : '0 B'} sub={items ? `${open.length} items by ${rules.length} rules` : 'no scan yet'} />
        <Figure caption="TICKED" value={bytes(tickedBytes)} sub={`${tickedItems.length} items`} />
        <Figure caption="FREED HERE" value={bytes(freedBytes)} sub={`${freed.length} items, each in the log`} />
      </Figures>
      {!missing && diskFree != null && diskFree < 10 && (
        <Notice tone={diskFree < 6 ? 'error' : 'waiting'} actions={scanButton('scan')}>
          {`${gb(diskFree)} free on this computer. A scan finds what the list allows; you choose what goes.`}
        </Notice>
      )}
      {error && <Unread text="The disk janitor could not finish:" detail={error} />}
      <div className="flex gap-3 items-stretch min-h-0 flex-1 min-w-0">
        <Box name="Proposed" fill className="flex-1"
          caption={deleting !== null ? `DELETING · ${deleting} ${deleting === 1 ? 'ITEM' : 'ITEMS'}` : scanning ? 'SCANNING' : items ? (open.length ? `PROPOSED · ${open.length} ITEMS BY ${rules.length} RULES` : 'PROPOSED · NOTHING') : 'PROPOSED'}
          note={items && scanAt && !scanning ? `scanned ${stamp(scanAt)} · a scan deletes nothing` : undefined}
          actions={items && !scanning ? scanButton('scan again', RefreshCw) : undefined}>
          {missing ? (
            <div className="px-3.5 pb-3.5"><Unread text="This Tars cannot read the disk janitor yet: the window gets it with its backend." /></div>
          ) : scanning ? (
            <Empty>{'Scanning: worktrees, test artefacts, the npx cache, Docker and the agents\' temporary folders. Nothing is deleted.'}</Empty>
          ) : !items ? (
            <div className="flex flex-col items-start gap-2.5 px-3.5 pb-3.5">
              <p className="text-[11.5px] leading-[1.5] text-text-secondary">No scan yet. A scan looks only for what the list allows and deletes nothing: you tick what goes, then approve.</p>
              {scanButton('scan')}
            </div>
          ) : list.length === 0 ? (
            <Empty>{`Nothing on this computer matches the list.${diskFree != null ? ` ${gb(diskFree)} free.` : ''}`}</Empty>
          ) : (
            <>
              <div className="flex-1 min-h-0 overflow-y-auto" aria-label="Proposed items">
                {rules.map(([rule, ruleItems]) => {
                  const openOfRule = ruleItems.filter((i) => !outcomes[i.id]);
                  const all = openOfRule.length > 0 && openOfRule.every((i) => ticked.has(i.id));
                  return (
                    <div key={rule} data-rule={rule}>
                      <div className="flex items-center gap-2.5 px-3.5 pt-[9px] pb-[5px] border-t border-border">
                        <Tick on={all} label={rule} disabled={!openOfRule.length || busy} onChange={(on) => toggle(openOfRule.map((i) => i.id), on)} />
                        <span className="flex-1 min-w-0 text-[11.5px] font-medium text-foreground first-letter:uppercase">{rule}</span>
                        <span className="font-mono text-[11px] text-text-secondary">{bytes(sum(ruleItems.map((i) => i.sizeBytes)))}</span>
                      </div>
                      {ruleItems.map((item) => {
                        const done = outcomes[item.id];
                        return (
                          <div key={item.id} data-item={item.path ?? item.ref ?? item.label} className="flex items-center gap-2.5 pl-[38px] pr-3.5 py-1.5">
                            <Tick on={!done && ticked.has(item.id)} label={item.label} disabled={Boolean(done) || busy} onChange={(on) => toggle([item.id], on)} />
                            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                              <span className="font-mono text-[11px] text-foreground break-all">{item.label}</span>
                              <span className={`font-mono text-[10px] ${done ? INK[done.kind] : 'text-muted-foreground'}`}>
                                {done ? outcomeWords(done) : item.project ? `in ${item.project}` : item.kind === 'docker-vm-trim' ? 'gives the freed space back to this Mac' : ''}
                              </span>
                            </span>
                            <span className="font-mono text-[11px] text-foreground">{item.sizeBytes ? bytes(item.sizeBytes) : ''}</span>
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
                <Button size="sm" className="font-mono" disabled={!tickedItems.length || busy} onClick={() => setTicked(new Set())}>untick all</Button>
                <Button size="sm" variant="primary" className="font-mono" disabled={!tickedItems.length || busy} onClick={() => void approve(tickedItems.map((i) => i.id))}>
                  <Trash2 className="w-3 h-3" />{`delete ${tickedItems.length} ${tickedItems.length === 1 ? 'item' : 'items'}`}
                </Button>
              </div>
            </>
          )}
        </Box>
        <div className="w-[380px] max-xl:w-[292px] shrink-0 flex flex-col gap-3">
          <Box name="Never proposed" caption="NEVER PROPOSED, NEVER DELETED">
            <ul className="pb-2.5">
              {NEVER.map((n) => (
                <li key={n} className="flex items-center gap-2 px-3.5 py-1"><Lock className="w-3 h-3 shrink-0 text-muted-foreground" /><span className="text-[11.5px] text-text-secondary">{n}</span></li>
              ))}
            </ul>
          </Box>
          <Box name="Freed" caption={`FREED HERE · ${bytes(freedBytes)}`} note="each in ~/.tars/logs/janitor.log">
            {freed.length ? (
              <ul className="pb-2">
                {freed.map((l, i) => (
                  <li key={`${l.at}-${l.label}-${i}`} className="flex items-center gap-2 px-3.5 py-[5px]">
                    <span className="font-mono text-[10px] text-muted-foreground">{stamp(l.at)}</span>
                    <span className="flex-1 min-w-0 font-mono text-[10.5px] text-text-secondary truncate" title={l.label}>{l.label}</span>
                    <span className="font-mono text-[10.5px] text-foreground">{bytes(l.bytes)}</span>
                  </li>
                ))}
              </ul>
            ) : <Empty>Nothing freed from this window yet.</Empty>}
          </Box>
        </div>
      </div>
    </section>
  );
}
