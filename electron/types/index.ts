export interface WorktreeConfig {
  enabled: boolean;
  branchName: string;
}

export type AgentCharacter = 'robot' | 'ninja' | 'wizard' | 'astronaut' | 'knight' | 'pirate' | 'alien' | 'viking';

export type AgentProvider =
  | 'amp'
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'grok'
  | 'opencode'
  | 'pi'
  | 'local'
  | 'openrouter'
  | 'deepseek'
  | 'mimo'
  | 'moonshot'
  | 'qwen'
  | 'zhipu'
  | 'minimax'
  | 'nvidia'
  | 'nous-portal'
  | 'ollama'
  | 'venice'
  | 'ollama-cloud'
  | 'custom-openai';

/** Permission mode for agent tool use:
 * - normal: Claude asks for confirmation on each tool use
 * - auto: agent runs fully autonomously (--dangerously-skip-permissions)
 * - bypass: same as auto, explicit intent to bypass all checks
 */
export type AgentPermissionMode = 'normal' | 'auto' | 'bypass';

/** Effort level for agent reasoning:
 * - low: fast, minimal thinking
 * - medium: default balanced mode
 * - high: extended thinking (--think flag)
 */
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** What the Orchestrator toggle sets. See core/agent-role.ts. */
export type AgentRole = 'orchestrator' | 'worker';

/** What a waiting agent waits on: the dialog its CLI shows. `permission` names
 *  the command, file or tool asked about; `question` is an AskUserQuestion's
 *  first question. One line, controls and direction overrides removed, at most
 *  200 characters. */
export interface AgentWaitingOn {
  kind: 'permission' | 'question';
  text: string;
}

/** How an asleep agent was woken (core/agent-asleep.ts). */
export type AgentWakeVia = 'message' | 'chat' | 'wake' | 'key' | 'start';

/** An asleep agent whose CLI is on its way back: who woke it, how, and when. */
export interface AgentWaking {
  /** "you", "Tars", an agent's name, or a chat ("Telegram"). */
  by: string;
  via: AgentWakeVia;
  /** ISO. */
  since: string;
}

