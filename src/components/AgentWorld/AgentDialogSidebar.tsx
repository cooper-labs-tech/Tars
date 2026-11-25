import { memo, useState } from 'react';
import dynamic from 'next/dynamic';
import type { AgentStatus } from '@/types/electron';
import type { PanelType } from './AgentDialogTypes';
import { AgentDialogSecondaryProject } from './AgentDialogSecondaryProject';
import { BrandSpinner, MetaChip, PanelCaption, SegmentedControl } from '@/components/ui';
import { TERMINAL_SURFACE_CLASS } from '@/lib/terminal-theme';
import type { AgentPermissionMode } from '@/types/agent';
import { hasPlanMode, noPlanReason } from '@/lib/plan-mode';

const GitPanel = dynamic(() => import('./GitPanel'), {
  loading: () => (
    <div className="flex items-center justify-center h-full">
      <BrandSpinner size={30} label="Loading git panel" />
    </div>
  ),
});

const CodePanel = dynamic(() => import('./CodePanel'), {
  loading: () => (
    <div className="flex items-center justify-center h-full">
      <BrandSpinner size={30} label="Loading code panel" />
    </div>
  ),
});

/** The rail is three tabs, not five accordions. */
type SidebarTab = 'git' | 'memory' | 'skills';

/** Row action: 26px bordered lowercase mono, never an icon-only button (R7). */
const RAIL_BUTTON =
  'h-[26px] px-2 border border-border font-mono text-[11px] text-muted-foreground ' +
  'hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40';

interface AgentDialogSidebarProps {
  agent: AgentStatus;
  projectPath: string;
  /**
   * Still owned by the dialog: `useQuickTerminal` spawns the PTY when
   * `terminal` is in this set, so the shell affordance below toggles it
   * instead of keeping a second copy of that state.
   */
  expandedPanels: Set<PanelType>;
  onTogglePanel: (panel: PanelType) => void;
  // Git
  gitBranch: string;
  onGitBranchChange: (branch: string) => void;
  // Shell
  quickTerminalRef: React.RefObject<HTMLDivElement | null>;
  quickXtermRef: React.RefObject<import('xterm').Terminal | null>;
  quickTerminalReady: boolean;
  hasActiveTerminal: boolean;
  onCloseQuickTerminal: () => void;
  // Context
  hasSecondaryProject: boolean;
  availableProjects: { path: string; name: string }[];
  customSecondaryPath: string;
  onCustomSecondaryPathChange: (value: string) => void;
  onSetSecondaryProject: (path: string | null) => void;
  /** Why the last folder was not set: main's refusal word for word, or the failed call's message. */
  secondaryError?: string | null;
  onBrowseFolder?: () => Promise<string | null>;
  // Settings
  editPermissionMode: AgentPermissionMode;
  isSavingSettings: boolean;
  /** Set when the last change was refused, so the control stops claiming it took. */
  permissionError?: string | null;
  onSavePermissionMode: (value: AgentPermissionMode) => void;
}

