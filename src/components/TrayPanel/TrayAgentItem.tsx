'use client';

import { useState } from 'react';
import type { AgentTickItem, DisplayStatus } from '@/types/electron';
import { StatusSquare, StatusBadge, type StatusTone } from '@/components/ui';
import { TERMINAL_SURFACE_CLASS } from '@/lib/terminal-theme';
import { useTrayTerminal } from './useTrayTerminal';

interface TrayAgentItemProps {
  agent: AgentTickItem;
  expanded: boolean;
  onToggle: () => void;
}

/** Tray display statuses fold onto the four raw status words. */
const STATUS_TONES: Record<DisplayStatus, StatusTone> = {
  working: 'running',
  waiting: 'waiting',
  error: 'error',
  done: 'idle',
  ready: 'idle',
  stopped: 'idle',
  // An agent whose CLI Tars ended after 30 minutes without a turn, in the idle
  // ink, and one coming back on its conversation, in the waiting one.
  // Frame: `Agent asleep · and how it wakes`.
  asleep: 'idle',
  waking: 'waiting',
};

export default function TrayAgentItem({
  agent,
  expanded,
  onToggle,
}: TrayAgentItemProps) {
  const [terminalEl, setTerminalEl] = useState<HTMLDivElement | null>(null);

  useTrayTerminal({ agentId: agent.id, container: terminalEl });

  const tone = STATUS_TONES[agent.displayStatus] ?? 'idle';

  return (
    <div className="border-b border-border">
      {/* Collapsed row: square + name, status word right-aligned */}
      <button
        onClick={onToggle}
        className="w-full h-8 px-4 flex items-center gap-2 text-left transition-colors hover:bg-secondary"
      >
        <StatusSquare tone={tone} />
        <span className="flex-1 min-w-0 truncate text-12 text-foreground">
          {agent.name}
        </span>
        <StatusBadge tone={tone} className="font-mono" />
      </button>

      {/* Expanded terminal */}
      {expanded && (
        <div className={TERMINAL_SURFACE_CLASS}>
          <div
            ref={setTerminalEl}
            className="h-[380px] w-full overflow-hidden"
          />
        </div>
      )}
    </div>
  );
}
