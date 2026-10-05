import { contextBridge, ipcRenderer } from 'electron';

// Agent event types
type AgentEventCallback = (event: {
  type: string;
  agentId: string;
  ptyId?: string;
  data: string;
  timestamp: string;
  exitCode?: number;
}) => void;

// PTY event types
type PtyDataCallback = (event: { id: string; data: string }) => void;
type PtyExitCallback = (event: { id: string; exitCode: number }) => void;

// What the renderer's Sentry SDK talks to main through, as @sentry/electron's
// own preload would expose it: this window is sandboxed and cannot load that
// one. Only the renderer's start and its envelopes pass, to main's
// IPCMode.Classic listeners, where report.ts rebuilds each error; its scope
// (user, extra, breadcrumbs, attachments), feedback, logs, metrics and status
// pings go nowhere. Main listens only once error reports are turned on.
contextBridge.exposeInMainWorld('__SENTRY_IPC__', {
  'sentry-ipc': {
    sendRendererStart: () => ipcRenderer.send('sentry-ipc.start'),
    sendEnvelope: (envelope: string | Uint8Array) => ipcRenderer.send('sentry-ipc.envelope', envelope),
    sendScope: () => undefined,
    sendFeedback: async () => ({}),
    sendStatus: () => undefined,
    sendStructuredLog: () => undefined,
    sendMetric: () => undefined,
  },
});

