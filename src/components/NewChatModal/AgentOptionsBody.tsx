'use client';

import { useEffect, useState } from 'react';
import type { AgentEffort, AgentPermissionMode } from '@/types/agent';
import { Dropdown, Input, SegmentedControl } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';
import { Toggle } from '@/components/Settings/Toggle';
import { OptionRow, OPTION_CONTROL_WIDTH } from './OptionsRow';
import { SkillsField } from './SkillsField';
import OrchestratorModeToggle from './OrchestratorModeToggle';
import { EFFORT_LEVELS } from './logic';
import { hasPlanMode, noPlanReason } from '@/lib/plan-mode';

const EFFORT_OPTIONS: SegmentedOption<AgentEffort>[] = EFFORT_LEVELS.map(level => ({ value: level, label: level }));

const PERMISSION_OPTIONS: SegmentedOption<AgentPermissionMode>[] = [
  { value: 'plan', label: 'plan', title: 'Reads and plans, edits nothing' },
  { value: 'normal', label: 'manual', title: 'Asks before each tool' },
  { value: 'auto', label: 'auto', title: 'Autonomous - recommended' },
  { value: 'bypass', label: 'bypass', title: 'Skips all restrictions' },
];

interface DetectedCli { key: string; label: string; path: string }

/**
 * Everything the collapsed Options row was holding, for a single agent: the
 * six controls that used to be spread across three of the four wizard steps.
 * None of them is needed to start an agent and all of them matter once you
 * know what you are doing, so they sit inside the one bordered list the
 * collapsed row already promised.
 */
export function AgentOptionsBody(props: {
  skills: string[];
  skillDescriptions: Map<string, string>;
  selectedSkills: string[];
  onToggleSkill: (name: string) => void;
  effort: AgentEffort;
  onEffortChange: (effort: AgentEffort) => void;
  permissionMode: AgentPermissionMode;
  onPermissionModeChange: (mode: AgentPermissionMode) => void;
  useWorktree: boolean;
  onToggleWorktree: () => void;
  worktreeLocked?: boolean;
  branchName: string;
  onBranchNameChange: (name: string) => void;
  isOrchestrator: boolean;
  onOrchestratorToggle: (enabled: boolean) => void;
  /** Editing an agent that exists, which a save restarts to apply the role. */
  editing?: boolean;
  cliPath: string;
  onCliPathChange: (path: string) => void;
  /** So the orchestrator row can say whether this CLI enforces the mode. */
  provider?: string;
}) {
  const [detectedClis, setDetectedClis] = useState<DetectedCli[]>([]);

  useEffect(() => {
    window.electronAPI?.cliPaths?.detect().then((paths) => {
      if (!paths) return;
      const cliMap: { key: string; label: string }[] = [
        { key: 'claude', label: 'Claude' },
        { key: 'codex', label: 'Codex' },
        { key: 'gemini', label: 'Gemini' },
        { key: 'grok', label: 'Grok' },
        { key: 'opencode', label: 'OpenCode' },
        { key: 'amp', label: 'Amp' },
        { key: 'pi', label: 'Pi' },
        { key: 'qwencode', label: 'Qwen Code' },
        { key: 'kimi', label: 'Kimi Code' },
        { key: 'minimax', label: 'MiniMax' },
      ];
      const detected: DetectedCli[] = [];
      for (const { key, label } of cliMap) {
        const p = (paths as Record<string, string>)[key];
        if (p) detected.push({ key, label, path: p });
      }
      setDetectedClis(detected);
    });
  }, []);

  return (
    <>
      <SkillsField
        skills={props.skills}
        descriptions={props.skillDescriptions}
        selected={props.selectedSkills}
        onToggle={props.onToggleSkill}
      />

      <OptionRow label="Effort" hint="How hard it thinks before it acts. Costs more at the top.">
        <SegmentedControl
          className="font-mono"
          ariaLabel="Effort"
          options={EFFORT_OPTIONS}
          value={props.effort}
          onChange={props.onEffortChange}
        />
      </OptionRow>

      <OptionRow label="Permissions" hint="Plan reads and plans, and edits nothing. Manual asks before each tool. Bypass skips every check.">
        <SegmentedControl
          className="font-mono"
          ariaLabel="Permission mode"
          options={PERMISSION_OPTIONS.map(option => (option.value === 'plan' && !hasPlanMode(props.provider)
            ? { ...option, disabled: true, title: noPlanReason(props.provider) }
            : option))}
          value={props.permissionMode}
          onChange={props.onPermissionModeChange}
        />
      </OptionRow>

      <OptionRow label="Its own worktree" hint="A separate checkout on its own branch, so two agents cannot overwrite each other.">
        <Toggle enabled={props.useWorktree} onChange={props.onToggleWorktree} disabled={props.worktreeLocked} />
      </OptionRow>

      <OptionRow label="Branch" hint="Created from the current HEAD.">
        <Input
          mono
          className={OPTION_CONTROL_WIDTH}
          value={props.branchName}
          onChange={(e) => props.onBranchNameChange(e.target.value.replace(/\s+/g, '-'))}
          placeholder="feat/frontend"
          disabled={!props.useWorktree || props.worktreeLocked}
        />
      </OptionRow>

      <OrchestratorModeToggle
        isOrchestrator={props.isOrchestrator}
        onToggle={props.onOrchestratorToggle}
        provider={props.provider}
        editing={props.editing}
      />

      {detectedClis.length > 0 && (
        <OptionRow label="CLI binary" hint="Which binary runs it. The provider's own by default.">
          <Dropdown
            mono
            className={OPTION_CONTROL_WIDTH}
            ariaLabel="CLI binary"
            value={props.cliPath}
            placeholder="default"
            options={[
              { value: '', label: 'default' },
              ...detectedClis.map((cli) => ({ value: cli.path, label: cli.label, hint: cli.path })),
            ]}
            onChange={props.onCliPathChange}
          />
        </OptionRow>
      )}
    </>
  );
}
