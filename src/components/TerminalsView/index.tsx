'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { isElectron } from '@/hooks/useElectron';
import { DndContext } from '@dnd-kit/core';
import { useElectronAgents, useElectronFS, useElectronSkills } from '@/hooks/useElectron';
import { panelAgentsKey } from './utils/panelAgentsKey';
import { useMultiTerminal } from './hooks/useMultiTerminal';
import { useTerminalGrid } from './hooks/useTerminalGrid';
import { useTabManager } from './hooks/useTabManager';
import { useBroadcast } from './hooks/useBroadcast';
import { useTerminalKeyboard } from './hooks/useTerminalKeyboard';
import { useTerminalSearch } from './hooks/useTerminalSearch';
import { useTerminalContextMenu } from './hooks/useTerminalContextMenu';
import { useTerminalDnd } from './hooks/useTerminalDnd';
import { useProjectTabOrder } from './hooks/useProjectTabOrder';
import { useHiddenAgents } from './hooks/useHiddenAgents';
import { getAutoLayout } from './constants';
import type { LayoutPreset } from './types';
import TerminalGrid from './components/TerminalGrid';
import ProjectTabBar from './components/ProjectTabBar';
import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import BroadcastIndicator from './components/BroadcastIndicator';
import ContextMenu from './components/ContextMenu';
import 'xterm/css/xterm.css';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

// Lazy-load NewChatModal only when needed
import dynamic from 'next/dynamic';
const NewChatModal = dynamic(() => import('@/components/NewChatModal'), { ssr: false });

/** Set once per window: this is what makes autostart a launch event rather
 *  than a navigation one. */
const LAUNCH_AUTOSTART_KEY = 'tars-launch-autostart-done';

