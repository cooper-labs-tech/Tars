'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { Button, StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';
import { Box, Empty, Figure, Figures, Unread } from './bits';
import type { AgentResources, FleetResources, ProjectResources } from './contract';
import { NOT_READ, bytes, clock, lasted, mb, pct, sum } from './format';
import { useFleetResources } from './hooks';

const TONE: Record<string, StatusTone> = { working: 'running', waiting: 'waiting', error: 'error' };
const INK: Record<string, string> = { working: 'text-status-running', waiting: 'text-status-waiting', error: 'text-status-error' };
const wtBytes = (a: AgentResources) => sum(a.worktrees.map((w) => w.bytes));
const tmpBytes = (a: AgentResources) => (a.tmp ? a.tmp.bytes : 0);
const memBytes = (a: AgentResources) => (a.memMb === null ? null : a.memMb * 1e6);

/** A project's figures, summed over its agents: unread if any agent's is. */
/** What was read, added: null only when nothing could be read. An agent with no terminal holds nothing to read. */
function partial(values: (number | null)[]): number | null {
  const read = values.filter((v): v is number => v !== null);
  return read.length ? read.reduce((a, b) => a + b, 0) : null;
}

/** A project's figures: memory and CPU as main sums them (PR 546's totals), the disk by folder kind, added. */
function totals(p: ProjectResources) {
  return {
    mem: p.totals.memMb === null ? null : p.totals.memMb * 1e6,
    cpu: p.totals.cpuPct,
    wt: partial(p.agents.map(wtBytes)),
    tmp: partial(p.agents.map(tmpBytes)),
    working: p.agents.filter((a) => a.status === 'working').length,
  };
}

/** A figure cell; one being measured says so. */
const cell = (value: number | null, measuring: boolean, fmt: (n: number | null) => string = bytes) => (measuring && value === null ? 'measuring' : fmt(value));

const COLS = 'grid grid-cols-[minmax(0,1fr)_150px_84px_64px_92px_92px] max-xl:grid-cols-[minmax(0,1fr)_118px_70px_50px_76px_76px] gap-3 items-center';

function ProjectRow({ project, open, onToggle, measuring }: { project: ProjectResources; open: boolean; onToggle: () => void; measuring: boolean }) {
  const t = totals(project);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} data-project-row={project.name}
      className={`${COLS} w-full px-3.5 py-2 border-t border-border bg-secondary text-left`}>
      <span className="flex items-center gap-2 min-w-0 overflow-hidden">
        <Chevron className="w-3 h-3 shrink-0 text-muted-foreground" />
        <span className="text-[12.5px] font-medium text-foreground truncate">{project.name}</span>
        <span className="font-mono text-[10.5px] text-muted-foreground shrink-0">{`${project.agents.length} ${project.agents.length === 1 ? 'agent' : 'agents'}`}</span>
      </span>
      <span className="font-mono text-[11px] text-muted-foreground truncate">{t.working ? `${t.working} working` : project.agents.every((a) => a.status === 'asleep') ? 'asleep' : 'none working'}</span>
      <span className="text-right font-mono text-[11px] text-foreground">{cell(t.mem, false)}</span>
      <span className="text-right font-mono text-[11px] text-foreground">{pct(t.cpu)}</span>
      <span className="text-right font-mono text-[11px] text-foreground">{cell(t.wt, measuring)}</span>
      <span className="text-right font-mono text-[11px] text-foreground">{cell(t.tmp, measuring)}</span>
    </button>
  );
}

function AgentRow({ agent, chosen, onChoose, measuring }: { agent: AgentResources; chosen: boolean; onChoose: () => void; measuring: boolean }) {
  return (
    <button type="button" aria-pressed={chosen} onClick={onChoose} data-agent-row={agent.name}
      className={`${COLS} w-full pl-10 pr-3.5 py-[7px] text-left ${chosen ? 'bg-bg-elevated border border-border-accent' : 'border-t border-border hover:bg-secondary/60'}`}>
      <span className="flex flex-col gap-0.5 min-w-0 overflow-hidden">
        <span className="text-[12px] text-foreground truncate">{agent.name}</span>
      </span>
      <span className="flex items-center gap-1.5 min-w-0 font-mono text-[11px]">
        <span className={INK[agent.status] ?? 'text-muted-foreground'}>{agent.status}</span>
        {agent.statusSince !== null && <span className="text-muted-foreground truncate">{`since ${clock(agent.statusSince)}`}</span>}
      </span>
      <span className="text-right font-mono text-[11px] text-text-secondary">{cell(memBytes(agent), false)}</span>
      <span className="text-right font-mono text-[11px] text-text-secondary">{pct(agent.cpuPct)}</span>
      <span className="text-right font-mono text-[11px] text-text-secondary">{cell(wtBytes(agent), measuring)}</span>
      <span className="text-right font-mono text-[11px] text-text-secondary">{cell(agent.tmp ? agent.tmp.bytes : 0, measuring)}</span>
    </button>
  );
}