export interface AgentStatus {
  id: string;
  /** 'asleep': its CLI was ended after 30 minutes without a turn, its
   *  conversation kept; a message, a dispatch, a chat, the wake call or a key
   *  typed into its terminal wakes it on that conversation (core/agent-asleep.ts,
   *  services/agent-sleep.ts). Not stopped: nothing has to start it again. */
  status: 'idle' | 'running' | 'completed' | 'error' | 'waiting' | 'stopped' | 'asleep';
  /** ISO: since when it is asleep. Set with `asleep`, gone when it wakes. */
  asleepSince?: string;
  /** Set from the moment a wake starts its CLI until that CLI's session is up
   *  or its launch is given up (AgentStatus.launching). Not saved. */
  waking?: AgentWaking;
  /** Set by a stop (core/agent-stop.ts) until the agent gets a terminal again:
   *  "you", "Tars", or the name of the agent that asked. */
  stoppedBy?: string;
  /** ISO. */
  stoppedAt?: string;
  /** One line, as the caller gave it; none from a window that gave none. */
  stopReason?: string;
  /** ISO: running, yet its transcript has had no write since then (30 minutes
   *  at least) and its CLI runs no tool (services/stall-watch.ts). Cleared by
   *  a write or by any other status. Not saved. */
  stalledSince?: string;
  projectPath: string;
  secondaryProjectPath?: string;
  worktreePath?: string;
  branchName?: string;
  skills: string[];
  currentTask?: string;
  output: string[];
  /** When the dialog this agent waits on opened (the PermissionRequest hook's
   *  `waiting`, `permission`). An interrupt the transcript records after it
   *  means the dialog was refused and is gone (core/agent-launch.ts, dialogOpen). */
  dialogSince?: string;
  /** When the current `status` began (ISO), stamped in the main process
   *  whenever `status` changes, and when the agent joins the fleet. Not
   *  `lastActivity`, which every repaint of the terminal moves. */
  statusSince?: string;
  /** Set while `status` is `waiting` on a dialog (a permission or a question),
   *  from the hook that reports it; gone as soon as `status` changes. Not set
   *  for the idle prompt. */
  waitingOn?: AgentWaitingOn;
  /** Set by agent:list, agent:get and agents:tick: a launch is on its way and
   *  its session is not up yet (a restart, a start from a window, a bot's cold
   *  start, a session the API starts). Main's own window (sessionStarting,
   *  core/agent-launch.ts): 15 s for a CLI that never runs, up to 180 s for
   *  one that runs, until its SessionStart (or, with a task, its first turn). */
  launching?: boolean;
  lastActivity: string;
  error?: string;
  ptyId?: string;
  /** CWD the active PTY was spawned with. Used to detect stale PTYs when
   *  the agent's worktreePath changes after the PTY was started. Not persisted. */
  ptyCwd?: string;
  /** True while a program, the CLI above all, runs in the agent's PTY rather
   *  than its shell (cliRunningIn in core/agent-pty.ts). Never stored: set on
   *  the copies sent to the renderer by agent:list, agent:get and agents:tick. */
  cliRunning?: boolean;
  /** True while the CLI in the agent's PTY repaints inline on an alternate
   *  screen it never left, which leaves the wheel reaching nothing (RepaintWatch
   *  in core/terminal-mirror.ts). Never stored, like cliRunning. */
  leftFullscreen?: boolean;
  character?: AgentCharacter;
  name?: string;
  pathMissing?: boolean;
  /** @deprecated use permissionMode instead */
  skipPermissions?: boolean;
  permissionMode?: AgentPermissionMode;
  effort?: AgentEffort;
  /** The Orchestrator toggle's old field, kept equal to `role === 'orchestrator'`
   *  for the renderer that still reads and sends it. Read `role`. See
   *  core/agent-role.ts. */
  orchestratorMode?: boolean;
  /** The Orchestrator toggle. An orchestrator gets the orchestration
   *  instructions, loses the editing tools, sits in the global room and
   *  answers Telegram and Slack; a project has one at most. Set by the toggle
   *  only, never by the name. See core/agent-role.ts. */
  role?: AgentRole;
  /**
   * The agent that asked for this one's current work, from the
   * X-Tars-Caller-Id header the MCP client sends on every call.
   *
   * Bound to the PTY it was recorded against, and not merely to the agent,
   * because clearing it correctly cannot be left to a list of callers. There
   * are three separate places that spawn a session (initAgentPty,
   * spawnAgentSession, and the local-provider path in ipc-handlers), the
   * interface reaches none of them through the API, and a fourth can be added
   * tomorrow. Every one of them assigns a fresh `ptyId`, so a link whose
   * `ptyId` is not the live one is simply not this session's link and is
   * ignored. Nothing has to remember to clear it.
   *
   * It is also consumed once delivered, so it can never speak for a later
   * piece of work. Read by services/agent-watch.ts.
   */
  requestedBy?: {
    agentId: string;
    ptyId: string;
    /** Set while the link is kept for work the agent left running in the
     *  background: its requester is owed one more note (agent-watch). */
    backgroundLeft?: string[];
  };
  currentSessionId?: string;
  /**
   * The last session this agent ran, kept so it can be resumed.
   *
   * Distinct from `currentSessionId` on purpose. That one is ownership: which
   * live session may drive status, and it has to be cleared on load or the
   * stale-session guard rejects the next real session's hooks. This one is
   * only a memory of where the work got to, so it survives a restart. Without
   * it, updating the app threw away every agent's conversation.
   */
  resumableSessionId?: string;
  /**
   * The session a forked session continues, until the fork has a transcript of
   * its own.
   *
   * A restart continues the conversation with `--resume <id> --fork-session`,
   * and Claude Code writes the forked session's transcript at its first turn,
   * not before. Measured on 2.1.280: a fork left without a turn has no file,
   * so the next resume of `resumableSessionId` found nothing and started a
   * fresh session, and the conversation was gone after two restarts in a row,
   * or after an app restart that followed one.
   */
  forkedFromSessionId?: string;
  /**
   * The Claude account this agent's CLI was last launched on
   * (DESIGN-COMPTES-CLAUDE.md, B3). Absent: account 1, as before the option.
   */
  claudeAccountId?: ClaudeAccountId;
  /**
   * The account the agent is held to, whatever the usage. Absent: automatic.
   * Set from the agent card through claude-accounts:set-agent-account.
   */
  claudeAccountPin?: ClaudeAccountId;
  /**
   * The last time Tars moved this agent to another account on its own, and
   * why: what its card says ("moved by Tars"). Absent: never moved.
   */
  claudeAccountMove?: ClaudeAccountMove;
  /** Session id of the most recently killed PTY's claude session. Its hooks
   *  may still be in flight after the kill; any post carrying this id is
   *  stale and must be ignored (tombstone). */
  lastKilledSessionId?: string;
  /**
   * When the current session last began a turn, from the UserPromptSubmit hook.
   *
   * Distinct from `currentSessionId`, which only says that a session registered.
   * A session that never received its task registers in exactly the same way,
   * which is what made a lost dispatch look like an agent at work.
   */
  lastTurnStartedAt?: string;
  /**
   * When a route last handed this agent work: typed a task into its live
   * session, spawned a session with one, or ran one over ACP.
   *
   * `running` alone cannot say how new it is, and two readers need that. The
   * idle prompt says the agent has sat at its prompt for a minute, and one
   * raised before this moment is about a rest the agent has left
   * (hooks-routes). And coming back to rest is the end of this work only once
   * a turn has begun after it (agent-watch).
   */
  workHandedAt?: string;
  /** When a session last claimed this agent through the SessionStart hook.
   *  The task-start watch reads this to ask "has a session registered since I
   *  armed", which it used to ask by emptying `currentSessionId` and seeing
   *  whether anything filled it back in. */
  sessionRegisteredAt?: string;
  /** Which pty that session claimed the agent from. It is how "the session
   *  that owns this agent is still alive" can be told from "this id is left
   *  over from a session that died with an older pty", which look identical
   *  on the agent otherwise. */
  sessionPtyId?: string;
  /**
   * A task handed to a session that has not started a turn yet, cleared the
   * moment one starts. If none does within the bound, the task is typed into
   * the live session once and the agent is marked failed if that fails too.
   * Runtime state: reset on load, like ptyId.
   */
  pendingDelivery?: { ptyId: string; task: string; dispatchedAt: string; retried?: boolean; checkArmed?: boolean };
  /** Why the agent is 'waiting': 'permission' = blocking permission dialog
   *  (auto-continue must NOT type into it), 'idle' = waiting for next prompt. */
  waitingReason?: string;
  kanbanTaskId?: string;  // For kanban task completion tracking
  statusLine?: string;       // ANSI-stripped last meaningful output line
  lastCleanOutput?: string;  // Clean text output captured from transcript by hooks
  provider?: AgentProvider;   // 'claude' (default) or 'local' (Tasmania)
  model?: string;              // Model name (e.g. 'sonnet', 'opus', 'haiku'), persisted across restarts
  localModel?: string;        // Tasmania model name when provider is 'local'
  savedPrompt?: string;       // Saved task/prompt for re-launching the agent
  obsidianVaultPaths?: string[]; // Obsidian vault paths to mount via --add-dir (read-only)
  createdAt?: string;         // ISO timestamp when the agent was created
  cliPath?: string;              // Custom CLI binary path override
}