export default function TerminalsView() {
  const {
    agents,
    isLoading,
    startAgent,
    stopAgent,
    wakeAgent,
    removeAgent,
    sendInput,
    createAgent,
  } = useElectronAgents();
  const { projects, openFolderDialog } = useElectronFS();
  const { installedSkills, refresh: refreshSkills } = useElectronSkills();

  // Read-only snapshot for callbacks that need the current agent list at call
  // time (e.g. a name lookup) without taking `agents` itself as a dependency:
  // `agents` gets a new identity on every agents:tick, even for a change to
  // an agent the callback has nothing to do with, so depending on it directly
  // recreates the callback - and every memoized prop built from it - twice a
  // second. The write happens in an effect, not inline during render: refs
  // may be torn under concurrent rendering, so only effects/handlers may
  // touch `.current`.
  const agentsRef = useRef(agents);
  useEffect(() => {
    agentsRef.current = agents;
  });

  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [viewFullscreen, setViewFullscreen] = useState(false);
  const lastCustomTabRef = useRef<{ type: 'custom'; tabId: string } | null>(null);
  const [terminalFontSize, setTerminalFontSize] = useState(11);
  const pendingStartRef = useRef<{ agentId: string; prompt: string; options?: { model?: string; provider?: import('@/types/electron').AgentProvider; localModel?: string } } | null>(null);
  const [terminalTheme, setTerminalTheme] = useState<'dark' | 'light'>('dark');
  const [terminalSettingsLoaded, setTerminalSettingsLoaded] = useState(!isElectron());
  // Remember last focused agent per custom tab so Ctrl+Tab restores focus where the user left it
  const lastFocusedByTabRef = useRef<Map<string, string>>(new Map());
  // Set by handleCycleTab; consumed by handleTerminalReady once the destination
  // tab's terminal finishes async init. Also consumed inline if the terminal is
  // already mounted (fast tab cycling).
  const pendingFocusRef = useRef<string | null>(null);
  // undefined until settings load, so the autostart effect waits rather than
  // guessing and starting agents the user has turned this off for.
  const [autoStartOnLaunch, setAutoStartOnLaunch] = useState<boolean | undefined>(undefined);

  // Load terminal settings from app settings
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.appSettings) {
      setTerminalSettingsLoaded(true);
      return;
    }
    window.electronAPI.appSettings.get().then((settings) => {
      if (settings) {
        if (settings.terminalFontSize) setTerminalFontSize(settings.terminalFontSize);
        if (settings.terminalTheme) setTerminalTheme(settings.terminalTheme);
        setAutoStartOnLaunch(settings.autoStartAgentsOnLaunch !== false);
      }
      setTerminalSettingsLoaded(true);
    });
  }, []);

  // Tab manager - core state for two-tier tab system
  const allAgentIds = useMemo(() => agents.map(a => a.id), [agents]);


  // Project folders with agents - offered as one-click boards in the tab bar
  const projectGroups = useMemo(() => {
    const byPath = new Map<string, string[]>();
    for (const a of agents) {
      if (!byPath.has(a.projectPath)) byPath.set(a.projectPath, []);
      byPath.get(a.projectPath)!.push(a.id);
    }
    return Array.from(byPath.entries()).map(([path, agentIds]) => ({
      name: path.split('/').pop() || path,
      path,
      agentIds,
    }));
  }, [agents]);
  const tabManager = useTabManager({ existingAgentIds: allAgentIds, isLoading });
  // Pull out the stable pieces: useTabManager returns a fresh object literal on
  // every render, so anything that depends on `tabManager` itself is unstable.
  const { activeTab, setActiveTab } = tabManager;

  // Project paths that currently have at least one agent. Keyed as a string so
  // the array identity survives an agents:tick that didn't change the set.
  // Otherwise the effect below would re-run twice a second. NUL is the one byte
  // a filesystem path cannot contain, so the join/split round-trip is lossless.
  const agentProjectPathsKey = useMemo(
    () => Array.from(new Set(agents.map(a => a.projectPath).filter(Boolean))).join('\u0000'),
    [agents]
  );
  const agentProjectPaths = useMemo(
    () => (agentProjectPathsKey ? agentProjectPathsKey.split('\u0000') : []),
    [agentProjectPathsKey]
  );

  // The strip's order is the user's, kept on this machine. `agentProjectPaths`
  // stays the source of truth for which projects exist.
  const { orderedPaths: orderedProjectPaths, reorder: reorderProjectTabs } =
    useProjectTabOrder(agentProjectPaths);

  // The board is project-driven: land on a real project instead of the empty
  // default custom tab, and follow along when the current project loses its
  // agents.
  //
  // This used to depend on the whole `tabManager` object and to redirect
  // whenever the active tab was not a project tab. Because that object is a new
  // literal every render the effect re-ran constantly, and, worse, it bounced
  // the user off any custom tab on the very next commit. Clicking the
  // already-active project tab runs the toggle-off branch below, which selects a
  // custom tab; the effect immediately forced the project tab back, unmounting
  // and remounting every TerminalPanel, which disposes and rebuilds every xterm
  // and replays each agent's full scrollback over IPC. So: depend only on the
  // stable `setActiveTab` plus the exact values read, and redirect only when the
  // active tab is genuinely unusable, never over a deliberately chosen custom tab.
  const didLandOnProjectRef = useRef(false);
  useEffect(() => {
    if (isLoading || agentProjectPaths.length === 0) return;
    if (activeTab.type === 'project') {
      didLandOnProjectRef.current = true;
      // Follow along only if this project no longer has any agents.
      if (!agentProjectPaths.includes(activeTab.projectPath)) {
        setActiveTab({ type: 'project', projectPath: agentProjectPaths[0] });
      }
      return;
    }
    // Custom tab: take over exactly once, to replace the empty default board on
    // first load. After that the user's tab choice stands.
    if (!didLandOnProjectRef.current) {
      didLandOnProjectRef.current = true;
      setActiveTab({ type: 'project', projectPath: agentProjectPaths[0] });
    }
  }, [activeTab, agentProjectPaths, isLoading, setActiveTab]);

  // Derive agents for current active tab.
  //
  // `agents` (the state array from useElectronAgents) gets a new top-level
  // identity whenever ANY agent's status/currentTask changes via agents:tick
  // - including agents on a project or tab that isn't even visible right
  // now. Recomputing the filtered list straight off `agents` therefore
  // builds a brand new array here every ~500ms, with the same agent objects
  // in it, and hands it down as a new `agents`/`filteredAgents` prop to
  // TerminalGrid/Sidebar/StatusBar. Nothing downstream is memoized against
  // object identity carefully enough to survive that: one agent's tick,
  // anywhere, re-renders the whole board.
  //
  // Same trick as agentProjectPathsKey above, one step further: build a
  // string signature of the filtered set (it only changes when a member is
  // added, removed, reordered, or has new status/task/activity data - see
  // useElectronAgents' onTick reducer for why that's exactly when an agent
  // object gets a new reference), then key the final useMemo on that string
  // instead of on computedFilteredAgents. Strings compare by value, so this
  // needs no ref and stays pure during render.
  const computedFilteredAgents = useMemo(() => {
    if (tabManager.isCustomTabActive && tabManager.activeCustomTab) {
      // Custom tab: agents in tab order
      const agentMap = new Map(agents.map(a => [a.id, a]));
      return tabManager.activeCustomTab.agentIds
        .map(id => agentMap.get(id))
        .filter((a): a is NonNullable<typeof a> => !!a);
    }
    if (tabManager.isProjectTabActive && tabManager.activeProjectPath) {
      // Project tab: every agent on that project, the orchestrator first so it
      // lands top-left. This is only the starting order: it feeds
      // generateLayout, which the saved layout overrides once the user has
      // dragged anything.
      const forProject = agents.filter(a => a.projectPath === tabManager.activeProjectPath);
      const rank = (a: typeof forProject[number]) => a.role === 'orchestrator' ? 0 : 1;
      return forProject.slice().sort((a, b) => rank(a) - rank(b));
    }
    return [];
  }, [agents, tabManager.isCustomTabActive, tabManager.isProjectTabActive, tabManager.activeCustomTab, tabManager.activeProjectPath]);
  // Which fields it reads, and why each: see panelAgentsKey.
  const filteredAgentsKey = useMemo(() => panelAgentsKey(computedFilteredAgents), [computedFilteredAgents]);
  const filteredAgents = useMemo(
    () => computedFilteredAgents,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on filteredAgentsKey on purpose, see comment above
    [filteredAgentsKey]
  );

  // Derive grid preset and editable state. A project tab has no stored layout,
  // so it follows the agent count instead of being frozen at 3x3 (four agents
  // must read as 2x2, not three on row one plus an orphan).
  // Both kinds of tab are arrangeable. Only custom tabs used to be, so inside a
  // project the panels were `static: true` and a drag did nothing at all: the
  // handle was there, the cursor changed, and the panel sprang back. The
  // layout store is keyed by tab id, and a project tab's id is its path, so
  // each project keeps its own arrangement.
  const isEditable = true;
  const tabType: 'custom' | 'project' = tabManager.isCustomTabActive ? 'custom' : 'project';
  const tabId = tabManager.isCustomTabActive && tabManager.activeCustomTab
    ? tabManager.activeCustomTab.id
    : tabManager.activeProjectPath || 'default';

  // Panels taken off this board. Project tabs only: a custom tab already has
  // its own membership list, and removing from one there is what it means.
  const hiddenAgents = useHiddenAgents(tabId);
  const visibleAgents = useMemo(
    () => (tabManager.isCustomTabActive ? filteredAgents : filteredAgents.filter(a => !hiddenAgents.hiddenIds.includes(a.id))),
    [filteredAgents, hiddenAgents.hiddenIds, tabManager.isCustomTabActive],
  );
  /** Hidden entries that still exist, so a deleted agent cannot linger. */
  const hiddenOnThisBoard = useMemo(
    () => filteredAgents.filter(a => hiddenAgents.hiddenIds.includes(a.id)),
    [filteredAgents, hiddenAgents.hiddenIds],
  );

  // The preset follows what is on screen: hiding a panel should re-flow the
  // board, not leave a gap where it was.
  const gridPreset: LayoutPreset = tabManager.activeCustomTab?.layout ?? getAutoLayout(visibleAgents.length);

  // Agent IDs for grid
  const agentIds = useMemo(() => visibleAgents.map(a => a.id), [visibleAgents]);

  // Set after multiTerminal is created; lets handleTerminalReady consume
  // pendingFocusRef without a circular dep.
  const focusTerminalRef = useRef<((agentId: string) => void) | null>(null);

  // Called when a terminal is fully initialized - fire any deferred agent start
  // and consume any pending Ctrl+Tab focus targeting this agent.
  const handleTerminalReady = useCallback((agentId: string) => {
    const pending = pendingStartRef.current;
    if (pending && pending.agentId === agentId) {
      pendingStartRef.current = null;
      startAgent(pending.agentId, pending.prompt, pending.options as { model?: string; resume?: boolean }).catch(error => {
        console.error('Failed to start agent after creation:', error);
      });
    }
    if (pendingFocusRef.current === agentId) {
      pendingFocusRef.current = null;
      focusTerminalRef.current?.(agentId);
    }
  }, [startAgent]);

  // Broadcast must be initialized before multiTerminal so we can pass broadcastMode
  const broadcast = useBroadcast();

  // Core hooks - delay terminal init until settings are loaded to avoid wrong font size
  const multiTerminal = useMultiTerminal({
    agents: terminalSettingsLoaded ? visibleAgents : [],
    initialFontSize: terminalFontSize,
    onFontSizeChange: (size) => {
      setTerminalFontSize(size);
      if (isElectron() && window.electronAPI?.appSettings) {
        window.electronAPI.appSettings.save({ terminalFontSize: size });
      }
    },
    theme: terminalTheme,
    onTerminalReady: handleTerminalReady,
    broadcastMode: broadcast.broadcastMode,
  });
  // Expose focusTerminal to handleTerminalReady via a ref to break the cycle.
  // Written in an effect, not during render: a ref assignment during render is
  // unsafe under concurrent rendering, and the only reader is a terminal-ready
  // callback that fires after commit.
  useEffect(() => {
    focusTerminalRef.current = multiTerminal.focusTerminal;
  }, [multiTerminal.focusTerminal]);

  // Prune lastFocusedByTabRef entries for tabs that no longer exist (mirrors
  // the cleanup useTabManager does for stale agent IDs and tab layouts).
  useEffect(() => {
    const validIds = new Set(tabManager.customTabs.map(t => t.id));
    for (const tabId of lastFocusedByTabRef.current.keys()) {
      if (!validIds.has(tabId)) lastFocusedByTabRef.current.delete(tabId);
    }
  }, [tabManager.customTabs]);

  const grid = useTerminalGrid({ agentIds, preset: gridPreset, isEditable, tabId });
  const search = useTerminalSearch(filteredAgents);
  const contextMenu = useTerminalContextMenu();

  // Dnd hook. onSkillDrop must be stable: useTerminalDnd threads it into
  // DndContext's onDragEnd, and a fresh closure every render defeats the
  // sensor/dropData memoization documented in useTerminalDnd.ts and
  // TerminalPanel.tsx.
  const handleSkillDrop = useCallback(async (skillName: string, agentId: string) => {
    await sendInput(agentId, `use this skill: ${skillName}\n`);
  }, [sendInput]);
  const dnd = useTerminalDnd({ onSkillDrop: handleSkillDrop });

  // ProjectTabBar is memoized and reads a stable `projectPaths` array (see
  // its own comment), which only helps if the click handler is stable too -
  // an inline arrow here would give it a new `onSelectProject` every render
  // and defeat that memo just as surely as the unstable array did.
  const handleSelectProject = useCallback((path: string) => {
    if (tabManager.activeTab.type === 'project' && tabManager.activeTab.projectPath === path) {
      // Toggle off: restore last custom tab, or fallback to first
      const restore = lastCustomTabRef.current;
      const target = restore && tabManager.customTabs.find(t => t.id === restore.tabId)
        ? restore
        : tabManager.customTabs[0] ? { type: 'custom' as const, tabId: tabManager.customTabs[0].id } : null;
      if (target) tabManager.setActiveTab(target);
    } else {
      // Save current custom tab before switching to project view
      if (tabManager.activeTab.type === 'custom') {
        lastCustomTabRef.current = { type: 'custom', tabId: tabManager.activeTab.tabId };
      }
      tabManager.setActiveTab({ type: 'project', projectPath: path });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- named fields of tabManager, not the object itself; see the comment on handleRemoveFromTab below
  }, [tabManager.activeTab, tabManager.customTabs, tabManager.setActiveTab]);

  // Handler callbacks
  // The main process refuses to start an agent whose folder is gone. That
  // rejection has to reach the screen: it used to be an unhandled promise, so
  // the click looked like it had worked and nothing happened.
  const [startError, setStartError] = useState<string | null>(null);
  const handleStartAgent = useCallback(async (agentId: string) => {
    setStartError(null);
    try {
      await startAgent(agentId, '', { resume: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // IPC wraps the main-process message; keep only the part worth reading.
      setStartError(message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
    }
  }, [startAgent]);

  const handleStopAgent = useCallback(async (agentId: string) => {
    await stopAgent(agentId);
  }, [stopAgent]);

  // The way back offered to a panel whose claude left fullscreen: the header's
  // stop, then its start, so the new session opens fullscreen and the wheel
  // scrolls again. A start that fails says why, as it does from the header.
  // A panel's `restart` (the left-fullscreen notice) continues the agent's
  // conversation (#138). A stop then a start began a new one, since a start
  // resumes only once per app run.
  const handleRestartAgent = useCallback(async (agentId: string) => {
    setStartError(null);
    try {
      const result = await window.electronAPI?.agent?.restart?.(agentId);
      // A launch that fails, or a restart already running, answers why: on
      // the line a failed start uses, rather than a click that did nothing.
      if (result && !result.success) setStartError(result.error || 'The agent could not be restarted.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStartError(message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
    }
  }, []);

  // A panel's `wake`: an asleep agent's CLI started again on its own
  // conversation (#322). Refused, or a launch that fails, it says why on the
  // line a failed start uses, and the agent stays asleep.
  const handleWakeAgent = useCallback(async (agentId: string) => {
    setStartError(null);
    try {
      const result = await wakeAgent(agentId);
      if (!result.success) setStartError(result.error || 'The agent could not be woken.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStartError(message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
    }
  }, [wakeAgent]);

  // Remove from tab (custom tabs): stop agent + remove from tab membership
  //
  // Deps here and below name the specific fields read, not `tabManager` or
  // `multiTerminal` themselves: both hooks return a fresh object literal on
  // every render (their individual fields are the stable, memoized part -
  // see the comments in useTabManager/useMultiTerminal), so depending on the
  // whole object recreated this callback - and every prop built from it -
  // every single render, defeating memoization on everything downstream.
  const handleRemoveFromTab = useCallback(async (agentId: string) => {
    if (tabManager.isCustomTabActive && tabManager.activeCustomTab) {
      await stopAgent(agentId);
      tabManager.removeAgentFromTab(tabManager.activeCustomTab.id, agentId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- named fields of tabManager, not the object itself; see comment above
  }, [stopAgent, tabManager.isCustomTabActive, tabManager.activeCustomTab, tabManager.removeAgentFromTab]);

  // For project tabs: full remove (backwards compat)
  const handleRemoveAgent = useCallback(async (agentId: string) => {
    if (tabManager.isCustomTabActive && tabManager.activeCustomTab) {
      // Custom tab: remove from tab, stop agent. The agent itself survives -
      // it still shows up under its project tab - so this needs no confirm.
      await stopAgent(agentId);
      tabManager.removeAgentFromTab(tabManager.activeCustomTab.id, agentId);
    } else {
      // Project tab: take the panel off this board. The agent keeps running,
      // keeps its worktree, and stays reachable everywhere else; the tab strip
      // says how many are hidden and puts them back. Deleting for good is the
      // separate action below, because "not on this screen" and "gone, along
      // with everything uncommitted in its checkout" are not the same wish.
      hiddenAgents.hide(agentId);
      multiTerminal.unregisterContainer(agentId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- named fields of tabManager/multiTerminal, not the objects themselves; see comment above
  }, [stopAgent, multiTerminal.unregisterContainer, hiddenAgents.hide, tabManager.isCustomTabActive, tabManager.activeCustomTab, tabManager.removeAgentFromTab]);

  const handleFocusPanel = useCallback((agentId: string) => {
    setFocusedPanelId(agentId);
    multiTerminal.focusTerminal(agentId);
    if (tabManager.isCustomTabActive && tabManager.activeCustomTab) {
      lastFocusedByTabRef.current.set(tabManager.activeCustomTab.id, agentId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- named fields of tabManager/multiTerminal, not the objects themselves; see comment above
  }, [multiTerminal.focusTerminal, tabManager.isCustomTabActive, tabManager.activeCustomTab]);

  // Ctrl+Tab / Ctrl+Shift+Tab: cycle through custom tabs (browser-style),
  // restoring focus to the last focused agent in the destination tab.
  const handleCycleTab = useCallback((direction: 'next' | 'prev') => {
    const tabs = tabManager.customTabs;
    if (tabs.length < 2) return;

    const currentIdx = tabManager.isCustomTabActive && tabManager.activeCustomTab
      ? tabs.findIndex(t => t.id === tabManager.activeCustomTab!.id)
      : 0;
    const step = direction === 'next' ? 1 : tabs.length - 1;
    const nextTab = tabs[(currentIdx + step) % tabs.length];

    // Resolve the focus target: last focused agent in the destination tab if
    // it's still a member, otherwise the first agent. Empty tabs get nothing.
    const remembered = lastFocusedByTabRef.current.get(nextTab.id);
    const targetAgentId = remembered && nextTab.agentIds.includes(remembered)
      ? remembered
      : nextTab.agentIds[0];

    tabManager.setActiveTab({ type: 'custom', tabId: nextTab.id });

    if (targetAgentId) {
      setFocusedPanelId(targetAgentId);
      // Switching tabs re-mounts terminals (registerContainer disposes the old
      // one and asynchronously inits a new xterm). Stash the focus target -
      // handleTerminalReady will consume it once the new terminal is ready.
      pendingFocusRef.current = targetAgentId;
      // Also try immediately in case the terminal happens to already be live
      // (no-op if it's not yet registered).
      multiTerminal.focusTerminal(targetAgentId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- named fields of tabManager/multiTerminal, not the objects themselves; see comment above
  }, [tabManager.customTabs, tabManager.isCustomTabActive, tabManager.activeCustomTab, tabManager.setActiveTab, multiTerminal.focusTerminal]);

  // Keyboard shortcuts (must come after handler declarations to avoid TDZ)
  const visibleAgentIds = useMemo(
    () => grid.visiblePanels.map(p => p.agentId),
    [grid.visiblePanels]
  );

  useTerminalKeyboard({
    panelAgentIds: visibleAgentIds,
    onFocusPanel: handleFocusPanel,
    onToggleFullscreen: () => grid.toggleFullscreen(focusedPanelId || undefined),
    onToggleBroadcast: broadcast.toggleBroadcast,
    onToggleSidebar: () => { },
    onNewAgent: () => setShowNewChatModal(true),
    onExitFullscreen: grid.exitFullscreen,
    onCycleTab: handleCycleTab,
    isFullscreen: !!grid.fullscreenPanelId,
  });

  const handleClosePanel = useCallback(() => setPanelOpen(false), []);

  // The panel's own text first: since #127 the main process answers with a
  // redraw of the screen, escape sequences and all, where the panel has the
  // lines as they read. The redraw is only for a panel with no terminal.
  const terminalText = multiTerminal.terminalText;
  const handleCopyOutput = useCallback(async (agentId: string) => {
    let output = terminalText(agentId);
    if (!output) {
      // The list no longer carries the scrollback, so ask for this one agent.
      const full = await window.electronAPI?.agent?.get(agentId);
      output = full?.output?.join('') ?? '';
    }
    if (output) navigator.clipboard.writeText(output).catch(() => { });
  }, [terminalText]);

  const handleNewAgent = useCallback(async (
    projectPath: string,
    skills: string[],
    prompt: string,
    model?: string,
    worktree?: { enabled: boolean; branchName: string },
    character?: string,
    name?: string,
    secondaryProjectPath?: string,
    permissionMode?: 'normal' | 'auto' | 'bypass',
    provider?: import('@/types/electron').AgentProvider,
    localModel?: string,
    obsidianVaultPaths?: string[],
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    role?: 'orchestrator' | 'worker',
    cliPath?: string,
  ) => {
    try {
      const resolvedModel = (provider !== 'local' && model && model !== 'default') ? model : undefined;
      const agent = await createAgent({
        projectPath,
        skills,
        worktree,
        character: character as import('@/types/electron').AgentCharacter,
        name,
        secondaryProjectPath,
        permissionMode,
        effort,
        provider,
        model: resolvedModel,
        localModel,
        obsidianVaultPaths,
        role,
        cliPath,
      });
      // Auto-add to active custom tab
      if (tabManager.isCustomTabActive && tabManager.activeCustomTab) {
        tabManager.addAgentToTab(tabManager.activeCustomTab.id, agent.id);
      }
      // Defer start until the terminal for this agent is initialized.
      // The onTerminalReady callback will fire startAgent once xterm is ready.
      if (prompt) {
        pendingStartRef.current = { agentId: agent.id, prompt, options: { model: resolvedModel, provider, localModel } };
      }
      setShowNewChatModal(false);
    } catch (error) {
      // This used to be an unhandled rejection: the dialog's own submit
      // handler now awaits this promise and wipes every field it just
      // collected the instant it resolves, success or not. Catching here and
      // reporting failure back keeps a failed create from losing the form.
      console.error('Failed to create agent:', error);
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- named fields of tabManager, not the object itself; see comment on handleRemoveFromTab above
  }, [createAgent, tabManager.isCustomTabActive, tabManager.activeCustomTab, tabManager.addAgentToTab]);

  // Each project starts its agents once, the first time you look at it.
  //
  // The original code resumed every idle agent on every mount, so leaving the
  // dashboard and coming back silently spawned sessions nobody asked for and
  // burned tokens - which is why it was removed wholesale. That also removed
  // what people actually want: open a project and see the CLI already running
  // instead of a bare shell with a button to press.
  //
  // The seen-set is what separates the two. A project is auto-started the first
  // time it is displayed in this window and never again, so switching tabs back
  // and forth stays inert. It is per window, so quitting and relaunching gives
  // you a running board again.
  const startedProjectsRef = useRef<Set<string>>(new Set());
  const visibleProjectPath = tabManager.activeTab.type === 'project' ? tabManager.activeTab.projectPath : null;

  useEffect(() => {
    if (isLoading) return;                           // wait for the real list
    if (autoStartOnLaunch === undefined) return;     // wait for settings
    if (!autoStartOnLaunch) return;
    if (typeof window === 'undefined') return;

    // Which agents are on screen right now: the open project, or everything on
    // a custom tab.
    const onScreen = visibleProjectPath
      ? agents.filter(a => a.projectPath === visibleProjectPath)
      : filteredAgents;
    if (onScreen.length === 0) return;

    const scope = visibleProjectPath ?? '__custom__';
    if (startedProjectsRef.current.has(scope)) return;
    startedProjectsRef.current.add(scope);

    // Only agents left with no live terminal. One already attached to a PTY is
    // mid-session and must not be resumed underneath it. A missing folder is
    // refused by the main process anyway, but skip it rather than collect an
    // error banner on every project you open.
    const toResume = onScreen.filter(a => !a.ptyId && a.status === 'idle' && !a.pathMissing);
    for (const agent of toResume) {
      startAgent(agent.id, '', { resume: true }).catch(err => {
        console.error(`[autostart] ${agent.name || agent.id}:`, err);
      });
    }
  }, [agents, filteredAgents, visibleProjectPath, isLoading, autoStartOnLaunch, startAgent]);

  // Exit view fullscreen on Escape
  useEffect(() => {
    if (!viewFullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewFullscreen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [viewFullscreen]);

  // Re-fit terminals when the view goes fullscreen.
  //
  // multiTerminal is a fresh object every render, so depending on it re-ran
  // this on every agents:tick: a full xterm refit of every pane, twice a
  // second. Only the fullscreen flag should trigger it.
  const fitAllRef = useRef(multiTerminal.fitAll);
  useEffect(() => {
    fitAllRef.current = multiTerminal.fitAll;
  });
  useEffect(() => {
    const timer = setTimeout(() => fitAllRef.current(), 100);
    return () => clearTimeout(timer);
  }, [viewFullscreen]);

  // Branch of the tab the board is showing - the focused agent wins, otherwise
  // the first one in the tab. Feeds the status bar's right-hand slot.
  const currentBranch = useMemo(() => {
    const focused = filteredAgents.find(a => a.id === focusedPanelId);
    return (focused ?? filteredAgents[0])?.branchName;
  }, [filteredAgents, focusedPanelId]);

  return (
    <DndContext sensors={dnd.sensors} onDragEnd={dnd.handleDragEnd}>
      <div className={`flex flex-col overflow-hidden ${viewFullscreen ? 'fixed inset-0 z-[100] bg-background window-no-drag pt-7' : 'h-full w-full relative'}`}>
        {/* Broadcast overlay */}
        <BroadcastIndicator active={broadcast.broadcastMode} />

        {/* Project tabs - the board follows your project folders. First element
            of the frame: the layout and + Terminal controls live in the page
            header now, not in a toolbar above the strip. */}
        <ProjectTabBar
          projectPaths={orderedProjectPaths}
          activeTab={tabManager.activeTab}
          onSelectProject={handleSelectProject}
          onReorder={reorderProjectTabs}
          hidden={hiddenOnThisBoard.map(a => ({ id: a.id, name: a.name || a.id }))}
          onShow={hiddenAgents.show}
          onShowAll={hiddenAgents.showAll}
        />

        {/* A start that was refused. The main process explains why - a folder
            that no longer exists is the common one - and this is the only place
            the user would ever see it. */}
        {startError && (
          <div className="mt-2 flex items-center gap-3 border border-danger/40 bg-danger-muted px-3 py-2">
            <span className="w-1.5 h-1.5 bg-danger shrink-0" />
            <p className="flex-1 text-xs text-foreground">{startError}</p>
            <button
              type="button"
              onClick={() => setStartError(null)}
              className="font-mono text-[11px] lowercase text-muted-foreground hover:text-foreground cursor-pointer"
            >
              dismiss
            </button>
          </div>
        )}

        {/* Terminal grid - takes full space, relative for sidebar panel */}
        <div className="flex-1 min-h-0 relative mt-2">
          <TerminalGrid
            agents={filteredAgents}
            visiblePanels={grid.visiblePanels}
            rglLayout={grid.rglLayout}
            cols={grid.cols}
            rows={grid.gridDefinition.rows}
            onDragStop={grid.onDragStop}
            broadcastMode={broadcast.broadcastMode}
            focusedPanelId={focusedPanelId}
            fullscreenPanelId={grid.fullscreenPanelId}
            isLoading={isLoading}
            isEditable={isEditable}
            tabType={tabType}
            onRegisterContainer={multiTerminal.registerContainer}
            onStartAgent={handleStartAgent}
            onStopAgent={handleStopAgent}
            onRestartAgent={handleRestartAgent}
            onWakeAgent={handleWakeAgent}
            onRemoveAgent={handleRemoveAgent}
            onClearTerminal={multiTerminal.clearTerminal}
            onFullscreenPanel={grid.fullscreenPanel}
            onExitFullscreen={grid.exitFullscreen}
            onFocusPanel={handleFocusPanel}
            onContextMenu={contextMenu.openMenu}
            onFitAll={multiTerminal.fitAll}
          />

          {/* Sidebar panel - overlays grid from the right */}
          <Sidebar
            open={panelOpen}
            onClose={handleClosePanel}
            agents={filteredAgents}
            focusedPanelId={focusedPanelId}
            onFocusPanel={handleFocusPanel}
            onStartAgent={handleStartAgent}
            onStopAgent={handleStopAgent}
            installedSkills={installedSkills}
          />
        </div>

        {/* Status bar - full-bleed chrome at the bottom of the frame */}
        <StatusBar agents={filteredAgents} branch={currentBranch} />

        {/* Context menu */}
        <ContextMenu
          state={contextMenu.menuState}
          agent={contextMenu.menuState.agentId ? agents.find(a => a.id === contextMenu.menuState.agentId) || null : null}
          onClose={contextMenu.closeMenu}
          onStart={handleStartAgent}
          onStop={handleStopAgent}
          onClear={multiTerminal.clearTerminal}
          onFullscreen={grid.fullscreenPanel}
          onCopyOutput={handleCopyOutput}
        />

        {/* New Chat Modal */}
        {showNewChatModal && (
          <NewChatModal
            open={showNewChatModal}
            onClose={() => setShowNewChatModal(false)}
            onSubmit={handleNewAgent}
            projects={projects}
            onBrowseFolder={openFolderDialog}
            installedSkills={installedSkills}
            onRefreshSkills={refreshSkills}
          />
        )}
      </div>
    </DndContext>
  );
}
