'use client';

import type { TeamPermissionMode } from '@/types/agent';
import { tildePath } from '@/lib/display-path';
import type { TeamTemplate, TeamTemplateMember } from '@/types/electron';
import { Button, Dropdown, PanelCaption, Textarea } from '@/components/ui';
import { MembersTable } from './MembersTable';
import { OptionsRow } from './OptionsRow';
import { TeamOptionsBody } from './TeamOptionsBody';
import { teamSelectionSummary, worktreeCount } from './logic';
import type { Project } from './types';


export function TeamPanel(props: {
  projects: Project[];
  projectPath: string;
  onSelectProject: (path: string) => void;

  teams: TeamTemplate[];
  selectedTeamId: string | null;
  onSelectTeam: (id: string) => void;

  members: TeamTemplateMember[];
  selected: Set<number>;
  onToggleSelect: (i: number) => void;
  onPatchMember: (i: number, patch: Partial<TeamTemplateMember>) => void;
  onRemoveMember: (i: number) => void;
  onAddMember: () => void;
  availability: Record<string, boolean>;

  brief: string;
  onBriefChange: (b: string) => void;

  optionsOpen: boolean;
  onToggleOptions: () => void;
  permissionOverride: TeamPermissionMode;
  onPermissionOverride: (m: TeamPermissionMode) => void;
  startOnDeploy: boolean;
  onToggleStartOnDeploy: () => void;
}) {
  const selectedCount = props.selected.size;
  // A folder picked outside the known list - or one the settings still name as
  // the default - is not in `projects`, and without an entry of its own the
  // dropdown showed an empty "Select a project" over a path that was really set.
  const currentIsListed = props.projects.some((p) => p.path === props.projectPath);
  const worktrees = worktreeCount(props.members.filter((_, i) => props.selected.has(i)));
  const summary = `skills per role · ${props.permissionOverride} permissions · ${props.startOnDeploy ? 'start on deploy' : 'created idle'}`;

  return (
    <div className="space-y-5">
      <div className="flex items-end gap-3">
        <div className="flex-1 min-w-0">
          <PanelCaption className="mb-1.5">Project</PanelCaption>
          <Dropdown
            mono
            ariaLabel="Project"
            placeholder="Select a project"
            searchable={props.projects.length > 12}
            value={props.projectPath}
            options={[
              ...(props.projectPath && !currentIsListed
                ? [{ value: props.projectPath, label: tildePath(props.projectPath) }]
                : []),
              ...props.projects.map((p) => ({ value: p.path, label: tildePath(p.path) })),
            ]}
            onChange={props.onSelectProject}
          />
        </div>
        <div className="flex-1 min-w-0">
          <PanelCaption className="mb-1.5">Start from</PanelCaption>
          <Dropdown
            ariaLabel="Start from"
            placeholder="Pick a team"
            value={props.selectedTeamId ?? ''}
            options={props.teams.map(t => ({ value: t.id, label: `${t.name} (${t.members.length})` }))}
            onChange={props.onSelectTeam}
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <PanelCaption>Members</PanelCaption>
          {props.members.length > 0 && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {teamSelectionSummary({ totalMembers: props.members.length, selectedCount, worktrees })}
            </span>
          )}
        </div>
        {props.members.length === 0 ? (
          <p className="text-xs text-muted-foreground">Pick a team above, or add a member to build one from scratch.</p>
        ) : (
          <MembersTable
            members={props.members}
            projectPath={props.projectPath}
            selected={props.selected}
            onToggleSelect={props.onToggleSelect}
            onPatch={props.onPatchMember}
            onRemove={props.onRemoveMember}
            onAdd={props.onAddMember}
            availability={props.availability}
          />
        )}
        {props.members.length === 0 && (
          <Button size="sm" variant="secondary" className="mt-2" onClick={props.onAddMember}>
            + Add a member
          </Button>
        )}
      </div>

      <div>
        <PanelCaption className="mb-1.5">The orchestrator&apos;s first task</PanelCaption>
        <Textarea
          value={props.brief}
          onChange={(e) => props.onBriefChange(e.target.value)}
          placeholder="What should this team ship? The orchestrator starts on it and splits the work."
          className="h-[72px]"
        />
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Typed once when the orchestrator first starts, now or later, and never kept as its role. It splits the work among
          its team; each member keeps its own role. A team with no orchestrator: every member gets it.
        </p>
      </div>

      <OptionsRow open={props.optionsOpen} onToggle={props.onToggleOptions} summary={summary}>
        <TeamOptionsBody
          permissionOverride={props.permissionOverride}
          onPermissionOverride={props.onPermissionOverride}
          startOnDeploy={props.startOnDeploy}
          onToggleStartOnDeploy={props.onToggleStartOnDeploy}
        />
      </OptionsRow>
    </div>
  );
}
