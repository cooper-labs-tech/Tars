'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { lastPathPart } from '@/lib/display-path';

import type { NewChatModalProps } from './types';
import type { AgentCharacter, AgentProvider, TeamTemplateMember } from '@/types/electron';
import type { AgentPermissionMode, TeamPermissionMode } from '@/types/agent';
import { computeProviderAvailability } from '@/lib/providers';
import { useElectronAgents } from '@/hooks/useElectron';
import { useElectronTeamTemplates } from '@/hooks/useElectronTeamTemplates';
import { useSkillInstall } from './hooks/useSkillInstall';
import { Button, DialogShell, SegmentedControl } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';
import { AgentPanel } from './AgentPanel';
import { TeamPanel } from './TeamPanel';
import SkillInstallTerminal from './SkillInstallTerminal';
import { blankMember } from './team-defaults';
import { canSubmitAgent, canSubmitTeam, deployButtonLabel, deployedMemberName, ownWorktreeOf, worktreeToSave } from './logic';
import type { CreationMode } from './types';
import { ReplaceOrchestratorDialog } from './ReplaceOrchestratorDialog';
import type { PendingReplace } from './ReplaceOrchestratorDialog';
import { modeForProvider } from '@/lib/plan-mode';

const MODE_OPTIONS: SegmentedOption<CreationMode>[] = [
  { value: 'agent', label: 'One agent' },
  { value: 'team', label: 'A team' },
];

/**
 * What an agent is called when the NAME field is left empty. One source for
 * both the field's placeholder and the name actually saved, so the two can
 * never drift apart. It was the character's word (`Robot on tars`) while there
 * was a character to show; the mark beside the field is drawn from this name.
 */
function generatedAgentName(projectPath: string): string {
  const projectName = lastPathPart(projectPath) || 'project';
  return `Agent on ${projectName}`;
}

/**
 * New agent / new team, one modal.
 *
 * The old wizard spent four steps - Project, Model, Tools, Task - getting a
 * folder, a CLI, and a sentence out of the user, which made the common case
 * cost as much as the rare one. This is that same information on one screen,
 * with everything else (skills, effort, permissions, worktree, orchestrator,
 * CLI override) folded into a single Options row that reads out its own
 * contents. A team is the same screen with the header switch flipped: the
 * member table replaces the single set of tiles, and deploying one agent per
 * row replaces the three dialogs (`DeployTeamDialog` plus its inline
 * save/edit/delete team affairs) that used to be the only way to do it.
 */
