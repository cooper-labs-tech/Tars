'use client';

import { PanelCaption, StatusSquare } from '@/components/ui';
import { useStore } from '@/store';
import type { LoadProjectView } from '@/types/electron';
import { Chip } from './bits';

/**
 * A project's load agents on its page (`Shell · Load window · load agents on the project page`), under its team: each
 * marked a load agent, its harness, endpoint and model, and whether a window has it at work; the memory line; and the
 * project's grant, with the way to the card's Projects view. Shown only for a project that has load agents.
 */
export function LoadAgentsCard({ project }: { project: LoadProjectView }) {
  const requestMore = useStore(s => s.requestMore);
  const setLoadView = useStore(s => s.setLoadView);
  if (project.agents.length === 0) return null;
  return (
    <section aria-label="Load agents" data-load-agents className="border border-border bg-card">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <PanelCaption>Load agents</PanelCaption>
        <span className="font-mono text-[10.5px] text-status-idle">{project.agents.length} · for load windows</span>
      </div>
      {project.agents.map(a => (
        <div key={a.id} className="flex items-center gap-2.5 px-4 py-[7px] border-t border-border">
          <span className="w-6 h-6 shrink-0 flex items-center justify-center bg-secondary font-mono text-[11px] text-text-secondary">L</span>
          <span className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="text-[12.5px] font-semibold text-foreground truncate">{a.name}</span>
              <Chip>load agent</Chip>
            </span>
            <span className="font-mono text-[10.5px] text-status-idle truncate">{[a.harness, a.endpointName, a.model].filter(Boolean).join(' · ')}</span>
          </span>
          <span className={`font-mono text-[10.5px] shrink-0 ${a.inWindow ? 'text-status-running' : 'text-status-idle'}`}>{a.inWindow ? 'in a window' : 'free'}</span>
        </div>
      ))}
      <div className="px-4 pt-2 pb-2.5 border-t border-border flex flex-col gap-1.5">
        <p className="text-[11px] text-muted-foreground">Each starts every task without the memory earlier load tasks wrote, and writes none.</p>
        <div className="flex items-center gap-2">
          <StatusSquare tone={project.allowed ? 'running' : 'idle'} />
          <span className="flex-1 min-w-0 text-[11.5px] text-text-secondary truncate">{project.allowed ? 'allowed for load windows' : project.reason}</span>
          <button type="button" onClick={() => { setLoadView('projects'); requestMore('load-window'); }}
            className="h-[26px] px-2.5 flex items-center border border-border bg-card text-xs text-text-secondary hover:bg-secondary transition-colors shrink-0">
            Load window, Projects
          </button>
        </div>
      </div>
    </section>
  );
}
