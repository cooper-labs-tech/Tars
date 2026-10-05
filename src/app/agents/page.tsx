'use client';

import { useState, useCallback, useMemo } from 'react';
import { Bot } from 'lucide-react';
import { useElectronAgents, useElectronFS, useElectronSkills, isElectron } from '@/hooks/useElectron';
import { useElectronTemplates } from '@/hooks/useElectronTemplates';
import { useClaude } from '@/hooks/useClaude';
import { useAgentFiltering, groupByProject, projectLabels, projectName, tildePath } from '@/hooks/useAgentFiltering';
import { useSuperAgent } from '@/hooks/useSuperAgent';
import { useProjectTabOrder } from '@/components/TerminalsView/hooks/useProjectTabOrder';
import type { AgentCharacter, AgentProvider } from '@/types/electron';
import NewChatModal from '@/components/NewChatModal';
import type { EditAgentData, CreationMode } from '@/components/NewChatModal/types';
import AgentTerminalDialog from '@/components/AgentWorld/AgentTerminalDialog';
import { TemplatesManagerDialog } from '@/components/Templates/TemplatesManagerDialog';
import {
  DesktopRequiredMessage,
  AgentListHeader,
  AgentManagementCard,
} from '@/components/AgentList';
import { Chip, Dropdown, LoadingState, type DropdownOption } from '@/components/ui';
import { statusWord } from './constants';

// The words the cards print, in the frames' order: stopped sits between idle
// and error (`Agent stopped · who and why`), asleep between idle and stopped
// (`Agent asleep · and how it wakes`). `completed` is not one of them: the
// card prints it as idle, so the Idle filter is where it is found, as is an
// agent coming back from sleep, whose status is idle while it reads waking.
const STATUS_FILTERS = ['running', 'waiting', 'idle', 'asleep', 'stopped', 'error'] as const;

// The picker's "every project" row. Never a project: an agent's projectPath
// is absolute.
const ALL_PROJECTS = 'all';

const agentCount = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;

