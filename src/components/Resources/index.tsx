'use client';

import { useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PageHeader, SegmentedControl } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';
import { DiskView } from './DiskView';
import { FleetView } from './FleetView';
import { HeavyRunsView } from './HeavyRunsView';

type View = 'heavy-runs' | 'agents' | 'disk';
const VIEWS: readonly SegmentedOption<View>[] = [
  { value: 'heavy-runs', label: 'Heavy runs' },
  { value: 'agents', label: 'Agents and projects' },
  { value: 'disk', label: 'Disk' },
];
const isView = (v: string | null): v is View => VIEWS.some((o) => o.value === v);

/**
 * Resources (2.0.5, lots 2 and 3 of the resources plan; frames `Resources (2.0.5) · heavy runs`, `· agents and
 * projects`, `· disk`, design PR 535): this computer, the heavy runs every project's agents take turns at, what each
 * agent and project holds, and the disk janitor. Between Usage, which says what the providers cost, and Brain. The view
 * is in ?view=, so a link can open one; in the new interface's card, where the page has no address, it is kept in the
 * same state.
 */
export function ResourcesPage() {
  const params = useSearchParams();
  const router = useRouter();
  const asked = params.get('view');
  const view: View = isView(asked) ? asked : 'heavy-runs';
  const choose = useCallback((next: View) => {
    const url = new URL(window.location.href);
    url.searchParams.set('view', next);
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  }, [router]);
  /** The agent the Agents and projects view shows beside the table; a holder's "show agent" chooses it there. */
  const [agent, setAgent] = useState<string | null>(null);
  const showAgent = useCallback((agentId: string) => { setAgent(agentId); choose('agents'); }, [choose]);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-x-clip">
      <PageHeader
        title="Resources"
        subtitle="This computer, the heavy runs your agents take turns at, and what each agent and project holds."
        actions={<SegmentedControl ariaLabel="Resources view" options={VIEWS} value={view} onChange={choose} />}
      />
      <div className="flex flex-col flex-1 min-h-0">
        {view === 'heavy-runs' && <HeavyRunsView onShowAgent={showAgent} />}
        {view === 'agents' && <FleetView chosen={agent} onChoose={setAgent} />}
        {view === 'disk' && <DiskView />}
      </div>
    </div>
  );
}