export const AgentDialogSidebar = memo(function AgentDialogSidebar({
  agent,
  projectPath,
  expandedPanels,
  onTogglePanel,
  gitBranch,
  onGitBranchChange,
  quickTerminalRef,
  quickXtermRef,
  quickTerminalReady,
  hasActiveTerminal,
  onCloseQuickTerminal,
  hasSecondaryProject,
  availableProjects,
  customSecondaryPath,
  onCustomSecondaryPathChange,
  onSetSecondaryProject,
  secondaryError,
  onBrowseFolder,
  editPermissionMode,
  isSavingSettings,
  permissionError,
  onSavePermissionMode,
}: AgentDialogSidebarProps) {
  const [tab, setTab] = useState<SidebarTab>('git');
  const shellOpen = expandedPanels.has('terminal');

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Tabs: one box per tab, the selected one boxed, never an accent fill (R2b) */}
      <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
        <SegmentedControl<SidebarTab>
          ariaLabel="Agent rail"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'git', label: 'Git' },
            {
              value: 'memory',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Memory
                  {hasSecondaryProject && <span className="w-1.5 h-1.5 bg-primary" />}
                </span>
              ),
            },
            { value: 'skills', label: 'Skills' },
          ]}
        />
        {tab === 'git' && gitBranch && <MetaChip>{gitBranch}</MetaChip>}
      </div>

      {/* Git: working tree, with the quick shell on the same worktree beneath it.
          Every tab body stays mounted so the terminal keeps its DOM node. */}
      <div className={tab === 'git' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
        <div className="flex-1 min-h-0">
          <GitPanel projectPath={projectPath} className="h-full" hideHeader onBranchChange={onGitBranchChange} />
        </div>
        <div className="shrink-0 border-t border-border">
          <div className="flex items-center justify-between gap-2 px-3 h-10">
            <PanelCaption>SHELL</PanelCaption>
            <div className="flex items-center gap-2">
              {hasActiveTerminal && !shellOpen && (
                <span className="font-mono text-[11px] text-status-running">running</span>
              )}
              {shellOpen ? (
                <button
                  onClick={onCloseQuickTerminal}
                  className={RAIL_BUTTON}
                  title="Close terminal (kills process)"
                >
                  close
                </button>
              ) : (
                <button onClick={() => onTogglePanel('terminal')} className={RAIL_BUTTON}>
                  open shell
                </button>
              )}
            </div>
          </div>
          {shellOpen && (
            <div className="relative h-[180px]">
              <div
                ref={quickTerminalRef}
                className={`absolute inset-0 p-1 ${TERMINAL_SURFACE_CLASS}`}
                style={{ cursor: 'text' }}
                onClick={() => quickXtermRef.current?.focus()}
              />
              {!quickTerminalReady && (
                <div className={`absolute inset-0 flex items-center justify-center ${TERMINAL_SURFACE_CLASS}`}>
                  <BrandSpinner size={30} label="Loading terminal" />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Memory. What the agent can see: this project's files, plus any extra context */}
      <div className={tab === 'memory' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
        <div className="shrink-0 h-[250px] border-b border-border">
          <CodePanel projectPath={projectPath} className="h-full" />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <AgentDialogSecondaryProject
            agent={agent}
            availableProjects={availableProjects}
            customSecondaryPath={customSecondaryPath}
            onCustomPathChange={onCustomSecondaryPathChange}
            onSetSecondaryProject={onSetSecondaryProject}
            error={secondaryError}
            onBrowseFolder={onBrowseFolder}
          />
        </div>
      </div>

      {/* Skills: what it is allowed to do, and what it was built with */}
      <div className={tab === 'skills' ? 'flex-1 min-h-0 overflow-y-auto' : 'hidden'}>
        <div className="p-3 space-y-4">
          <div className="space-y-2">
            <PanelCaption>PERMISSIONS</PanelCaption>
            <SegmentedControl<AgentPermissionMode>
              ariaLabel="Permission mode"
              value={editPermissionMode}
              onChange={onSavePermissionMode}
              options={[
                hasPlanMode(agent.provider)
                  ? { value: 'plan', label: 'Plan', disabled: isSavingSettings }
                  : { value: 'plan', label: 'Plan', disabled: true, title: noPlanReason(agent.provider) },
                { value: 'normal', label: 'Manual', disabled: isSavingSettings },
                { value: 'auto', label: 'Auto', disabled: isSavingSettings },
                { value: 'bypass', label: 'Bypass', disabled: isSavingSettings },
              ]}
            />
            <p className={`text-[11px] ${permissionError && !isSavingSettings ? 'text-danger' : 'text-muted-foreground'}`}>
              {isSavingSettings
                ? 'Saving…'
                : permissionError || 'Changes take effect on the next task.'}
            </p>
          </div>

          <div className="space-y-2">
            <PanelCaption>SKILLS</PanelCaption>
            {agent.skills.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {agent.skills.map(skill => (
                  <MetaChip key={skill}>{skill}</MetaChip>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">None</p>
            )}
          </div>

          <div className="space-y-1.5 text-xs">
            {agent.branchName && (
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Branch</span>
                <span className="font-mono text-[11px] truncate">{agent.branchName}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