/**
 * Every binary Tars locates for the user, and whose directory goes on the PATH
 * of an agent's PTY.
 *
 * A runtime list and not only an interface, because four places in the main
 * process walked these keys and each carried its own copy of them. They had
 * already drifted: one forgot opencode and pi, two forgot grok and minimax,
 * and the preload's save signature forgot grok before Amp was ever added. Each
 * was silent, and each grew by one more omission per provider.
 *
 * This is deliberately NOT derived from the provider registry. It is a superset
 * of it: gh, node, gws and gcloud are tools an agent needs on its PATH and are
 * nobody's provider, while qwencode and minimax are path keys whose providers
 * run the claude binary under another name. Deriving from getAllProviders would
 * have quietly dropped four working entries.
 */
export const CLI_PATH_KEYS = [
  'amp',
  'claude',
  'codex',
  'gemini',
  'grok',
  'qwencode',
  'opencode',
  'pi',
  'gws',
  'gcloud',
  'gh',
  'node',
  'minimax',
] as const;

export type CLIPathKey = typeof CLI_PATH_KEYS[number];

export type CLIPaths = Record<CLIPathKey, string> & {
  /** Extra directories the user added by hand, already directories not files. */
  additionalPaths: string[];
};

export interface AppSettings {
  notificationsEnabled: boolean;
  notifyOnWaiting: boolean;
  notifyOnComplete: boolean;
  notifyOnStop: boolean;
  notifyOnError: boolean;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string; // Legacy - kept for backwards compatibility
  telegramAuthToken: string; // Secret token for authentication
  telegramAuthorizedChatIds: string[]; // List of authorized chat IDs
  telegramRequireMention: boolean; // Only respond when bot is @mentioned in groups
  /**
   * The relay to the user's Telegram through their Hermes (services/hermes-relay.ts): off unless turned on in
   * Settings, Hermes. On, it is the only voice there: the Tars bot's token is erased and the bot off
   * (hermes-relay-switch.ts), questions, reports and the orchestrator's send_telegram go through it.
   */
  hermesRelayEnabled?: boolean;
  slackEnabled: boolean;
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  slackChannelId: string;
  /**
   * The Slack users (member ids, `U…`) the bot answers. Empty answers nobody:
   * without it, anyone who could reach the bot (a workspace member, a guest, a
   * Slack Connect user in a shared channel) could list, start, stop and brief
   * agents (the audit's lead #15). The Telegram bot's authorized chats, for Slack.
   */
  slackAllowedUserIds: string[];
  discordEnabled: boolean;
  discordBotToken: string;
  /** The channel Tars posts to: detected when an allowed member mentions the bot or DMs it. */
  discordChannelId: string;
  /**
   * The Discord users (user ids, 17 to 20 digits) the bot answers. Empty answers
   * nobody, as Slack's allowed members (the audit's lead #15).
   */
  discordAllowedUserIds: string[];
  /** In server channels, answer only a message that mentions the bot. Direct messages always work. */
  discordRequireMention: boolean;
  /**
   * Send error reports to Tars's Sentry project: the error, its stack, Tars's
   * version, the system and a random install id, nothing else
   * (services/error-reports). Off by default; followed live.
   */
  errorReportsEnabled: boolean;
  jiraEnabled: boolean;
  jiraDomain: string;
  jiraEmail: string;
  jiraApiToken: string;
  socialDataEnabled: boolean;
  socialDataApiKey: string;
  xPostingEnabled: boolean;
  xApiKey: string;
  xApiSecret: string;
  xAccessToken: string;
  xAccessTokenSecret: string;
  tasmaniaEnabled: boolean;
  tasmaniaServerPath: string;
  gwsEnabled: boolean;
  gwsSkillsInstalled: boolean;
  verboseModeEnabled: boolean;
  chromeEnabled: boolean;
  autoCheckUpdates: boolean;
  /** Resume idle agents once, when the app launches. Not on navigation - that
   *  was the old behaviour and it spawned sessions on every visit home. */
  autoStartAgentsOnLaunch?: boolean;
  cliPaths: CLIPaths;
  opencodeEnabled: boolean;
  opencodeDefaultModel: string;
  ampEnabled?: boolean;
  ampDefaultModel?: string;
  /** Amp access token (sgamp_...), passed to the PTY as AMP_API_KEY. */
  ampApiKey?: string;
  /** External AI provider keys. All alt providers use the claude binary
   *  with ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY injected into the PTY. */
  openRouterEnabled?: boolean;
  openRouterApiKey?: string;
  deepSeekEnabled?: boolean;
  deepSeekApiKey?: string;
  mimoEnabled?: boolean;
  mimoApiKey?: string;
  moonshotEnabled?: boolean;
  moonshotApiKey?: string;
  qwenEnabled?: boolean;
  qwenApiKey?: string;
  zhipuEnabled?: boolean;
  zhipuApiKey?: string;
  minimaxEnabled?: boolean;
  minimaxApiKey?: string;
  nvidiaEnabled?: boolean;
  nvidiaApiKey?: string;
  nousPortalEnabled?: boolean;
  nousPortalApiKey?: string;
  /** Venice AI has no Anthropic-compatible endpoint (OpenAI-compatible only), so
   *  it is reached through Tars's own local translation bridge, not directly. */
  veniceEnabled?: boolean;
  veniceApiKey?: string;
  /** Ollama is a local server, not a hosted vendor: no key, just where to find it.
   *  Empty means the default http://localhost:11434. */
  ollamaBaseUrl?: string;
  /** Ollama Cloud is a different product from local Ollama: a hosted vendor at
   *  https://ollama.com with its own key. It speaks the Anthropic wire format
   *  natively (like local Ollama), but wants `Authorization: Bearer`, not
   *  `x-api-key` (ollama/ollama#16922) - a header difference, not a translation
   *  problem, so it is a direct provider like local Ollama, never through the
   *  OpenAI-compatible bridge. See providers/ollama-cloud-provider.ts. */
  ollamaCloudEnabled?: boolean;
  ollamaCloudApiKey?: string;
  /** Any OpenAI-compatible endpoint the user points Tars at directly - the
   *  point of not shipping a named provider for every such vendor. Has no
   *  models.dev catalogue entry (private/self-hosted), so the model is typed
   *  by hand rather than picked from a live list. Reached through the same
   *  translation bridge as Venice; see services/openai-bridge.ts. */
  customOpenAIEnabled?: boolean;
  customOpenAIBaseUrl?: string;
  customOpenAIApiKey?: string;
  customOpenAIModel?: string;
  /** Remote Hermes instance (external scheduler) */
  hermesGatewayUrl?: string;
  hermesGatewayToken?: string;
  /** Shared memory backends: remote MCP servers auto-registered so every
   *  claude-binary agent shares the same brain as Hermes/Cowork. */
  memoryGbrainEnabled?: boolean;
  memoryGbrainMcpUrl?: string;
  memoryGbrainAuthToken?: string;
  memoryHonchoEnabled?: boolean;
  memoryHonchoMcpUrl?: string;
  memoryHonchoApiKey?: string;
  /**
   * Sent as the X-Honcho-Workspace-ID header on every Honcho call.
   *
   * Not a nicety: none of Honcho's tools declares workspace_id as required
   * in its schema, so an agent reads it as optional and omits it, and the
   * server then refuses the call at execution time. list_workspaces, the
   * one way out, answers 502. The header is the only clean way to bind a
   * workspace, and the server's own error message asks for it by name.
   *
   * Empty means no header, which is exactly today's behaviour.
   */
  memoryHonchoWorkspaceId?: string;
  defaultProvider?: AgentProvider;
  obsidianVaultPaths?: string[];
  notificationSounds?: {
    waiting?: string;
    complete?: string;
    stop?: string;
    error?: string;
  };
  terminalFontSize?: number;
  terminalTheme?: 'dark' | 'light';
  statusLineEnabled?: boolean;
  favoriteProjects?: string[];
  hiddenProjects?: string[];
  defaultProjectPath?: string;
  /** Monthly ceiling per provider, in dollars. Set on the Usage page. */
  providerBudgets?: Record<string, number>;
}