export default function AgentsPage() {
  const {
    agents,
    isLoading: agentsLoading,
    isElectron: hasElectron,
    createAgent,
    updateAgent,
    startAgent,
    stopAgent,
    wakeAgent,
    removeAgent,
  } = useElectronAgents();
  const { projects, openFolderDialog } = useElectronFS();
  const { installedSkills, refresh: refreshSkills } = useElectronSkills();
  const { create: createTemplate } = useElectronTemplates();
  const { data: claudeData } = useClaude();

  // Local state
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [newChatMode, setNewChatMode] = useState<CreationMode>('agent');
  const [showTemplatesDialog, setShowTemplatesDialog] = useState(false);
  const [viewAgentId, setViewAgentId] = useState<string | null>(null);  // terminal dialog
  const [editAgentId, setEditAgentId] = useState<string | null>(null);  // edit dialog
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState<string | null>(null);


  // Custom hooks
  const { superAgent } = useSuperAgent({ agents });

  // A project whose last agent is gone has nothing to show, so the page falls
  // back to every project rather than to an empty list under a stale name.
  const project = projectFilter && agents.some(a => a.projectPath === projectFilter) ? projectFilter : null;
  // And the pick is dropped, not only ignored: kept, it came back by itself the
  // moment a new agent was added to that project. Set during render, React's
  // way of adjusting state to what it was handed, so no frame shows the old pick.
  if (projectFilter && !project) setProjectFilter(null);

  const { filteredAgents, uniqueProjects } = useAgentFiltering({
    agents,
    projectFilter: project,
    statusFilter,
    searchQuery,
  });

  // Projects in the order of the Dashboard's tabs, so arranging them there
  // arranges this page too. Read only: the order is changed on the Dashboard.
  const projectPaths = useMemo(() => uniqueProjects.map(p => p.path), [uniqueProjects]);
  const { orderedPaths } = useProjectTabOrder(projectPaths);
  const groups = useMemo(() => groupByProject(filteredAgents, orderedPaths), [filteredAgents, orderedPaths]);

  // The status counts describe the project on screen, so a count is always
  // the number of cards its chip would show. The picker counts every agent of
  // each project, whatever the status filter says.
  const inProject = project ? agents.filter(a => a.projectPath === project) : agents;
  const projectOptions: DropdownOption[] = useMemo(() => {
    const labels = projectLabels(orderedPaths);
    return [
      { value: ALL_PROJECTS, label: 'All projects', hint: agentCount(agents.length) },
      ...orderedPaths.map(path => ({
        value: path,
        label: labels.get(path) ?? path,
        hint: agentCount(agents.filter(a => a.projectPath === path).length),
      })),
    ];
  }, [agents, orderedPaths]);

  // Build edit agent data from editAgentId
  const editAgentData: EditAgentData | null = useMemo(() => {
    if (!editAgentId) return null;
    const agent = agents.find(a => a.id === editAgentId);
    if (!agent) return null;
    return {
      id: agent.id,
      name: agent.name,
      character: agent.character,
      projectPath: agent.projectPath,
      secondaryProjectPath: agent.secondaryProjectPath,
      skills: agent.skills,
      permissionMode: agent.permissionMode ?? (agent.skipPermissions ? 'auto' : 'normal'),
      effort: agent.effort,
      provider: agent.provider,
      model: agent.model,
      localModel: agent.localModel,
      branchName: agent.branchName,
      obsidianVaultPaths: agent.obsidianVaultPaths,
      savedPrompt: agent.savedPrompt,
      role: agent.role,
      cliPath: agent.cliPath,
    };
  // Snapshot on open: depending on `agents` would rebuild this object on every
  // status tick and reset the edit form mid-typing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editAgentId]);

  // Handlers
  const handleCreateAgent = useCallback(async (
    projectPath: string,
    skills: string[],
    prompt: string,
    model?: string,
    worktree?: { enabled: boolean; branchName: string },
    character?: AgentCharacter,
    name?: string,
    secondaryProjectPath?: string,
    permissionMode?: 'normal' | 'auto' | 'bypass',
    provider?: AgentProvider,
    localModel?: string,
    obsidianVaultPaths?: string[],
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    role?: 'orchestrator' | 'worker',
    cliPath?: string,
  ) => {
    try {
      const resolvedModel = (provider !== 'local' && model && model !== 'default') ? model : undefined;
      const agent = await createAgent({ projectPath, skills, worktree, character, name, secondaryProjectPath, permissionMode, effort, provider, model: resolvedModel, localModel, obsidianVaultPaths, role, cliPath });
      if (prompt) {
        const options = { model: resolvedModel, provider, localModel };
        await startAgent(agent.id, prompt, options);
      }
      setShowNewChatModal(false);
    } catch (error) {
      console.error('Failed to create agent:', error);
      // Tells the modal not to wipe what the user typed - there is nothing to
      // resume into otherwise, since the failure never reaches the screen.
      return false;
    }
  }, [createAgent, startAgent]);

  const handleUpdateAgent = useCallback(async (id: string, updates: {
    projectPath?: string;
    skills?: string[];
    secondaryProjectPath?: string | null;
    permissionMode?: 'normal' | 'auto' | 'bypass';
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    name?: string;
    character?: AgentCharacter;
    model?: string | null;
    provider?: AgentProvider;
    localModel?: string | null;
    savedPrompt?: string | null;
    obsidianVaultPaths?: string[];
    worktree?: { enabled: boolean; branchName: string };
    role?: 'orchestrator' | 'worker';
    cliPath?: string | null;
  }) => {
    try {
      await updateAgent({ id, ...updates });
      setEditAgentId(null);
    } catch (error) {
      console.error('Failed to update agent:', error);
      return false;
    }
  }, [updateAgent]);

  // A card's `wake`: the agent's CLI started again on its own conversation
  // (#322). A refusal, or a launch that fails, leaves it asleep, and is logged.
  const handleWakeAgent = useCallback(async (id: string) => {
    try {
      const result = await wakeAgent(id);
      if (!result.success) console.error('Failed to wake agent:', result.error);
    } catch (error) {
      console.error('Failed to wake agent:', error);
    }
  }, [wakeAgent]);

  const handleStartAgent = useCallback(async (agentId: string, prompt?: string) => {
    await startAgent(agentId, prompt || '');
  }, [startAgent]);

  // The only place an agent can be permanently deleted from. It kills the PTY,
  // drops agents.json's only record of it, AND runs `git worktree remove
  // --force`, which throws away anything uncommitted in that checkout. So the
  // confirmation names the worktree and counts what is in it rather than saying
  // "cannot be undone" and leaving the one real consequence unmentioned.
  // Committed work survives: the branch is left behind, only the checkout goes.
  const handleRemoveAgent = useCallback(async (agentId: string) => {
    const agent = agents.find(a => a.id === agentId);
    const agentName = agent?.name || 'this agent';

    let worktreeNote = '';
    if (agent?.worktreePath && agent?.branchName) {
      let dirtyCount: number | null = null;
      try {
        const res = await window.electronAPI?.review?.repo(agent.worktreePath);
        if (res?.success && res.summary) dirtyCount = res.summary.status.length;
      } catch {
        // Best effort: a worktree we cannot read still gets the generic warning.
      }
      worktreeNote = dirtyCount
        ? `\n\nIts worktree ${agent.worktreePath} will be deleted, along with ${dirtyCount} uncommitted change${dirtyCount === 1 ? '' : 's'}. Commits on ${agent.branchName} are kept.`
        : `\n\nIts worktree ${agent.worktreePath} will be deleted. Commits on ${agent.branchName} are kept.`;
    }

    if (!window.confirm(`Delete "${agentName}"? This stops it and cannot be undone.${worktreeNote}`)) return;
    await removeAgent(agentId);
  }, [agents, removeAgent]);

  const handleSaveAsTemplate = useCallback(async (agentId: string) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;
    // window.prompt throws in Electron renderers; confirm() works. The name
    // can be edited afterwards in the Templates manager.
    const name = agent.name?.trim() || `Agent ${agent.id.slice(0, 4)}`;
    if (!window.confirm(`Save "${name}" as a template? (You can rename it in Templates.)`)) return;
    const result = await createTemplate({
      displayName: name.trim(),
      description: `Saved from agent "${agent.name ?? ''}"`.trim(),
      icon: '📦',
      character: agent.character,
      provider: agent.provider,
      model: agent.model,
      localModel: agent.localModel,
      permissionMode: agent.permissionMode ?? (agent.skipPermissions ? 'auto' : 'normal'),
      effort: agent.effort,
      skills: agent.skills,
      obsidianVaultPaths: agent.obsidianVaultPaths,
      savedPrompt: agent.savedPrompt,
    });
    if (!result.success) {
      alert(`Could not save template: ${result.error ?? 'unknown error'}`);
    }
  }, [agents, createTemplate]);

  // Early returns
  if (!hasElectron && typeof window !== 'undefined') {
    return <DesktopRequiredMessage />;
  }

  if (agentsLoading && agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <LoadingState loading what="Still loading your agents…" detail="reading ~/.dorothy/agents.json" />
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-44px)] flex flex-col">
      <AgentListHeader
        onNewAgentClick={() => { setNewChatMode('agent'); setShowNewChatModal(true); }}
        onDeployTeamClick={() => { setNewChatMode('team'); setShowNewChatModal(true); }}
        onManageTemplatesClick={() => setShowTemplatesDialog(true)}
      />

      {/* One filter row, every control 26px: the status chips on the left,
          counted within the project on screen, then the filter field and the
          project picker on the right. */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Chip active={!statusFilter} onClick={() => setStatusFilter(null)}>
          All ({inProject.length})
        </Chip>
        {STATUS_FILTERS.map((key) => {
          const count = inProject.filter(a => statusWord(a.status) === key).length;
          return (
            <Chip
              key={key}
              active={statusFilter === key}
              onClick={() => setStatusFilter(statusFilter === key ? null : key)}
              className="capitalize"
            >
              {key} ({count})
            </Chip>
          );
        })}

        <div className="ml-auto flex items-center gap-2">
          <input
            type="text"
            placeholder="filter by name or branch"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-[220px] h-[26px] px-2.5 text-sm border border-border bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
          />
          <Dropdown
            value={project ?? ALL_PROJECTS}
            options={projectOptions}
            onChange={(value) => setProjectFilter(value === ALL_PROJECTS ? null : value)}
            size="sm"
            align="right"
            searchable={projectOptions.length > 12}
            searchPlaceholder="filter projects"
            ariaLabel="Show the agents of one project"
            className="w-48"
          />
        </div>
      </div>

      {/* The grid, one section per project in the Dashboard's tab order: its
          name, its path and how many of its agents are shown, then its cards.
          Picking a project leaves its section alone on the page. */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {groups.length > 0 ? (
          <div className="flex flex-col gap-5 pb-4">
            {groups.map((group) => (
              <section key={group.path} className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2 min-w-0" title={group.path}>
                  <h2 className="shrink-0 text-[13px] leading-[1.4] font-medium text-foreground">{projectName(group.path)}</h2>
                  <span className="min-w-0 truncate font-mono text-[11px] text-text-muted">{tildePath(group.path)}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">{agentCount(group.agents.length)}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                  {group.agents.map((agent) => (
                    <AgentManagementCard
                      key={agent.id}
                      agent={agent}
                      onClick={() => setViewAgentId(agent.id)}
                      onEdit={() => setEditAgentId(agent.id)}
                      onStart={() => handleStartAgent(agent.id)}
                      onStop={() => stopAgent(agent.id)}
                      onWake={() => handleWakeAgent(agent.id)}
                      onDelete={() => handleRemoveAgent(agent.id)}
                      onSaveAsTemplate={() => handleSaveAsTemplate(agent.id)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20">
            <Bot className="w-12 h-12 text-muted-foreground/30 mb-4" />
            <p className="text-muted-foreground text-sm mb-2">
              {agents.length === 0 ? 'No agents yet' : 'No agents match your filters'}
            </p>
            {agents.length === 0 ? (
              <button
                onClick={() => setShowNewChatModal(true)}
                className="text-primary text-sm hover:underline cursor-pointer"
              >
                Create your first agent
              </button>
            ) : (
              <button
                onClick={() => { setStatusFilter(null); setSearchQuery(''); setProjectFilter(null); }}
                className="text-primary text-sm hover:underline cursor-pointer"
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>

      {/* Create Modal - opens on the agent or team half of the switch
          depending on which header button was clicked; also the whole of
          what used to be DeployTeamDialog, folded into the team half. */}
      <NewChatModal
        open={showNewChatModal}
        onClose={() => setShowNewChatModal(false)}
        onSubmit={handleCreateAgent}
        projects={projects.map(p => ({ path: p.path, name: p.name }))}
        onBrowseFolder={isElectron() ? openFolderDialog : undefined}
        installedSkills={installedSkills}
        allInstalledSkills={claudeData?.skills || []}
        onRefreshSkills={refreshSkills}
        onManageTemplates={() => setShowTemplatesDialog(true)}
        existingSuperAgent={superAgent}
        initialMode={newChatMode}
      />

      {/* Edit Modal - reuses NewChatModal pre-filled with agent data */}
      <NewChatModal
        open={!!editAgentId}
        onClose={() => setEditAgentId(null)}
        onSubmit={handleCreateAgent}
        onUpdate={handleUpdateAgent}
        editAgent={editAgentData}
        projects={projects.map(p => ({ path: p.path, name: p.name }))}
        onBrowseFolder={isElectron() ? openFolderDialog : undefined}
        installedSkills={installedSkills}
        allInstalledSkills={claudeData?.skills || []}
        onRefreshSkills={refreshSkills}
        initialStep={1}
      />

      {/* Templates manager - browse, edit, and instantiate agent templates */}
      <TemplatesManagerDialog
        open={showTemplatesDialog}
        onClose={() => setShowTemplatesDialog(false)}
      />

      {/* Terminal Dialog - click card body to view */}
      <AgentTerminalDialog
        agent={viewAgentId ? agents.find(a => a.id === viewAgentId) || null : null}
        open={!!viewAgentId}
        onClose={() => setViewAgentId(null)}
        onStart={(id, prompt) => handleStartAgent(id, prompt)}
        onStop={stopAgent}
        projects={projects.map(p => ({ path: p.path, name: p.name }))}
        agents={agents}
        onBrowseFolder={isElectron() ? openFolderDialog : undefined}
      />
    </div>
  );
}
