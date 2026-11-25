'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CrossProjectGrant } from '@/types/electron';
import { Button, Dropdown, PanelCaption, StatusSquare } from '@/components/ui';
import { useElectronAgents } from '@/hooks/useElectron';
import { comparablePath, lastPathPart } from '@/lib/display-path';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

const projectOf = (p: string) => lastPathPart(p) || p;
const same = (a: string, b: string) => comparablePath(a) === comparablePath(b);

/**
 * Settings > AI & Providers > Across projects (2.0.7, PR 595): the owner's grants from one project to another. A grant
 * gives the acting project's orchestrator, its chats' runners and the workers it names the powers of the other
 * project's orchestrator over its agents; one way, effective at once, given and removed only here. Frames:
 * `Settings · Across projects`, `· states`, and their light copies.
 */
export const CrossProjectSection = () => {
  const api = typeof window !== 'undefined' ? window.electronAPI?.crossProject : undefined;
  const { agents } = useElectronAgents();
  const [grants, setGrants] = useState<CrossProjectGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ from: string; to: string; workers: string[]; editing?: boolean } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<CrossProjectGrant | null>(null);

  const read = useCallback(async () => {
    if (!api) return;
    try { setGrants(await api.list()); setError(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [api]);
  useEffect(() => { void read(); }, [read]);

  // The projects the fleet knows, and those a grant names.
  const projects = useMemo(() => {
    const all = [...agents.map(a => a.projectPath), ...(grants ?? []).flatMap(g => [g.from, g.to])].filter(Boolean);
    return all.filter((p, i) => all.findIndex(q => same(p, q)) === i).sort((a, b) => projectOf(a).localeCompare(projectOf(b)));
  }, [agents, grants]);
  const workersOf = (project: string) => agents.filter(a => same(a.projectPath, project) && a.role !== 'orchestrator');
  const nameOf = (id: string) => agents.find(a => a.id === id)?.name ?? id;

  const give = async () => {
    if (!api || !form) return;
    const r = await api.set({ from: form.from, to: form.to, workers: form.workers });
    if (!r.ok) { setFormError(r.error); return; }
    setForm(null);
    setFormError(null);
    void read();
  };

  const remove = async (g: CrossProjectGrant) => {
    if (!api) return;
    const r = await api.remove({ from: g.from, to: g.to });
    setRemoving(null);
    if (!r.ok) setError(r.error);
    void read();
  };

  const formBox = form && (
    <div data-grant-form className="border border-border-accent bg-background px-4 py-3.5 space-y-3">
      <p className="text-[12.5px] text-foreground">{form.editing ? `${projectOf(form.from)} to ${projectOf(form.to)}: its workers` : 'Give a grant'}</p>
      {!form.editing && (
        <div className="flex gap-3">
          <div className="w-[300px] space-y-1.5">
            <PanelCaption>FROM, THE PROJECT THAT ACTS</PanelCaption>
            <Dropdown mono ariaLabel="From" placeholder="a project" value={form.from} options={projects.map(p => ({ value: p, label: projectOf(p), hint: p }))}
              onChange={v => { setForm({ ...form, from: v, workers: [] }); setFormError(null); }} />
          </div>
          <div className="w-[300px] space-y-1.5">
            <PanelCaption>TO, THE PROJECT IT MAY ACT IN</PanelCaption>
            <Dropdown mono ariaLabel="To" placeholder="a project" value={form.to} options={projects.map(p => ({ value: p, label: projectOf(p), hint: p }))}
              onChange={v => { setForm({ ...form, to: v }); setFormError(null); }} />
          </div>
        </div>
      )}
      <div className="space-y-1.5">
        <PanelCaption>ITS WORKERS THE GRANT NAMES, IF ANY</PanelCaption>
        <div className="flex flex-wrap gap-1.5">
          {form.from ? workersOf(form.from).map(w => {
            const on = form.workers.includes(w.id);
            return (
              <Button key={w.id} size="sm" className="font-mono" active={on} aria-pressed={on}
                onClick={() => setForm({ ...form, workers: on ? form.workers.filter(x => x !== w.id) : [...form.workers, w.id] })}>
                {w.name}
              </Button>
            );
          }) : <span className="font-mono text-[10.5px] text-muted-foreground">pick the project that acts first</span>}
          {form.from && workersOf(form.from).length === 0 && <span className="font-mono text-[10.5px] text-muted-foreground">it has no worker</span>}
        </div>
        <p className="font-mono text-[10.5px] text-muted-foreground">Its orchestrator and its chats&apos; runners always have it; a worker only when named here.</p>
      </div>
      {formError && <p className="font-mono text-[10.5px] text-status-error">{formError}</p>}
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10.5px] text-muted-foreground">effective at once</span>
        <span className="flex-1" />
        <Button onClick={() => { setForm(null); setFormError(null); }}>Cancel</Button>
        <Button variant="primary" disabled={!form.from || !form.to} onClick={() => { void give(); }}>{form.editing ? 'Save the workers' : 'Give the grant'}</Button>
      </div>
    </div>
  );

  return (
    <SettingsCard>
      {error && (
        <div data-settings-row className="px-4 py-[11px] flex items-center gap-2">
          <StatusSquare tone="error" /><span className="text-[11.5px] text-status-error">{error}</span>
        </div>
      )}

      <SettingsRow
        wrap
        label="Across projects"
        description={
          <>
            <span className="block">A grant from one project to another gives the first project&apos;s orchestrator, its chats&apos; runners and the workers it names the powers of the other project&apos;s orchestrator over its agents: list them, hand them tasks, start, stop and message them, read their answers, and make worktrees there with push turned off. One way: nothing of the second opens to the first.</span>
            <span className="block">Without a grant, orchestrators of different projects may still hand each other tasks and read the answer, and any agent may leave a note for any agent. Everything else across projects needs a grant, and only you give one, here.</span>
          </>
        }
        control={<Button size="sm" className="font-mono lowercase" disabled={!api} onClick={() => setForm({ from: '', to: '', workers: [] })}>give a grant</Button>}
      />

      {grants && grants.length === 0 && !form && (
        <div data-settings-row className="px-4 py-[11px] flex items-center gap-2">
          <StatusSquare tone="idle" />
          <span className="font-mono text-[10.5px] text-muted-foreground">no grant: each project&apos;s agents act in their own project only, apart from tasks between orchestrators and notes</span>
        </div>
      )}

      {(grants ?? []).map(g => (
        <div key={`${g.from}>${g.to}`} data-grant={`${projectOf(g.from)} to ${projectOf(g.to)}`} className="px-4 py-[11px] space-y-2">
          <div className="flex items-center gap-3">
            <div className="w-[330px] shrink-0 flex items-center gap-2 min-w-0">
              <span className="text-[12.5px] text-foreground truncate" title={g.from}>{projectOf(g.from)}</span>
              <span className="font-mono text-[11px] text-muted-foreground">to</span>
              <span className="text-[12.5px] text-foreground truncate" title={g.to}>{projectOf(g.to)}</span>
            </div>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="font-mono text-[10.5px] text-text-secondary truncate">
                {g.workers.length ? `and its workers ${g.workers.map(nameOf).join(', ')}` : "its orchestrator and chats' runners only"}
              </p>
              <p className="font-mono text-[10.5px] text-muted-foreground">{`given by you, ${new Date(g.grantedAt).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`}</p>
            </div>
            <Button size="sm" className="font-mono lowercase" onClick={() => setForm({ from: g.from, to: g.to, workers: g.workers, editing: true })}>change workers</Button>
            <Button size="sm" className="font-mono lowercase" onClick={() => setRemoving(g)}>remove</Button>
          </div>
          {form?.editing && same(form.from, g.from) && same(form.to, g.to) && formBox}
          {removing && same(removing.from, g.from) && same(removing.to, g.to) && (
            <div className="px-3.5 py-3 bg-secondary border border-danger/40 space-y-2.5">
              <p className="text-xs text-foreground">{`Remove ${projectOf(g.from)}'s grant to ${projectOf(g.to)}? Its agents lose the powers in ${projectOf(g.to)} at once; a task they handed there goes on.`}</p>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="danger" className="font-mono" onClick={() => { void remove(g); }}>remove</Button>
                <Button size="sm" className="font-mono" onClick={() => setRemoving(null)}>keep it</Button>
              </div>
            </div>
          )}
        </div>
      ))}

      {form && !form.editing && <div data-settings-row className="px-4 py-[11px]">{formBox}</div>}
    </SettingsCard>
  );
};
