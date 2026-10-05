'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { useClaude, useSessionMessages } from '@/hooks/useClaude';
import { useElectronAgents, useElectronFS, useElectronSkills, isElectron } from '@/hooks/useElectron';
import type { ClaudeProject } from '@/lib/claude-code';
import type { AgentStatus, AgentCharacter } from '@/types/electron';
import NewChatModal from '@/components/NewChatModal';
import { BrandSpinner, Button, DialogShell, ErrorState, LoadingState, MetaChip, PageHeader, Panel, PanelCaption, StatusSquare } from '@/components/ui';
import { STATUS_COLORS, statusTone, statusWord } from '@/app/agents/constants';
import { wakingLine } from '@/lib/asleep-line';
import { lastActiveLabel } from '@/lib/last-active';

// xterm touches `window` at import time, so the terminal only ever loads in the
// browser - same reason Dashboard loads TerminalsView this way.
const Terminal = dynamic(() => import('@/components/Terminal'), { ssr: false });

// Row actions are words, not glyphs (R7): one 26px bordered lowercase-mono
// button each.
const ROW_ACTION = 'font-mono lowercase';

// Storage key (custom projects still use localStorage, hidden/default use app settings)
const CUSTOM_PROJECTS_KEY = 'dorothy-custom-projects';

interface CustomProject {
  path: string;
  name: string;
  addedAt: string;
}

// Strip ANSI codes from git output
const stripAnsi = (str: string): string => {
   
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
};

