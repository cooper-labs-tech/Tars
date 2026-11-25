'use client';

import type { TeamPermissionMode } from '@/types/agent';
import { SegmentedControl } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';
import { Toggle } from '@/components/Settings/Toggle';
import { OptionRow } from './OptionsRow';

const PERMISSION_OPTIONS: SegmentedOption<TeamPermissionMode>[] = [
  { value: 'normal', label: 'manual', title: 'Asks before each tool' },
  { value: 'auto', label: 'auto', title: 'Autonomous - recommended' },
  { value: 'bypass', label: 'bypass', title: 'Skips all restrictions' },
];

/**
 * A team's Options: no per-skills picker here, because a member's skills come
 * from the role it was started from - editing them means editing the team
 * preset, not this one deployment. What is left is bulk permission and
 * whether the members start the moment they exist, the orchestrator last with its first task.
 */
export function TeamOptionsBody({
  permissionOverride,
  onPermissionOverride,
  startOnDeploy,
  onToggleStartOnDeploy,
}: {
  permissionOverride: TeamPermissionMode;
  onPermissionOverride: (mode: TeamPermissionMode) => void;
  startOnDeploy: boolean;
  onToggleStartOnDeploy: () => void;
}) {
  return (
    <>
      <OptionRow label="Permissions" hint="Applied to every member at once - each keeps its own until you change this.">
        <SegmentedControl
          className="font-mono"
          ariaLabel="Permission mode for every member"
          options={PERMISSION_OPTIONS}
          value={permissionOverride}
          onChange={onPermissionOverride}
        />
      </OptionRow>
      <OptionRow label="Start on deploy" hint="Start every member now, the orchestrator last with its first task, instead of leaving them idle until their first start.">
        <div className="flex justify-end">
          <Toggle enabled={startOnDeploy} onChange={onToggleStartOnDeploy} />
        </div>
      </OptionRow>
    </>
  );
}
