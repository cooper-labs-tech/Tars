import { useState, useEffect } from 'react';
import { Toggle } from '@/components/Settings/Toggle';
import { isElectron } from '@/hooks/useElectron';
import { OPTION_ROW } from './OptionsRow';

interface OrchestratorModeToggleProps {
  isOrchestrator: boolean;
  onToggle: (enabled: boolean) => void;
  /** The provider this agent will run on, so the row can say whether the
   *  role takes the editing tools away on it or only asks it to delegate. */
  provider?: string;
  /** An agent that already exists, which a save restarts to apply the role. */
  editing?: boolean;
}

/**
 * The Orchestrator toggle, which is the role. Frames: `Overlay · Edit agent ·
 * Orchestrator`, `Orchestrator role · states`.
 *
 * Only this switch makes an agent its project's orchestrator: the name decides
 * nothing. A project has one, so switching it on takes the role from the
 * current one, once the dialog's save has asked (ReplaceOrchestratorDialog).
 * It sets the role and nothing else: the permission mode and the character
 * stay as they are.
 *
 * It used to install the orchestrator's MCP configuration the first time it
 * was switched on, and drew itself off until that had succeeded. The main
 * process writes that configuration for every agent at boot, so the switch has
 * nothing to wait for.
 */
export default function OrchestratorModeToggle({
  isOrchestrator,
  onToggle,
  provider,
  editing,
}: OrchestratorModeToggleProps) {
  // Fourteen providers run the Claude binary and genuinely lose the editing
  // and subagent tools. The CLIs with their own syntax have no verified
  // equivalent, so on those the role asks rather than stops. They are also the
  // ones a save does not restart: they take the role at their next start.
  const [enforcedBy, setEnforcedBy] = useState<Record<string, boolean> | null>(null);
  useEffect(() => {
    void window.electronAPI?.provider?.orchestratorSupport().then(setEnforcedBy);
  }, []);
  const enforced = !provider || !enforcedBy ? true : enforcedBy[provider] !== false;

  if (!isElectron()) {
    return null;
  }

  const hint = [
    enforced
      // Every orchestrator is a member of the global room; Telegram and Slack
      // pick the fleet's first one (getSuperAgent with no project).
      ? 'Runs the project: it delegates instead of editing files, and joins the global Chat room. If it is the fleet’s first orchestrator, it also answers Slack. A Telegram message reaches the orchestrator of the project it names, through Hermes.'
      : 'Runs the project and joins the global Chat room. If it is the fleet’s first orchestrator, it also answers Slack. A Telegram message reaches the orchestrator of the project it names, through Hermes. This CLI keeps its editing tools: it is asked to delegate, not stopped.',
    'A project has one, so switching this on takes the role from the current one.',
    ...(editing
      ? [enforced ? 'If it is running, saving restarts it once it is free.' : 'It takes the change at its next start.']
      : []),
  ].join(' ');

  // The same row rule as every other option, not a copy of it: this one is not
  // an OptionRow only because its hint changes with the provider.
  return (
    <div className={OPTION_ROW}>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-foreground">Orchestrator</p>
        <p className={`text-[11px] ${enforced ? 'text-muted-foreground' : 'text-warning'}`}>{hint}</p>
      </div>
      <div className="shrink-0">
        <Toggle enabled={isOrchestrator} onChange={() => onToggle(!isOrchestrator)} />
      </div>
    </div>
  );
}
