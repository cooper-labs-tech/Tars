'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import type { AgentStatus, AgentEvent, ElectronAPI, AgentCharacter, AgentProvider } from '@/types/electron';

// Check if we're running in Electron
export const isElectron = (): boolean => {
  return typeof window !== 'undefined' && window.electronAPI !== undefined;
};

/** A wake on its way as one comparable value: who, how and since when. */
const wakingKey = (waking: AgentStatus['waking']) => (waking ? `${waking.by}\u0000${waking.via}\u0000${waking.since}` : '');

// Hook for agent management via Electron IPC
export function useElectronAgents() {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Mirror of `agents`, readable from event callbacks without making them
  // depend on the current state. Kept in sync after every commit so the
  // agents:tick handler can compare *outside* of a setState updater (see the
  // comment on onTick below).
  const agentsRef = useRef<AgentStatus[]>([]);
  useEffect(() => {
    agentsRef.current = agents;
  });

  // Fetch all agents
  const fetchAgents = useCallback(async () => {
    if (!isElectron()) {
      setIsLoading(false);
      return;
    }

    try {
      const list = await window.electronAPI!.agent.list();
      // Only update state if data has actually changed to prevent unnecessary re-renders
      setAgents(prev => {
        // Quick length check first
        if (prev.length !== list.length) return list;
        // Compare each agent's key fields
        const hasChanged = list.some((agent, i) => {
          const prevAgent = prev[i];
          return (
            prevAgent.id !== agent.id ||
            prevAgent.status !== agent.status ||
            prevAgent.currentTask !== agent.currentTask ||
            prevAgent.lastActivity !== agent.lastActivity ||
            prevAgent.error !== agent.error ||
            prevAgent.cliRunning !== agent.cliRunning ||
            prevAgent.leftFullscreen !== agent.leftFullscreen ||
            // A new terminal under the same agent: its panel resends its size.
            prevAgent.ptyId !== agent.ptyId ||
            // Another agent's save can take this one's role, and a role
            // change moves nothing else on the record.
            prevAgent.role !== agent.role ||
            // A rename, which every agent row draws the mark from.
            prevAgent.name !== agent.name ||
            // The Claude account it runs on, and the one it is pinned to,
            // which its account control names.
            prevAgent.claudeAccountId !== agent.claudeAccountId ||
            prevAgent.claudeAccountPin !== agent.claudeAccountPin ||
            // The last move by Tars, which its control's title tells.
            prevAgent.claudeAccountMove?.at !== agent.claudeAccountMove?.at ||
            // Asleep since when, and who is waking it: the line in place of
            // its task, branch or path says both.
            prevAgent.asleepSince !== agent.asleepSince ||
            wakingKey(prevAgent.waking) !== wakingKey(agent.waking)
          );
        });
        return hasChanged ? list : prev;
      });
    } catch (error) {
      console.error('Failed to fetch agents:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Create a new agent
  const createAgent = useCallback(async (config: {
    projectPath: string;
    skills: string[];
    worktree?: { enabled: boolean; branchName: string };
    character?: AgentCharacter;
    name?: string;
    secondaryProjectPath?: string;
    permissionMode?: 'normal' | 'auto' | 'bypass';
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    provider?: AgentProvider;
    model?: string;
    localModel?: string;
    obsidianVaultPaths?: string[];
    role?: 'orchestrator' | 'worker';
    cliPath?: string;
  }) => {
    if (!isElectron()) {
      throw new Error('Electron API not available');
    }
    const agent = await window.electronAPI!.agent.create(config);
    setAgents(prev => [...prev, agent]);
    // A new orchestrator takes the role from its project's current one, and
    // neither the answer nor the tick says so: the list is read again.
    if (config.role === 'orchestrator') await fetchAgents();
    return agent;
  }, [fetchAgents]);

  // Update an agent
  const updateAgent = useCallback(async (params: {
    id: string;
    projectPath?: string;
    skills?: string[];
    secondaryProjectPath?: string | null;
    permissionMode?: 'normal' | 'auto' | 'bypass';
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    name?: string;
    character?: AgentCharacter;
    model?: string | null;
    provider?: AgentProvider;
    localModel?: string | null;
    savedPrompt?: string | null;
    obsidianVaultPaths?: string[];
    worktree?: { enabled: boolean; branchName: string };
    role?: 'orchestrator' | 'worker';
    cliPath?: string | null;
  }) => {
    if (!isElectron()) {
      throw new Error('Electron API not available');
    }
    const result = await window.electronAPI!.agent.update(params);
    if (result.success && result.agent) {
      setAgents(prev => prev.map(a => a.id === params.id ? result.agent! : a));
      // Same as a create: the project's previous orchestrator is a worker now.
      if (params.role === 'orchestrator') await fetchAgents();
    }
    return result;
  }, [fetchAgents]);

  // Start an agent
  const startAgent = useCallback(async (
    id: string,
    prompt: string,
    options?: { model?: string; resume?: boolean; provider?: AgentProvider; localModel?: string }
  ) => {
    if (!isElectron()) {
      throw new Error('Electron API not available');
    }
    await window.electronAPI!.agent.start({ id, prompt, options });
    await fetchAgents();
  }, [fetchAgents]);

  // Stop an agent
  const stopAgent = useCallback(async (id: string) => {
    if (!isElectron()) {
      throw new Error('Electron API not available');
    }
    await window.electronAPI!.agent.stop(id);
    await fetchAgents();
  }, [fetchAgents]);

  // Wake an asleep agent on its own conversation, nothing typed (#322). The
  // answer says why when it is refused: not asleep, or a launch that failed,
  // after which it stays asleep.
  const wakeAgent = useCallback(async (id: string) => {
    if (!isElectron()) {
      throw new Error('Electron API not available');
    }
    const result = await window.electronAPI!.agent.wake(id);
    await fetchAgents();
    return result;
  }, [fetchAgents]);

  // Remove an agent
  const removeAgent = useCallback(async (id: string) => {
    if (!isElectron()) {
      throw new Error('Electron API not available');
    }
    await window.electronAPI!.agent.remove(id);
    setAgents(prev => prev.filter(a => a.id !== id));
  }, []);

  // Send input to an agent
  const sendInput = useCallback(async (id: string, input: string) => {
    if (!isElectron()) {
      throw new Error('Electron API not available');
    }
    await window.electronAPI!.agent.sendInput({ id, input });
  }, []);

  // Subscribe to agent events
  useEffect(() => {
    if (!isElectron()) return;

    // Output and error events are handled directly by xterm.js terminals.
    // We do NOT update React state here. Doing so on every output chunk
    // causes "Maximum update depth exceeded" because high-frequency PTY
    // output triggers a re-render cascade.
    const unsubOutput = window.electronAPI!.agent.onOutput(() => {});

    const unsubError = window.electronAPI!.agent.onError(() => {});

    const unsubComplete = window.electronAPI!.agent.onComplete(() => {
      fetchAgents();
    });

    const unsubStatus = window.electronAPI!.agent.onStatus?.((event: { agentId: string; status: string; timestamp: string }) => {
      // Neither this event nor the tick says why an agent is in error: the
      // reason is only on the full record. Patching the status alone put
      // `error` beside whatever reason this copy last read, which is nothing
      // for a first failure and the previous failure's sentence for a second.
      if (event.status === 'error') {
        fetchAgents();
        return;
      }
      setAgents(prev => prev.map(a =>
        a.id === event.agentId
          ? { ...a, status: event.status as AgentStatus['status'], lastActivity: event.timestamp || new Date().toISOString() }
          : a
      ));
    });

    // An agent's Claude account or pin, changed from this window's control,
    // from another window, or by main itself: main says it to every window
    // with both fields, so the agent is patched where it is.
    const unsubAccount = window.electronAPI!.claudeAccounts?.onAgentChanged?.((change) => {
      setAgents(prev => prev.map(a => a.id === change.agentId
        ? { ...a, claudeAccountId: change.claudeAccountId ?? undefined, claudeAccountPin: change.claudeAccountPin ?? undefined }
        : a));
    });
    // A move by Tars, kept on the agent for its control's title; the new
    // account follows on onAgentChanged.
    const unsubMove = window.electronAPI!.claudeAccounts?.onAgentMoved?.((move) => {
      setAgents(prev => prev.map(a => a.id === move.agentId ? { ...a, claudeAccountMove: move } : a));
    });

    // Also subscribe to agents:tick for reliable live status updates
    // (proven to reach all windows: tray panel uses this successfully)
    const unsubTick = window.electronAPI!.agent.onTick?.((tickAgents) => {
      // If agent count changed, refetch full data (tick only has partial fields).
      // This comparison and the fetch used to live *inside* the setAgents
      // updater below, which made the updater impure: React may invoke an
      // updater more than once per dispatch (StrictMode double-invocation in
      // dev, re-invocation on a concurrent re-render), so a single tick could
      // fire several duplicate `agent:list` IPC round trips. The count is
      // therefore read from a ref, outside the updater, and the updater below
      // stays a pure function of `prev`.
      const known = agentsRef.current;
      if (known.length !== tickAgents.length) {
        fetchAgents();
        return;
      }
      // An agent that has just entered error is read again rather than
      // patched, for the reason given on onStatus above. The watches that
      // mark a task that never started only send this tick, not a status
      // event, so the check has to be here as well.
      const enteredError = tickAgents.some(t =>
        t.status === 'error' && known.find(a => a.id === t.id)?.status !== 'error',
      );
      if (enteredError) {
        fetchAgents();
        return;
      }
      setAgents(prev => {
        // Check if any status, currentTask or running CLI changed. A CLI starts
        // and exits without the status moving (/exit, or claude left at its
        // prompt by a failed turn), and the panel's start/stop follows it. The
        // same for a claude that left fullscreen: its panel says so, and for a
        // launch on its way, which no status change announces (a restart keeps
        // idle): the Chat counts it neither stopped nor idle.
        const changed = (a: AgentStatus, t: (typeof tickAgents)[number]) =>
          a.status !== t.status || a.currentTask !== t.currentTask || a.cliRunning !== t.cliRunning ||
          a.leftFullscreen !== t.leftFullscreen || !!a.launching !== !!t.launching ||
          // Asleep since when, and who is waking it (#322): the tick carries both.
          a.asleepSince !== t.asleepSince || wakingKey(a.waking) !== wakingKey(t.waking);
        const hasChange = tickAgents.some(t => {
          const existing = prev.find(a => a.id === t.id);
          return existing && changed(existing, t);
        });
        if (!hasChange) return prev;
        return prev.map(a => {
          const tick = tickAgents.find(t => t.id === a.id);
          if (tick && changed(a, tick)) {
            return { ...a, status: tick.status as AgentStatus['status'], currentTask: tick.currentTask, lastActivity: tick.lastActivity, cliRunning: tick.cliRunning, leftFullscreen: tick.leftFullscreen, launching: tick.launching, asleepSince: tick.asleepSince, waking: tick.waking };
          }
          return a;
        });
      });
    });

    return () => {
      unsubOutput();
      unsubError();
      unsubComplete();
      unsubStatus?.();
      unsubTick?.();
      unsubAccount?.();
      unsubMove?.();
    };
  }, [fetchAgents]);

  // Initial fetch
  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  return {
    agents,
    isLoading,
    isElectron: isElectron(),
    createAgent,
    updateAgent,
    startAgent,
    stopAgent,
    wakeAgent,
    removeAgent,
    sendInput,
    refresh: fetchAgents,
  };
}

// Hook for skill management via Electron IPC
export function useElectronSkills() {
  const [installedSkillsByProvider, setInstalledSkillsByProvider] = useState<Record<string, string[]>>({});
  const [isLoading, setIsLoading] = useState(true);

  // Flat list derived from all providers (backward compat)
  const installedSkills = useMemo(() => {
    const all = new Set<string>();
    for (const skills of Object.values(installedSkillsByProvider)) {
      for (const s of skills) all.add(s);
    }
    return Array.from(all);
  }, [installedSkillsByProvider]);

  const isSkillInstalledOn = useCallback((name: string, provider: string): boolean => {
    const skills = installedSkillsByProvider[provider];
    if (!skills) return false;
    return skills.some(s => s.toLowerCase() === name.toLowerCase());
  }, [installedSkillsByProvider]);

  const fetchInstalledSkills = useCallback(async () => {
    if (!isElectron()) {
      setIsLoading(false);
      return;
    }

    try {
      const byProvider = await window.electronAPI!.skill.listInstalledAll();
      setInstalledSkillsByProvider(byProvider);
    } catch (error) {
      console.error('Failed to fetch installed skills:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const installSkill = useCallback(async (repo: string) => {
    if (!isElectron()) {
      throw new Error('Electron API not available');
    }
    const result = await window.electronAPI!.skill.install(repo);
    await fetchInstalledSkills();
    return result;
  }, [fetchInstalledSkills]);

  const linkToProvider = useCallback(async (skillName: string, providerId: string) => {
    if (!isElectron()) {
      throw new Error('Electron API not available');
    }
    return window.electronAPI!.skill.linkToProvider({ skillName, providerId });
  }, []);

  useEffect(() => {
    fetchInstalledSkills();
  }, [fetchInstalledSkills]);

  return {
    installedSkills,
    installedSkillsByProvider,
    isSkillInstalledOn,
    isLoading,
    isElectron: isElectron(),
    installSkill,
    linkToProvider,
    refresh: fetchInstalledSkills,
  };
}

// Hook for file system operations via Electron IPC
export function useElectronFS() {
  const [projects, setProjects] = useState<{ path: string; name: string; lastModified?: string; custom?: boolean }[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchProjects = useCallback(async () => {
    if (!isElectron()) {
      setIsLoading(false);
      return;
    }

    try {
      const list = await window.electronAPI!.fs.listProjects();
      // Filter out worktree paths to avoid duplicate React keys
      setProjects(list.filter((p: { path: string }) => !p.path.includes('/.worktrees/')));
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const openFolderDialog = useCallback(async () => {
    if (!isElectron()) {
      throw new Error('Electron API not available');
    }
    return window.electronAPI!.dialog.openFolder();
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  return {
    projects,
    isLoading,
    isElectron: isElectron(),
    openFolderDialog,
    refresh: fetchProjects,
  };
}

// Hook for shell operations via Electron IPC
export function useElectronShell() {
  // Directory only. The `command` this used to forward was removed from the
  // handler: it was pasted into an AppleScript literal and executed.
  const openTerminal = useCallback(async (cwd: string) => {
    if (!isElectron()) {
      throw new Error('Electron API not available');
    }
    return window.electronAPI!.shell.openTerminal({ cwd });
  }, []);

  // There is deliberately no general exec: the renderer asks for a CLI's
  // version, a repository's branch or a path to be revealed, by name.
  const cliVersion = useCallback(async (binary: string) => {
    if (!isElectron()) throw new Error('Electron API not available');
    return window.electronAPI!.shell.version(binary);
  }, []);

  return {
    isElectron: isElectron(),
    openTerminal,
    cliVersion,
  };
}
