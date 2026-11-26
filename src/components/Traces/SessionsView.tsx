'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, DialogShell, Dropdown, SegmentedControl } from '@/components/ui';
import type { DropdownOption, SegmentedOption } from '@/components/ui';
import type { HarnessId, TraceFilter, TraceSessionSummary, TraceSettingsView } from '@/types/electron';
import { bytes } from '@/components/Resources/format';
import { Notice, Unread } from '@/components/Resources/bits';
import { fmtTokens } from '@/lib/usage-format';
import { dayClockOf, dayOf, marksOf, outcomeOf, projectNameOf, reasonOf, sizeOf } from '@/lib/traces-format';
import { useEndpoints } from '@/hooks/useEndpoints';
import { useElectronAgents } from '@/hooks/useElectron';
import { Meter, Stat, StateLine } from './bits';
import { tracesApi, useTraceSessions, useTraceStats } from './hooks';
import { ExportDialog } from './ExportDialog';

type Range = '24h' | '7d' | '30d' | 'all';
const RANGES: readonly SegmentedOption<Range>[] = [
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'all' },
];
const RANGE_MS: Record<Range, number | undefined> = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, all: undefined };
const HARNESSES: HarnessId[] = ['codex', 'pi', 'qwen-code', 'opencode'];
const ALL = '';

/** The table's columns, as the frame sets them; the outcome takes what is left. */
const COLS = 'grid grid-cols-[92px_70px_112px_206px_44px_62px_58px_60px_minmax(0,1fr)_110px] gap-3 items-center px-3';

/** How a filter's date range reads in the delete dialog. */
const rangeWords: Record<Range, string> = { '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', all: 'all dates' };

/**
 * Traces · sessions: the figures, the filters, and the sessions newest first, 50 at a time. Empty, it says which of
 * the switches are on; at the cap, it says new requests keep their timings but not their messages.
 */
