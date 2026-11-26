'use client';

import { useMemo, useState } from 'react';
import { tildePath } from '@/lib/display-path';
import type { AgentEffort, AgentPermissionMode } from '@/types/agent';
import type { AgentProvider } from '@/types/electron';
import { AgentMark, Button, Dropdown, Input, PanelCaption, Textarea } from '@/components/ui';
import { ProviderAndModel } from './ProviderAndModel';
import { OptionsRow } from './OptionsRow';
import { AgentOptionsBody } from './AgentOptionsBody';
import { agentOptionsSummary } from './logic';
import type { Project } from './types';


export function AgentPanel(props: {
  name: string;
  onNameChange: (name: string) => void;
  /** The auto-generated name an untouched field falls back to, shown as its placeholder. */
  namePlaceholder: string;

  projects: Project[];
  projectPath: string;
  onSelectProject: (path: string) => void;
  onBrowseFolder?: () => Promise<string | null>;
  favoriteProjects: string[];
  hiddenProjects: string[];
  defaultProjectPath: string;

  provider: AgentProvider;
  onProviderChange: (p: AgentProvider) => void;
  model: string;
  onModelChange: (m: string) => void;
  installedProviders: Record<string, boolean>;

  prompt: string;
  onPromptChange: (p: string) => void;

  optionsOpen: boolean;
  onToggleOptions: () => void;
  skills: string[];
  skillDescriptions: Map<string, string>;
  selectedSkills: string[];
  onToggleSkill: (name: string) => void;
  effort: AgentEffort;
  onEffortChange: (e: AgentEffort) => void;
  permissionMode: AgentPermissionMode;
  onPermissionModeChange: (m: AgentPermissionMode) => void;
  useWorktree: boolean;
  onToggleWorktree: () => void;
  worktreeLocked?: boolean;
  branchName: string;
  onBranchNameChange: (b: string) => void;
  isOrchestrator: boolean;
  onOrchestratorToggle: (v: boolean) => void;
  /** Editing an agent that exists, which a save restarts to apply the role. */
  editing?: boolean;
  cliPath: string;
  onCliPathChange: (p: string) => void;
}) {
  /** Main's refusal of the folder chosen here, word for word (frame `Projects · a project the rule refuses · states`). */
  const [addRefused, setAddRefused] = useState<string | null>(null);
  const orderedProjects = useMemo(() => {
    const rank = (p: Project) =>
      props.defaultProjectPath === p.path ? 0 : props.favoriteProjects.includes(p.path) ? 1 : 2;
    const list = props.hiddenProjects.length > 0
      ? props.projects.filter((p) => !props.hiddenProjects.includes(p.path))
      : props.projects;
    return [...list].sort((a, b) => rank(a) - rank(b));
  }, [props.projects, props.favoriteProjects, props.hiddenProjects, props.defaultProjectPath]);

  const currentIsListed = orderedProjects.some((p) => p.path === props.projectPath);

  const summary = agentOptionsSummary({
    skillsCount: props.selectedSkills.length,
    effort: props.effort,
    useWorktree: props.useWorktree,
    permissionMode: props.permissionMode,
  });

  return (
    <div className="space-y-5">
      {/* NAME, the frame's first field, above the project row. Editing an agent
          used to have nowhere to change its name: the state was prefilled and
          round-tripped straight back out, so an agent kept whatever it was
          called at creation for ever. Left empty it still falls back to the
          generated name, which is what the placeholder shows. The mark beside
          it is the one the name will draw everywhere else, redrawn as you
          type, and orange once the Orchestrator row below is on. */}
      <div>
        <PanelCaption className="mb-1.5">Name</PanelCaption>
        <div className="flex items-center gap-2.5">
          <AgentMark name={props.name.trim() || props.namePlaceholder} orchestrator={props.isOrchestrator} size={24} />
          <Input
            aria-label="Agent name"
            value={props.name}
            onChange={(e) => props.onNameChange(e.target.value)}
            placeholder={props.namePlaceholder}
          />
        </div>
      </div>

      {/* PROJECT beside OR / Choose a folder - the two ways to point an agent
          somewhere, side by side rather than a field with a button glued on. */}
      <div className="flex items-end gap-3">
        <div className="flex-1 min-w-0">
          <PanelCaption className="mb-1.5">Project</PanelCaption>
          <Dropdown
            mono
            ariaLabel="Project"
            placeholder="Select a project"
            searchable={orderedProjects.length > 12}
            searchPlaceholder={`filter ${orderedProjects.length} projects`}
            value={props.projectPath}
            options={[
              ...(props.projectPath && !currentIsListed
                ? [{ value: props.projectPath, label: tildePath(props.projectPath) }]
                : []),
              // A project the window's project rule refuses: listed, not to be chosen, main's reason as its title.
              ...orderedProjects.map((p) => (p.refused
                ? { value: p.path, label: tildePath(p.path), hint: 'refused', hintClassName: 'text-status-error', disabled: true }
                : { value: p.path, label: tildePath(p.path) })),
            ]}
            onChange={(path) => { setAddRefused(null); props.onSelectProject(path); }}
          />
        </div>
        {props.onBrowseFolder && (
          <div className="shrink-0">
            <PanelCaption className="mb-1.5">Or</PanelCaption>
            <Button
              variant="secondary"
              onClick={async () => {
                const picked = await props.onBrowseFolder!();
                if (!picked) return;
                const normalized = picked.replace(/\/+$/, '');
                // A folder the window's project rule refuses is not taken: main's reason shows under the row. A call
                // that fails otherwise leaves the pick for this run, as before.
                const answer = await window.electronAPI?.fs?.addCustomProject(normalized).catch(() => null);
                if (answer && !answer.success) {
                  setAddRefused(answer.error || 'The folder was not added.');
                  return;
                }
                setAddRefused(null);
                props.onSelectProject(normalized);
              }}
            >
              Choose a folder…
            </Button>
          </div>
        )}
      </div>
      {addRefused && <p data-project-add-refused className="-mt-1 text-[11px] leading-snug text-danger">{`not added: ${addRefused}`}</p>}

      <ProviderAndModel
        provider={props.provider}
        onProviderChange={props.onProviderChange}
        model={props.model}
        onModelChange={props.onModelChange}
        installedProviders={props.installedProviders}
      />

      {/* THE TASK - the hero. Everything above it exists to be set once and
          forgotten; this is the field you land on. */}
      <div>
        <PanelCaption className="mb-1.5">The task</PanelCaption>
        <Textarea
          value={props.prompt}
          onChange={(e) => props.onPromptChange(e.target.value)}
          placeholder="Describe what you want done."
          className="h-[116px]"
        />
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Leave it empty to start the CLI and type into it yourself.
        </p>
      </div>

      <OptionsRow open={props.optionsOpen} onToggle={props.onToggleOptions} summary={summary}>
        <AgentOptionsBody
          provider={props.provider}
          skills={props.skills}
          skillDescriptions={props.skillDescriptions}
          selectedSkills={props.selectedSkills}
          onToggleSkill={props.onToggleSkill}
          effort={props.effort}
          onEffortChange={props.onEffortChange}
          permissionMode={props.permissionMode}
          onPermissionModeChange={props.onPermissionModeChange}
          useWorktree={props.useWorktree}
          onToggleWorktree={props.onToggleWorktree}
          worktreeLocked={props.worktreeLocked}
          branchName={props.branchName}
          onBranchNameChange={props.onBranchNameChange}
          isOrchestrator={props.isOrchestrator}
          onOrchestratorToggle={props.onOrchestratorToggle}
          editing={props.editing}
          cliPath={props.cliPath}
          onCliPathChange={props.onCliPathChange}
        />
      </OptionsRow>
    </div>
  );
}
