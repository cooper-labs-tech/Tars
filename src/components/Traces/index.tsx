'use client';

import { useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, PageHeader, SegmentedControl } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';
import { SessionsView } from './SessionsView';
import { SessionView } from './SessionView';
import { StorageView } from './StorageView';
import { PairsView } from './PairsView';
import { UploadView } from './UploadView';
import { ExportDialog } from './ExportDialog';

type View = 'sessions' | 'storage' | 'pairs' | 'upload';
const VIEWS: readonly SegmentedOption<View>[] = [
  { value: 'sessions', label: 'Sessions' },
  { value: 'storage', label: 'Storage and access' },
  { value: 'pairs', label: 'Who may be traced' },
  { value: 'upload', label: 'Upload' },
];
const isView = (v: string | null): v is View => VIEWS.some(o => o.value === v);

/**
 * Traces: the sessions Tars recorded for agents on an inference endpoint that allows it, kept on this computer, and
 * read by an external reader with the reader token. Three views in ?view=, and a session in ?session=, so a link can
 * open either. Frames: `Traces · sessions`, `· a session's turns`, `· storage and reader access`, `· who may be
 * traced`, `· upload`, their states and their light copies.
 */
export function TracesPage() {
  const params = useSearchParams();
  const router = useRouter();
  const asked = params.get('view');
  const view: View = isView(asked) ? asked : 'sessions';
  const session = params.get('session');
  const [exporting, setExporting] = useState(false);

  const go = useCallback((next: { view?: View; session?: string | null }) => {
    const url = new URL(window.location.href);
    if (next.view) url.searchParams.set('view', next.view);
    if (next.session) url.searchParams.set('session', next.session);
    else url.searchParams.delete('session');
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  }, [router]);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-x-clip">
      <PageHeader
        title="Traces"
        subtitle="Sessions your agents recorded on endpoints that allow it, kept on this computer. An external reader reads them with the reader token."
        actions={<>
          <SegmentedControl size="md" ariaLabel="Traces view" options={VIEWS} value={view} onChange={v => go({ view: v, session: null })} />
          <Button onClick={() => setExporting(true)}>Export</Button>
        </>}
      />
      <div className="flex flex-col flex-1 min-h-0">
        {view === 'sessions' && (session
          ? <SessionView traceId={session} onBack={() => go({ session: null })} />
          : <SessionsView onOpen={id => go({ session: id })} />)}
        {view === 'storage' && <StorageView />}
        {view === 'pairs' && <PairsView />}
        {view === 'upload' && <UploadView />}
      </div>
      {exporting && <ExportDialog filter={{}} onClose={() => setExporting(false)} />}
    </div>
  );
}
