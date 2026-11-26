'use client';

import { useState } from 'react';
import { Button, DialogShell, SegmentedControl } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';
import type { TraceFilter, TraceSessionSummary } from '@/types/electron';
import { StateLine } from './bits';
import { tracesApi } from './hooks';

type Scope = 'filtered' | 'one' | 'all';

/**
 * Export sessions (frame `Traces · states`, export then done): what the filters show, one session, or everything.
 * The main process asks where to save it, through the system's save dialog, and writes the file: the window never
 * holds the requests it writes. A cancelled save dialog does nothing.
 */
export function ExportDialog({ filter, oneSession, filteredCount, onClose }: {
  filter: TraceFilter;
  oneSession?: TraceSessionSummary;
  filteredCount?: number;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<Scope>(oneSession ? 'one' : filteredCount !== undefined ? 'filtered' : 'all');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true; path: string; sessions: number } | { ok: false; error: string } | null>(null);

  const options: SegmentedOption<Scope>[] = [
    ...(filteredCount !== undefined ? [{ value: 'filtered' as const, label: `the ${filteredCount} these filters show` }] : []),
    ...(oneSession ? [{ value: 'one' as const, label: 'this session' }] : []),
    { value: 'all', label: 'everything' },
  ];

  const run = async () => {
    const api = tracesApi();
    if (!api) return;
    setBusy(true);
    const f: TraceFilter = scope === 'all' ? {} : scope === 'one' && oneSession ? { traceId: oneSession.traceId } : filter;
    const r = await api.exportTo(f);
    setBusy(false);
    if (r.ok) setResult(r);
    else if (!r.cancelled) setResult({ ok: false, error: r.error });
  };

  if (result?.ok) {
    return (
      <DialogShell
        onClose={onClose}
        width={560}
        title="Exported"
        footerRight={<>
          <Button onClick={() => { void window.electronAPI?.shell?.reveal(result.path); }}>Show the file</Button>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </>}
      >
        <StateLine word={`${result.sessions} session${result.sessions === 1 ? '' : 's'} exported to ${result.path}`} tone="running" />
      </DialogShell>
    );
  }

  return (
    <DialogShell
      onClose={onClose}
      width={560}
      title="Export sessions"
      subtitle="JSONL, one line per record. Tars asks where to save it. An export holds the requests whole, the code your agents read and wrote included."
      footerRight={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={() => { void run(); }}>Export</Button>
      </>}
    >
      <div className="space-y-3">
        <SegmentedControl ariaLabel="What to export" options={options} value={scope} onChange={setScope} />
        {result && !result.ok && <StateLine word={`not exported: ${result.error}`} tone="error" />}
      </div>
    </DialogShell>
  );
}