/* ── The agent bus ─────────────────────────────────────────────────────────
 * The shared contract, read by the Backend that implements it, the Frontend
 * that builds the Chat page on it and the QA that tests it. A room holds
 * threads, a thread anchors messages, and a delivery is the only thing the
 * interface may show as proof that a message reached an agent.
 */

/** `global` is today's super chat, watching every project; `project` is one
 *  room per project, whose members are that project's agents. */
export type BusRoomKind = 'global' | 'project';

export interface BusRoom {
  /** `global`, or `project:<project path>`. */
  id: string;
  kind: BusRoomKind;
  projectPath?: string;
  title: string;
  memberIds: string[];
  createdAt: string;
  /** The newest message in this room, for sorting the conversation list and
   *  showing a line under each. Absent on the global room, whose history is
   *  the overseer's own conversation and is not in this journal. */
  lastMessageAt?: string;
  lastMessagePreview?: string;
  /** What is waiting in this room, by delivery state, so the conversation
   *  list can show it without reading each room. Zero for the global room,
   *  whose messages are not in this journal. */
  pending: BusRoomPending;
}

/** Deliveries of a room's messages still waiting, by state. `delivered` and
 *  `dropped` are over and not counted. */
export interface BusRoomPending {
  queued: number;
  held: number;
  notSent: number;
}

