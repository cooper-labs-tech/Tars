'use client';

import { useEffect, useRef, useState } from 'react';
import { GripVertical, ShieldOff, Bot, Shield, Gauge, Maximize2, Minimize2 } from 'lucide-react';
import type { AgentStatus } from '@/types/electron';
import { AgentMark } from '@/components/ui';
import { errorReason } from '@/app/agents/constants';
import { stopLine } from '@/lib/stop-line';
import { asleepLine, wakingLine } from '@/lib/asleep-line';
import AgentStatusWord from '@/components/AgentStatusWord';
import { AgentAccountControl } from '@/components/ClaudeAccounts/AgentAccountControl';

interface TerminalPanelHeaderProps {
  agent: AgentStatus;
  isFullscreen: boolean;
  isBroadcasting: boolean;
  tabType: 'custom' | 'project';
  onStart: () => void;
  onStop: () => void;
  /** An asleep agent's CLI started again on its own conversation (PR 322). */
  onWake: () => void;
  onFullscreen: () => void;
  onExitFullscreen: () => void;
  onClear: () => void;
  onRemove: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export default function TerminalPanelHeader({
  agent,
  isFullscreen,
  isBroadcasting,
  tabType,
  onStart,
  onStop,
  onWake,
  onFullscreen,
  onExitFullscreen,
  onClear,
  onRemove,
  onContextMenu,
}: TerminalPanelHeaderProps) {
  const name = agent.name || `Agent ${agent.id.slice(0, 6)}`;
  const branch = agent.branchName || '';
  // Local (Tasmania) agents carry their model under localModel instead.
  const model = agent.model || agent.localModel || '';
  // Whether a CLI runs in this terminal, read from the terminal itself by the
  // main process. The status cannot tell: a failed turn leaves claude at its
  // prompt in error, and an agent at rest or done keeps its session, so the
  // button offered start and a click typed `cd '...' && claude ...` into the
  // running claude. Frame: `Agent error · reason`.
  const isLive = agent.cliRunning === true;
  const reason = errorReason(agent);
  // Who stopped it, when and why. Frame: `Agent stopped · who and why`.
  const stop = stopLine(agent);
  // Asleep since when, or who is waking it: the same place, the same ink.
  // Frame: `Agent asleep · and how it wakes`.
  const waking = wakingLine(agent);
  const sleep = waking ?? asleepLine(agent);

  const showDragHandle = tabType === 'custom';
  // Neither kind of tab deletes anything from here any more. A custom tab
  // takes the agent off its own membership list; a project board hides the
  // panel and the tab strip puts it back. Deleting for good is its own item
  // below, with its own wording, because it also destroys the worktree.
  const removeLabel = tabType === 'custom' ? 'remove from tab' : 'hide from this board';

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // The same row as every other menu panel in the app: the hidden-agents list
  // on the tab strip and the Dropdown panel both use this. It used to be a
  // 26px mono lowercase row in a 140px box, which was its own idiom and too
  // narrow for a label like "hide from this board".
  const menuItemClass =
    'w-full px-2.5 py-1.5 flex items-center text-left text-xs whitespace-nowrap text-text-secondary hover:bg-secondary hover:text-foreground transition-colors';

  const run = (action: () => void) => () => { setMenuOpen(false); action(); };

  return (
    <div
      className={`${showDragHandle ? 'terminal-drag-handle' : ''} window-no-drag flex items-center gap-2 h-8 px-3 bg-card border-b border-border select-none`}
      onContextMenu={onContextMenu}
    >
      {/* Drag handle grip - custom tabs only */}
      {showDragHandle && (
        <GripVertical className="w-3 h-3 text-muted-foreground/50 flex-shrink-0" />
      )}

      {/* Agent identity: its mark, name, git branch. The status is the word
          on the right, as on the agent cards. Frame: `Dashboard · dark`. */}
      <AgentMark name={agent.name || agent.id} orchestrator={agent.role === 'orchestrator'} />
      <span className="text-[11.5px] font-semibold text-foreground truncate max-w-[140px]">{name}</span>
      {reason ? (
        // In error, why: the reason takes the branch's place and the room the
        // marks below use, one red line cut where the header runs out, the
        // whole sentence in the title. In the header and not over the
        // terminal, so a failed turn neither resizes the pty nor covers the
        // line the CLI printed. Frame: `Agent error · reason`.
        <span className="flex-1 min-w-0 text-[11px] text-status-error truncate" title={reason}>
          {reason}
        </span>
      ) : stop ? (
        // Stopped, who did it, when and why, in the same place and the same
        // way, in the secondary ink: a stop is not a failure. In a narrow
        // panel it gets no room at all, and the word keeps the sentence in
        // its title. Frame: `Agent stopped · who and why`.
        <span className="flex-1 min-w-0 text-[11px] text-text-secondary truncate" title={stop}>
          {stop}
        </span>
      ) : sleep ? (
        // Asleep since when, or who is waking it, where the stop says who
        // stopped it. Frame: `Agent asleep · and how it wakes`.
        <span className="flex-1 min-w-0 text-[11px] text-text-secondary truncate" title={sleep}>
          {sleep}
        </span>
      ) : branch && (
        <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[120px] shrink-[3]">
          {branch}
        </span>
      )}

      {/* Broadcast indicator */}
      {isBroadcasting && (
        <span className="text-[10px] px-1.5 py-0.5 bg-accent-dim text-primary font-medium">
          BROADCAST
        </span>
      )}

      {!reason && !stop && !sleep && (
        <>
          {/* Permission mode indicator */}
          {(agent.permissionMode === 'auto' || (!agent.permissionMode && agent.skipPermissions)) && (
            <span title="Auto mode - runs autonomously">
              <Bot className="w-3 h-3 text-warning" />
            </span>
          )}
          {agent.permissionMode === 'bypass' && (
            <span title="Bypass mode - all permissions skipped">
              <ShieldOff className="w-3 h-3 text-danger" />
            </span>
          )}
          {agent.permissionMode === 'normal' && (
            <span title="Normal mode - asks for permissions">
              <Shield className="w-3 h-3 text-primary" />
            </span>
          )}

          {/* Effort indicator */}
          {agent.effort === 'high' && (
            <span title="High effort - extended thinking">
              <Gauge className="w-3 h-3 text-primary" />
            </span>
          )}

          {/* Spacer */}
          <div className="flex-1" />
        </>
      )}

      {/* The status as a word in its colour, then which CLI and which model as
          plain words. The provider was only ever implied by the model string,
          so an agent left on its provider default showed nothing at all and
          you could not tell what would launch. */}
      <AgentStatusWord agent={agent} className="text-[10px] font-mono shrink-0" title={stop ?? sleep ?? undefined} />
      {/* It gives way first, then the branch, so the name keeps its width
          in a narrow panel: the mark and the status word took the room. */}
      {(agent.provider || model) && (
        <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[160px] shrink-[6]">
          {[agent.provider, model].filter(Boolean).join(' · ')}
        </span>
      )}
      {/* The Claude account it runs on, after provider and model, when several
          subscriptions are on. Frame: `Agent · Claude account`. */}
      <AgentAccountControl agent={agent} stopMouseDown />

      {/* What the panel shows: its agent's session, as it runs. It named the
          live view while a history view sat beside it, and is a word now,
          boxed as that selected segment was. Frame: `Panel header · session
          and fullscreen`. */}
      <span
        className="inline-flex items-center h-[26px] px-2.5 mr-0.5 text-xs border bg-secondary border-border-accent text-foreground shrink-0"
        title="The agent's session, in its terminal"
      >
        session
      </span>

      {/* Start / stop. The panel's primary action, so it is a button you can
          see and hit - not a row inside the overflow menu. A grid of terminals
          with no visible way to launch the CLI is a grid of empty shells. */}
      {agent.status === 'asleep' || waking ? (
        // Asleep, the panel's action wakes it on its conversation; off while
        // it comes back. Frame: `Agent asleep · and how it wakes`.
        <button
          type="button"
          onMouseDown={e => e.stopPropagation()}
          onClick={onWake}
          disabled={!!waking}
          className="h-[26px] px-2 text-[11px] font-mono lowercase border border-border-accent text-foreground hover:border-primary hover:text-primary transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default disabled:hover:border-border-accent disabled:hover:text-foreground"
          title={waking ? 'Coming back on its conversation' : 'Wake it on its own conversation'}
        >
          wake
        </button>
      ) : (
        <button
          type="button"
          onMouseDown={e => e.stopPropagation()}
          onClick={isLive ? onStop : onStart}
          // A bordered 26px row action, like every other action in the app. The
          // first version was accent-filled, which put a solid orange block in
          // every pane header at once - the accent is for one primary action on
          // a screen, not for six of them in a row.
          className={`h-[26px] px-2 text-[11px] font-mono lowercase border transition-colors cursor-pointer ${
            isLive
              ? 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
              : 'border-border-accent text-foreground hover:border-primary hover:text-primary'
          }`}
          title={isLive ? 'Stop this agent' : `Start ${agent.provider ?? 'the CLI'} in this terminal`}
        >
          {isLive ? 'stop' : 'start'}
        </button>
      )}

      {/* Fullscreen in one press, out of the menu: the arrows point out at
          rest and turn inward while the panel fills the window. */}
      <button
        type="button"
        onMouseDown={e => e.stopPropagation()}
        onClick={isFullscreen ? onExitFullscreen : onFullscreen}
        className="h-[26px] w-[26px] shrink-0 inline-flex items-center justify-center border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      >
        {isFullscreen ? <Minimize2 className="w-3 h-3" aria-hidden /> : <Maximize2 className="w-3 h-3" aria-hidden />}
      </button>

      {/* Overflow menu: clear and remove */}
      <div
        ref={menuRef}
        className="relative [&_button]:cursor-pointer"
        onMouseDown={e => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => setMenuOpen(o => !o)}
          className={`h-[26px] px-1.5 leading-none text-sm transition-colors ${
            menuOpen ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
          // `title` loses to the visible glyph when a screen reader computes the
          // accessible name, so this button announced itself as "middle dot
          // middle dot middle dot". aria-label wins, and the two menu states are
          // now distinguishable.
          aria-label="Panel actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Panel actions"
        >
          <span aria-hidden>···</span>
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 z-[90] min-w-[190px] bg-card border border-border">
            <button type="button" onClick={run(onClear)} className={menuItemClass}>clear</button>

            {/* Taking a panel off a board and destroying an agent are two
                different intentions, so they are two different items. */}
            {!isFullscreen && (
              <button type="button" onClick={run(onRemove)} className={menuItemClass}>{removeLabel}</button>
            )}
            {/* No "delete for good" here. Destroying an agent and its worktree
                is not a thing to offer beside "clear" on a board; it lives on
                the Agents page, where the agent itself is managed. */}
          </div>
        )}
      </div>
    </div>
  );
}