export function SessionsView({ onOpen }: { onOpen: (traceId: string) => void }) {
  const router = useRouter();
  const [project, setProject] = useState(ALL);
  const [harness, setHarness] = useState(ALL);
  const [model, setModel] = useState(ALL);
  const [endpointId, setEndpointId] = useState(ALL);
  const [range, setRange] = useState<Range>('7d');
  // Fixed at the moment the range is chosen, so the filter does not change on every render.
  const [from, setFrom] = useState<number | undefined>(() => Date.now() - 7 * 864e5);
  const chooseRange = (r: Range) => { setRange(r); setFrom(RANGE_MS[r] === undefined ? undefined : Date.now() - RANGE_MS[r]!); };

  const filter: TraceFilter = useMemo(() => ({
    project: project || undefined,
    harness: harness || undefined,
    model: model || undefined,
    endpointId: endpointId || undefined,
    from,
  }), [project, harness, model, endpointId, from]);

  const { stats, error: statsError, read: readStats } = useTraceStats();
  const { sessions, total, hasMore, more, error, reload } = useTraceSessions(filter);
  const { endpoints } = useEndpoints();
  // Which projects record traces: the owner's list (traces.settings), for the empty page's switches.
  const [recording, setRecording] = useState<TraceSettingsView | null>(null);
  useEffect(() => { void tracesApi()?.settings().then(setRecording).catch(() => undefined); }, []);
  const { agents } = useElectronAgents();
  const [selected, setSelected] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ traceIds?: string[]; label: string; body: string } | null>(null);
  /** A removal main refused: said in its dialog, above its answers; the dialog's button tries again. */
  const [removeError, setRemoveError] = useState<string | null>(null);
  const closeDelete = () => { setDeleting(null); setRemoveError(null); };
  const [done, setDone] = useState<string | null>(null);
  const [exporting, setExporting] = useState<{ one?: TraceSessionSummary } | null>(null);

  const projects = useMemo(() => [...new Set((sessions ?? []).map(s => s.projectPath))].sort(), [sessions]);
  const models = useMemo(() => [...new Set((sessions ?? []).map(s => s.model))].sort(), [sessions]);
  const option = (label: string, values: string[], word: (v: string) => string = v => v): DropdownOption[] =>
    [{ value: ALL, label }, ...values.map(v => ({ value: v, label: word(v) }))];

  const remove = async () => {
    const api = tracesApi();
    if (!api || !deleting) return;
    let r: Awaited<ReturnType<typeof api.remove>>;
    try {
      r = await api.remove(deleting.traceIds ? { traceIds: deleting.traceIds } : { filter });
    } catch (e) {
      // Main's refusal (a full disk) reaches the window as a rejected call: said in the dialog, which stays, never an
      // unhandled rejection.
      console.warn('[traces] deleting sessions failed:', e);
      setRemoveError(reasonOf(e));
      return;
    }
    closeDelete();
    setDone(`${r.deleted} session${r.deleted === 1 ? '' : 's'} deleted · ${sizeOf(r.bytesFreed)} freed`);
    void reload();
    void readStats();
  };

  if (statsError && error) {
    return <Unread text="could not read the traces:" detail={error} onRetry={() => { void reload(); void readStats(); }} />;
  }

  if (stats && stats.sessions === 0) {
    const endpointsAllowing = (endpoints ?? []).filter(e => e.allowTraces && e.approved);
    const agentsRecording = agents.filter(a => (a as { traces?: boolean }).traces === true);
    return (
      <EmptyTraces
        endpointNames={endpointsAllowing.map(e => e.name)}
        projectCount={recording?.projects.length ?? 0}
        agentCount={agentsRecording.length}
        onProjects={() => router.push('/projects')}
        onEndpoints={() => router.push('/settings?section=inference-endpoints')}
      />
    );
  }

  const loaded = sessions?.length ?? 0;
  const shown = total?.sessions ?? loaded;
  const deleteBody = (n: number) => {
    const where = [project ? projectNameOf(project) : 'every project', rangeWords[range]].join(', ');
    return `Every session the filters show: ${where}, ${n} in all. The reader can no longer read them. This cannot be undone.`;
  };

  return (
    <div className="flex flex-col gap-2.5 flex-1 min-h-0">
      <div className="grid grid-cols-4 gap-2.5 shrink-0">
        <Stat caption="SESSIONS" value={stats ? stats.sessions.toLocaleString('en-US') : '-'} sub={total ? `${total.sessions} in these filters` : ' '} />
        <Stat caption="REQUESTS" value={stats ? stats.requests.toLocaleString('en-US') : '-'} sub={stats && stats.sessions > 0 ? `${Math.round(stats.requests / stats.sessions)} a session on average` : ' '} />
        <Stat
          caption="STORAGE"
          value={stats ? bytes(stats.bytes) : '-'}
          sub={stats ? `of ${bytes(stats.capBytes)}` : ' '}
          tone={stats?.bodiesDropped ? 'waiting' : undefined}
          meter={stats ? <Meter share={stats.bytes / Math.max(1, stats.capBytes)} tone={stats.bodiesDropped ? 'waiting' : 'accent'} className="w-[240px] max-w-full" /> : undefined}
        />
        <Stat caption="KEPT" value={stats ? `${stats.retentionDays} days` : '-'} sub={stats?.oldest ? `the oldest from ${dayOf(stats.oldest)}` : ' '} />
      </div>

      {stats?.bodiesDropped && (
        <Notice tone="waiting" actions={<Button size="sm" className="font-mono" onClick={() => router.push('/traces?view=storage')}>raise the cap</Button>}>
          {`At the cap: ${bytes(stats.capBytes)}. The oldest sessions go at the next sweep. Until then, new requests keep their timings and tokens but not their messages.`}
        </Notice>
      )}

      {done && <Notice tone="running" actions={<Button size="sm" variant="ghost" className="font-mono" onClick={() => setDone(null)}>close</Button>}>{done}</Notice>}

      <div className="flex items-center gap-2 shrink-0">
        <Dropdown size="sm" mono="trigger" ariaLabel="Project" className="w-[136px]" value={project} options={option('All projects', projects, projectNameOf)} onChange={setProject} />
        <Dropdown size="sm" mono="trigger" ariaLabel="Harness" className="w-[136px]" value={harness} options={option('All harnesses', HARNESSES)} onChange={setHarness} />
        <Dropdown size="sm" mono="trigger" ariaLabel="Model" className="w-[160px]" value={model} options={option('All models', models)} onChange={setModel} />
        <Dropdown size="sm" mono="trigger" ariaLabel="Endpoint" className="w-[150px]" value={endpointId} options={[{ value: ALL, label: 'All endpoints' }, ...(endpoints ?? []).map(e => ({ value: e.id, label: e.name }))]} onChange={setEndpointId} />
        <SegmentedControl ariaLabel="Started" options={RANGES} value={range} onChange={chooseRange} />
        <span className="flex-1" />
        {total && <span className="font-mono text-[10.5px] text-muted-foreground">{`${total.sessions} session${total.sessions === 1 ? '' : 's'} · ${sizeOf(total.bytes)}`}</span>}
        <Button size="sm" variant="danger" className="font-mono" disabled={shown === 0} onClick={() => setDeleting({ label: `Delete ${shown} session${shown === 1 ? '' : 's'}`, body: deleteBody(shown) })}>
          delete what these show
        </Button>
      </div>

      {error && <Unread text="could not read the traces:" detail={error} onRetry={() => { void reload(); }} />}

      <section role="region" aria-label="Sessions" className="border border-border bg-card flex flex-col min-h-0 flex-1">
        <div className={`${COLS} h-[30px] border-b border-border shrink-0 font-mono text-[10px] text-muted-foreground`}>
          <span>STARTED</span><span>PROJECT</span><span>AGENT</span><span>HARNESS · MODEL</span><span>TURNS</span><span>REQUESTS</span><span>TOKENS</span><span>SIZE</span><span>OUTCOME</span><span />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {sessions === null ? (
            [0, 1, 2, 3].map(i => (
              <div key={i} data-skeleton className={`${COLS} h-[34px] border-b border-border`}>
                {[80, 56, 96, 180, 30, 40, 44].map((w, j) => <span key={j} className="block h-2 bg-secondary" style={{ width: w }} />)}
              </div>
            ))
          ) : sessions.length === 0 ? (
            <p className="px-3.5 py-3 text-[11.5px] text-text-secondary">No session matches these filters.</p>
          ) : sessions.map(s => {
            const out = outcomeOf(s.finalStatus);
            const marks = marksOf(s);
            const isSel = selected === s.traceId;
            return (
              <div
                key={s.traceId}
                data-trace-session={s.traceId}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(s.traceId)}
                onDoubleClick={() => onOpen(s.traceId)}
                onKeyDown={e => { if (e.key === 'Enter') onOpen(s.traceId); }}
                className={`${COLS} group h-[34px] border-b border-border font-mono text-[11px] text-text-secondary cursor-pointer ${isSel ? 'bg-secondary' : 'hover:bg-secondary'}`}
              >
                <span className="truncate">{dayClockOf(s.startedAt)}</span>
                <span className="truncate">{projectNameOf(s.projectPath)}</span>
                <span className="truncate text-foreground">{s.agentName ?? s.agentId}</span>
                <span className="truncate">{`${s.harness} · ${s.model}`}</span>
                <span>{s.turnCount}</span>
                <span>{s.requestCount}</span>
                <span>{fmtTokens(s.tokensIn + s.tokensOut)}</span>
                <span>{sizeOf(s.bytes)}</span>
                <span className="flex items-center gap-2 min-w-0">
                  <StateLine word={out.word} tone={out.tone} />
                  {marks && <span className="truncate text-[10.5px] text-muted-foreground">{marks}</span>}
                </span>
                <span className={`flex items-center justify-end gap-1 ${isSel ? '' : 'invisible group-hover:visible group-focus-within:visible'}`}>
                  <Button size="sm" variant="ghost" className="font-mono" onClick={e => { e.stopPropagation(); onOpen(s.traceId); }}>open</Button>
                  <Button size="sm" variant="ghost" className="font-mono" onClick={e => { e.stopPropagation(); setExporting({ one: s }); }}>export</Button>
                  <Button size="sm" variant="ghost" className="font-mono" onClick={e => {
                    e.stopPropagation();
                    setDeleting({ traceIds: [s.traceId], label: 'Delete', body: `${s.agentName ?? s.agentId}, ${dayClockOf(s.startedAt)}: ${s.turnCount} turns, ${s.requestCount} requests, ${sizeOf(s.bytes)}. The reader can no longer read it. This cannot be undone.` });
                  }}>delete</Button>
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex items-center px-3 py-2 border-t border-border shrink-0">
          <span className="font-mono text-[10.5px] text-muted-foreground">newest first, 50 at a time</span>
          <span className="flex-1" />
          {hasMore && <Button size="sm" className="font-mono" onClick={() => { void more(); }}>more</Button>}
        </div>
      </section>

      {deleting && (
        <DialogShell
          onClose={closeDelete}
          width={560}
          title={deleting.traceIds ? 'Delete this session?' : `Delete ${shown} session${shown === 1 ? '' : 's'}?`}
          subtitle={deleting.body}
          footerRight={<>
            <Button onClick={closeDelete}>Cancel</Button>
            <Button variant="danger" onClick={() => { void remove(); }}>{deleting.label}</Button>
          </>}
        >
          {removeError && <div data-remove-refused><StateLine word={`not deleted: ${removeError}. ${deleting.label} tries again.`} tone="error" /></div>}
        </DialogShell>
      )}

      {exporting && (
        <ExportDialog
          filter={exporting.one ? { ...filter } : filter}
          oneSession={exporting.one}
          filteredCount={shown}
          onClose={() => setExporting(null)}
        />
      )}
    </div>
  );
}

/** No session yet: which of the switches are on, the first one off getting the primary button. */
function EmptyTraces({ endpointNames, projectCount, agentCount, onProjects, onEndpoints }: {
  endpointNames: string[];
  projectCount: number;
  agentCount: number;
  onProjects: () => void;
  onEndpoints: () => void;
}) {
  const endpointOn = endpointNames.length > 0;
  const projectOn = projectCount > 0;
  const line = (on: boolean, count: string, text: string, firstOff: boolean) => (
    <div className="flex items-center gap-2">
      <span className="w-[70px] shrink-0"><StateLine word={count} tone={on ? 'running' : firstOff ? 'waiting' : 'idle'} /></span>
      <span className="text-xs text-text-secondary">{text}</span>
    </div>
  );
  return (
    <section data-traces-empty className="border border-border bg-card px-6 py-5 space-y-3 max-w-[760px]">
      <span className="block w-2.5 h-2.5 bg-primary" />
      <h2 className="font-serif text-xl text-foreground">No traces yet</h2>
      <p className="max-w-[600px] text-xs leading-relaxed text-text-secondary">
        A session is recorded when its endpoint allows traces, its project records traces, the agent records traces, and its harness and model are among your pairs.
      </p>
      {line(endpointOn, endpointOn ? `${endpointNames.length} on` : 'none', endpointOn ? `endpoint: ${endpointNames.join(', ')} ${endpointNames.length === 1 ? 'allows' : 'allow'} traces` : 'endpoint: no endpoint allows traces yet', !endpointOn)}
      {line(projectOn, projectOn ? `${projectCount} on` : 'none', projectOn ? `project: ${projectCount} project${projectCount === 1 ? '' : 's'} record${projectCount === 1 ? 's' : ''} traces` : 'project: no project records traces yet', endpointOn && !projectOn)}
      {line(agentCount > 0, agentCount > 0 ? `${agentCount} on` : 'none', agentCount > 0 ? `agent: ${agentCount} agent${agentCount === 1 ? '' : 's'} record${agentCount === 1 ? 's' : ''} traces` : 'agent: no agent records traces yet', endpointOn && projectOn && agentCount === 0)}
      <div className="flex items-center gap-2 pt-1">
        <Button variant={endpointOn ? 'primary' : 'secondary'} onClick={onProjects}>open Projects</Button>
        <Button variant={endpointOn ? 'secondary' : 'primary'} onClick={onEndpoints}>open Inference endpoints</Button>
      </div>
    </section>
  );
}