/**
 * A thread is the anchor, and the bounds are per anchor.
 *
 * `open` is live, `bounded` hit three rounds or ten agent messages and only a
 * human message reopens it, `stopped` was stopped by hand, and `superseded`
 * was closed by a newer human message or by a change of members. Late replies
 * to anything but `open` are dropped with that reason.
 */
export type BusThreadState = 'open' | 'bounded' | 'stopped' | 'superseded';

export interface BusThread {
  id: string;
  roomId: string;
  anchorMessageId: string;
  state: BusThreadState;
  round: number;
  agentMessageCount: number;
  openedAt: string;
}

export type BusMessageAuthorKind = 'human' | 'agent' | 'system';

/**
 * What a machine line is about.
 *
 * The Chat page draws these as distinct rows, and with only `text` they all
 * collapse into one grey line. Each value here has a producer in this process;
 * a kind nobody emits would be a row the page can never show, which is the
 * same mistake as a state with no way out.
 *
 * There is deliberately no `passed`: an agent with nothing to add is refused
 * before anything is stored, so a silence has no row and no source of data.
 */
export type BusSystemKind = 'thread_stopped' | 'members_changed' | 'queue_released' | 'turn_interrupted';

/** What a `members_changed` line is about, as data: the page picks its icon
 *  and names from this, never from the sentence. `added` and `removed` are
 *  agent ids; `names` holds each one's name when the change was made, since a
 *  removed agent may be gone by the time the row is drawn. `dropped` is how
 *  many messages still queued in the thread the change closed were dropped. */
