'use client';

import type { DiskReport, JanitorCleanupRequest, JanitorItem } from '@/types/electron';
import { Button, StatusSquare } from '@/components/ui';
import { Box, Empty, Row } from './bits';
import { bytes } from './format';

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const projectName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const sum = (xs: Array<number | null | undefined>) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
/** "1.2 GB", "-" when nothing is there, "in use" for a node_modules not measured because in use. */
const cell = (n: number | null, inUse = false) => (n === null ? (inUse ? 'in use' : '-') : bytes(n));

/** The open items of a list of ids, from the last scan: what an approval of them would take. */
function openItems(ids: string[], items: JanitorItem[]): JanitorItem[] {
  const want = new Set(ids);
  return items.filter((i) => want.has(i.id) && !i.outcome);
}

/**
 * ASKED BY AGENTS (2.0.7, frame `Resources (2.0.7) · disk · asked by agents`): each cleanup an agent asked for in its
 * own project, with why, its items and their size, and the owner's one click (diskJanitor.approveRequest). Nothing is
 * deleted without it; each item is checked again first, as for any approval.
 */
export function AskedByAgents({ requests, items, busy, onApprove }: {
  requests: JanitorCleanupRequest[];
  items: JanitorItem[];
  busy: boolean;
  onApprove: (id: string) => void;
}) {
  const waiting = requests.filter((r) => r.state === 'waiting').length;
  return (
    <Box name="Asked by agents" caption="ASKED BY AGENTS" note={waiting ? `${waiting} waiting` : undefined}>
      {requests.length === 0 ? (
        <Empty>No agent has asked for a cleanup. An agent may ask for items in its own project; you approve it here.</Empty>
      ) : (
        [...requests].reverse().map((r) => {
          const own = items.filter((i) => r.ids.includes(i.id));
          const freed = sum(own.filter((i) => i.outcome?.kind === 'deleted').map((i) => i.outcome?.bytes ?? 0));
          const kept = own.filter((i) => i.outcome && i.outcome.kind !== 'deleted').length;
          const names = own.slice(0, 3).map((i) => i.path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')).join(', ');
          return (
            <Row key={r.id} data-cleanup-request={r.state} className="space-y-1.5 py-2.5">
              <p className="flex items-center gap-2 text-xs text-foreground">
                <StatusSquare tone={r.state === 'approved' ? (kept ? 'waiting' : 'running') : 'waiting'} />
                {`${r.by} asks to free ${bytes(r.bytes)} in ${projectName(r.project)}`}
              </p>
              <p className="text-[11.5px] leading-[1.45] text-text-secondary">{r.why}</p>
              <p className="font-mono text-[10.5px] text-muted-foreground">{`${r.ids.length} ${r.ids.length === 1 ? 'item' : 'items'}${names ? ` · ${names}` : ''} · asked ${clock(r.at)}`}</p>
              {r.state === 'approved' ? (
                <p className={`font-mono text-[10.5px] ${kept ? 'text-status-waiting' : 'text-status-running'}`}>
                  {`approved by you${r.approvedAt ? ` at ${clock(r.approvedAt)}` : ''}${freed ? ` · ${bytes(freed)} freed` : ''}${kept ? `, ${kept} ${kept === 1 ? 'item' : 'items'} kept` : ''}`}
                </p>
              ) : (
                <Button size="sm" variant="primary" className="font-mono" disabled={busy} onClick={() => onApprove(r.id)}>{`Approve, delete ${bytes(r.bytes)}`}</Button>
              )}
            </Row>
          );
        })
      )}
      <p className="px-3.5 py-2.5 border-t border-border font-mono text-[10.5px] text-muted-foreground">Nothing is deleted until you approve it here; each item is checked again first.</p>
    </Box>
  );
}

const WT_COLS = 'grid grid-cols-[150px_100px_40px_56px_56px_56px_80px_minmax(0,1fr)] gap-2 items-center px-3.5';

/**
 * What agents leave (2.0.7, frame `Resources (2.0.7) · disk · what agents leave`): per project, its worktrees with
 * their agent, branch, idle days and caches; per agent, its temporary files; the machine's free disk and swap. Each
 * row's approve takes its items from the last scan, checked again as any approval.
 */
export function WhatAgentsLeave({ report, items, busy, onApprove }: {
  report: DiskReport | null;
  items: JanitorItem[];
  busy: boolean;
  onApprove: (ids: string[]) => void;
}) {
  if (!report) return <Box name="What agents leave" caption="WHAT AGENTS LEAVE"><Empty>No report yet: it is made after the first scan.</Empty></Box>;
  const approveButton = (ids: string[], dim = false) => {
    const open = openItems(ids, items);
    const size = sum(open.map((i) => i.bytes));
    return (
      <Button size="sm" variant="ghost" className="font-mono justify-self-end" disabled={busy || dim || open.length === 0} onClick={() => onApprove(open.map((i) => i.id))}>
        {open.length ? `approve ${bytes(size)}` : 'nothing to approve'}
      </Button>
    );
  };
  const m = report.machine;
  return (
    <div className="flex gap-3 items-stretch min-h-0 flex-1 min-w-0">
      <Box name="By project" fill className="flex-1" caption="BY PROJECT · WORKTREES AND CACHES">
        <div className="overflow-y-auto min-h-0">
          {report.projects.length === 0 && <Empty>No worktree left behind.</Empty>}
          {report.projects.map((p) => (
            <div key={p.project} data-report-project={projectName(p.project)}>
              <p className="flex items-center gap-2 px-3.5 pt-2.5 pb-1.5">
                <span className="text-[12.5px] text-foreground">{projectName(p.project)}</span>
                <span className="font-mono text-[10.5px] text-muted-foreground">{`${bytes(p.bytes)} in ${p.worktrees.length} ${p.worktrees.length === 1 ? 'worktree' : 'worktrees'}`}</span>
              </p>
              <div className={`${WT_COLS} h-7 border-y border-border font-mono text-[10px] text-muted-foreground`}>
                <span>WORKTREE · BRANCH</span><span>AGENT</span><span>IDLE</span><span>.NEXT</span><span>RELEASE</span><span>TESTS</span><span>NODE_MODULES</span><span />
              </div>
              {p.worktrees.map((w) => (
                <div key={w.path} className={`${WT_COLS} py-1.5 border-b border-border font-mono text-[11px] text-text-secondary`} title={w.path}>
                  <span className="min-w-0"><span className="block truncate text-foreground">{w.name}</span><span className="block truncate text-[10.5px] text-muted-foreground">{w.branch ?? 'no branch'}</span></span>
                  <span className={`truncate ${w.agent ? '' : 'text-muted-foreground'}`}>{w.agent ?? 'no agent'}</span>
                  <span>{`${w.idleDays} d`}</span>
                  <span>{cell(w.bytes.next)}</span>
                  <span>{cell(w.bytes.release)}</span>
                  <span>{cell(w.bytes.testArtefacts)}</span>
                  <span className={w.bytes.nodeModules === null ? 'text-muted-foreground' : ''}>{cell(w.bytes.nodeModules, true)}</span>
                  {approveButton(w.itemIds)}
                </div>
              ))}
            </div>
          ))}
        </div>
      </Box>
      <div className="w-[380px] max-xl:w-[292px] shrink-0 flex flex-col gap-3 min-h-0">
        <Box name="By agent" caption="BY AGENT · TEMPORARY FILES">
          {report.agents.length === 0 ? <Empty>No agent keeps temporary files.</Empty> : report.agents.map((a) => (
            <Row key={a.id} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-foreground">{a.name}</span>
                <span className="block truncate font-mono text-[10.5px] text-muted-foreground">{`${projectName(a.project)}${a.status ? ` · ${a.status}` : ''}`}</span>
              </span>
              <span className="font-mono text-[11px] text-text-secondary">{bytes(a.tmpBytes)}</span>
              {approveButton(a.itemIds)}
            </Row>
          ))}
        </Box>
        <Box name="The machine" caption="THE MACHINE">
          <div className="px-3.5 pb-3 space-y-1.5">
            <p className={`font-mono text-[11px] ${m.swapGrowthMbPerMin !== null && m.swapGrowthMbPerMin > 0 ? 'text-status-waiting' : 'text-text-secondary'}`}>
              {[
                `free disk ${m.diskFreeBytes === null ? 'not measured yet' : bytes(m.diskFreeBytes)}`,
                m.swapUsedMb === null ? 'swap not measured yet' : `swap ${bytes(m.swapUsedMb * 1024 ** 2)}${m.swapGrowthMbPerMin !== null && m.swapGrowthMbPerMin > 0 ? `, growing ${Math.round(m.swapGrowthMbPerMin)} MB a minute` : ''}`,
              ].join(' · ')}
            </p>
            <p className="text-[11px] leading-[1.45] text-text-secondary">Approving a row deletes its items after checking each again, as any approval does.</p>
          </div>
        </Box>
      </div>
    </div>
  );
}
