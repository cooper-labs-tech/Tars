'use client';

import { useState } from 'react';
import { Shield } from 'lucide-react';
import { Button, StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';
import { Box, Empty, Figure, Figures, Notice, Row, Unread } from './bits';
import type { HeavySlotAlert, HeavySlotHolder, HeavySlotStatus, HeavySlotTicket } from './contract';
import { NOT_READ, clock, diskGb, freeMemory, gb, mb, pct, since } from './format';
import { useDiskSpace, useHeavyRuns } from './hooks';

const PRIORITY: Record<HeavySlotTicket['priority'], string> = { gate: 'release gate', normal: 'ordinary', background: 'background' };
const ms = (iso: string) => Date.parse(iso);

function Chip({ priority, strong = false }: { priority: HeavySlotTicket['priority']; strong?: boolean }) {
  return (
    <span className={`shrink-0 px-1.5 py-0.5 border font-mono text-[10px] ${strong ? 'border-border-accent bg-secondary text-foreground' : 'border-border text-text-secondary'}`}>
      {PRIORITY[priority]}
    </span>
  );
}

/** The run that holds the slot: who, for what, since when, its tree; show agent, and give back, which asks once. */
function Holder({ run, onShow, onGiveBack }: { run: HeavySlotHolder; onShow: (agentId: string) => void; onGiveBack: (ticketId: string) => Promise<boolean> }) {
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState(false);
  const tree = [`pid ${run.pid}`, run.tree ? `its tree ${mb(run.tree.memoryMb)}, ${pct(run.tree.cpuPct)} CPU` : null].filter(Boolean).join(' · ');
  const give = async () => {
    setAsking(false);
    setFailed(!(await onGiveBack(run.id)));
  };
  return (
    <div data-holder={run.agentName}>
      <Row className="flex flex-col gap-1.5 pt-2.5 pb-3">
        <div className="flex items-center gap-2 min-w-0">
          <StatusSquare tone="running" />
          <span className="text-[12.5px] font-medium text-foreground truncate">{run.agentName}</span>
          <span className="font-mono text-[10.5px] text-muted-foreground truncate">{run.project}</span>
          <Chip priority={run.priority} strong />
        </div>
        <p data-label className="font-mono text-[11.5px] text-foreground break-all">{run.label}</p>
        <div className="flex items-center gap-2">
          <p className="flex-1 min-w-0 font-mono text-[10.5px] text-muted-foreground">{`holds it ${since(ms(run.grantedAt ?? run.askedAt))} · ${tree}`}</p>
          <Button size="sm" className="font-mono" onClick={() => onShow(run.agentId)}>show agent</Button>
          {!asking && <Button size="sm" className="font-mono" onClick={() => { setFailed(false); setAsking(true); }}>give back</Button>}
        </div>
      </Row>
      {asking && (
        <div className="flex items-center gap-2 px-3.5 py-2 bg-secondary border-t border-border">
          <p className="flex-1 min-w-0 text-[11.5px] leading-[1.45] text-foreground">{`Give the slot back? ${run.agentName}'s run goes on; the slot goes to the next waiter. ${run.agentName} and its orchestrator are told.`}</p>
          <Button size="sm" className="font-mono" onClick={() => void give()}>give it back</Button>
          <Button size="sm" className="font-mono" onClick={() => setAsking(false)}>keep</Button>
        </div>
      )}
      {failed && <div className="px-3.5 pb-2.5"><Unread text="The slot could not be given back: that run had already ended. Nothing else changed." /></div>}
    </div>
  );
}

function Waiter({ run, n }: { run: HeavySlotTicket; n: number }) {
  return (
    <Row data-waiter={run.agentName} className="flex flex-col gap-1">
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-[11px] text-muted-foreground">{n}</span>
        <span className="w-[200px] max-xl:w-[150px] shrink-0 flex items-center gap-1.5 min-w-0 overflow-hidden">
          <span className="text-[12px] text-foreground truncate">{run.agentName}</span>
          <span className="font-mono text-[10.5px] text-muted-foreground truncate">{run.project}</span>
        </span>
        <span className="w-[104px] max-xl:w-[92px] shrink-0"><Chip priority={run.priority} /></span>
        <span className="flex-1 min-w-0 font-mono text-[11px] text-text-secondary truncate" title={run.label}>{run.label}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{since(ms(run.askedAt))}</span>
      </div>
      {run.why && (
        <p className="flex items-center gap-1.5 pl-4 font-mono text-[10.5px] text-status-waiting"><StatusSquare tone="waiting" />{run.why}</p>
      )}
    </Row>
  );
}

/** A give-back is said in the idle grey; an alert of the machine in the waiting colour. */
const alertTone = (a: HeavySlotAlert): StatusTone => (/given back/i.test(a.text) ? 'idle' : 'waiting');

function AlertRow({ alert }: { alert: HeavySlotAlert }) {
  return (
    <Row data-alert className="flex flex-col gap-[3px]">
      <p className="flex items-start gap-2">
        <StatusSquare tone={alertTone(alert)} className="mt-[5px]" />
        <span className="shrink-0 font-mono text-[10.5px] leading-[1.6] text-muted-foreground">{clock(ms(alert.at))}</span>
        <span className="flex-1 min-w-0 text-[11.5px] leading-[1.45] text-foreground">{alert.text}</span>
      </p>
      {alert.sentTo.length > 0 && <p className="font-mono text-[10px] text-muted-foreground">{`sent to ${alert.sentTo.join(' · ')}`}</p>}
    </Row>
  );
}

function FloorLine({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center gap-2 px-3.5 py-[5px]">
      <span className="flex-1 min-w-0 text-[11.5px] text-text-secondary">{k}</span>
      <span className="font-mono text-[11px] text-foreground">{v}</span>
    </div>
  );
}

/** The four figures of the machine: the slot's last reading, and the free disk system.disk gives before it. */
function Machine({ state }: { state: HeavySlotStatus | null }) {
  const disk = useDiskSpace();
  const m = state?.machine ?? null;
  // The disk as the window reads it now (system.disk); the slot's last sample only when that cannot be read.
  const diskFree = disk ? diskGb(disk.freeBytes) : m?.diskFreeGb ?? null;
  const floorGb = state?.floors.diskGb ?? (disk ? diskGb(disk.floorBytes) : null);
  const memTone = m?.memFreePct != null && state && m.memFreePct < state.floors.memFreePct ? 'waiting' : undefined;
  const diskTone = diskFree == null ? undefined : diskFree < 6 ? 'error' : diskFree < 10 ? 'waiting' : undefined;
  const later = state ? 'not read yet' : 'with the heavy-run slot';
  // One measure, as the frame draws it: the share's free memory over its share of the total (the QA's F2 on PR 539).
  const memory = freeMemory(m, state?.floors.memFreePct);
  return (
    <Figures>
      <Figure volatile caption="FREE MEMORY" value={memory?.value ?? NOT_READ} tone={memTone} sub={memory?.sub ?? later} />
      <Figure volatile caption="SWAP" value={m ? mb(m.swapUsedMb) : NOT_READ}
        sub={m?.swapGrowthMbPerMin != null ? `${m.swapGrowthMbPerMin >= 0 ? '+' : ''}${mb(m.swapGrowthMbPerMin)} a minute` : m ? 'its growth not read yet' : later} />
      <Figure volatile caption="FREE DISK" value={gb(diskFree)} tone={diskTone}
        sub={diskFree == null ? 'cannot be read' : `${disk ? `of ${gb(diskGb(disk.totalBytes))}` : 'free'}${floorGb != null ? ` · floor ${Math.round(floorGb)} GB` : ''}`} />
      <Figure volatile caption="LOAD" value={m?.load1 != null ? m.load1.toFixed(1) : NOT_READ}
        sub={m ? (m.load1 != null ? '1 min average' : 'not given on this system') : later} />
    </Figures>
  );
}

/**
 * Heavy runs: the machine, the slot every project's agents share for test suites, builds, dev servers, Docker and
 * simulators, who holds it and for what, who waits and why, today's alerts, the slots and the floors (frames
 * `Resources (2.0.5) · heavy runs` and `· heavy runs · states`), on Tars-Backend's heavySlot (PR 537). Tars never stops
 * a run: a floor delays a grant, an alert only tells; the owner may give a slot back, and the run goes on.
 */
export function HeavyRunsView({ onShowAgent }: { onShowAgent: (agentId: string) => void }) {
  const { state, missing, error, reload, giveBack } = useHeavyRuns();
  const taken = state?.holders.length ?? 0;
  const head = !state ? 'THE SLOT' : taken === 0 ? (state.slots > 1 ? 'THE SLOTS · FREE' : 'THE SLOT · FREE') : `${state.slots > 1 ? 'THE SLOTS' : 'THE SLOT'} · ${taken} OF ${state.slots} TAKEN`;
  const firstWaits = state && taken < state.slots ? state.waiting.find((w) => w.why) : undefined;

  return (
    <section role="region" aria-label="Heavy runs" className="flex flex-col gap-3 min-h-0">
      <Machine state={state} />
      {firstWaits && (
        <Notice tone="waiting">
          {`The slot is free, but ${firstWaits.agentName} waits: ${firstWaits.why}. It starts as soon as the floor is met; nothing is stopped to make room.`}
        </Notice>
      )}
      <div className="flex gap-3 items-start min-w-0">
        <Box name="The slot" caption={head} note="it comes back by itself when its process ends" className="flex-1">
          {missing || error || !state ? (
            <div className="px-3.5 pb-3.5">
              {missing ? (
                <Unread text="This Tars cannot read the heavy-run slot yet: the window gets it with its backend." />
              ) : error ? (
                <Unread text="Tars cannot read the heavy-run slot:" detail={error} onRetry={reload} />
              ) : (
                <p className="text-[11.5px] text-muted-foreground">Reading the slot</p>
              )}
            </div>
          ) : (
            <>
              {state.holders.map((run) => <Holder key={run.id} run={run} onShow={onShowAgent} onGiveBack={giveBack} />)}
              {taken === 0 && state.waiting.length === 0 && (
                <Empty>Nobody holds the slot and nothing waits. When an agent asks for it for a test suite, a build, a dev server, Docker or a simulator, it shows here with what it runs.</Empty>
              )}
              {state.waiting.length > 0 && (
                <>
                  <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-2 border-t border-border">
                    <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{`Waiting · ${state.waiting.length}`}</span>
                    <span className="flex-1" />
                    <span className="font-mono text-[10px] text-muted-foreground">by priority, then by arrival</span>
                  </div>
                  {state.waiting.map((run, i) => <Waiter key={run.id} run={run} n={i + 1} />)}
                </>
              )}
            </>
          )}
        </Box>
        <div className="w-[380px] max-xl:w-[292px] shrink-0 flex flex-col gap-3">
          <Box name="Alerts" caption="ALERTS · TODAY">
            {state && state.alerts.length > 0
              ? [...state.alerts].reverse().map((a) => <AlertRow key={`${a.at}-${a.ticket}-${a.text}`} alert={a} />)
              : <Empty>{state ? 'No alert today.' : 'Alerts come with the heavy-run slot.'}</Empty>}
          </Box>
          <Box name="Slots and floors" caption="SLOTS AND FLOORS">
            {state ? (
              <>
                <FloorLine k="Slots for the whole machine" v={String(state.slots)} />
                <FloorLine k="A grant waits under" v={`${state.floors.diskGb} GB free disk`} />
                <FloorLine k="or under" v={`${state.floors.memFreePct} % free memory`} />
                <FloorLine k="Alerts at free disk of" v="10, 6 and 3 GB" />
                <FloorLine k="and at swap growing" v="1 GB a minute" />
              </>
            ) : <Empty>The slots and floors come with the heavy-run slot.</Empty>}
            <div className="flex items-center gap-2 px-3.5 pt-2 pb-3 border-t border-border">
              <Shield className="w-3 h-3 shrink-0 text-muted-foreground" />
              <p className="text-[11px] leading-[1.45] text-muted-foreground">Tars never stops a run by itself. A floor delays a grant; an alert only tells.</p>
            </div>
          </Box>
        </div>
      </div>
    </section>
  );
}