export interface BusMembersChanged {
  added: string[];
  removed: string[];
  names: Record<string, string>;
  dropped: number;
}

/** A file staged for a room (`bus:stageFiles`): written under ~/.dorothy,
 *  which is in every agent's `--add-dir`, and named by its absolute path in
 *  what each target receives. */
export interface BusAttachment {
  id: string;
  name: string;
  /** Absolute, readable by the agents. */
  path: string;
  bytes: number;
  isImage: boolean;
}

export interface BusMessage {
  id: string;
  roomId: string;
  threadId: string;
  authorKind: BusMessageAuthorKind;
  /** Agent id, or `human` for JeanBrasse. */
  authorId: string;
  authorName: string;
  text: string;
  /** Agent ids named in the text: after the first round, only a mentioned
   *  agent that has not spoken since gets a turn. */
  mentions: string[];
  /** Set only when `authorKind` is `system`: which machine event this is. */
  systemKind?: BusSystemKind;
  /** Set only on a `members_changed` line. */
  systemData?: BusMembersChanged;
  /** Files staged with `bus:stageFiles` and sent with it. */
  attachments?: BusAttachment[];
  createdAt: string;
}

/**
 * Where a message got to, per target.
 *
 * `queued` waits for the target to leave `running`, `delivered` was written
 * into its session, `dropped` will never be sent and says why. `not_sent` is
 * the fourth state and the one that needs saying: amp, codex, grok, opencode
 * and pi never leave `running` in an interactive session, so nothing can be
 * delivered to them at rest. A message aimed at one of those is neither queued
 * nor delivered on its own: it is kept, shown as NOT SENT with its reason, and
 * moves only on an explicit human action. Never inferred from silence, which
 * is idleness detection and deliberately out of v1.
 */