// Expose protected APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // PTY terminal management
  pty: {
    create: (params: { cwd?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('pty:create', params),
    write: (params: { id: string; data: string }) =>
      ipcRenderer.invoke('pty:write', params),
    resize: (params: { id: string; cols: number; rows: number }) =>
      ipcRenderer.invoke('pty:resize', params),
    kill: (params: { id: string }) =>
      ipcRenderer.invoke('pty:kill', params),

    // Event listeners
    onData: (callback: PtyDataCallback) => {
      const listener = (_: unknown, event: { id: string; data: string }) => callback(event);
      ipcRenderer.on('pty:data', listener);
      return () => ipcRenderer.removeListener('pty:data', listener);
    },
    onExit: (callback: PtyExitCallback) => {
      const listener = (_: unknown, event: { id: string; exitCode: number }) => callback(event);
      ipcRenderer.on('pty:exit', listener);
      return () => ipcRenderer.removeListener('pty:exit', listener);
    },
  },

  // Agent management
  agent: {
    create: (config: {
      projectPath: string;
      skills: string[];
      worktree?: { enabled: boolean; branchName: string };
      character?: string;
      name?: string;
      secondaryProjectPath?: string;
      permissionMode?: 'normal' | 'auto' | 'bypass';
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      provider?: string;
      model?: string;
      localModel?: string;
      obsidianVaultPaths?: string[];
      /** The Orchestrator toggle: 'orchestrator' makes it its project's one. */
      role?: 'orchestrator' | 'worker';
      /** The toggle's old name, read only when `role` is absent. */
      orchestratorMode?: boolean;
      cliPath?: string;
    }) => ipcRenderer.invoke('agent:create', config),
    update: (params: {
      id: string;
      projectPath?: string;
      skills?: string[];
      secondaryProjectPath?: string | null;
      permissionMode?: 'normal' | 'auto' | 'bypass';
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
      name?: string;
      character?: string;
      model?: string | null;
      provider?: string;
      localModel?: string | null;
      savedPrompt?: string | null;
      obsidianVaultPaths?: string[];
      worktree?: { enabled: boolean; branchName: string };
      /** The Orchestrator toggle: 'orchestrator' takes the role from the
       *  project's current one, which becomes a worker; both CLIs restart. */
      role?: 'orchestrator' | 'worker';
      /** The toggle's old name, read only when `role` is absent. */
      orchestratorMode?: boolean;
      cliPath?: string | null;
    }) => ipcRenderer.invoke('agent:update', params),
    start: (params: { id: string; prompt: string; options?: { model?: string; resume?: boolean; provider?: string; localModel?: string } }) =>
      ipcRenderer.invoke('agent:start', params),
    get: (id: string) =>
      ipcRenderer.invoke('agent:get', id),
    list: () =>
      ipcRenderer.invoke('agent:list'),
    stop: (id: string, reason?: string) =>
      ipcRenderer.invoke('agent:stop', id, reason),
    remove: (id: string) =>
      ipcRenderer.invoke('agent:remove', id),
    sendInput: (params: { id: string; input: string }) =>
      ipcRenderer.invoke('agent:input', params),
    wake: (id: string) =>
      ipcRenderer.invoke('agent:wake', id),
    resize: (params: { id: string; cols: number; rows: number }) =>
      ipcRenderer.invoke('agent:resize', params),
    setSecondaryProject: (params: { id: string; secondaryProjectPath: string | null }) =>
      ipcRenderer.invoke('agent:setSecondaryProject', params),

    // Event listeners
    onOutput: (callback: AgentEventCallback) => {
      const listener = (_: unknown, event: Parameters<AgentEventCallback>[0]) => callback(event);
      ipcRenderer.on('agent:output', listener);
      return () => ipcRenderer.removeListener('agent:output', listener);
    },
    onError: (callback: AgentEventCallback) => {
      const listener = (_: unknown, event: Parameters<AgentEventCallback>[0]) => callback(event);
      ipcRenderer.on('agent:error', listener);
      return () => ipcRenderer.removeListener('agent:error', listener);
    },
    onComplete: (callback: AgentEventCallback) => {
      const listener = (_: unknown, event: Parameters<AgentEventCallback>[0]) => callback(event);
      ipcRenderer.on('agent:complete', listener);
      return () => ipcRenderer.removeListener('agent:complete', listener);
    },
    onToolUse: (callback: AgentEventCallback) => {
      const listener = (_: unknown, event: Parameters<AgentEventCallback>[0]) => callback(event);
      ipcRenderer.on('agent:tool_use', listener);
      return () => ipcRenderer.removeListener('agent:tool_use', listener);
    },
    onStatus: (callback: (event: { type: string; agentId: string; status: string; timestamp: string }) => void) => {
      const listener = (_: unknown, event: { type: string; agentId: string; status: string; timestamp: string }) => callback(event);
      ipcRenderer.on('agent:status', listener);
      return () => ipcRenderer.removeListener('agent:status', listener);
    },
    onTick: (callback: (agents: Array<{
      id: string; name: string; character: string;
      status: string; displayStatus: string; statusLine: string;
      currentTask: string; projectName: string; lastActivity: string; provider: string;
      leftFullscreen?: boolean;
    }>) => void) => {
      const listener = (_: unknown, data: unknown) => callback(data as Parameters<typeof callback>[0]);
      ipcRenderer.on('agents:tick', listener);
      return () => ipcRenderer.removeListener('agents:tick', listener);
    },
    /**
     * A message that cannot go into this agent's terminal yet.
     *
     * Pushed whenever that changes, including the moment it stops being true,
     * where `waiting` is 0. It is the alternative to writing a note across
     * what somebody is half way through typing: the note waits, and the panel
     * says so, because the two things that end the wait, sending the draft or
     * clearing it, can only be done by the person at that keyboard.
     */
    /**
     * What is waiting right now, for a panel that has just opened.
     *
     * The event below is only heard by a window already listening, so a
     * Dashboard opened after a message started waiting knew nothing about it.
     * An agent absent from this list is holding nothing.
     */
    messagesWaiting: () =>
      ipcRenderer.invoke('agent:messagesWaiting'),
    onMessageWaiting: (callback: (waiting: { agentId: string; waiting: number; from: string[] }) => void) => {
      const listener = (_: unknown, data: unknown) => callback(data as Parameters<typeof callback>[0]);
      ipcRenderer.on('agent:message-waiting', listener);
      return () => ipcRenderer.removeListener('agent:message-waiting', listener);
    },
    /**
     * Restart the agent's CLI now, continuing its conversation. What a panel's
     * `restart` calls: a stop then a start begins a new conversation.
     */
    restart: (id: string) =>
      ipcRenderer.invoke('agent:restart', id),
    /**
     * The restarts waiting to apply a changed launch setting, for a window that
     * has just opened. An agent absent from the list has none waiting.
     */
    pendingRestarts: () =>
      ipcRenderer.invoke('agent:pendingRestarts'),
    /**
     * A restart started or stopped waiting, or now waits on something else.
     * `pending` is null once it happened or had nothing to do.
     */
    onRestartPending: (callback: (event: {
      agentId: string;
      pending: { settings: string[]; waitingFor: string } | null;
    }) => void) => {
      const listener = (_: unknown, data: unknown) => callback(data as Parameters<typeof callback>[0]);
      ipcRenderer.on('agent:restart-pending', listener);
      return () => ipcRenderer.removeListener('agent:restart-pending', listener);
    },
  },

  // Skills management
  skill: {
    install: (repo: string) =>
      ipcRenderer.invoke('skill:install', repo),
    installStart: (params: { repo: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('skill:install-start', params),
    installWrite: (params: { id: string; data: string }) =>
      ipcRenderer.invoke('skill:install-write', params),
    installResize: (params: { id: string; cols: number; rows: number }) =>
      ipcRenderer.invoke('skill:install-resize', params),
    installKill: (params: { id: string }) =>
      ipcRenderer.invoke('skill:install-kill', params),
    listInstalled: () =>
      ipcRenderer.invoke('skill:list-installed'),
    listInstalledAll: () =>
      ipcRenderer.invoke('skill:list-installed-all'),
    linkToProvider: (params: { skillName: string; providerId: string }) =>
      ipcRenderer.invoke('skill:link-to-provider', params),
    fetchMarketplace: () =>
      ipcRenderer.invoke('skill:fetch-marketplace') as Promise<{ skills: Array<{ rank: number; name: string; repo: string; installs: string; installsNum: number }> | null }>,
    onPtyData: (callback: (event: { id: string; data: string }) => void) => {
      const listener = (_: unknown, event: { id: string; data: string }) => callback(event);
      ipcRenderer.on('skill:pty-data', listener);
      return () => ipcRenderer.removeListener('skill:pty-data', listener);
    },
    onPtyExit: (callback: (event: { id: string; exitCode: number }) => void) => {
      const listener = (_: unknown, event: { id: string; exitCode: number }) => callback(event);
      ipcRenderer.on('skill:pty-exit', listener);
      return () => ipcRenderer.removeListener('skill:pty-exit', listener);
    },
    onInstallOutput: (callback: (event: { repo: string; data: string }) => void) => {
      const listener = (_: unknown, event: { repo: string; data: string }) => callback(event);
      ipcRenderer.on('skill:install-output', listener);
      return () => ipcRenderer.removeListener('skill:install-output', listener);
    },
  },

  // Several Claude subscriptions (DESIGN-COMPTES-CLAUDE.md, B6)
  claudeAccounts: {
    list: () => ipcRenderer.invoke('claude-accounts:list'),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('claude-accounts:set-enabled', enabled),
    setThresholds: (params: { fiveHour: number; weekly: number }) =>
      ipcRenderer.invoke('claude-accounts:set-thresholds', params),
    add: (params: { label: string }) => ipcRenderer.invoke('claude-accounts:add', params),
    rename: (params: { id: string; label: string }) => ipcRenderer.invoke('claude-accounts:rename', params),
    setAccountEnabled: (params: { id: string; enabled: boolean }) =>
      ipcRenderer.invoke('claude-accounts:set-account-enabled', params),
    reorder: (ids: string[]) => ipcRenderer.invoke('claude-accounts:reorder', ids),
    remove: (id: string) => ipcRenderer.invoke('claude-accounts:remove', id),
    refresh: (id?: string) => ipcRenderer.invoke('claude-accounts:refresh', id),
    loginStart: (params: { id: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('claude-accounts:login-start', params),
    loginWrite: (params: { ptyId: string; data: string }) => ipcRenderer.invoke('claude-accounts:login-write', params),
    loginResize: (params: { ptyId: string; cols: number; rows: number }) =>
      ipcRenderer.invoke('claude-accounts:login-resize', params),
    loginKill: (params: { ptyId: string }) => ipcRenderer.invoke('claude-accounts:login-kill', params),
    onLoginData: (callback: (event: { ptyId: string; data: string }) => void) => {
      const listener = (_: unknown, event: { ptyId: string; data: string }) => callback(event);
      ipcRenderer.on('claude-accounts:login-data', listener);
      return () => ipcRenderer.removeListener('claude-accounts:login-data', listener);
    },
    onLoginExit: (callback: (event: { ptyId: string; exitCode: number }) => void) => {
      const listener = (_: unknown, event: { ptyId: string; exitCode: number }) => callback(event);
      ipcRenderer.on('claude-accounts:login-exit', listener);
      return () => ipcRenderer.removeListener('claude-accounts:login-exit', listener);
    },
    onChanged: (callback: (view: unknown) => void) => {
      const listener = (_: unknown, view: unknown) => callback(view);
      ipcRenderer.on('claude-accounts:changed', listener);
      return () => ipcRenderer.removeListener('claude-accounts:changed', listener);
    },
    onAgentChanged: (callback: (event: unknown) => void) => {
      const listener = (_: unknown, event: unknown) => callback(event);
      ipcRenderer.on('claude-accounts:agent-changed', listener);
      return () => ipcRenderer.removeListener('claude-accounts:agent-changed', listener);
    },
    onAgentMoved: (callback: (event: unknown) => void) => {
      const listener = (_: unknown, event: unknown) => callback(event);
      ipcRenderer.on('claude-accounts:agent-moved', listener);
      return () => ipcRenderer.removeListener('claude-accounts:agent-moved', listener);
    },
    setAgentAccount: (params: { agentId: string; accountId: string | null }) =>
      ipcRenderer.invoke('claude-accounts:set-agent-account', params),
  },

  // Plugin management (with in-app terminal)
  plugin: {
    installStart: (params: { command: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('plugin:install-start', params),
    installWrite: (params: { id: string; data: string }) =>
      ipcRenderer.invoke('plugin:install-write', params),
    installResize: (params: { id: string; cols: number; rows: number }) =>
      ipcRenderer.invoke('plugin:install-resize', params),
    installKill: (params: { id: string }) =>
      ipcRenderer.invoke('plugin:install-kill', params),
    onPtyData: (callback: (event: { id: string; data: string }) => void) => {
      const listener = (_: unknown, event: { id: string; data: string }) => callback(event);
      ipcRenderer.on('plugin:pty-data', listener);
      return () => ipcRenderer.removeListener('plugin:pty-data', listener);
    },
    onPtyExit: (callback: (event: { id: string; exitCode: number }) => void) => {
      const listener = (_: unknown, event: { id: string; exitCode: number }) => callback(event);
      ipcRenderer.on('plugin:pty-exit', listener);
      return () => ipcRenderer.removeListener('plugin:pty-exit', listener);
    },
  },

  // File system
  fs: {
    listProjects: () =>
      ipcRenderer.invoke('fs:list-projects'),
    readTextFile: (filePath: string) =>
      ipcRenderer.invoke('fs:read-text-file', filePath),
    writeTextFile: (params: { filePath: string; content: string }) =>
      ipcRenderer.invoke('fs:write-text-file', params),
    readProjectFiles: (params: { paths: string[]; relative: string[] }) =>
      ipcRenderer.invoke('fs:read-project-files', params),
    addCustomProject: (projectPath: string) =>
      ipcRenderer.invoke('fs:add-custom-project', projectPath),
    removeCustomProject: (projectPath: string) =>
      ipcRenderer.invoke('fs:remove-custom-project', projectPath),
  },

  // Claude data
  claude: {
    getData: () =>
      ipcRenderer.invoke('claude:getData'),
  },

  // Settings
  settings: {
    get: () =>
      ipcRenderer.invoke('settings:get'),
    save: (settings: {
      enabledPlugins?: Record<string, boolean>;
      env?: Record<string, string>;
      hooks?: Record<string, unknown>;
      includeCoAuthoredBy?: boolean;
      permissions?: { allow: string[]; deny: string[] };
    }) =>
      ipcRenderer.invoke('settings:save', settings),
    getInfo: () =>
      ipcRenderer.invoke('settings:getInfo'),
  },

  // App settings (notifications, etc.)
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
  },

  usage: {
    byProvider: (sinceDays?: number) =>
      ipcRenderer.invoke('usage:by-provider', { sinceDays }),
  },

  logs: {
    search: (query: string, opts?: { agentIds?: string[]; projectPath?: string; limit?: number }) =>
      ipcRenderer.invoke('logs:search', { query, ...opts }),
    tail: (agentId: string, lines?: number) =>
      ipcRenderer.invoke('logs:tail', { agentId, lines }),
    fleet: () => ipcRenderer.invoke('logs:fleet'),
  },

  review: {
    // listOnly: the file list without the patches, which review:file reads one at a time.
    diff: (repoPath: string, baseBranch?: string, opts?: { listOnly?: boolean }) =>
      ipcRenderer.invoke('review:diff', { repoPath, baseBranch, listOnly: opts?.listOnly === true }),
    file: (repoPath: string, file: string, baseBranch?: string) =>
      ipcRenderer.invoke('review:file', { repoPath, file, baseBranch }),
    repo: (repoPath: string) =>
      ipcRenderer.invoke('review:repo', { repoPath }),
  },

  memoryHub: {
    sources: (projectPath?: string) =>
      ipcRenderer.invoke('memory:sources', { projectPath }),
    search: (query: string, opts?: { projectPath?: string; sources?: string[]; limit?: number }) =>
      ipcRenderer.invoke('memory:search', { query, ...opts }),
  },

  models: {
    list: (provider: string) =>
      ipcRenderer.invoke('models:list', { provider }),
    price: (modelId: string, provider?: string) =>
      ipcRenderer.invoke('models:price', { modelId, provider }),
    catalogStatus: () =>
      ipcRenderer.invoke('models:catalog-status'),
    refresh: () =>
      ipcRenderer.invoke('models:refresh'),
  },

  appSettings: {
    get: () =>
      ipcRenderer.invoke('app:getSettings'),
    save: (settings: Record<string, unknown>) =>
      ipcRenderer.invoke('app:saveSettings', settings),
    onUpdated: (callback: (settings: unknown) => void) => {
      const listener = (_: unknown, settings: unknown) => callback(settings);
      ipcRenderer.on('settings:updated', listener);
      return () => ipcRenderer.removeListener('settings:updated', listener);
    },
  },

  // Telegram bot
  telegram: {
    test: () =>
      ipcRenderer.invoke('telegram:test'),
    sendTest: () =>
      ipcRenderer.invoke('telegram:sendTest'),
    generateAuthToken: () =>
      ipcRenderer.invoke('telegram:generateAuthToken'),
    removeAuthorizedChatId: (chatId: string) =>
      ipcRenderer.invoke('telegram:removeAuthorizedChatId', chatId),
  },

  // Slack bot
  slack: {
    test: () =>
      ipcRenderer.invoke('slack:test'),
    sendTest: () =>
      ipcRenderer.invoke('slack:sendTest'),
  },

  // Discord bot
  discord: {
    test: () =>
      ipcRenderer.invoke('discord:test'),
    sendTest: () =>
      ipcRenderer.invoke('discord:sendTest'),
    inviteUrl: (token: string) =>
      ipcRenderer.invoke('discord:inviteUrl', token),
  },

  // JIRA
  jira: {
    test: () =>
      ipcRenderer.invoke('jira:test'),
  },

  // SocialData (Twitter/X)
  socialData: {
    test: () =>
      ipcRenderer.invoke('socialdata:test'),
  },

  // X API (posting)
  xApi: {
    test: () =>
      ipcRenderer.invoke('xapi:test') as Promise<{ success: boolean; username?: string; error?: string }>,
  },

  // Google Workspace (gws CLI)
  gws: {
    detect: () =>
      ipcRenderer.invoke('gws:detect'),
    detectGcloud: () =>
      ipcRenderer.invoke('gws:detectGcloud'),
    authStatus: () =>
      ipcRenderer.invoke('gws:authStatus'),
    setup: () =>
      ipcRenderer.invoke('gws:setup'),
    remove: () =>
      ipcRenderer.invoke('gws:remove'),
    getMcpStatus: () =>
      ipcRenderer.invoke('gws:getMcpStatus'),
    listSkills: () =>
      ipcRenderer.invoke('gws:listSkills') as Promise<string[]>,
  },

  // Tasmania (Local LLM)
  tasmania: {
    test: () =>
      ipcRenderer.invoke('tasmania:test'),
    getStatus: () =>
      ipcRenderer.invoke('tasmania:getStatus'),
    getModels: () =>
      ipcRenderer.invoke('tasmania:getModels'),
    loadModel: (modelPath: string) =>
      ipcRenderer.invoke('tasmania:loadModel', modelPath),
    stopModel: () =>
      ipcRenderer.invoke('tasmania:stopModel'),
    getMcpStatus: () =>
      ipcRenderer.invoke('tasmania:getMcpStatus'),
    setup: () =>
      ipcRenderer.invoke('tasmania:setup'),
    remove: () =>
      ipcRenderer.invoke('tasmania:remove'),
  },

  // Ollama (local LLM server)
  ollama: {
    test: () =>
      ipcRenderer.invoke('ollama:test'),
  },

  // Dialogs
  dialog: {
    openFolder: () =>
      ipcRenderer.invoke('dialog:open-folder'),
    openFiles: () =>
      ipcRenderer.invoke('dialog:open-files') as Promise<string[]>,
    openAudio: () =>
      ipcRenderer.invoke('dialog:open-audio') as Promise<string | null>,
  },

  // Shell operations
  project: {
    listFiles: (root: string, maxDepth?: number) =>
      ipcRenderer.invoke('project:list-files', { root, maxDepth }),
    searchFiles: (root: string, query: string) =>
      ipcRenderer.invoke('project:search-files', { root, query }),
    searchContent: (root: string, query: string) =>
      ipcRenderer.invoke('project:search-content', { root, query }),
  },

  shell: {
    // Opens Terminal.app in a directory. The bridge lost this method when the
    // general shell.exec primitive was removed, but `shell:open-terminal`
    // stayed registered and two call sites kept calling it - `shell` existed so
    // the optional chain went through, `.openTerminal` was undefined, and the
    // Settings "open" button threw a TypeError on every click in every shipped
    // build. Re-exposed deliberately with the directory only: the handler no
    // longer accepts a `command`, which is what made it an arbitrary-execution
    // channel.
    openTerminal: (params: { cwd: string }) => ipcRenderer.invoke('shell:open-terminal', { cwd: params.cwd }),
    version: (binary: string) => ipcRenderer.invoke('shell:version', { binary }),
    branch: (cwd: string) => ipcRenderer.invoke('shell:branch', { cwd }),
    reveal: (path: string) => ipcRenderer.invoke('shell:reveal', { path }),
  },

  // Orchestrator (Super Agent) management
  orchestrator: {
    getStatus: () =>
      ipcRenderer.invoke('orchestrator:getStatus'),
    setup: () =>
      ipcRenderer.invoke('orchestrator:setup'),
    remove: () =>
      ipcRenderer.invoke('orchestrator:remove'),
  },

  // Kanban Board
  kanban: {
    list: () =>
      ipcRenderer.invoke('kanban:list'),
    get: (id: string) =>
      ipcRenderer.invoke('kanban:get', id),
    create: (params: {
      title: string;
      description: string;
      projectId: string;
      projectPath: string;
      requiredSkills?: string[];
      priority?: 'low' | 'medium' | 'high';
      labels?: string[];
    }) =>
      ipcRenderer.invoke('kanban:create', params),
    update: (params: {
      id: string;
      title?: string;
      description?: string;
      requiredSkills?: string[];
      priority?: 'low' | 'medium' | 'high';
      labels?: string[];
      progress?: number;
      assignedAgentId?: string | null;
    }) =>
      ipcRenderer.invoke('kanban:update', params),
    move: (params: { id: string; column: 'backlog' | 'planned' | 'ongoing' | 'done'; order?: number }) =>
      ipcRenderer.invoke('kanban:move', params),
    delete: (id: string) =>
      ipcRenderer.invoke('kanban:delete', id),
    reorder: (params: { taskIds: string[]; column: 'backlog' | 'planned' | 'ongoing' | 'done' }) =>
      ipcRenderer.invoke('kanban:reorder', params),
    generate: (params: { prompt: string; availableProjects: Array<{ path: string; name: string }> }) =>
      ipcRenderer.invoke('kanban:generate', params),
    // Event listeners
    onTaskCreated: (callback: (task: unknown) => void) => {
      const listener = (_: unknown, task: unknown) => callback(task);
      ipcRenderer.on('kanban:task-created', listener);
      return () => ipcRenderer.removeListener('kanban:task-created', listener);
    },
    onTaskUpdated: (callback: (task: unknown) => void) => {
      const listener = (_: unknown, task: unknown) => callback(task);
      ipcRenderer.on('kanban:task-updated', listener);
      return () => ipcRenderer.removeListener('kanban:task-updated', listener);
    },
    onTaskDeleted: (callback: (event: { id: string }) => void) => {
      const listener = (_: unknown, event: { id: string }) => callback(event);
      ipcRenderer.on('kanban:task-deleted', listener);
      return () => ipcRenderer.removeListener('kanban:task-deleted', listener);
    },
  },

  // Agent templates
  template: {
    list: () =>
      ipcRenderer.invoke('template:list'),
    get: (id: string) =>
      ipcRenderer.invoke('template:get', id),
    create: (input: Record<string, unknown>) =>
      ipcRenderer.invoke('template:create', input),
    update: (patch: Record<string, unknown>) =>
      ipcRenderer.invoke('template:update', patch),
    delete: (id: string) =>
      ipcRenderer.invoke('template:delete', id),
    duplicate: (id: string) =>
      ipcRenderer.invoke('template:duplicate', id),
    export: (ids: string[]) =>
      ipcRenderer.invoke('template:export', ids),
    import: (payload: unknown) =>
      ipcRenderer.invoke('template:import', payload),
  },

  // Hermes integration (remote scheduler wiring)
  hermes: {
    getConnectionInfo: () =>
      ipcRenderer.invoke('hermes:getConnectionInfo'),
    getConnection: () =>
      ipcRenderer.invoke('hermes:connection:get'),
    saveConnection: (connection: Record<string, unknown>) =>
      ipcRenderer.invoke('hermes:connection:save', connection),
    importDesktopConnection: () =>
      ipcRenderer.invoke('hermes:connection:import'),
    // The relay to the user's Telegram through their Hermes: its state now, and each change of it.
    relayStatus: () =>
      ipcRenderer.invoke('hermes:relay:status'),
    onRelayStatus: (callback: (status: unknown) => void) => {
      const listener = (_: unknown, status: unknown) => callback(status);
      ipcRenderer.on('hermes:relay:status', listener);
      return () => ipcRenderer.removeListener('hermes:relay:status', listener);
    },
    testConnection: (connection: Record<string, unknown>) =>
      ipcRenderer.invoke('hermes:connection:test', connection),
    signIn: (params: { connection: Record<string, unknown>; username: string; password: string; provider?: string }) =>
      ipcRenderer.invoke('hermes:signIn', params),
    signOut: (connection: Record<string, unknown>) =>
      ipcRenderer.invoke('hermes:signOut', connection),
    crons: () => ipcRenderer.invoke('hermes:crons:list'),
    cronAction: (params: { action: 'pause' | 'resume' | 'trigger'; jobId: string; profile?: string }) =>
      ipcRenderer.invoke('hermes:crons:action', params),
    cronUpdate: (params: { jobId: string; updates: Record<string, unknown>; profile?: string }) =>
      ipcRenderer.invoke('hermes:crons:update', params),
    cronDelete: (params: { jobId: string; profile?: string }) =>
      ipcRenderer.invoke('hermes:crons:delete', params),
    kanbanBoard: (params?: { board?: string }) =>
      ipcRenderer.invoke('hermes:kanban:board', params ?? {}),
    kanbanGetTask: (params: { taskId: string }) =>
      ipcRenderer.invoke('hermes:kanban:getTask', params),
    kanbanCreateTask: (task: Record<string, unknown>) =>
      ipcRenderer.invoke('hermes:kanban:createTask', task),
    kanbanUpdateTask: (params: { taskId: string; patch: Record<string, unknown> }) =>
      ipcRenderer.invoke('hermes:kanban:updateTask', params),
    kanbanDeleteTask: (params: { taskId: string }) =>
      ipcRenderer.invoke('hermes:kanban:deleteTask', params),
    kanbanAddComment: (params: { taskId: string; body: string }) =>
      ipcRenderer.invoke('hermes:kanban:addComment', params),
    testWebhook: (params: { agentName?: string; agentId?: string; projectPath?: string }) =>
      ipcRenderer.invoke('hermes:testWebhook', params),
    testGateway: (url: string) =>
      ipcRenderer.invoke('hermes:testGateway', url),
    mcpServers: () =>
      ipcRenderer.invoke('hermes:mcp:servers'),
    memoryProviders: () =>
      ipcRenderer.invoke('hermes:memory:providers'),
    setMemoryProvider: (provider: string) =>
      ipcRenderer.invoke('hermes:memory:setProvider', { provider }),
  },

  // Overseer chat (Hermes watches every project's agents)
  overseer: {
    send: (message: string, attachments?: { name: string; path: string; isImage: boolean }[]) =>
      ipcRenderer.invoke('overseer:send', message, attachments),
    attachFiles: () =>
      ipcRenderer.invoke('overseer:attachFiles'),
    attachData: (files: Array<{ name: string; mimeType: string; data: Uint8Array }>) =>
      ipcRenderer.invoke('overseer:attachData', files),
    effort: () =>
      ipcRenderer.invoke('overseer:effort'),
    setEffort: (effort: string) =>
      ipcRenderer.invoke('overseer:setEffort', effort),
    history: () =>
      ipcRenderer.invoke('overseer:history'),
    clearHistory: () =>
      ipcRenderer.invoke('overseer:clearHistory'),
    fleet: () =>
      ipcRenderer.invoke('overseer:fleet'),
    confirmAction: (params: { action: Record<string, unknown>; approve: boolean }) =>
      ipcRenderer.invoke('overseer:confirmAction', params),
    pause: () =>
      ipcRenderer.invoke('overseer:pause'),
    resume: () =>
      ipcRenderer.invoke('overseer:resume'),
    watchStatus: () =>
      ipcRenderer.invoke('overseer:watchStatus'),
    settings: () =>
      ipcRenderer.invoke('overseer:settings'),
    setSettings: (patch: { watchIntervalMs?: number; model?: string; provider?: string }) =>
      ipcRenderer.invoke('overseer:setSettings', patch),
    modelOptions: () =>
      ipcRenderer.invoke('overseer:modelOptions'),
    autoActions: () =>
      ipcRenderer.invoke('overseer:autoActions'),
    onBriefing: (callback: (message: Record<string, unknown>) => void) => {
      const listener = (_: unknown, message: Record<string, unknown>) => callback(message);
      ipcRenderer.on('overseer:briefing', listener);
      return () => ipcRenderer.removeListener('overseer:briefing', listener);
    },
  },

  // Team templates (sets of agents deployed onto a project in one click)
  teamTemplate: {
    list: () =>
      ipcRenderer.invoke('teamTemplate:list'),
    create: (input: Record<string, unknown>) =>
      ipcRenderer.invoke('teamTemplate:create', input),
    delete: (id: string) =>
      ipcRenderer.invoke('teamTemplate:delete', id),
  },

  // Vault
  vault: {
    listDocuments: (params?: { folder_id?: string; tags?: string[] }) =>
      ipcRenderer.invoke('vault:listDocuments', params),
    getDocument: (id: string) =>
      ipcRenderer.invoke('vault:getDocument', id),
    createDocument: (params: {
      title: string;
      content: string;
      folder_id?: string;
      author: string;
      agent_id?: string;
      tags?: string[];
    }) =>
      ipcRenderer.invoke('vault:createDocument', params),
    updateDocument: (params: {
      id: string;
      title?: string;
      content?: string;
      tags?: string[];
      folder_id?: string | null;
    }) =>
      ipcRenderer.invoke('vault:updateDocument', params),
    deleteDocument: (id: string) =>
      ipcRenderer.invoke('vault:deleteDocument', id),
    search: (params: { query: string; limit?: number }) =>
      ipcRenderer.invoke('vault:search', params),
    listFolders: () =>
      ipcRenderer.invoke('vault:listFolders'),
    createFolder: (params: { name: string; parent_id?: string }) =>
      ipcRenderer.invoke('vault:createFolder', params),
    deleteFolder: (params: { id: string; recursive?: boolean }) =>
      ipcRenderer.invoke('vault:deleteFolder', params),
    attachFile: (params: { document_id: string; file_path: string }) =>
      ipcRenderer.invoke('vault:attachFile', params),
    // Event listeners
    onDocumentCreated: (callback: (doc: unknown) => void) => {
      const listener = (_: unknown, doc: unknown) => callback(doc);
      ipcRenderer.on('vault:document-created', listener);
      return () => ipcRenderer.removeListener('vault:document-created', listener);
    },
    onDocumentUpdated: (callback: (doc: unknown) => void) => {
      const listener = (_: unknown, doc: unknown) => callback(doc);
      ipcRenderer.on('vault:document-updated', listener);
      return () => ipcRenderer.removeListener('vault:document-updated', listener);
    },
    onDocumentDeleted: (callback: (event: { id: string }) => void) => {
      const listener = (_: unknown, event: { id: string }) => callback(event);
      ipcRenderer.on('vault:document-deleted', listener);
      return () => ipcRenderer.removeListener('vault:document-deleted', listener);
    },
  },

  // Custom MCP server config
  mcp: {
    list: (params: { provider: string }) =>
      ipcRenderer.invoke('mcp:list', params),
    update: (params: { provider: string; name: string; command: string; args: string[]; env: Record<string, string> }) =>
      ipcRenderer.invoke('mcp:update', params),
    delete: (params: { provider: string; name: string }) =>
      ipcRenderer.invoke('mcp:delete', params),
  },

  // CLI Paths management
  provider: {
    orchestratorSupport: () =>
      ipcRenderer.invoke('provider:orchestratorSupport') as Promise<Record<string, boolean>>,
  },

  cliPaths: {
    /** The last detection; `refresh: true` looks again (the Detect button). */
    detect: (options?: { refresh?: boolean }) =>
      ipcRenderer.invoke('cliPaths:detect', options),
    get: () =>
      ipcRenderer.invoke('cliPaths:get'),
    save: (paths: { amp: string; claude: string; codex: string; gemini: string; grok: string; qwencode: string; opencode: string; pi: string; gws: string; gcloud: string; gh: string; node: string; minimax: string; additionalPaths: string[] }) =>
      ipcRenderer.invoke('cliPaths:save', paths),
  },

  // Updates
  updates: {
    check: () => ipcRenderer.invoke('app:checkForUpdates'),
    download: () => ipcRenderer.invoke('app:downloadUpdate'),
    quitAndInstall: () => ipcRenderer.invoke('app:quitAndInstall'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    onUpdateAvailable: (callback: (info: { currentVersion: string; latestVersion: string; releaseNotes: string; hasUpdate: boolean }) => void) => {
      const listener = (_: unknown, info: Parameters<typeof callback>[0]) => callback(info);
      ipcRenderer.on('app:update-available', listener);
      return () => ipcRenderer.removeListener('app:update-available', listener);
    },
    onUpdateNotAvailable: (callback: (info: { currentVersion: string; latestVersion: string }) => void) => {
      const listener = (_: unknown, info: Parameters<typeof callback>[0]) => callback(info);
      ipcRenderer.on('app:update-not-available', listener);
      return () => ipcRenderer.removeListener('app:update-not-available', listener);
    },
    onDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => {
      const listener = (_: unknown, progress: Parameters<typeof callback>[0]) => callback(progress);
      ipcRenderer.on('app:update-progress', listener);
      return () => ipcRenderer.removeListener('app:update-progress', listener);
    },
    onUpdateDownloaded: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('app:update-downloaded', listener);
      return () => ipcRenderer.removeListener('app:update-downloaded', listener);
    },
    onUpdateError: (callback: (error: string) => void) => {
      const listener = (_: unknown, error: string) => callback(error);
      ipcRenderer.on('app:update-error', listener);
      return () => ipcRenderer.removeListener('app:update-error', listener);
    },
  },

  // Native Claude memory (reads ~/.claude/projects/*/memory/)
  memory: {
    listProjects: (extraProjectPaths?: string[]) =>
      ipcRenderer.invoke('memory:list-projects', extraProjectPaths),
    readFile: (filePath: string) =>
      ipcRenderer.invoke('memory:read-file', filePath),
    writeFile: (filePath: string, content: string) =>
      ipcRenderer.invoke('memory:write-file', filePath, content),
    createFile: (memoryDir: string, fileName: string, content?: string) =>
      ipcRenderer.invoke('memory:create-file', memoryDir, fileName, content ?? ''),
    deleteFile: (filePath: string) =>
      ipcRenderer.invoke('memory:delete-file', filePath),
  },

  // Obsidian vault (read-only browsing, multi-vault)
  obsidian: {
    scan: () => ipcRenderer.invoke('obsidian:scan'),
    readFile: (filePath: string, vaultPath: string) => ipcRenderer.invoke('obsidian:readFile', filePath, vaultPath),
    writeFile: (filePath: string, content: string, vaultPath: string) => ipcRenderer.invoke('obsidian:writeFile', filePath, content, vaultPath),
    getVaultInfo: () => ipcRenderer.invoke('obsidian:getVaultInfo'),
    detectVault: (projectPath: string) => ipcRenderer.invoke('obsidian:detectVault', projectPath),
    addVault: (vaultPath: string) => ipcRenderer.invoke('obsidian:addVault', vaultPath),
    removeVault: (vaultPath: string) => ipcRenderer.invoke('obsidian:removeVault', vaultPath),
  },

  // Tray menu events
  tray: {
    onFocusAgent: (callback: (agentId: string) => void) => {
      const listener = (_: unknown, agentId: string) => callback(agentId);
      ipcRenderer.on('tray:focus-agent', listener);
      return () => ipcRenderer.removeListener('tray:focus-agent', listener);
    },
    showMainWindow: () => ipcRenderer.invoke('tray:showMainWindow'),
    quit: () => ipcRenderer.invoke('tray:quit'),
  },

  // The agent bus: rooms, threads, messages and deliveries. The channels and
  // their types are written here and mirrored in src/types/electron.d.ts, in
  // the same commit, because the renderer consumes them and never invents one.
  bus: {
    listRooms: () =>
      ipcRenderer.invoke('bus:listRooms'),
    getRoom: (roomId: string, params?: { limit?: number; before?: string }) =>
      ipcRenderer.invoke('bus:getRoom', roomId, params),
    postMessage: (params: { roomId: string; text: string; mentions?: string[]; attachments?: string[] }) =>
      ipcRenderer.invoke('bus:postMessage', params),
    stopThread: (threadId: string) =>
      ipcRenderer.invoke('bus:stopThread', threadId),
    setMembers: (roomId: string, memberIds: string[]) =>
      ipcRenderer.invoke('bus:setMembers', roomId, memberIds),
    releaseNotSent: (agentId: string) =>
      ipcRenderer.invoke('bus:releaseNotSent', agentId),
    stageFiles: (params: { roomId: string; files: Array<{ name: string; mimeType: string; data: Uint8Array }> }) =>
      ipcRenderer.invoke('bus:stageFiles', params),
    sendNow: (params: { roomId: string; agentId: string; text: string; attachments?: string[] }) =>
      ipcRenderer.invoke('bus:sendNow', params),

    // Pushed from the main process, so the Chat page never polls.
    onMessage: (callback: (message: unknown) => void) => {
      const listener = (_: unknown, message: unknown) => callback(message);
      ipcRenderer.on('bus:message', listener);
      return () => ipcRenderer.removeListener('bus:message', listener);
    },
    onDelivery: (callback: (delivery: unknown) => void) => {
      const listener = (_: unknown, delivery: unknown) => callback(delivery);
      ipcRenderer.on('bus:delivery', listener);
      return () => ipcRenderer.removeListener('bus:delivery', listener);
    },
    onThread: (callback: (thread: unknown) => void) => {
      const listener = (_: unknown, thread: unknown) => callback(thread);
      ipcRenderer.on('bus:thread', listener);
      return () => ipcRenderer.removeListener('bus:thread', listener);
    },
  },

  // Platform info
  platform: process.platform,
});
