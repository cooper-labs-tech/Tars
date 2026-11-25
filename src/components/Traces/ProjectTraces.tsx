'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentStatus } from '@/types/electron';
import { Button, Panel, PanelCaption } from '@/components/ui';
import { comparablePath, lastPathPart } from '@/lib/display-path';
import { Toggle } from '@/components/Settings/Toggle';
import { StateLine } from './bits';
import { tracesApi, useUnsavedNote } from './hooks';

/**
 * A project's TRACES section in its Projects panel (frame `Projects · a project · Record traces for this project`,
 * and `Traces · states`, the switch off). On, its agents on an endpoint that allows traces may record their
 * sessions, each saying so itself; off, none does. The list of projects is main's (traces.settings).
 */
export function ProjectTraces({ projectPath, agents }: { projectPath: string; agents: AgentStatus[] }) {
  const router = useRouter();
  const [projects, setProjects] = useState<string[] | null>(null);
  const [upload, setUpload] = useState<{ url: string; consent: boolean }>({ url: '', consent: false });
  const [error, setError] = useState<string | null>(null);
  /** The switch turned off and held by main, not written yet: main's words under the switch until it is. */
  const [unsaved, setUnsaved] = useUnsavedNote();

  const read = useCallback(() => {
    const api = tracesApi();
    if (!api) return;
    // The consent is the one the uploader acts on (uploadState.consentAt), never the settings' alone: a consent whose
    // file a revoke dropped is no consent (the Audit's I-5 on PR 599).
    void Promise.all([api.settings(), api.uploadState()])
      .then(([s, u]) => { setProjects(s.projects); setUpload({ url: s.uploadUrl, consent: !!u.consentAt }); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => { read(); }, [read]);
  // A consent main holds back or gives back comes with 'traces:changed': the panel reads it again.
  useEffect(() => tracesApi()?.onChanged(() => read()), [read]);

  if (!tracesApi()) return null;
  const key = comparablePath(projectPath);
  const on = !!projects?.some(p => comparablePath(p) === key);
  const recording = agents.filter(a => a.traces === true).length;
  const name = lastPathPart(projectPath) || projectPath;
  /** The back-office's host, as the line names it. */
  const host = (() => { try { return new URL(upload.url).host; } catch { return upload.url; } })();
  const uploads = !!upload.url && upload.consent;

  const toggle = async () => {
    const api = tracesApi();
    if (!api || !projects) return;
    const next = on ? projects.filter(p => comparablePath(p) !== key) : [...projects, projectPath];
    let r: Awaited<ReturnType<typeof api.setSettings>>;
    try {
      r = await api.setSettings({ projects: next });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!r.ok) { setError(r.error); return; }
    setProjects(r.settings.projects);
    setError(null);
    // A switch turned off applies at once; when main could not write it yet, its words say so here, and the
    // settings are read again, so the switch shows what main holds.
    setUnsaved(r.unsaved ?? null);
    if (r.unsaved) read();
  };

  return (
    <Panel data-project-traces={on ? 'on' : 'off'}>
      <PanelCaption className="mb-2">TRACES</PanelCaption>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] text-foreground">{uploads ? 'Record and upload traces for this project' : 'Record traces for this project'}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {on && uploads
              ? `Its sessions are recorded on this computer and uploaded, scrubbed, to ${host}, for the agents that say so.`
              : on && upload.url
                ? 'Its sessions are recorded on this computer. Uploading waits for you to read what leaves it.'
                : on
              ? 'Its agents on an endpoint that allows traces may record their sessions, each agent saying so in its own settings, for the pairs you allow.'
              : `No agent of ${name} records traces. Turning it on records nothing by itself: each agent on an endpoint that allows traces then says so in its own settings.`}
          </p>
        </div>
        <Toggle label="Record traces for this project" enabled={on} disabled={projects === null} onChange={() => { void toggle(); }} />
      </div>
      {error && <p className="mt-2 font-mono text-[10.5px] text-status-error">{error}</p>}
      {unsaved && <div data-project-traces-unsaved className="mt-2"><StateLine wrap word={unsaved} tone="waiting" /></div>}
      {on && (
        <div className="mt-2.5 flex items-center gap-2">
          {upload.url && !upload.consent
            ? <StateLine word="not uploaded: read what leaves this computer first" tone="waiting" />
            : <StateLine word={`${recording} agent${recording === 1 ? '' : 's'} record${recording === 1 ? 's' : ''} traces${uploads ? ` · uploaded to ${host}` : ''}`} tone={recording > 0 ? 'running' : 'idle'} />}
          <span className="flex-1" />
          <Button size="sm" variant="ghost" className="font-mono" onClick={() => router.push(upload.url && !upload.consent ? '/traces?view=upload' : '/traces')}>open Traces</Button>
        </div>
      )}
    </Panel>
  );
}