/** `held` is taken by the target's terminal but waits behind what somebody has
 *  typed in its field (`reasonCode: 'draft'`, `heldAt`): Tars never types
 *  across a draft, and it goes in by itself once that field is sent or
 *  cleared, when it turns `delivered`. */
export type BusDeliveryState = 'queued' | 'held' | 'not_sent' | 'delivered' | 'dropped';

/**
 * Why a delivery is not going anywhere, as a value rather than a sentence.
 *
 * The interface has to render this, and matching on English prose is how a
 * wording change silently turns a visible state invisible. The sentence stays
 * beside it for a human to read.
 *
 * `no_end_of_turn` is the one that names the five: amp, codex, grok, opencode
 * and pi never leave `running` in an interactive session. `session_replaced`
 * is a message queued for a session that was killed before it drained: it
 * belongs to that session and is not handed to whatever took its place.
 */
export type BusDeliveryReason =
  | 'no_end_of_turn'
  | 'no_live_session'
  | 'session_replaced'
  | 'thread_stopped'
  | 'thread_replaced'
  | 'members_changed'
  | 'draft';

export interface BusDelivery {
  messageId: string;
  targetAgentId: string;
  state: BusDeliveryState;
  reasonCode?: BusDeliveryReason;
  reason?: string;
  queuedAt: string;
  /** When it was found waiting behind a draft: set with `held`. */
  heldAt?: string;
  deliveredAt?: string;
  /** When this stopped being on its way: set with `dropped` and with
   *  `not_sent`. Without it the page can say a message is refused but not
   *  when, which for `not_sent` is the whole of how old a held message is. */
  refusedAt?: string;
}

/**
 * A member of a room, as the page needs to draw it.
 *
 * `hasEndOfTurn` is derived here from the provider's hook configuration, the
 * same read the delivery path makes. It is exposed because the renderer was
 * otherwise copying the list of five CLIs by hand, and a hand-written copy of
 * a derived value is a copy that goes stale the day a provider gains hooks.
 */
export interface BusMember {
  id: string;
  name: string;
  provider?: string;
  hasEndOfTurn: boolean;
  /** Tars can interrupt this member's turn (`bus:sendNow`): a CLI on the claude
   *  binary, where Esc stops the turn and the transcript records it. */
  canInterrupt: boolean;
}

/** What `bus:getRoom` answers: the room and its journal, newest last. */
export interface BusRoomSnapshot {
  room: BusRoom;
  members: BusMember[];
  threads: BusThread[];
  messages: BusMessage[];
  deliveries: BusDelivery[];
}

/**
 * A message that cannot go into an agent's terminal yet, and why.
 *
 * Pushed on `agent:message-waiting` whenever that changes for a terminal,
 * including the moment it stops being true, where `waiting` is 0 and the
 * panel takes the notice down.
 *
 * It exists because the alternative to mixing a message into what somebody is
 * typing is making it wait, and a wait nobody can see is worse than either:
 * the two things that end it, sending the draft or clearing it, can only be
 * done by the person at that keyboard, and only if they are told.
 */
export interface AgentMessageWaiting {
  /** The agent whose terminal is holding them. */
  agentId: string;
  /** How many messages are waiting. 0 means the wait is over. */
  waiting: number;
  /** Who they are from, each named once, oldest first. */
  from: string[];
}

/**
 * Several Claude subscriptions (DESIGN-COMPTES-CLAUDE.md, B6).
 *
 * An account is a Claude Code configuration directory, signed in once by
 * Claude Code itself (`claude auth login`). Tars chooses which directory a
 * CLI starts with, and never reads, copies or stores a credential.
 *
 * 'default' is ~/.claude, launched without CLAUDE_CONFIG_DIR. Others are
 * 'acct-' and six random hex digits, drawn afresh for each new account.
 */
export type ClaudeAccountId = string;

