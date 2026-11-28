'use client';

import { useState } from 'react';
import { Button, Select, StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';
import { Toggle } from '@/components/Settings/Toggle';
import { useStore } from '@/store';
import type { LoadGrant, LoadHarness, LoadProjectState, LoadProjectView } from '@/types/electron';
import { useLoadProjects, loadApi } from '@/hooks/useLoadWindow';
import { Chip } from './bits';

const HARNESSES: LoadHarness[] = ['codex', 'qwen-code', 'pi', 'opencode'];
/** A project that cannot run whatever its grant: no controls, only main's reason. */
const NO_CONTROLS: LoadProjectState[] = ['traces_off', 'no_repo', 'unknown_project'];

const toneOf = (s: LoadProjectState): StatusTone =>
  s === 'allowed' || s === 'allowed_by_name' ? 'running'
    : s === 'no_endpoint' || s === 'no_harness' ? 'waiting'
      : s === 'traces_off' || s === 'no_repo' || s === 'unknown_project' ? 'error' : 'idle';

/** The project's visibility chip, as the frames word it. */
function Visibility({ p }: { p: LoadProjectView }) {
  if (p.state === 'traces_off') return <Chip tone="error">traces off</Chip>;
  if (p.grant?.allowedByName && p.visibility !== 'public') return <Chip tone="waiting">allowed by name</Chip>;
  if (p.visibility === 'public' || p.visibility === 'private') return <Chip>{p.visibility}</Chip>;
  if (p.visibility === 'none') return <Chip>no GitHub repository</Chip>;
  if (p.visibility === 'unknown') return <Chip>visibility unknown</Chip>;
  return null;
}

/**
 * The card's second view (`Shell · Load window card · projects`): each project's load grant, set only here. Every change
 * goes to main whole (`load.grant`), which answers with the project as it now stands, its line in main's words; a
 * refusal says main's own sentence under the row.
 */
export function Projects() {
  const { view, setView, error } = useLoadProjects();
  const requestMore = useStore(s => s.requestMore);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const send = async (p: LoadProjectView, patch: Partial<LoadGrant>) => {
    const api = loadApi();
    if (!api || !view) return;
    const grant: LoadGrant = {
      path: p.path, enabled: p.grant?.enabled ?? false, allowedByName: p.grant?.allowedByName ?? false,
      endpointId: p.grant?.endpointId ?? null, model: p.grant?.model ?? null, harnesses: p.grant?.harnesses ?? [], ...patch,
    };
    setBusy(p.path);
    try {
      const r = await api.grant(grant);
      if (r.ok) {
        setView(v => (v ? { ...v, projects: v.projects.map(x => (x.path === p.path ? r.project : x)) } : v));
        setRowError(e => { const next = { ...e }; delete next[p.path]; return next; });
      } else {
        setRowError(e => ({ ...e, [p.path]: r.error }));
      }
    } catch (err) {
      setRowError(e => ({ ...e, [p.path]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(null);
    }
  };

  if (!view) {
    return <div className="flex-1 min-h-0 px-[26px] pt-[18px] text-[12.5px] text-muted-foreground">{error ? <span className="text-status-error">{error}</span> : 'Reading the projects'}</div>;
  }
  const allowed = view.projects.filter(p => p.allowed).length;

  return (
    <div data-load-projects className="flex-1 min-h-0 overflow-y-auto px-[26px] pt-[18px] pb-[22px] flex flex-col gap-2.5">
      <div className="flex items-center gap-4">
        <p className="flex-1 min-w-0 text-[12.5px] text-text-secondary">Which projects a load window may run, its endpoint and model, and the harnesses its load agents use. Only you set this, here: no agent, token or message can.</p>
        <span className="font-mono text-[10.5px] text-muted-foreground shrink-0">{view.projects.length} project{view.projects.length === 1 ? '' : 's'} · {allowed} allowed</span>
      </div>
      {view.projects.map(p => {
        const endpoint = view.endpoints.find(e => e.id === p.grant?.endpointId);
        const controls = !NO_CONTROLS.includes(p.state);
        const harnesses = p.grant?.harnesses ?? [];
        const on = p.grant?.enabled ?? false;
        const action = p.state === 'traces_off' ? { label: 'open its traces opt-in', run: () => requestMore('traces') }
          : (p.state === 'private' || p.state === 'unknown') && !p.grant?.allowedByName ? { label: 'allow by name', run: () => { void send(p, { allowedByName: true, enabled: true }); } }
            : p.grant?.allowedByName && p.visibility !== 'public' ? { label: 'withdraw the name', run: () => { void send(p, { allowedByName: false }); } }
              : null;
        return (
          <section key={p.path} data-load-grant={p.name} className="border border-border bg-card px-3 py-2.5 flex flex-col gap-2">
            <div className="flex items-center gap-2.5">
              <span className="text-[13px] font-semibold text-foreground">{p.name}</span>
              {p.repo && <span className="font-mono text-[11px] text-muted-foreground truncate">github.com/{p.repo}</span>}
              <Visibility p={p} />
              <span className="flex-1" />
              <span className={`text-[11.5px] ${controls ? 'text-text-secondary' : 'text-muted-foreground'}`}>load windows</span>
              <Toggle label={`${p.name} load windows`} enabled={on} disabled={!controls || busy === p.path} onChange={() => { void send(p, { enabled: !on }); }} />
            </div>
            {controls && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="w-[60px] text-[11.5px] text-text-secondary">endpoint</span>
                <span className="w-[200px]">
                  <Select aria-label={`${p.name} endpoint`} compact value={p.grant?.endpointId ?? ''} disabled={busy === p.path}
                    onChange={e => { const id = e.target.value || null; const ep = view.endpoints.find(x => x.id === id); void send(p, { endpointId: id, model: ep?.models[0] ?? null }); }}>
                    <option value="">choose one</option>
                    {view.endpoints.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </Select>
                </span>
                <span className="w-[40px] text-[11.5px] text-text-secondary">model</span>
                <span className="w-[170px]">
                  <Select aria-label={`${p.name} model`} compact value={p.grant?.model ?? ''} disabled={!endpoint || busy === p.path}
                    onChange={e => { void send(p, { model: e.target.value || null }); }}>
                    <option value="">choose one</option>
                    {(endpoint?.models ?? []).map(m => <option key={m} value={m}>{m}</option>)}
                  </Select>
                </span>
                <span className="w-[62px] text-[11.5px] text-text-secondary">harnesses</span>
                {HARNESSES.map(h => {
                  const chosen = harnesses.includes(h);
                  return (
                    <button key={h} type="button" aria-pressed={chosen} disabled={busy === p.path}
                      onClick={() => { void send(p, { harnesses: chosen ? harnesses.filter(x => x !== h) : [...harnesses, h] }); }}
                      className={`h-[26px] px-[9px] border font-mono text-[11px] transition-colors ${chosen ? 'bg-accent-dim border-primary text-foreground' : 'bg-card border-border text-muted-foreground hover:text-foreground'}`}>
                      {h}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-2">
              <StatusSquare tone={toneOf(p.state)} />
              <span data-load-reason className="flex-1 min-w-0 text-[11.5px] text-text-secondary">{p.reason}</span>
              {action && <Button size="sm" onClick={action.run} disabled={busy === p.path}>{action.label}</Button>}
            </div>
            {rowError[p.path] && <p data-load-error className="font-mono text-[10.5px] text-status-error">{rowError[p.path]}</p>}
          </section>
        );
      })}
      <p className="text-[11px] text-muted-foreground">Kept in ~/.tars-private, which no agent is handed. A project is allowed only once it is traced; a private repository only by its name.</p>
    </div>
  );
}
