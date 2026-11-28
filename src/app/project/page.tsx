'use client';

import { Suspense, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { LayoutDashboard, Plus, Users } from 'lucide-react';
import { Button, LoadingPanel, PageHeader, PanelCaption } from '@/components/ui';
import { useElectronAgents } from '@/hooks/useElectron';
import { projectNameOf, useChats } from '@/hooks/useChats';
import { sectionOf } from '@/lib/chat-sections';
import { AgentSquare, StateWord, clockOf } from '@/components/NewShell/chat-bits';
import { useLoadProjects } from '@/hooks/useLoadWindow';
import { LoadAgentsCard } from '@/components/LoadWindow/LoadAgentsCard';

/**
 * A project's page, under Projects (`Shell · chats · project page, from the
 * records`): its chats by number, Main named as its inbox; its team, each
 * agent with what it is on; its terminals; its room. `?path=` names the
 * project; without it, the first project that has chats or agents.
 */
export default function ProjectPage() {
  return (
    <Suspense>
      <ProjectPageInner />
    </Suspense>
  );
}

function ProjectPageInner() {
  const router = useRouter();
  const asked = useSearchParams().get('path');
  const { chats, at } = useChats();
  const { agents, isLoading } = useElectronAgents();
  const { view: loadView } = useLoadProjects();

  const project = useMemo(() => {
    if (asked) return asked;
    const paths = [...(chats ?? []).map(chat => chat.projectPath), ...agents.map(agent => agent.projectPath)].filter(Boolean);
    return paths.sort((a, b) => projectNameOf(a).localeCompare(projectNameOf(b)))[0] ?? null;
  }, [asked, chats, agents]);

  if (chats === null || (isLoading && agents.length === 0)) return <LoadingPanel what="Reading the project" />;
  if (!project) {
    return <PageHeader title="Projects" subtitle="No project yet: add one from Agents, with its first agent." />;
  }

  const name = projectNameOf(project);
  const now = at;
  const mine = chats.filter(chat => chat.projectPath === project);
  const open = mine.filter(chat => { const s = sectionOf(chat, now); return s !== 'Snoozed' && s !== 'Settled'; }).sort((a, b) => a.number - b.number);
  const snoozed = mine.filter(chat => sectionOf(chat, now) === 'Snoozed').length;
  const settled = mine.filter(chat => sectionOf(chat, now) === 'Settled').length;
  // The project's load agents have their own card (`Shell · Load window · load agents on the project page`), not the team.
  const loadProject = loadView?.projects.find(p => p.path === project);
  const loadIds = new Set(loadProject?.agents.map(a => a.id) ?? []);
  const team = agents.filter(agent => agent.projectPath === project && !loadIds.has(agent.id));
  const live = team.filter(agent => !!agent.ptyId).length;

  return (
    <div className="h-[calc(100vh-44px)] flex flex-col">
      <PageHeader
        title={name}
        subtitle={<span className="font-mono">{team.length} agent{team.length === 1 ? '' : 's'} · {mine.length} chat{mine.length === 1 ? '' : 's'}</span>}
        actions={(
          <>
            <Link href="/" className="h-8 px-3 flex items-center gap-2 border border-border bg-card text-sm text-text-secondary hover:bg-secondary transition-colors">
              <LayoutDashboard className="w-3.5 h-3.5" />
              Open terminals
            </Link>
            <Button variant="primary" onClick={() => router.push(`/chats?new=1&project=${encodeURIComponent(project)}`)}>
              <Plus className="w-3.5 h-3.5" />
              New chat in {name}
            </Button>
          </>
        )}
      />
      <div className="flex-1 min-h-0 flex gap-4">
        <section aria-label={`Chats in ${name}`} className="flex-1 min-w-0 self-start border border-border bg-card">
          <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
            <PanelCaption>Chats in {name}</PanelCaption>
            <span className="font-mono text-[10.5px] text-status-idle">{open.length} open, {snoozed} snoozed, {settled} settled</span>
          </div>
          {open.length === 0 && <p className="px-4 py-3 border-t border-border text-xs text-status-idle">No open chat in {name}.</p>}
          {open.map(chat => (
            <Link key={chat.id} href={`/chats?chat=${encodeURIComponent(chat.id)}`} data-project-chat className="block px-4 py-[11px] border-t border-border hover:bg-secondary transition-colors">
              <span className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-text-secondary">#{chat.number}</span>{' '}
                <span className="text-[13.5px] font-semibold text-foreground truncate">{chat.title}</span>
                <span className="flex-1" />
                {chat.runner && chat.runner.status !== 'idle' && <>{' '}<StateWord status={chat.runner.status} /></>}{' '}
                <span className="font-mono text-[10.5px] text-status-idle">{clockOf(chat.lastActivityAt)}</span>
              </span>
              {chat.inbox && (
                <>
                  {' '}
                  <span className="block mt-1 text-xs text-text-secondary">The project&apos;s inbox: the bots, Hermes and Tars&apos;s notes arrive here.</span>
                </>
              )}
            </Link>
          ))}
        </section>

        <div className="w-[400px] shrink-0 flex flex-col gap-4">
          <section aria-label="Team" className="border border-border bg-card">
            <div className="px-4 pt-3 pb-2"><PanelCaption>Team</PanelCaption></div>
            {team.map(agent => (
              <div key={agent.id} data-team-member className="flex items-center gap-2.5 px-4 py-[9px] border-t border-border">
                <AgentSquare agent={agent} />
                <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-[12.5px] font-semibold text-foreground truncate">{agent.name ?? agent.id}</span>
                    {agent.role === 'orchestrator' && (
                      <span className="h-[18px] px-1.5 flex items-center border border-primary bg-accent-dim font-mono text-[10px] text-foreground shrink-0">orchestrator</span>
                    )}
                    {agent.model && <span className="font-mono text-[10.5px] text-status-idle truncate">{agent.model}</span>}
                  </span>
                  <span className="text-[11.5px] text-text-secondary truncate">{agent.currentTask || 'free'}</span>
                </span>
                <StateWord status={agent.status} />
              </div>
            ))}
          </section>

          {loadProject && <LoadAgentsCard project={loadProject} />}

          <section aria-label="Dashboard terminals" className="border border-border bg-card">
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
              <PanelCaption>Dashboard terminals</PanelCaption>
              <span className="font-mono text-[10.5px] text-status-idle">{live} running</span>
            </div>
            <div className="flex items-center gap-2 px-4 pt-1 pb-3.5">
              <span className="flex-1 text-xs text-text-secondary">One terminal per agent of {name}, live.</span>
              <Link href="/" className="h-[26px] px-2.5 flex items-center gap-1.5 border border-border bg-card text-xs text-text-secondary hover:bg-secondary transition-colors">
                <LayoutDashboard className="w-3 h-3" />
                Open the Dashboard
              </Link>
            </div>
          </section>

          <section aria-label="Room" className="border border-border bg-card">
            <div className="px-4 pt-3 pb-2"><PanelCaption>Room</PanelCaption></div>
            <div className="flex items-center gap-2.5 px-4 pb-3.5">
              <span className="flex-1 text-xs leading-[1.45] text-text-secondary">In the Chat page, under Tars: what this project and Tars say to each other.</span>
              <Link href="/chat" className="h-[26px] px-2.5 flex items-center gap-1.5 border border-border bg-card text-xs text-text-secondary hover:bg-secondary transition-colors shrink-0">
                <Users className="w-3 h-3" />
                Open the room
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
