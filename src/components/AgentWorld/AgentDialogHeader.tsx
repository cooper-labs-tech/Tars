import { memo } from 'react';
import type { AgentStatus } from '@/types/electron';
import { AgentMark, Button } from '@/components/ui';
import { stopLine } from '@/lib/stop-line';
import { asleepLine, wakingLine } from '@/lib/asleep-line';
import AgentStatusWord from '@/components/AgentStatusWord';
import { AgentAccountControl } from '@/components/ClaudeAccounts/AgentAccountControl';

interface AgentDialogHeaderProps {
  agent: AgentStatus;
  isSuperAgentMode: boolean;
  onClose: () => void;
  /** Row actions. Each renders disabled until the dialog wires a handler in. */
  onStop?: () => void;
  onRestart?: () => void;
  /** An asleep agent's CLI started again on its own conversation (PR 322): the
   *  window's `wake`, in restart's place while it is asleep or waking. */
  onWake?: () => void;
  onEdit?: () => void;
  onOpenInReview?: () => void;
  /** @deprecated The design has no Finder button and no fullscreen toggle.
   *  Still accepted so the dialog keeps compiling while it is reworked. */
  isFullscreen?: boolean;
  hasSecondaryProject?: boolean;
  onOpenInFinder?: () => void;
  onToggleFullscreen?: () => void;
}

export const AgentDialogHeader = memo(function AgentDialogHeader({
  agent,
  isSuperAgentMode,
  onClose,
  onStop,
  onRestart,
  onWake,
  onEdit,
  onOpenInReview,
}: AgentDialogHeaderProps) {
  // provider · model · branch · effort, as plain words: the facts the agent
  // cards write, and the effort only this window has room for.
  const model = agent.localModel || agent.model;
  const facts = [
    isSuperAgentMode ? 'orchestrator' : agent.provider || 'claude',
    model,
    agent.branchName,
    agent.effort,
  ].filter(Boolean).join(' · ');
  // Who stopped it, when and why, as the word's title. A second stop would be
  // filed under you and replace them, so there is none to offer. Frame:
  // `Agent stopped · who and why`.
  const stop = stopLine(agent);
  // Asleep, or coming back: wake takes restart's place, off while it comes
  // back. Frame: `Agent asleep · and how it wakes`.
  const waking = wakingLine(agent);
  const sleep = waking ?? asleepLine(agent);

  return (
    <div className="h-12 px-4 border-b border-border bg-card flex items-center justify-between gap-4">
      <div className="flex items-center gap-2.5 min-w-0">
        <AgentMark name={agent.name || agent.id} orchestrator={agent.role === 'orchestrator'} size={24} />
        <span className="text-[12.5px] font-semibold truncate">{agent.name || 'Agent'}</span>
        <span className="font-mono text-[11px] text-muted-foreground truncate" title={facts}>{facts}</span>
        {/* The Claude account it runs on, with the same menu as its card. */}
        <AgentAccountControl agent={agent} className="shrink-0" />
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {/* The status as a word, in its colour, where the frame puts it:
            first of the row's actions. */}
        <AgentStatusWord agent={agent} className="font-mono text-[11px] mr-1.5" title={stop ?? sleep ?? undefined} />
        <Button
          variant="ghost"
          size="sm"
          className="font-mono font-normal"
          onClick={onStop}
          disabled={!onStop || !!stop}
          title={!onStop ? 'Not wired yet' : stop ? 'Already stopped' : undefined}
        >
          stop
        </Button>
        {sleep ? (
          <Button
            variant="ghost"
            size="sm"
            className="font-mono font-normal"
            onClick={onWake}
            disabled={!onWake || !!waking}
            title={waking ? 'Coming back on its conversation' : 'Wake it on its own conversation'}
          >
            wake
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="font-mono font-normal"
            onClick={onRestart}
            disabled={!onRestart}
            title={onRestart ? undefined : 'Not wired yet'}
          >
            restart
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="font-mono font-normal"
          onClick={onEdit}
          disabled={!onEdit}
          title={onEdit ? undefined : 'Not wired yet'}
        >
          edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="font-mono font-normal"
          onClick={onOpenInReview}
          disabled={!onOpenInReview}
          title={onOpenInReview ? undefined : 'Not wired yet'}
        >
          open in Review
        </Button>
        <Button variant="ghost" size="sm" className="font-mono font-normal" onClick={onClose}>
          close
        </Button>
      </div>
    </div>
  );
});
