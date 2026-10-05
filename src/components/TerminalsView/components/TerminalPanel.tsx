'use client';

import { memo, useRef, useEffect, useCallback, useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { AgentStatus } from '@/types/electron';
import MessageWaitingNotice from '@/components/MessageWaitingNotice';
import LeftFullscreenNotice from './LeftFullscreenNotice';
import RestartPendingNotice from './RestartPendingNotice';
import { useMessageWaiting } from '@/hooks/useMessagesWaiting';
import { useRestartPending } from '@/hooks/useRestartPending';
import { asleepHint } from '@/lib/asleep-line';
import TerminalPanelHeader from './TerminalPanelHeader';

interface TerminalPanelProps {
  agent: AgentStatus;
  isFullscreen: boolean;
  isBroadcasting: boolean;
  isFocused: boolean;
  tabType: 'custom' | 'project';
  onRegisterContainer: (agentId: string, container: HTMLDivElement | null) => void;
  onStart: (agentId: string) => void;
  onStop: (agentId: string) => void;
  onRestart: (agentId: string) => void;
  onWake: (agentId: string) => void;
  onRemove: (agentId: string) => void;
  onClear: (agentId: string) => void;
  onFullscreen: (agentId: string) => void;
  onExitFullscreen: () => void;
  onFocus: (agentId: string) => void;
  onContextMenu: (e: React.MouseEvent, agentId: string) => void;
}

// Boards with many panels re-render this on every agents:tick otherwise: the
// parent (TerminalsView/TerminalGrid) re-renders on any agent's status
// change, board-wide, and with no memo here every panel re-ran its render
// body - including the xterm-hosting one - even for agents nothing about
// changed. Default (shallow, per-prop Object.is) comparison is enough
// because `agent` is only ever a new object when that specific agent's own
// data changed (see useElectronAgents' onTick reducer and the filteredAgents
// bail-out in TerminalsView/index.tsx), and every callback prop is a stable
// useCallback/useMemo by the time it reaches here.
function TerminalPanel({
  agent,
  isFullscreen,
  isBroadcasting,
  isFocused,
  tabType,
  onRegisterContainer,
  onStart,
  onStop,
  onRestart,
  onWake,
  onRemove,
  onClear,
  onFullscreen,
  onExitFullscreen,
  onFocus,
  onContextMenu,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onRegisterRef = useRef(onRegisterContainer);
  // Written in an effect, not during render: a ref assignment during render
  // is unsafe under concurrent rendering, and every reader of this one runs
  // after commit (a callback, a subscription), so the timing is the same.
  useEffect(() => {
    onRegisterRef.current = onRegisterContainer;
  }, [onRegisterContainer]);

  // Make this panel a drop target for skills. `data` has to be referentially
  // stable across renders where agent.id hasn't changed: dnd-kit stores it
  // straight into DndContext's own droppable registry, which every other
  // useDroppable/useDraggable in the tree reads from - a fresh object literal
  // here changed that registry, and its context value, on every render of
  // this one panel, so a single agent's tick re-rendered every OTHER panel
  // via dnd-kit's context regardless of the memo above.
  const dropData = useMemo(() => ({ type: 'terminal-panel' as const, agentId: agent.id }), [agent.id]);
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `panel-${agent.id}`, data: dropData });

  // Register container for xterm mounting - only on mount or agent ID change.
  // Uses a ref for the callback to avoid re-registering when the parent
  // re-creates the callback (e.g. on agents poll or font size change).
  //
  // The cleanup is load-bearing: this effect used to return nothing, so an
  // unmounted panel left its xterm alive in useMultiTerminal's map with
  // disposed:false. Going fullscreen (TerminalGrid swaps ReactGridLayout for a
  // plain div) or switching project tabs unmounts every other panel, and those
  // detached emulators kept parsing every PTY chunk into a 10k-line scrollback
  // and kept receiving broadcast-mode keystrokes meant for the visible set.
  // Passing null unregisters + disposes (registerContainer treats a null
  // container as "this panel is gone").
  useEffect(() => {
    const agentId = agent.id;
    if (containerRef.current) {
      onRegisterRef.current(agentId, containerRef.current);
    }
    return () => {
      onRegisterRef.current(agentId, null);
    };
  }, [agent.id]);

  // A message this terminal is holding because somebody is typing in it. Read
  // here rather than passed down the grid: the store is one subscription for
  // the window, and each panel reading its own agent out of it means a wait on
  // one terminal re-renders that panel and leaves the other nineteen alone.
  const waiting = useMessageWaiting(agent.id);
  const restartPending = useRestartPending(agent.id);
  const hint = asleepHint(agent);

  const handleClick = useCallback(() => {
    onFocus(agent.id);
  }, [agent.id, onFocus]);

  const handleStart = useCallback(() => onStart(agent.id), [agent.id, onStart]);
  const handleStop = useCallback(() => onStop(agent.id), [agent.id, onStop]);
  const handleRestart = useCallback(() => onRestart(agent.id), [agent.id, onRestart]);
  const handleWake = useCallback(() => onWake(agent.id), [agent.id, onWake]);
  const handleRemove = useCallback(() => onRemove(agent.id), [agent.id, onRemove]);
  const handleClear = useCallback(() => onClear(agent.id), [agent.id, onClear]);
  const handleFullscreen = useCallback(() => onFullscreen(agent.id), [agent.id, onFullscreen]);
  const handleContextMenu = useCallback((e: React.MouseEvent) => onContextMenu(e, agent.id), [agent.id, onContextMenu]);

  return (
    <div
      ref={setDropRef}
      data-agent-panel={agent.id}
      className={`
        flex flex-col overflow-hidden h-full bg-background border transition-colors
        ${isOver ? 'border-primary' : isFocused ? 'border-border-accent' : 'border-border'}
        ${isFullscreen ? 'fixed inset-0 z-[80] window-no-drag pt-7' : ''}
      `}
      onClick={handleClick}
    >
      {/* Header */}
      <TerminalPanelHeader
        agent={agent}
        isFullscreen={isFullscreen}
        isBroadcasting={isBroadcasting}
        tabType={tabType}
        onStart={handleStart}
        onStop={handleStop}
        onWake={handleWake}
        onFullscreen={handleFullscreen}
        onExitFullscreen={onExitFullscreen}
        onClear={handleClear}
        onRemove={handleRemove}
        onContextMenu={handleContextMenu}
      />

      {/* A message is waiting for this terminal's input field, and only the
          person at that keyboard can let it in. Under the header rather than
          in it: the header has about fifty pixels to spare on a board panel,
          and a notice cut to fifty pixels is the one nobody reads. */}
      <MessageWaitingNotice waiting={waiting} />

      {/* A changed setting waits to restart this agent, and says on what: until
          it has, the agent answers on the old settings. */}
      {restartPending && <RestartPendingNotice pending={restartPending} />}

      {/* This terminal's claude left fullscreen, so the wheel reaches nothing
          (useMultiTerminal has stopped sending it). Restarting gives a session
          on the same conversation that opens fullscreen. */}
      {agent.leftFullscreen && <LeftFullscreenNotice onRestart={handleRestart} />}

      {/* Terminal body */}
      <div className="flex-1 min-h-0 overflow-hidden relative bg-background">
        <div ref={containerRef} className="absolute inset-0" />
        {/* Asleep, under the last screen of the CLI it slept in: since when,
            and that a key wakes it; coming back, that its CLI starts again.
            Over the terminal rather than written into it: the screen opens
            with a reset and a full-screen program's ends on its own cursor,
            so a line written before is wiped and one written after lands
            inside the program's frame. Frame: `Agent asleep · and how it wakes`. */}
        {hint && (
          <p className="absolute inset-x-0 bottom-0 px-3 py-1.5 bg-background font-mono text-[11px] text-muted-foreground truncate pointer-events-none select-none">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

export default memo(TerminalPanel);