export default function ProjectsPage() {
  const { data, loading, error, refresh } = useClaude();
  const { agents, createAgent, startAgent, wakeAgent, isElectron: hasElectron } = useElectronAgents();
  const { projects: electronProjects, openFolderDialog } = useElectronFS();
  const { installedSkills, refresh: refreshSkills } = useElectronSkills();
  const [selectedProject, setSelectedProject] = useState<ClaudeProject | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [hiddenProjects, setHiddenProjects] = useState<string[]>([]);
  const [customProjects, setCustomProjects] = useState<CustomProject[]>([]);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [defaultProjectPath, setDefaultProjectPath] = useState<string>('');

  // Agent dialog state
  const [showAgentDialog, setShowAgentDialog] = useState(false);
  // Default project confirmation dialog
  const [pendingDefaultPath, setPendingDefaultPath] = useState<string | null>(null);
  // Project terminal dialog: the id of the live PTY, plus the folder it opened in
  const [terminalPty, setTerminalPty] = useState<{ id: string; cwd: string } | null>(null);
  const [terminalOpening, setTerminalOpening] = useState(false);

  // Load git branch for selected project
  const loadGitBranch = useCallback(async (projectPath: string) => {
    if (!projectPath || typeof window === 'undefined' || !window.electronAPI?.shell?.branch) {
      setGitBranch(null);
      return;
    }

    setGitLoading(true);
    try {
      const result = await window.electronAPI.shell.branch(projectPath);

      if (result.success && result.output) {
        const branch = stripAnsi(result.output).replace(/\r/g, '').trim();
        setGitBranch(branch || null);
      } else {
        setGitBranch(null);
      }
    } catch (err) {
      console.error('Failed to get git branch:', err);
      setGitBranch(null);
    } finally {
      setGitLoading(false);
    }
  }, []);

  // Load git branch when project is selected
  useEffect(() => {
    if (selectedProject) {
      loadGitBranch(selectedProject.path);
    } else {
      setGitBranch(null);
    }
  }, [selectedProject, loadGitBranch]);

  // Open a shell in the project folder.
  //
  // This button used to call `window.electronAPI.shell.openTerminal(...)`. That
  // method was deleted from the preload bridge when shell.exec and friends were
  // removed, but the call site and its `electron.d.ts` declaration stayed - so
  // the optional chain stopped at `shell` (which exists), `.openTerminal` was
  // `undefined`, and every click threw a TypeError inside the handler. The
  // button was dead in every shipped build, silently.
  //
  // It now runs on `pty:create`, which the bridge really does expose, and the
  // shell appears in-app instead of in Terminal.app.
  const openProjectTerminal = useCallback(async (projectPath: string) => {
    if (!window.electronAPI?.pty?.create) return;
    setTerminalOpening(true);
    try {
      const { id } = await window.electronAPI.pty.create({ cwd: projectPath });
      setTerminalPty({ id, cwd: projectPath });
    } catch (err) {
      console.error('Failed to open terminal:', err);
    } finally {
      setTerminalOpening(false);
    }
  }, []);

  const closeProjectTerminal = useCallback(() => setTerminalPty(null), []);

  // One effect owns the PTY's lifetime. It subscribes so a shell that exits on
  // its own (`exit`, Ctrl-D) takes the dialog with it, and its cleanup kills the
  // process - which covers closing the dialog and navigating away from the page
  // alike. Without that kill an orphaned login shell would sit in the main
  // process with nothing attached to read it. Killing an id that already exited
  // is a no-op in the handler.
  useEffect(() => {
    if (!terminalPty) return;
    const ptyId = terminalPty.id;
    const unsubscribe = window.electronAPI?.pty?.onExit(({ id }) => {
      if (id === ptyId) setTerminalPty(null);
    });
    return () => {
      unsubscribe?.();
      window.electronAPI?.pty?.kill({ id: ptyId }).catch(() => {});
    };
  }, [terminalPty]);

  // Custom projects live in ~/.dorothy/projects.json (main process): they
  // survive app updates and every surface sees them (agent creation, team
  // deployment, Brain). Anything left in localStorage is migrated once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const legacyRaw = localStorage.getItem(CUSTOM_PROJECTS_KEY);
        if (legacyRaw) {
          const legacy = JSON.parse(legacyRaw) as CustomProject[];
          for (const p of legacy) {
            if (p?.path) await window.electronAPI?.fs?.addCustomProject(p.path);
          }
          localStorage.removeItem(CUSTOM_PROJECTS_KEY);
        }
      } catch (err) {
        console.error('Failed to migrate custom projects:', err);
      }
      const list = await window.electronAPI?.fs?.listProjects().catch(() => []);
      if (cancelled || !list) return;
      setCustomProjects(list.filter(p => p.custom).map(p => ({
        path: p.path, name: p.name, addedAt: p.lastModified ?? '',
      })));
    })();
    return () => { cancelled = true; };
  }, []);

  // Add a new project
  const handleAddProject = async () => {
    if (!openFolderDialog) return;
    try {
      const selectedPath = await openFolderDialog();
      if (selectedPath) {
        const normalizedPath = selectedPath.replace(/\/+$/, '');
        const existsInCustom = customProjects.some(p => p.path.replace(/\/+$/, '').toLowerCase() === normalizedPath.toLowerCase());
        if (!existsInCustom) {
          const name = selectedPath.split('/').pop() || 'Unknown Project';
          await window.electronAPI?.fs?.addCustomProject(normalizedPath);
          setCustomProjects([...customProjects, { path: normalizedPath, name, addedAt: new Date().toISOString() }]);
        }
      }
    } catch (err) {
      console.error('Failed to add project:', err);
    }
  };

  // Remove a custom project
  const handleRemoveProject = (projectPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    window.electronAPI?.fs?.removeCustomProject(projectPath);
    setCustomProjects(customProjects.filter(p => p.path !== projectPath));
    if (selectedProject?.path === projectPath) {
      setSelectedProject(null);
    }
  };

  // Check if a project is custom
  const isCustomProject = (projectPath: string) => {
    return customProjects.some(p => p.path === projectPath);
  };

  // Load hidden & default from app settings (file-based, persists across restarts)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.appSettings?.get) return;
    window.electronAPI.appSettings.get().then((settings: Record<string, unknown>) => {
      if (Array.isArray(settings?.hiddenProjects)) setHiddenProjects(settings.hiddenProjects as string[]);
      if (typeof settings?.defaultProjectPath === 'string') setDefaultProjectPath(settings.defaultProjectPath);
      // Favourites are no longer shown on this page, but the setting is still
      // read by NewChatModal - fold any legacy localStorage list into it once
      // so nothing is stranded.
      try {
        const stored = localStorage.getItem('dorothy-favorite-projects');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const existing = Array.isArray(settings?.favoriteProjects) ? settings.favoriteProjects as string[] : [];
            window.electronAPI?.appSettings?.save({
              favoriteProjects: Array.from(new Set([...existing, ...parsed])),
            });
          }
          localStorage.removeItem('dorothy-favorite-projects');
        }
      } catch {}
    }).catch(() => {});
  }, []);

  // Save hidden to app settings
  const saveHidden = (newHidden: string[]) => {
    setHiddenProjects(newHidden);
    window.electronAPI?.appSettings?.save({ hiddenProjects: newHidden });
  };

  // Toggle hidden (stored by path for cross-component compatibility)
  const toggleHidden = (projectPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (hiddenProjects.includes(projectPath)) {
      saveHidden(hiddenProjects.filter(p => p !== projectPath));
    } else {
      saveHidden([...hiddenProjects, projectPath]);
    }
  };

  const isHidden = (projectPath: string) => hiddenProjects.includes(projectPath);

  // Set default project (with confirmation if replacing)
  const handleSetDefault = (projectPath: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    // Unpin if already default
    if (defaultProjectPath === projectPath) {
      setDefaultProjectPath('');
      window.electronAPI?.appSettings?.save({ defaultProjectPath: '' });
      return;
    }
    // If another default exists, ask for confirmation
    if (defaultProjectPath) {
      setPendingDefaultPath(projectPath);
      return;
    }
    // No existing default, just set it
    setDefaultProjectPath(projectPath);
    window.electronAPI?.appSettings?.save({ defaultProjectPath: projectPath });
  };

  const confirmSetDefault = () => {
    if (pendingDefaultPath) {
      setDefaultProjectPath(pendingDefaultPath);
      window.electronAPI?.appSettings?.save({ defaultProjectPath: pendingDefaultPath });
      setPendingDefaultPath(null);
    }
  };

  const isDefaultProject = (projectPath: string) => defaultProjectPath === projectPath;

  // Normalize path for comparison
  const normalizePath = (p: string) => {
    const trimmed = p.replace(/\/+$/, '').toLowerCase();
    return trimmed === '' ? '/' : trimmed;
  };

  // Segment-boundary matching. The old version used endsWith(), and since
  // normalizing '/' produced an empty string, endsWith('') was true for every
  // path - one phantom card claimed every agent on the machine.
  const pathsMatch = (path1: string, path2: string) => {
    const a = normalizePath(path1);
    const b = normalizePath(path2);
    if (a === b) return true;
    return a.startsWith(b + '/') || b.startsWith(a + '/');
  };

  // Get agents for the selected project
  const projectAgents = selectedProject
    ? agents.filter(a => pathsMatch(a.projectPath, selectedProject.path))
    : [];

  // Handle creating a new agent
  const handleCreateAgent = async (
    projectPath: string,
    skills: string[],
    prompt: string,
    model?: string,
    worktree?: { enabled: boolean; branchName: string },
    character?: AgentCharacter,
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
        character,
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

      if (prompt) {
        setTimeout(async () => {
          await startAgent(agent.id, prompt, { model: resolvedModel, provider, localModel });
        }, 600);
      }

      setShowAgentDialog(false);
    } catch (err) {
      console.error('Failed to create agent:', err);
      // Tells the modal not to wipe what the user typed on a failed create.
      return false;
    }
  };

  // Handle restarting an agent
  const handleRestartAgent = async (agent: AgentStatus, resume: boolean = false) => {
    const prompt = resume ? '/resume' : 'Continue working on the previous task';
    try {
      await startAgent(agent.id, prompt, { resume });
    } catch (err) {
      console.error('Failed to restart agent:', err);
    }
  };

  const { messages, loading: messagesLoading } = useSessionMessages(
    selectedProject?.id || null,
    selectedSession
  );

  // Merge Claude Code projects with custom projects
  const claudeProjects = data?.projects || [];
  const allProjects = useMemo(() => {
    const merged: ClaudeProject[] = [...claudeProjects];
    customProjects.forEach(cp => {
      const exists = claudeProjects.some(p => pathsMatch(p.path, cp.path));
      if (!exists) {
        merged.push({
          id: `custom-${cp.path}`,
          name: cp.name,
          path: cp.path,
          sessions: [],
          lastActivity: new Date(cp.addedAt),
        });
      }
    });
    return merged;
  }, [claudeProjects, customProjects]);

  // One grid, no tabs. Hidden projects sink to the end rather than vanishing:
  // the tab strip that used to bring them back is gone, so the card's own
  // `unhide` button is the only way out and it has to stay reachable.
  const projects = useMemo(() => {
    const visible = allProjects.filter(p => !hiddenProjects.includes(p.path));
    const hidden = allProjects.filter(p => hiddenProjects.includes(p.path));
    return [...visible, ...hidden];
  }, [allProjects, hiddenProjects]);

  const getMessagePreview = (content: string | unknown[]): string => {
    if (typeof content === 'string') {
      return content.slice(0, 100) + (content.length > 100 ? '...' : '');
    }
    if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>;
          if (obj.type === 'text' && typeof obj.text === 'string') {
            const text = obj.text;
            return text.slice(0, 100) + (text.length > 100 ? '...' : '');
          }
        }
      }
    }
    return 'Message content';
  };

  // Get short path for display
  const getShortPath = (path: string) => {
    const parts = path.split('/');
    if (parts.length <= 3) return path;
    return '~/' + parts.slice(-2).join('/');
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <LoadingState loading what="Still loading your projects…" detail="scanning the project directories" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <ErrorState
          title="Could not read your projects."
          detail={error}
          onRetry={refresh}
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle="Every folder Tars knows about, and what is running in it."
        actions={hasElectron ? (
          <Button variant="primary" size="md" onClick={handleAddProject}>
            + Project
          </Button>
        ) : undefined}
      />

      {/* Projects Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {projects.map((project) => {
          const isSelected = selectedProject?.id === project.id;
          const linkedAgents = agents.filter(a => pathsMatch(a.projectPath, project.path));
          const hidden = isHidden(project.path);
          const custom = isCustomProject(project.path);
          // None for a custom project Claude Code has not run in: no chip
          // rather than "Invalid Date".
          const lastActive = lastActiveLabel(project.lastActivity);

          return (
            <div
              key={project.id}
              className={`flex flex-col gap-2 border bg-card p-3 transition-colors ${
                isSelected ? 'border-border-accent' : 'border-border'
              } ${hidden ? 'opacity-50' : ''}`}
            >
              {/* Name, and how many agents are living in the folder */}
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="min-w-0 truncate text-[12.5px] text-foreground" title={project.name}>
                  {project.name}
                </h3>
                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                  {linkedAgents.length} agents
                </span>
              </div>

              <p className="truncate font-mono text-[10.5px] text-muted-foreground" title={project.path}>
                {getShortPath(project.path)}
              </p>

              <div className="flex flex-wrap items-center gap-1.5">
                <MetaChip>{project.sessions.length} sessions</MetaChip>
                {lastActive && <MetaChip>{lastActive}</MetaChip>}
                {isDefaultProject(project.path) && <MetaChip>default</MetaChip>}
                {custom && <MetaChip>custom</MetaChip>}
              </div>

              <div className="flex items-center gap-2 pt-0.5">
                <Button
                  size="sm"
                  className={ROW_ACTION}
                  onClick={() => setSelectedProject(isSelected ? null : project)}
                >
                  open
                </Button>
                <Button
                  size="sm"
                  className={ROW_ACTION}
                  onClick={(e) => toggleHidden(project.path, e)}
                >
                  {hidden ? 'unhide' : 'hide'}
                </Button>
                <Button
                  size="sm"
                  className={ROW_ACTION}
                  disabled={!custom}
                  title={custom ? undefined : 'Only folders you added yourself can be removed'}
                  onClick={(e) => handleRemoveProject(project.path, e)}
                >
                  remove
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Empty state. The page used to also carry a full-width "Add a folder"
          row under the grid, which called the very same handleAddProject as
          "+ Project" in the header: two controls, one action, on screen at once.
          The row is gone; the button here is the only place the header control
          is worth repeating, because an empty grid is the one case where the
          header is not the obvious next thing to look at. */}
      {projects.length === 0 && (
        <div className="border border-border bg-card p-6 text-center">
          <p className="text-[12.5px] text-foreground">No projects yet</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Add a folder, or run any agent CLI in one and it shows up here.
            A folder you add is remembered on disk, so an update never loses it.
          </p>
          {hasElectron && (
            <Button variant="primary" size="md" className="mt-3" onClick={handleAddProject}>
              + Project
            </Button>
          )}
        </div>
      )}

      {/* Project Detail Panel (Slide-out) */}
      <AnimatePresence>
        {selectedProject && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedProject(null)}
              className="fixed inset-0 bg-scrim z-40"
            />

            {/* Panel */}
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-background border-l border-border z-50 overflow-y-auto"
            >
              {/* Header - no coloured rule under it (R2), no icon-only close (R7) */}
              <div className="sticky top-0 bg-card border-b border-border z-10">
                <div className="p-4 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-serif text-2xl leading-[1.15] truncate">{selectedProject.name}</h2>
                    <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                      {selectedProject.path}
                    </p>
                  </div>
                  <Button size="sm" className={ROW_ACTION} onClick={() => setSelectedProject(null)}>
                    close
                  </Button>
                </div>

                {/* Git Branch */}
                {hasElectron && (
                  <div className="px-4 pb-3 flex items-center gap-2">
                    {gitLoading ? (
                      <BrandSpinner size={14} />
                    ) : (
                      <span className="text-xs font-mono text-muted-foreground truncate">
                        {gitBranch || 'not a git repository'}
                      </span>
                    )}
                    <Button
                      size="sm"
                      className={`${ROW_ACTION} ml-auto`}
                      onClick={() => loadGitBranch(selectedProject.path)}
                    >
                      refresh
                    </Button>
                  </div>
                )}
              </div>

              {/* Content */}
              <div className="p-4 space-y-4">
                {/* Quick Actions */}
                <div className="flex gap-2">
                  <Button
                    size="md"
                    className="flex-1"
                    onClick={() => window.electronAPI?.shell?.reveal(selectedProject.path)}
                    title="Reveal this folder in Finder"
                  >
                    Reveal in Finder
                  </Button>
                  <Button
                    size="md"
                    className="flex-1"
                    disabled={!hasElectron || terminalOpening}
                    onClick={() => openProjectTerminal(selectedProject.path)}
                    title="Open a terminal in this folder"
                  >
                    {terminalOpening ? 'Opening…' : 'Terminal'}
                  </Button>
                  {hasElectron && (
                    <Button
                      variant="primary"
                      size="md"
                      className="flex-1"
                      onClick={() => setShowAgentDialog(true)}
                    >
                      Launch Agent
                    </Button>
                  )}
                </div>

                {/* Set as default - selected is a box, not a warning-tinted fill */}
                <Button
                  size="md"
                  className="w-full"
                  active={isDefaultProject(selectedProject.path)}
                  onClick={() => handleSetDefault(selectedProject.path)}
                >
                  {isDefaultProject(selectedProject.path) ? 'Default project' : 'Pin as default'}
                </Button>

                {/* Stats */}
                <div className="grid grid-cols-3 gap-2">
                  <Panel className="text-center">
                    <p className="font-serif text-2xl leading-none">{selectedProject.sessions.length}</p>
                    <p className="text-[11px] text-muted-foreground mt-1">Sessions</p>
                  </Panel>
                  <Panel className="text-center">
                    <p className="font-serif text-2xl leading-none">{projectAgents.length}</p>
                    <p className="text-[11px] text-muted-foreground mt-1">Agents</p>
                  </Panel>
                  <Panel className="text-center">
                    <p className="text-sm">{lastActiveLabel(selectedProject.lastActivity) ?? 'unknown'}</p>
                    <p className="text-[11px] text-muted-foreground mt-1">Last active</p>
                  </Panel>
                </div>

                {/* Project Agents */}
                {hasElectron && projectAgents.length > 0 && (
                  <Panel>
                    <PanelCaption className="mb-3">AGENTS ({projectAgents.length})</PanelCaption>

                    <div className="space-y-2">
                      {projectAgents.map((agent) => {
                        const tone = statusTone(agent.status);
                        // A stopped agent is at rest too, and is started again from here.
                        // Frame: `Agent stopped · who and why`.
                        const atRest = agent.status === 'idle' || agent.status === 'completed' || agent.status === 'stopped';
                        // An asleep one offers wake, which starts it again on its
                        // conversation, off while it comes back. Frame: `Agent asleep ·
                        // and how it wakes`.
                        const waking = !!wakingLine(agent);
                        const asleep = agent.status === 'asleep';

                        return (
                          <div
                            key={agent.id}
                            data-project-agent={agent.id}
                            className="p-3 bg-secondary border border-border"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                {asleep || waking ? (
                                  <StatusSquare tone={waking ? 'waiting' : 'idle'} hollow={!waking} />
                                ) : (
                                  <StatusSquare tone={tone} />
                                )}
                                <span className="truncate text-xs font-semibold text-foreground">
                                  {agent.name || `Agent ${agent.id.slice(0, 6)}`}
                                </span>
                                {waking ? (
                                  <span className="text-[11px] font-mono shrink-0 text-status-waiting">waking</span>
                                ) : (
                                  <span className={`text-[11px] font-mono shrink-0 ${STATUS_COLORS[agent.status].text}`}>
                                    {statusWord(agent.status)}
                                  </span>
                                )}
                              </div>

                              {(asleep || waking) && (
                                <div className="flex items-center gap-2 shrink-0">
                                  <Button
                                    size="sm"
                                    className={ROW_ACTION}
                                    disabled={waking}
                                    onClick={() => {
                                      wakeAgent(agent.id).then(
                                        result => { if (!result.success) console.error('Failed to wake agent:', result.error); },
                                        error => console.error('Failed to wake agent:', error),
                                      );
                                    }}
                                  >
                                    wake
                                  </Button>
                                </div>
                              )}

                              {atRest && !waking && (
                                <div className="flex items-center gap-2 shrink-0">
                                  <Button
                                    size="sm"
                                    className={ROW_ACTION}
                                    onClick={() => handleRestartAgent(agent, true)}
                                  >
                                    resume
                                  </Button>
                                  <Button
                                    size="sm"
                                    className={ROW_ACTION}
                                    onClick={() => handleRestartAgent(agent, false)}
                                  >
                                    start
                                  </Button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </Panel>
                )}

                {/* Sessions */}
                <Panel>
                  <PanelCaption className="mb-3">SESSIONS ({selectedProject.sessions.length})</PanelCaption>

                  {selectedProject.sessions.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">No sessions yet</p>
                  ) : (
                    <div className="space-y-2">
                      {selectedProject.sessions.slice(0, 5).map((session) => (
                        <button
                          key={session.id}
                          onClick={() => setSelectedSession(selectedSession === session.id ? null : session.id)}
                          className={`
                            w-full text-left p-3 transition-colors border
                            ${selectedSession === session.id
                              ? 'bg-secondary border-border-accent'
                              : 'bg-bg-tertiary border-border hover:border-border-accent'
                            }
                          `}
                        >
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-mono text-muted-foreground truncate">
                              {session.id.slice(0, 12)}...
                            </p>
                            <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${selectedSession === session.id ? 'rotate-180' : ''
                              }`} />
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {lastActiveLabel(session.lastActivity)}
                          </p>
                        </button>
                      ))}
                      {selectedProject.sessions.length > 5 && (
                        <p className="text-xs text-muted-foreground text-center pt-2">
                          +{selectedProject.sessions.length - 5} more sessions
                        </p>
                      )}
                    </div>
                  )}
                </Panel>

                {/* Session Messages */}
                <AnimatePresence>
                  {selectedSession && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="border border-border bg-card p-3 overflow-hidden"
                    >
                      <PanelCaption className="mb-3">MESSAGES</PanelCaption>

                      {messagesLoading ? (
                        <div className="flex items-center justify-center py-8">
                          <BrandSpinner size={30} label="Loading messages" />
                        </div>
                      ) : (
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                          {messages.slice(0, 10).map((message) => (
                            <div
                              key={message.uuid}
                              className={`p-3 ${message.type === 'user' ? 'bg-secondary' : 'bg-bg-tertiary'}`}
                            >
                              <p className="text-[10px] text-muted-foreground mb-1">
                                {message.type === 'user' ? 'You' : 'Claude'}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {getMessagePreview(message.content)}
                              </p>
                            </div>
                          ))}
                          {messages.length === 0 && (
                            <p className="text-sm text-muted-foreground text-center py-4">
                              No messages found
                            </p>
                          )}
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Project Path */}
                <Panel>
                  <PanelCaption className="mb-2">FULL PATH</PanelCaption>
                  <p className="font-mono text-xs text-muted-foreground break-all select-all">
                    {selectedProject.path}
                  </p>
                </Panel>

                {/* Delete Custom Project */}
                {isCustomProject(selectedProject.path) && (
                  <Button
                    variant="danger"
                    size="md"
                    className="w-full"
                    onClick={(e) => handleRemoveProject(selectedProject.path, e)}
                  >
                    Remove project
                  </Button>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Replace Default Project Confirmation Dialog */}
      {pendingDefaultPath && (
        <DialogShell
          onClose={() => setPendingDefaultPath(null)}
          title="Replace default project?"
          footerRight={
            <>
              <Button size="md" onClick={() => setPendingDefaultPath(null)}>
                Cancel
              </Button>
              <Button variant="primary" size="md" onClick={confirmSetDefault}>
                Replace
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">
            <span className="text-foreground font-mono">{defaultProjectPath.split('/').pop()}</span> is currently the default project. Replace it with{' '}
            <span className="text-foreground font-mono">{pendingDefaultPath.split('/').pop()}</span>?
          </p>
        </DialogShell>
      )}

      {/* Project Terminal */}
      {terminalPty && (
        <DialogShell
          onClose={closeProjectTerminal}
          width={860}
          title="Terminal"
          subtitle={terminalPty.cwd}
          footerRight={
            <Button size="md" onClick={closeProjectTerminal}>
              Close
            </Button>
          }
        >
          <Terminal ptyId={terminalPty.id} className="h-[420px]" />
        </DialogShell>
      )}

      {/* Launch Agent Modal */}
      <NewChatModal
        open={showAgentDialog}
        onClose={() => setShowAgentDialog(false)}
        onSubmit={handleCreateAgent}
        projects={electronProjects.map(p => ({ path: p.path, name: p.name }))}
        onBrowseFolder={isElectron() ? openFolderDialog : undefined}
        installedSkills={installedSkills}
        onRefreshSkills={refreshSkills}
        initialProjectPath={selectedProject?.path}
        initialStep={2}
      />
    </div>
  );
}