export interface ClaudeAccount {
  id: ClaudeAccountId;
  /** Chosen by the user, 1 to 40 characters. */
  label: string;
  /**
   * ~/.claude-accounts/<id>, the home resolved once: derived from the id,
   * never read from the registry file, and passed exactly as it is, since
   * Claude Code names the keychain item after this string, not after the
   * folder it resolves to. null for 'default'.
   */
  configDir: string | null;
  enabled: boolean;
}

export interface ClaudeAccountsSettings {
  /** The option. false by default: with it off nothing changes for anyone. */
  enabled: boolean;
  /** In order of preference. 'default' is always there. At most 5. */
  accounts: ClaudeAccount[];
  /** Percent, whole numbers from 50 to 100. Defaults 90 and 95. */
  fiveHourThreshold: number;
  weeklyThreshold: number;
}

export interface ClaudeAccountWindow {
  usedPercentage: number;
  /** Epoch seconds. */
  resetsAt: number;
}

/** One account's 5 h and weekly counters, as the Usage page shows them (claude:getData). */
export interface ClaudeAccountCounters {
  accountId: ClaudeAccountId;
  label: string;
  /** null when no status line or probe has reported it, or its reset has passed. */
  fiveHour: ClaudeAccountWindow | null;
  sevenDay: ClaudeAccountWindow | null;
  /** The per-model weeklies a probe read (get_usage), when it read any. */
  models?: ClaudeAccountModelWindow[];
  /** Epoch ms of the last report on that account: a status line's or a probe's. */
  updatedAt: number | null;
}

/** One per-model weekly window ("Fable"), as Claude Code's get_usage gives it. */
export interface ClaudeAccountModelWindow {
  name: string;
  usedPercentage: number;
  /** Epoch seconds. */
  resetsAt: number;
}

export interface ClaudeAccountState extends ClaudeAccount {
  /** From `claude auth status`. null until it has answered. */
  signedIn: boolean | null;
  email: string | null;
  subscriptionType: string | null;
  /** Last reported by a status line or a probe; null when never seen or reset. */
  fiveHour: ClaudeAccountWindow | null;
  sevenDay: ClaudeAccountWindow | null;
  /** The per-model weeklies a probe read; empty when none. */
  models: ClaudeAccountModelWindow[];
  /** Epoch ms of that report. */
  updatedAt: number | null;
  /** Epoch seconds: a limit was hit, the account is skipped until then. */
  blockedUntil: number | null;
  /** Agents whose CLI runs on it now. */
  agentIds: string[];
  /** A sentence for the page: why the last sign-in or status check did not work. */
  error: string | null;
}

export interface ClaudeAccountsView {
  settings: ClaudeAccountsSettings;
  accounts: ClaudeAccountState[];
  /**
   * Set when ~/.tars-private/claude-accounts.json is there and does not read:
   * the view shows account 1 alone, and every change is refused until the
   * file is fixed or removed, so the other accounts are not written over.
   */
  registryError: string | null;
}

/**
 * Pushed on claude-accounts:agent-moved when Tars has moved an agent to
 * another account on its own, and kept on the agent as claudeAccountMove.
 * 'limit': the account hit that window's limit mid-turn; the agent was
 * restarted on the same conversation and told to continue. 'threshold': the
 * account was past its threshold for that window when a turn ended; nothing
 * was cut. Sent when the launch on the new account is made.
 */
export interface ClaudeAccountMove {
  agentId: string;
  from: ClaudeAccountId;
  to: ClaudeAccountId;
  reason: 'limit' | 'threshold';
  window: 'fiveHour' | 'sevenDay';
  /** The window's use on `from` when the move was decided; 100 for a limit. null when not measured. */
  usedPercentage: number | null;
  /** Epoch ms of the launch on `to`. */
  at: number;
}

/** Pushed on claude-accounts:agent-changed when an agent's account or pin changes. */
export interface ClaudeAccountAgentChange {
  agentId: string;
  /** The account its CLI was last launched on; null is account 1. */
  claudeAccountId: ClaudeAccountId | null;
  /** The account it is held to; null is automatic. */
  claudeAccountPin: ClaudeAccountId | null;
}