/** The agent chosen: its figures, its process tree with secrets masked, its disk. */
function AgentDetail({ agent, project, diskMeasuredAt }: { agent: AgentResources; project: string; diskMeasuredAt: number | null }) {
  const disk = sum([wtBytes(agent), tmpBytes(agent)]);
  return (
    <section role="region" aria-label={`Agent ${agent.name}`} className="w-[360px] max-xl:w-[292px] shrink-0 border border-border bg-card flex flex-col min-w-0">
      <div className="flex flex-col gap-1 px-3.5 pt-3 pb-2.5">
        <p className="flex items-center gap-2 min-w-0"><span className="text-[14px] font-medium text-foreground truncate">{agent.name}</span><span className="font-mono text-[10.5px] text-muted-foreground">{project}</span></p>
        <p className="flex items-center gap-1.5 font-mono text-[11px] text-text-secondary">
          <StatusSquare tone={TONE[agent.status] ?? 'idle'} />{agent.statusSince !== null ? `${agent.status} since ${clock(agent.statusSince)} · ${lasted(agent.statusSince)}` : agent.status}
        </p>
        <p className="font-mono text-[11px] text-foreground">{`${mb(agent.memMb)} memory · ${pct(agent.cpuPct)} CPU · ${bytes(disk)} on disk`}</p>
      </div>
      <div className="flex items-center gap-2 px-3.5 pt-2 pb-1.5 border-t border-border">
        <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{`Its tree · ${agent.processes.length} ${agent.processes.length === 1 ? 'process' : 'processes'}`}</span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-muted-foreground">secrets masked</span>
      </div>
      <ul aria-label="Its processes">
        {agent.processes.map((p) => (
          <li key={p.pid} className="flex flex-col gap-[3px] px-3.5 py-[7px] border-t border-border">
            <p className="flex items-center gap-2"><span className="flex-1 min-w-0 text-[11.5px] text-foreground truncate">{p.name}</span><span className="font-mono text-[11px] text-foreground">{mb(p.memMb)}</span><span className="font-mono text-[11px] text-muted-foreground">{pct(p.cpuPct)}</span></p>
            <p data-command className="font-mono text-[10px] leading-[1.45] text-muted-foreground break-all">{p.command}</p>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 px-3.5 pt-2 pb-1 border-t border-border">
        <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Its disk</span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-muted-foreground">{diskMeasuredAt ? `measured ${clock(diskMeasuredAt)}` : 'not measured yet'}</span>
      </div>
      <div className="pb-2">
        {[...agent.worktrees, ...(agent.tmp ? [agent.tmp] : [])].map((w) => (
          <p key={w.path} className="flex items-center gap-2 px-3.5 py-[5px]"><span className="flex-1 min-w-0 font-mono text-[10.5px] text-text-secondary break-all">{w.path}</span><span className="font-mono text-[11px] text-foreground">{bytes(w.bytes)}</span></p>
        ))}
      </div>
    </section>
  );
}

/**
 * Agents and projects: what each agent holds, its whole tree's memory and CPU, the disk of its worktrees and of its
 * temporary folder, its status and since when; each project the same, summed (frames `Resources (2.0.5) · agents and
 * projects` and `· agents and projects · states`). The disk is measured on demand, never on every tick.
 */
export function FleetView({ chosen, onChoose }: { chosen: string | null; onChoose: (agentId: string | null) => void }) {
  const { state, missing, error, reload, measureDisk } = useFleetResources();
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [measureError, setMeasureError] = useState<string | null>(null);
  const projects = useMemo(() => [...(state?.projects ?? [])].sort((a, b) => (totals(b).mem ?? -1) - (totals(a).mem ?? -1)), [state]);
  const agents = projects.flatMap((p) => p.agents);
  const pick = agents.find((a) => a.id === chosen) ?? null;
  const pickProject = projects.find((p) => p.agents.some((a) => a.id === chosen))?.name ?? '';
  const measuring = Boolean(state?.measuring);
  const all = (f: (a: AgentResources) => number | null) => partial(agents.map(f));
  const unread = agents.filter((a) => a.memMb === null).length;

  const measure = async () => { setMeasureError(await measureDisk()); };

  return (
    <section role="region" aria-label="Agents and projects" className="flex flex-col gap-3 min-h-0">
      <Figures>
        <Figure volatile caption="AGENTS HOLD" value={state ? bytes(all(memBytes)) : NOT_READ} sub={state ? `${agents.length} agents, ${agents.filter((a) => a.status === 'asleep').length} asleep${unread ? `, ${unread} not read` : ''}` : 'with the fleet\'s figures'} />
        <Figure volatile caption="CPU" value={state ? pct(all((a) => a.cpuPct)) : NOT_READ} sub={state ? 'every agent\'s tree' : 'with the fleet\'s figures'} />
        <Figure volatile caption="WORKTREES" value={state ? cell(all(wtBytes), measuring) : NOT_READ} sub={state?.diskMeasuredAt ? `${agents.reduce((n, a) => n + a.worktrees.length, 0)} worktrees · measured ${clock(state.diskMeasuredAt)}` : 'not measured yet'} />
        <Figure volatile caption="TEMPORARY FOLDERS" value={state ? cell(all(tmpBytes), measuring) : NOT_READ} sub={state ? `${agents.filter((a) => a.tmp).length} folders under ~/.tars/tmp` : 'not measured yet'} />
      </Figures>
      {state?.error && <Unread text="Tars cannot read the processes:" detail={state.error} onRetry={reload} />}
      <div className="flex gap-3 items-start min-w-0">
        <Box name="Fleet" className="flex-1"
          caption={state ? `${projects.length} ${projects.length === 1 ? 'project' : 'projects'} · ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}` : 'PROJECTS AND AGENTS'}
          note={state ? (state.measuring ? `measuring the disk · ${state.measuring.done} of ${state.measuring.total} worktrees` : `${state.readAt ? `memory and CPU ${clock(state.readAt)}` : 'memory and CPU not read'} · ${state.diskMeasuredAt ? `disk measured ${clock(state.diskMeasuredAt)}` : 'disk not measured'}`) : undefined}
          actions={state ? <Button size="sm" className="font-mono shrink-0" disabled={measuring} onClick={() => void measure()}><RefreshCw className="w-3 h-3" />{measuring ? 'measuring' : 'measure the disk again'}</Button> : undefined}>
          {missing ? (
            <div className="px-3.5 pb-3.5"><Unread text="This Tars cannot read what each agent holds yet: the window gets it with its backend." /></div>
          ) : error ? (
            <div className="px-3.5 pb-3.5"><Unread text="Tars cannot read what each agent holds:" detail={error} onRetry={reload} /></div>
          ) : !state ? (
            <Empty>Reading what each agent holds</Empty>
          ) : agents.length === 0 ? (
            <Empty>No agent yet. Each agent you create shows here with what it holds: its memory and CPU, its worktrees, its temporary folder.</Empty>
          ) : (
            <>
              {measureError && <div className="px-3.5 pb-2"><Unread text={measureError} /></div>}
              <div className={`${COLS} px-3.5 py-1.5 border-t border-border text-[10px] uppercase tracking-[0.08em] text-muted-foreground`}>
                <span>Project · agent</span><span>Status since</span><span className="text-right">Memory</span><span className="text-right">CPU</span><span className="text-right">Worktrees</span><span className="text-right">Temp folder</span>
              </div>
              {projects.map((p) => (
                <div key={p.path}>
                  <ProjectRow project={p} measuring={measuring} open={!closed.has(p.path)} onToggle={() => setClosed((prev) => { const next = new Set(prev); if (next.has(p.path)) next.delete(p.path); else next.add(p.path); return next; })} />
                  {!closed.has(p.path) && [...p.agents].sort((a, b) => (memBytes(b) ?? -1) - (memBytes(a) ?? -1)).map((a) => (
                    <AgentRow key={a.id} agent={a} measuring={measuring} chosen={a.id === chosen} onChoose={() => onChoose(a.id === chosen ? null : a.id)} />
                  ))}
                </div>
              ))}
            </>
          )}
        </Box>
        {pick && <AgentDetail agent={pick} project={pickProject} diskMeasuredAt={state?.diskMeasuredAt ?? null} />}
      </div>
    </section>
  );
}

export type { FleetResources };