export default function NewChatModal({
  open,
  onClose,
  onSubmit,
  onUpdate,
  onTeamDeployed,
  editAgent,
  projects,
  onBrowseFolder,
  // `installedSkills` is still accepted (all three call sites pass it) but
  // unused: the picker now reads `allInstalledSkills` plus the per-provider
  // map fetched below, same as before this rewrite.
  allInstalledSkills = [],
  onRefreshSkills,
  initialProjectPath,
  initialOrchestrator,
  initialMode,
  // `initialStep`, `onManageTemplates` and `existingSuperAgent` are still
  // accepted by the props type but no longer read - see types.ts for why each
  // one lost its home in the one-screen redesign.
}: NewChatModalProps) {
  const isEditMode = !!editAgent;
  const [mode, setMode] = useState<CreationMode>(initialMode || 'agent');

  /* ── shared: project, availability ───────────────────────────────── */
  const [projectPath, setProjectPath] = useState<string>(initialProjectPath || '');
  const [favoriteProjects, setFavoriteProjects] = useState<string[]>([]);
  const [hiddenProjects, setHiddenProjects] = useState<string[]>([]);
  const [defaultProjectPath, setDefaultProjectPath] = useState<string>('');
  const [installedProviders, setInstalledProviders] = useState<Record<string, boolean>>({ claude: true, codex: true, gemini: true, grok: true });

  /* ── agent mode ───────────────────────────────────────────────────── */
  const [provider, setProvider] = useState<AgentProvider>('claude');
  const [model, setModel] = useState<string>('default');
  const [cliPath, setCliPath] = useState('');
  // Kept in the agent's data and carried through an edit, but drawn nowhere:
  // an agent is shown by the mark its name draws.
  const [character, setCharacter] = useState<AgentCharacter>('robot');
  // Edited through the NAME field the frame draws at the top of the panel.
  // Left empty it falls back to the generated `Agent on <project>` below,
  // which is also what the field shows as its placeholder.
  const [agentName, setAgentName] = useState('');
  const skipNextSkillsClear = useRef(false);

  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [installedSkillsByProvider, setInstalledSkillsByProvider] = useState<Record<string, string[]>>({});

  const [prompt, setPrompt] = useState('');
  const [useWorktree, setUseWorktree] = useState(false);
  const [branchName, setBranchName] = useState('');
  // Why the main process refused the last save of an agent's settings; the dialog stays open with the changes.
  const [saveRefusal, setSaveRefusal] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>('normal');
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'xhigh' | 'max'>('medium');
  const [isOrchestrator, setIsOrchestrator] = useState(false);
  const [agentOptionsOpen, setAgentOptionsOpen] = useState(false);
  // A save that gives the orchestrator role to an agent while another agent of
  // the same project holds it is asked first (ReplaceOrchestratorDialog), and
  // the answer goes ahead with the save it interrupted.
  const [pendingReplace, setPendingReplace] = useState<PendingReplace | null>(null);

  const handleRefreshSkills = useCallback(() => {
    onRefreshSkills?.();
    window.electronAPI?.skill?.listInstalledAll().then((byProvider) => {
      if (byProvider) setInstalledSkillsByProvider(byProvider);
    });
  }, [onRefreshSkills]);
  const skillInstall = useSkillInstall(handleRefreshSkills);

  // The skills this agent can actually reach: what the provider has on disk,
  // plus anything already selected (edit mode can carry a skill the provider
  // no longer reports).
  const availableSkills = useMemo(() => {
    const byName = new Map<string, string>();
    for (const name of installedSkillsByProvider[provider] ?? []) byName.set(name.toLowerCase(), name);
    for (const s of allInstalledSkills) if (!byName.has(s.name.toLowerCase())) byName.set(s.name.toLowerCase(), s.name);
    for (const name of selectedSkills) if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), name);
    return [...byName.values()].sort((a, b) => a.localeCompare(b));
  }, [installedSkillsByProvider, provider, allInstalledSkills, selectedSkills]);

  // The one-line description under each skill's name in the picker - lost if
  // this isn't carried alongside the bare name list above, since
  // `installedSkillsByProvider` only ever reports names.
  const skillDescriptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of allInstalledSkills) if (s.description) map.set(s.name.toLowerCase(), s.description);
    return map;
  }, [allInstalledSkills]);

  /* ── team mode ────────────────────────────────────────────────────── */
  const { agents: existingAgents, createAgent, updateAgent, startAgent } = useElectronAgents();
  const { teams } = useElectronTeamTemplates();
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [editedMembers, setEditedMembers] = useState<TeamTemplateMember[]>([]);
  const [selectedMemberIdx, setSelectedMemberIdx] = useState<Set<number>>(new Set());
  const [teamBrief, setTeamBrief] = useState('');
  const [teamOptionsOpen, setTeamOptionsOpen] = useState(false);
  const [teamPermissionOverride, setTeamPermissionOverride] = useState<TeamPermissionMode>('auto');
  const [startOnDeploy, setStartOnDeploy] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [deployErrors, setDeployErrors] = useState<string[]>([]);

  // Loading a preset replaces the working roster with a fresh copy of its
  // members - editing them here never writes back to the saved team.
  const loadTeam = useCallback((id: string) => {
    setSelectedTeamId(id);
    const team = teams.find(t => t.id === id);
    const members = team ? team.members.map(m => ({ ...m })) : [];
    setEditedMembers(members);
    setSelectedMemberIdx(new Set(members.map((_, i) => i)));
    setTeamPermissionOverride(members[0]?.permissionMode ?? 'auto');
  }, [teams]);

  // The team half opens with a roster already in view rather than an empty
  // table waiting for a pick - one team exists on every install (the built-in
  // full project team), so there is always something to default to.
  useEffect(() => {
    if (mode === 'team' && !selectedTeamId && teams.length > 0) loadTeam(teams[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, teams]);

  const patchMember = useCallback((i: number, patch: Partial<TeamTemplateMember>) => {
    setEditedMembers(prev => prev.map((m, idx) => idx === i ? { ...m, ...patch } : m));
  }, []);
  const toggleMemberSelected = useCallback((i: number) => {
    setSelectedMemberIdx(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }, []);
  const removeMember = useCallback((i: number) => {
    setEditedMembers(prev => prev.filter((_, idx) => idx !== i));
    setSelectedMemberIdx(prev => new Set(Array.from(prev).filter(x => x !== i).map(x => (x > i ? x - 1 : x))));
  }, []);
  const addMember = useCallback(() => {
    setEditedMembers(prev => {
      const next = [...prev, blankMember(prev.length)];
      setSelectedMemberIdx(sel => new Set([...sel, next.length - 1]));
      return next;
    });
  }, []);
  const applyPermissionOverride = useCallback((mode: TeamPermissionMode) => {
    setTeamPermissionOverride(mode);
    setEditedMembers(prev => prev.map(m => ({ ...m, permissionMode: mode })));
  }, []);

  /* ── reset / prepopulate on open ─────────────────────────────────── */
  useEffect(() => {
    if (!open) return;
    // Same guard as the model catalogue's in ProviderAndModel: the answers
    // below are asynchronous, and one belonging to a previous opening must not
    // land in this one.
    let cancelled = false;
    setMode(isEditMode ? 'agent' : (initialMode || 'agent'));
    setSaveRefusal(null);

    if (editAgent) {
      setProjectPath(editAgent.projectPath);
      setSelectedSkills(editAgent.skills || []);
      setPrompt(editAgent.savedPrompt || '');
      setModel(editAgent.model || 'default');
      // Its own worktree, from worktreePath: branchName is the branch its folder is on.
      const own = ownWorktreeOf(editAgent);
      setUseWorktree(own.on);
      setBranchName(own.branchName);
      setCharacter(editAgent.character || 'robot');
      setAgentName(editAgent.name || '');
      setPermissionMode(editAgent.permissionMode ?? (editAgent.skipPermissions ? 'auto' : 'normal'));
      setEffort(editAgent.effort || 'medium');
      if ((editAgent.provider || 'claude') !== provider) skipNextSkillsClear.current = true;
      setProvider(editAgent.provider || 'claude');
      setIsOrchestrator(editAgent.role === 'orchestrator');
      setCliPath(editAgent.cliPath || '');
    } else {
      setProjectPath(initialProjectPath || '');
      setSelectedSkills([]);
      setPrompt('');
      setUseWorktree(false);
      setBranchName('');
      setPermissionMode('normal');
      setEffort('medium');
      setProvider('claude');
      setModel('default');
      setCliPath('');

      if (initialOrchestrator) {
        setCharacter('wizard');
        setAgentName('Super Agent (Orchestrator)');
        setPermissionMode('bypass');
        setIsOrchestrator(true);
      } else {
        setCharacter('robot');
        setAgentName('');
        setIsOrchestrator(false);
      }
    }
    setAgentOptionsOpen(false);
    setTeamOptionsOpen(false);
    setDeployErrors([]);
    setPendingReplace(null);

    window.electronAPI?.appSettings?.get().then((settings) => {
      if (cancelled) return;
      if (Array.isArray(settings?.favoriteProjects)) setFavoriteProjects(settings.favoriteProjects);
      if (Array.isArray(settings?.hiddenProjects)) setHiddenProjects(settings.hiddenProjects);
      if (settings?.defaultProjectPath) {
        const fallback = settings.defaultProjectPath;
        setDefaultProjectPath(fallback);
        // Only fills a field still empty. The main process is usually busy, so
        // this answer often arrives after the user has already picked a folder,
        // and writing it unconditionally put the whole team back to work in the
        // pre-selected project instead of the chosen one.
        if (!initialProjectPath && !editAgent) setProjectPath(prev => prev || fallback);
      }
    });

    Promise.all([
      window.electronAPI?.cliPaths?.detect(),
      window.electronAPI?.appSettings?.get(),
      window.electronAPI?.ollama?.test(),
    ]).then(([paths, settings, ollama]) => {
      if (cancelled) return;
      setInstalledProviders(computeProviderAvailability(
        paths as Record<string, string | undefined> | undefined,
        settings,
        ollama?.reachable,
      ));
    });

    window.electronAPI?.skill?.listInstalledAll().then((byProvider) => {
      if (cancelled) return;
      if (byProvider) setInstalledSkillsByProvider(byProvider);
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialProjectPath, editAgent, initialOrchestrator, initialMode]);

  // Clear selected skills when the USER changes provider - not when edit-mode
  // prepopulation does (that would wipe the agent's saved skills on open).
  const previousProvider = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousProvider.current;
    previousProvider.current = provider;
    if (previous === null) return;
    if (skipNextSkillsClear.current) { skipNextSkillsClear.current = false; return; }
    setSelectedSkills([]);
  }, [provider]);

  const toggleSkill = useCallback((skillName: string) => {
    setSelectedSkills((prev) => prev.includes(skillName) ? prev.filter((s) => s !== skillName) : [...prev, skillName]);
  }, []);

  /* ── one orchestrator per project ────────────────────────────────── */
  // The other orchestrator of the project an agent is saved into, read from the
  // main process at the moment of saving rather than from this dialog's copy of
  // the fleet: a role can change hands elsewhere, and nothing pushes it here.
  const currentOrchestrator = useCallback(async (inProject: string, selfId?: string) => {
    const fleet = (await window.electronAPI?.agent?.list()) ?? existingAgents;
    return fleet.find(a => a.projectPath === inProject && a.role === 'orchestrator' && a.id !== selfId) ?? null;
  }, [existingAgents]);

  /* ── submit: one agent ───────────────────────────────────────────── */
  const [isSubmitting, setIsSubmitting] = useState(false);
  const commitAgent = useCallback(async () => {
    const agentCharacter = character;
    const finalName = agentName.trim() || generatedAgentName(projectPath);

    setIsSubmitting(true);
    try {
      if (isEditMode && editAgent && onUpdate) {
        const worktreeConfig = worktreeToSave({ useWorktree, branchName }, editAgent);
        setSaveRefusal(null);
        const result = await onUpdate(editAgent.id, {
          projectPath,
          skills: selectedSkills,
          permissionMode,
          effort: effort || undefined,
          name: finalName,
          character: agentCharacter,
          model: (model && model !== 'default') ? model : null,
          provider,
          savedPrompt: prompt.trim() || null,
          worktree: worktreeConfig,
          role: isOrchestrator ? 'orchestrator' : 'worker',
          cliPath: cliPath || null,
        });
        if (result === false) return;
        if (result && typeof result === 'object' && 'error' in result) {
          setSaveRefusal(result.error);
          return;
        }
        onClose();
        return;
      }

      const finalPrompt = prompt.trim()
        || (selectedSkills.length > 0 ? `Use the following skills: ${selectedSkills.join(', ')}` : '');
      const worktreeConfig = useWorktree ? { enabled: true, branchName: branchName.trim() } : undefined;

      const result = await onSubmit(projectPath, selectedSkills, finalPrompt, model, worktreeConfig, agentCharacter, finalName, undefined, permissionMode, provider, undefined, undefined, effort, isOrchestrator ? 'orchestrator' : 'worker', cliPath || undefined);
      if (result === false) return;

      setProjectPath('');
      setSelectedSkills([]);
      setPrompt('');
      setUseWorktree(false);
      setBranchName('');
      setCharacter('robot');
      setAgentName('');
      setPermissionMode('normal');
      setEffort('medium');
      setProvider('claude');
      setModel('default');
      setCliPath('');
      setAgentOptionsOpen(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [projectPath, prompt, selectedSkills, useWorktree, branchName, model, permissionMode, effort, provider, cliPath, agentName, character, onSubmit, isEditMode, editAgent, onUpdate, onClose, isOrchestrator]);

  // Switching the toggle on, creating with it on and moving an orchestrator into
  // another project all end here: the project is the one the dialog now names.
  const handleSubmitAgent = useCallback(async () => {
    if (!canSubmitAgent({ projectPath, useWorktree, branchName })) return;
    if (isOrchestrator) {
      // Busy while it looks, as it is while it saves: a second click in
      // between would otherwise save twice.
      setIsSubmitting(true);
      let holder: Awaited<ReturnType<typeof currentOrchestrator>>;
      try {
        holder = await currentOrchestrator(projectPath, editAgent?.id);
      } finally {
        setIsSubmitting(false);
      }
      if (holder) {
        setPendingReplace({
          kind: isEditMode ? 'edit' : 'create',
          holder: holder.name || holder.id,
          newcomer: agentName.trim() || generatedAgentName(projectPath),
          project: lastPathPart(projectPath) || projectPath,
        });
        return;
      }
    }
    await commitAgent();
  }, [projectPath, useWorktree, branchName, isOrchestrator, currentOrchestrator, editAgent, isEditMode, agentName, commitAgent]);

  /* ── submit: a team ──────────────────────────────────────────────── */
  const selectedMembers = useMemo(
    () => editedMembers.filter((_, i) => selectedMemberIdx.has(i)),
    [editedMembers, selectedMemberIdx],
  );

  const commitTeam = useCallback(async () => {
    setDeploying(true);
    setDeployErrors([]);
    const existingNames = new Set(existingAgents.filter(a => a.projectPath === projectPath).map(a => a.name));
    const createdIds: string[] = [];
    const issues: string[] = [];

    for (const member of selectedMembers) {
      const agentDisplayName = deployedMemberName(member.name, projectPath);
      if (existingNames.has(agentDisplayName)) {
        issues.push(`${member.name}: already deployed on this project - skipped.`);
        continue;
      }
      try {
        const resolvedModel = member.provider !== 'local' && member.model && member.model !== 'default' ? member.model : undefined;
        const agent = await createAgent({
          projectPath,
          skills: member.skills,
          character: member.character,
          name: agentDisplayName,
          permissionMode: member.permissionMode,
          effort: member.effort,
          provider: member.provider,
          model: resolvedModel,
          localModel: member.localModel,
          worktree: member.worktreeBranch ? { enabled: true, branchName: member.worktreeBranch } : undefined,
          role: member.role,
        });
        createdIds.push(agent.id);
        if (member.worktreeBranch && !agent.branchName) {
          issues.push(`${member.name}: worktree "${member.worktreeBranch}" could not be created - agent works in the project root.`);
        }
        const combinedBrief = [teamBrief.trim(), member.savedPrompt?.trim()].filter(Boolean).join('\n\n');
        if (startOnDeploy && combinedBrief) {
          await startAgent(agent.id, combinedBrief, { model: resolvedModel, provider: member.provider, localModel: member.localModel });
        } else if (combinedBrief) {
          await updateAgent({ id: agent.id, savedPrompt: combinedBrief });
        }
      } catch (err) {
        console.error(`Failed to create team member "${member.name}":`, err);
        issues.push(`${member.name}: ${err instanceof Error ? err.message : 'creation failed'}`);
      }
    }

    setDeploying(false);
    if (issues.length > 0) setDeployErrors(issues);
    if (createdIds.length > 0) onTeamDeployed?.(createdIds);
    if (issues.length === 0) onClose();
  }, [projectPath, selectedMembers, existingAgents, createAgent, updateAgent, startAgent, teamBrief, startOnDeploy, onTeamDeployed, onClose]);

  // A team with an orchestrator member, deployed into a project that already
  // has one, takes the role from it. Not when that member is the orchestrator
  // already there: the deploy skips a member deployed before, so nothing
  // changes hands.
  const handleDeployTeam = useCallback(async () => {
    if (!canSubmitTeam({ projectPath, selectedCount: selectedMembers.length })) return;
    const lead = selectedMembers.find(m => m.role === 'orchestrator');
    if (lead) {
      const projectName = lastPathPart(projectPath) || 'project';
      const leadName = deployedMemberName(lead.name, projectPath);
      setDeploying(true);
      let holder: Awaited<ReturnType<typeof currentOrchestrator>>;
      try {
        holder = await currentOrchestrator(projectPath);
      } finally {
        setDeploying(false);
      }
      if (holder && holder.name !== leadName) {
        setPendingReplace({ kind: 'team', holder: holder.name || holder.id, newcomer: leadName, project: projectName });
        return;
      }
    }
    await commitTeam();
  }, [projectPath, selectedMembers, currentOrchestrator, commitTeam]);

  const confirmReplace = useCallback(async () => {
    const pending = pendingReplace;
    setPendingReplace(null);
    if (!pending) return;
    if (pending.kind === 'team') await commitTeam();
    else await commitAgent();
  }, [pendingReplace, commitTeam, commitAgent]);

  const canStartAgent = canSubmitAgent({ projectPath, useWorktree, branchName });
  const canDeployTeam = canSubmitTeam({ projectPath, selectedCount: selectedMembers.length }) && !deploying;

  if (!open) return null;

  const width = mode === 'team' ? 920 : 760;

  return (
    <>
      <DialogShell
        // Both dialogs close on Escape through the window. While the question
        // is open, Escape answers it and leaves this one as it was.
        onClose={pendingReplace ? () => setPendingReplace(null) : onClose}
        width={width}
        title={isEditMode ? 'Edit agent' : mode === 'team' ? 'New team' : 'New agent'}
        subtitle={isEditMode
          ? 'Everything about this agent, on one screen.'
          : mode === 'team'
            ? 'Several agents on one project, each on its own branch.'
            : 'A folder, a CLI, and what you want done.'}
        headerRight={!isEditMode && (
          <SegmentedControl size="md" ariaLabel="Creation mode" options={MODE_OPTIONS} value={mode} onChange={setMode} />
        )}
        className="[&_button:not(:disabled)]:cursor-pointer"
        footerLeft={
          isEditMode
            ? saveRefusal && (
              <p role="alert" className="text-xs text-status-error">
                Not saved: {saveRefusal.trim().replace(/[.\s]+$/, '')}. Your changes are still here.
              </p>
            )
            : mode === 'team'
              ? <span className="text-xs text-muted-foreground">Five worktrees are created under the project. Nothing is pushed.</span>
              : <span className="text-xs text-muted-foreground">It starts as soon as you create it.</span>
        }
        footerRight={
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            {mode === 'team' && !isEditMode ? (
              <Button variant="primary" onClick={handleDeployTeam} disabled={!canDeployTeam}>
                {deploying ? 'Deploying…' : deployButtonLabel(selectedMembers.length)}
              </Button>
            ) : (
              <Button variant="primary" onClick={handleSubmitAgent} disabled={!canStartAgent || isSubmitting}>
                {isSubmitting ? 'Working...' : isEditMode ? 'Save changes' : 'Create and start'}
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-5">
          {deployErrors.length > 0 && (
            <div className="border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs text-danger space-y-0.5">
              {deployErrors.map((e, i) => <p key={i}>{e}</p>)}
            </div>
          )}

          {mode === 'agent' || isEditMode ? (
            <AgentPanel
              name={agentName}
              onNameChange={setAgentName}
              namePlaceholder={generatedAgentName(projectPath)}
              projects={projects}
              projectPath={projectPath}
              onSelectProject={setProjectPath}
              onBrowseFolder={onBrowseFolder}
              favoriteProjects={favoriteProjects}
              hiddenProjects={hiddenProjects}
              defaultProjectPath={defaultProjectPath}
              provider={provider}
              onProviderChange={(next) => {
                setProvider(next);
                // Plan runs on Claude Code only: another CLI keeps manual (frame: Permissions · plan mode · states).
                setPermissionMode(mode => modeForProvider(mode, next));
              }}
              model={model}
              onModelChange={setModel}
              installedProviders={installedProviders}
              prompt={prompt}
              onPromptChange={setPrompt}
              optionsOpen={agentOptionsOpen}
              onToggleOptions={() => setAgentOptionsOpen(v => !v)}
              skills={availableSkills}
              skillDescriptions={skillDescriptions}
              selectedSkills={selectedSkills}
              onToggleSkill={toggleSkill}
              effort={effort}
              onEffortChange={setEffort}
              permissionMode={permissionMode}
              onPermissionModeChange={setPermissionMode}
              useWorktree={useWorktree}
              onToggleWorktree={() => setUseWorktree(v => !v)}
              worktreeLocked={isEditMode && ownWorktreeOf(editAgent ?? {}).locked}
              branchName={branchName}
              onBranchNameChange={setBranchName}
              isOrchestrator={isOrchestrator}
              onOrchestratorToggle={setIsOrchestrator}
              editing={isEditMode}
              cliPath={cliPath}
              onCliPathChange={setCliPath}
            />
          ) : (
            <TeamPanel
              projects={projects}
              projectPath={projectPath}
              onSelectProject={setProjectPath}
              teams={teams}
              selectedTeamId={selectedTeamId}
              onSelectTeam={loadTeam}
              members={editedMembers}
              selected={selectedMemberIdx}
              onToggleSelect={toggleMemberSelected}
              onPatchMember={patchMember}
              onRemoveMember={removeMember}
              onAddMember={addMember}
              availability={installedProviders}
              brief={teamBrief}
              onBriefChange={setTeamBrief}
              optionsOpen={teamOptionsOpen}
              onToggleOptions={() => setTeamOptionsOpen(v => !v)}
              permissionOverride={teamPermissionOverride}
              onPermissionOverride={applyPermissionOverride}
              startOnDeploy={startOnDeploy}
              onToggleStartOnDeploy={() => setStartOnDeploy(v => !v)}
            />
          )}
        </div>
      </DialogShell>

      {pendingReplace && (
        <ReplaceOrchestratorDialog
          pending={pendingReplace}
          onCancel={() => setPendingReplace(null)}
          onReplace={confirmReplace}
        />
      )}

      {/* Skill installation terminal - its own overlay, lifted above the
          dialog's z-70 the same way the old wizard did. */}
      <div className="relative z-[80]">
        <SkillInstallTerminal
          show={skillInstall.showInstallTerminal}
          installingSkill={skillInstall.installingSkill}
          installComplete={skillInstall.installComplete}
          installExitCode={skillInstall.installExitCode}
          terminalRef={skillInstall.terminalRef}
          onClose={skillInstall.closeInstallTerminal}
        />
      </div>
    </>
  );
}
