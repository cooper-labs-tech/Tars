export interface RepoSummary {
  branch: string;
  status: { status: string; file: string }[];
  commits: { hash: string; subject: string; author: string; when: string }[];
  additions: number;
  deletions: number;
}

export interface LogLine {
  agentId: string;
  agentName: string;
  projectPath: string;
  branch?: string;
  status: string;
  line: string;
  position: number;
}

export interface FleetEntry {
  agentId: string;
  agentName: string;
  projectPath: string;
  branch?: string;
  provider?: string;
  status: string;
  lastActivity?: string;
  lines: number;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  additions: number;
  deletions: number;
}

export interface ReviewDiff {
  repo: string;
  branch: string;
  baseBranch: string | null;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  totalAdditions: number;
  totalDeletions: number;
  patch: string;
  truncated: boolean;
}

export interface MemorySourceStatus {
  id: string;
  label: string;
  configured: boolean;
  reachable: boolean;
  detail: string;
  tools?: string[];
}

export interface MemoryHit {
  source: string;
  title: string;
  content: string;
  ref?: string;
}

export interface ModelCost {
  /** USD per million tokens */
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
  reasoning?: boolean;
  effortValues?: string[];
  cost?: ModelCost;
  releaseDate?: string;
  /** True for an undated id that tracks the newest build of its family. */
  alias?: boolean;
}

export type DisplayStatus = 'working' | 'waiting' | 'done' | 'ready' | 'stopped' | 'error' | 'asleep' | 'waking';

export interface AgentTickItem {
  id: string;
  name: string;
  character: string;
  status: 'idle' | 'running' | 'completed' | 'error' | 'waiting' | 'stopped' | 'asleep';
  displayStatus: DisplayStatus;
  /** Since when it is asleep (ISO). See AgentStatus.asleepSince. */
  asleepSince?: string;
  /** Who woke it and how, while its CLI comes back. See AgentStatus.waking. */
  waking?: AgentWaking;
  statusLine: string;
  currentTask: string;
  projectName: string;
  lastActivity: string;
  /** When the current status began (ISO). See AgentStatus.statusSince. */
  statusSince?: string;
  /** What a waiting agent waits on. See AgentStatus.waitingOn. */
  waitingOn?: AgentWaitingOn;
  /** A launch is on its way. See AgentStatus.launching. Always set on agents:tick. */
  launching?: boolean;
  provider: string;
  /** A CLI runs in the agent's terminal, whatever its status says: a turn that
   *  failed leaves claude alive, and done or idle agents keep their session.
   *  Always set on agents:tick; optional for items the renderer builds itself. */
  cliRunning?: boolean;
  /** The CLI repaints inline on an alternate screen it never left: it asked for
   *  the wheel in fullscreen and no longer reads the reports. Always set on
   *  agents:tick; optional for items the renderer builds itself. */
  leftFullscreen?: boolean;
}

/**
 * A message that is waiting for an agent's input field to be free.
 *
 * Mirror of `AgentMessageWaiting` in electron/types/index.ts. Never mixing a
 * note into somebody's half-written prompt means sometimes making the note
 * wait, and a wait nobody can see is worse than either: only the person at
 * that keyboard can end it, by sending their draft or clearing it.
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
 * What a restart that applies a changed launch setting waits on
 * (electron/core/agent-restart.ts):
 * - `turn`: the turn in progress ends.
 * - `permission`: its permission question is answered and the turn ends.
 * - `note`: a note or room message owed to the agent has been typed in.
 * - `background`: work the session left running (a Bash command, a Monitor,
 *   an asynchronous Agent) has reported back.
 * - `launch`: its CLI, restarted a moment ago, is still starting.
 * - `draft`: its field is emptied: something is typed in it and not sent.
 * - `typing`: nobody has typed in its field for five seconds.
 * - `queued`: the messages waiting for its field have gone in.
 * - `writing`: the message Tars just typed into it has started.
 */
export type AgentRestartWait =
  | 'turn' | 'permission' | 'note' | 'background' | 'launch'
  | 'draft' | 'typing' | 'queued' | 'writing';

export interface AgentPendingRestart {
  agentId: string;
  /** The settings it applies: `model`, `effort`, `permissionMode`, `orchestrator`, `secondaryProjectPath`, `obsidianVaultPaths`, `localModel`. */
  settings: string[];
  waitingFor: AgentRestartWait;
}

export interface AgentEvent {
  type: string;
  agentId: string;
  ptyId?: string;
  data: string;
  timestamp: string;
  exitCode?: number;
}

export interface KanbanTaskElectron {
  id: string;
  title: string;
  description: string;
  column: 'backlog' | 'planned' | 'ongoing' | 'done';
  projectId: string;
  projectPath: string;
  assignedAgentId: string | null;
  requiredSkills: string[];
  priority: 'low' | 'medium' | 'high';
  progress: number;
  createdAt: string;
  updatedAt: string;
  order: number;
  labels: string[];
}

export interface VaultDocumentElectron {
  id: string;
  title: string;
  content: string;
  folder_id: string | null;
  author: string;
  agent_id: string | null;
  tags: string; // JSON array string
  created_at: string;
  updated_at: string;
  snippet?: string; // From FTS search results
}

export interface VaultFolderElectron {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface VaultAttachmentElectron {
  id: string;
  document_id: string;
  filename: string;
  filepath: string;
  mimetype: string;
  size: number;
  created_at: string;
}

export interface MemoryFile {
  name: string;
  path: string;
  content: string;
  size: number;
  lastModified: string;
  isEntrypoint: boolean;
}

export interface ProjectMemory {
  id: string;
  projectName: string;
  projectPath: string;
  memoryDir: string;
  files: MemoryFile[];
  totalSize: number;
  lastModified: string;
  hasMemory: boolean;
  provider: string;    // 'claude' | 'codex' | 'gemini'
}

export interface ObsidianFile {
  name: string;
  path: string;
  relativePath: string;
  content: string;
  size: number;
  lastModified: string;
  frontmatter?: Record<string, unknown>;
}

export interface ObsidianFolder {
  name: string;
  path: string;
  relativePath: string;
  children: (ObsidianFolder | { type: 'file'; name: string; relativePath: string })[];
}

export interface ImportPreview {
  name: string;
  description: string;
  width: number;
  height: number;
  npcCount: number;
  buildingCount: number;
  screenshot: string;
}

export interface WorktreeConfig {
  enabled: boolean;
  branchName: string;
}

export type AgentCharacter = 'robot' | 'ninja' | 'wizard' | 'astronaut' | 'knight' | 'pirate' | 'alien' | 'viking' | 'frog';

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

/** What a waiting agent waits on: the dialog its CLI shows. `permission` names
 *  the command, file or tool asked about; `question` is an AskUserQuestion's
 *  first question. One line, controls and direction overrides removed, at most
 *  200 characters. */
/** How an asleep agent was woken. Mirror of `AgentWakeVia` in electron/types/index.ts. */
export type AgentWakeVia = 'message' | 'chat' | 'wake' | 'key' | 'start';

/** An asleep agent whose CLI is on its way back. Mirror of `AgentWaking`. */
export interface AgentWaking {
  /** "you", "Tars", an agent's name, or a chat ("Telegram"). */
  by: string;
  via: AgentWakeVia;
  /** ISO. */
  since: string;
}

export interface AgentWaitingOn {
  kind: 'permission' | 'question';
  text: string;
}

export interface AgentStatus {
  id: string;
  /** 'stopped': ended by a stop, with stoppedBy, stoppedAt and stopReason, until it is started again.
   *  'asleep': its CLI was ended after 30 minutes without a turn (never an orchestrator), its
   *  conversation kept, from asleepSince; a message, a dispatch, a chat, `wake` or a key typed into
   *  its pane wakes it on that conversation. agent:get gives the pane the last screen of the CLI it
   *  slept in, in `output`. */
  status: 'idle' | 'running' | 'completed' | 'error' | 'waiting' | 'stopped' | 'asleep';
  /** ISO: since when it is asleep. */
  asleepSince?: string;
  /** Set by agent:list, agent:get and agents:tick from the moment a wake starts its CLI until
   *  that CLI's session is up or its launch is given up: who woke it, how, and when. */
  waking?: AgentWaking;
  /** "you", "Tars", or the name of the agent that stopped it. */
  stoppedBy?: string;
  /** ISO. */
  stoppedAt?: string;
  /** One line, or none when the window's stop gave none. */
  stopReason?: string;
  /** ISO: running, yet nothing written to its transcript since then (30 minutes
   *  at least) and no tool at work: it looks frozen. Cleared by a write or by any
   *  other status. */
  stalledSince?: string;
  projectPath: string;
  secondaryProjectPath?: string; // Secondary project added via --add-dir
  worktreePath?: string;
  branchName?: string;
  skills: string[];
  currentTask?: string;
  /** Empty from agent:list. From agent:get, what to write into a fresh terminal
   *  to show this agent: its terminal's screen as one chunk, opening with RIS
   *  (core/terminal-mirror.ts), or the kept tail of the stream when the
   *  terminal has no mirror. Empty, with no ptyId, for an agent with no
   *  terminal: agent:get opens none. */
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
  /** Set by agent:list and agent:get: a CLI runs in the agent's terminal. */
  cliRunning?: boolean;
  /** Set by agent:list and agent:get: the CLI repaints inline on an alternate
   *  screen it never left, so wheel reports reach nothing. */
  leftFullscreen?: boolean;
  character?: AgentCharacter;
  name?: string;
  statusLine?: string;    // ANSI-stripped last meaningful output line
  pathMissing?: boolean; // True if project path no longer exists
  /** @deprecated Use permissionMode instead */
  skipPermissions?: boolean;
  permissionMode?: 'normal' | 'auto' | 'bypass';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** @deprecated Read `role`. Kept equal to `role === 'orchestrator'`. */
  orchestratorMode?: boolean;
  /** The Orchestrator toggle, and nothing else: never read from the name.
   *  An orchestrator gets the orchestration instructions, cannot edit files
   *  and sits in the global room. Telegram and Slack talk to one of them only,
   *  the fleet's first (getSuperAgent with no project). A project has one at
   *  most. Always set on a record from the main process. */
  role?: 'orchestrator' | 'worker';
  /** The Claude account this agent's CLI was last launched on. Absent: account 1. */
  claudeAccountId?: ClaudeAccountId;
  /** The account the agent is held to. Absent: chosen automatically. */
  claudeAccountPin?: ClaudeAccountId;
  /** The last time Tars moved it to another account on its own, and why. Absent: never. */
  claudeAccountMove?: ClaudeAccountMove;
  provider?: AgentProvider;   // 'claude' (default) or 'local' (Tasmania)
  model?: string;              // Model name (e.g. 'sonnet', 'opus', 'haiku')
  /** Set by agent:list: the model the agent's last session answered on, read
   *  from its transcript. It differs from `model` after a `/model` typed into
   *  the terminal, which lasts for that session only. `model` is what the next
   *  launch uses. */
  sessionModel?: string;
  localModel?: string;        // Tasmania model name when provider is 'local'
  savedPrompt?: string;       // Saved task/prompt for re-launching the agent
  obsidianVaultPaths?: string[]; // Obsidian vault paths to mount via --add-dir (read-only)
  createdAt?: string;         // ISO timestamp when the agent was created
  cliPath?: string;              // Custom CLI binary path override
}

export interface AgentTemplate {
  id: string;
  builtin: boolean;
  /** True if this built-in has been customized by the user. */
  overridden?: boolean;
  displayName: string;
  description: string;
  icon: string;
  tags: string[];
  character: AgentCharacter;
  provider: AgentProvider;
  model?: string;
  localModel?: string;
  permissionMode: 'normal' | 'auto' | 'bypass';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  skills: string[];
  obsidianVaultPaths?: string[];
  savedPrompt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTemplateInput {
  displayName: string;
  description?: string;
  icon?: string;
  tags?: string[];
  character?: AgentCharacter;
  provider?: AgentProvider;
  model?: string;
  localModel?: string;
  permissionMode?: 'normal' | 'auto' | 'bypass';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  skills?: string[];
  obsidianVaultPaths?: string[];
  savedPrompt?: string;
}

export interface AgentTemplatePatch extends Partial<AgentTemplateInput> {
  id: string;
}

export interface TemplateExport {
  version: number;
  kind: 'tars.agent-template';
  exportedAt: string;
  templates: AgentTemplateInput[];
}

/** One agent slot in a team. Deploying a team creates one agent per member. */
export type HermesMode = 'local' | 'ssh' | 'remote' | 'cloud';
export type HermesAuthMode = 'token' | 'oauth';

export interface HermesSshConfig {
  host: string;
  user: string;
  port?: number;
  keyPath?: string;
  remotePort?: number;
  localPort?: number;
}

/**
 * The relay to the user's Telegram through their Hermes (electron/services/hermes-relay.ts), as Settings, Hermes shows
 * it. `state`: off (the switch, hermesRelayEnabled, is off); ready; unreachable (Hermes did not answer); not-configured
 * (the tars-relay plugin has no user id on the server); plugin-missing (not installed on the server); unauthorized
 * (the dashboard token was refused); no-connection (no Hermes connection saved). `waiting`: sends Hermes has not
 * taken yet, which go when it does.
 */
export interface HermesRelayStatus {
  enabled: boolean;
  state: 'off' | 'ready' | 'unreachable' | 'not-configured' | 'plugin-missing' | 'unauthorized' | 'no-connection';
  waiting: number;
  lastError?: string;
  lastSentAt?: string;
  lastReplyAt?: string;
  checkedAt?: string;
}

export interface HermesConnection {
  mode: HermesMode;
  localPort?: number;
  ssh?: HermesSshConfig;
  url?: string;
  authMode?: HermesAuthMode;
  token?: string;
  org?: string;
}

/** An MCP server the Hermes gateway itself has registered (gbrain, pencil, …). */
export interface HermesMcpServer {
  name: string;
  url: string | null;
  transport: string | null;
  enabled: boolean;
  /** True when the URL only resolves on the gateway's own machine. */
  gatewayLocal: boolean;
}

/** One of the gateway's pluggable long-term memory backends. */
export interface HermesMemoryProvider {
  name: string;
  description: string;
  available: boolean;
  configured: boolean;
  status: string;
}

export interface TeamTemplateMember {
  name: string;
  character: AgentCharacter;
  provider: AgentProvider;
  model?: string;
  localModel?: string;
  permissionMode: 'normal' | 'auto' | 'bypass';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  skills: string[];
  savedPrompt?: string;
  worktreeBranch?: string;
  /** The Orchestrator toggle of the agent this member deploys. */
  role?: 'orchestrator' | 'worker';
  /** @deprecated Read `role`. Kept equal to `role === 'orchestrator'`. */
  orchestratorMode?: boolean;
}

export interface TeamTemplate {
  id: string;
  builtin: boolean;
  name: string;
  description: string;
  icon: string;
  members: TeamTemplateMember[];
  createdAt: string;
  updatedAt: string;
}

// Overseer chat: mirrors electron/services/overseer.ts

/** A proposed write to one agent. Never executed until confirmAction sends
 *  it with approve:true - the main process re-resolves the target against
 *  the live fleet immediately before writing, regardless of what this
 *  object says. */
export interface OverseerAction {
  actionId: string;
  agentId: string;
  agentName: string;
  projectPath: string;
  provider: string;
  model?: string;
  pane: string;
  text: string;
  /** ISO timestamp of the resolution this action was built from. */
  resolvedAt: string;
}

/** A file already uploaded to the gateway, named by the message that sent it. */
export interface OverseerAttachment {
  name: string;
  path: string;
  isImage: boolean;
}

export interface OverseerMessage {
  id: string;
  role: 'user' | 'overseer';
  text: string;
  action: OverseerAction | null;
  /** Set when this message is an unprompted watch-timer check-in rather
   *  than a reply to something JeanBrasse asked. */
  isBriefing?: boolean;
  timestamp: string;
  /** Files sent with this message, kept beside the text so the bubble can
   *  show a chip and the text stays what was typed. */
  attachments?: OverseerAttachment[];
  /** Set when this reply looks like the format template rather than an answer.
   *  Computed on read, never stored, so nothing is lost if the rule is wrong:
   *  the bubble can be hidden or greyed, and the message is still there. */
  templateEcho?: boolean;
}

export interface OverseerFleetAgent {
  id: string;
  name: string;
  projectPath: string;
  worktreePath?: string;
  branchName?: string;
  provider: string;
  model?: string;
  status: string;
  statusDurationMs: number;
  recentOutput: string;
  outputTruncated: boolean;
}

export interface OverseerFleetProject {
  path: string;
  branch: string;
  dirty: boolean;
  agentCount: number;
}

export interface OverseerFleetSnapshot {
  takenAt: string;
  agents: OverseerFleetAgent[];
  projects: OverseerFleetProject[];
  agentsOmitted: number;
}

export type OverseerAskResult =
  | { ok: true; message: OverseerMessage }
  | { ok: false; reason: 'not_configured' | 'gateway_unreachable' | 'needs_sign_in' | 'run_timeout' | 'busy' | 'error'; error: string };

export interface TeamTemplateInput {
  name: string;
  description?: string;
  icon?: string;
  members: Partial<TeamTemplateMember>[];
}

export interface PtyDataEvent {
  id: string;
  data: string;
}

export interface PtyExitEvent {
  id: string;
  exitCode: number;
}

export interface SkillInstallOutputEvent {
  repo: string;
  data: string;
}

export interface OverseerAutoRule {
  id: string;
  label: string;
  description: string;
}

export interface OverseerSettings {
  /** How often the watch looks at the fleet. 1 minute to 6 hours. */
  watchIntervalMs: number;
  /** Rules the overseer may act on without asking. Empty by default. */
  autoActions: string[];
  /** Empty means "whatever the Hermes gateway is set to". */
  model: string;
  provider: string;
}

export interface OverseerModelProvider {
  slug: string;
  name: string;
  models: string[];
  isCurrent: boolean;
}

/* ── The agent bus ─────────────────────────────────────────────────────────
 * Mirror of electron/types/index.ts. The Chat page reads these and never
 * invents a channel: both sides move in the same commit.
 */
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

/** `open` is live; `bounded` hit three rounds or ten agent messages and only a
 *  human message reopens it; `stopped` was stopped by hand; `superseded` was
 *  closed by a newer human message or by a change of members. */
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

/** What a machine line is about, so the page can draw each as its own row
 *  instead of collapsing them into one grey line. There is no `passed`: a
 *  silence is refused before anything is stored, so it has no row. */
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
  authorId: string;
  authorName: string;
  text: string;
  mentions: string[];
  /** Set only when `authorKind` is `system`. */
  systemKind?: BusSystemKind;
  /** Set only on a `members_changed` line. */
  systemData?: BusMembersChanged;
  /** Files staged with `bus:stageFiles` and sent with it. */
  attachments?: BusAttachment[];
  createdAt: string;
}

/** `not_sent` is the state to render as NOT SENT: the target has no end of
 *  turn, so nothing is queued and nothing leaves on its own. It carries its
 *  reason and moves only on an explicit human action. */
/** `held` is taken by the target's terminal but waits behind what somebody has
 *  typed in its field (`reasonCode: 'draft'`, `heldAt`): Tars never types
 *  across a draft, and it goes in by itself once that field is sent or
 *  cleared, when it turns `delivered`. */
export type BusDeliveryState = 'queued' | 'held' | 'not_sent' | 'delivered' | 'dropped';

/** Why a delivery is not going anywhere, as a value the Chat page can render
 *  without matching on English. The sentence in `reason` is for a human.
 *  `no_end_of_turn` names the five providers that never leave `running`. */
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
  /** When it stopped being on its way: set with `dropped` and `not_sent`. */
  refusedAt?: string;
}

/** A member of a room, reachability included. `hasEndOfTurn` is derived in the
 *  main process from the provider's hook configuration: do not keep a copy of
 *  which CLIs cannot be reached, it goes stale silently. */
export interface BusMember {
  id: string;
  name: string;
  provider?: string;
  hasEndOfTurn: boolean;
  /** Tars can interrupt this member's turn (`bus:sendNow`): a CLI on the claude
   *  binary, where Esc stops the turn and the transcript records it. */
  canInterrupt: boolean;
}

export interface BusRoomSnapshot {
  room: BusRoom;
  members: BusMember[];
  threads: BusThread[];
  messages: BusMessage[];
  deliveries: BusDelivery[];
}

/**
 * Several Claude subscriptions. Mirror of the types at the end of
 * electron/types/index.ts (DESIGN-COMPTES-CLAUDE.md, B6). An account is a
 * Claude Code configuration directory signed in by Claude Code itself; Tars
 * never sees a credential.
 */
/** 'default' is ~/.claude. Others: 'acct-' and six hex digits. */
export type ClaudeAccountId = string;

export interface ClaudeAccount {
  id: ClaudeAccountId;
  /** 1 to 40 characters. */
  label: string;
  /** ~/.claude-accounts/<id>, derived from the id; null for 'default'. */
  configDir: string | null;
  enabled: boolean;
}

export interface ClaudeAccountsSettings {
  /** The option, off by default. */
  enabled: boolean;
  /** In order of preference; 'default' always there; 5 at most. */
  accounts: ClaudeAccount[];
  /** Whole percent, 50 to 100. Defaults 90 and 95. */
  fiveHourThreshold: number;
  weeklyThreshold: number;
}

export interface ClaudeAccountWindow {
  usedPercentage: number;
  /** Epoch seconds. */
  resetsAt: number;
}

export interface ClaudeAccountState extends ClaudeAccount {
  /** From `claude auth status`; null until it has answered. */
  signedIn: boolean | null;
  email: string | null;
  subscriptionType: string | null;
  /** From a status line or a probe (get_usage) of this account; null when never seen or reset. */
  fiveHour: ClaudeAccountWindow | null;
  sevenDay: ClaudeAccountWindow | null;
  /** Per-model weeklies a probe read ("Fable"); empty when none. */
  models: Array<{ name: string; usedPercentage: number; resetsAt: number }>;
  /** Epoch ms of that report. */
  updatedAt: number | null;
  /** Epoch seconds: a limit was hit, skipped until then. */
  blockedUntil: number | null;
  /** Agents whose CLI runs on it now. */
  agentIds: string[];
  /** Why the last sign-in or check did not work, as a sentence. */
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

/** What the claude-accounts channels answer: the result, or a sentence. */
export type ClaudeAccountsResult<T = object> = ({ success: true } & T) | { success: false; error: string };

export interface ElectronAPI {
  // PTY terminal management
  pty: {
    create: (params: { cwd?: string; cols?: number; rows?: number }) => Promise<{ id: string }>;
    write: (params: { id: string; data: string }) => Promise<{ success: boolean }>;
    resize: (params: { id: string; cols: number; rows: number }) => Promise<{ success: boolean }>;
    kill: (params: { id: string }) => Promise<{ success: boolean }>;
    onData: (callback: (event: PtyDataEvent) => void) => () => void;
    onExit: (callback: (event: PtyExitEvent) => void) => () => void;
  };

  // Agent management
  agent: {
    create: (config: {
      projectPath: string;
      skills: string[];
      worktree?: WorktreeConfig;
      character?: AgentCharacter;
      name?: string;
      secondaryProjectPath?: string;
      permissionMode?: 'normal' | 'auto' | 'bypass';
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      provider?: AgentProvider;
      localModel?: string;
      obsidianVaultPaths?: string[];
      /** The Orchestrator toggle: 'orchestrator' takes the role from the
       *  project's current one, which becomes a worker and restarts. */
      role?: 'orchestrator' | 'worker';
      /** @deprecated Send `role`. Read only when `role` is absent. */
      orchestratorMode?: boolean;
    }) => Promise<AgentStatus & { ptyId: string }>;
    update: (params: {
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
      worktree?: WorktreeConfig;
      /** The Orchestrator toggle: 'orchestrator' takes the role from the
       *  project's current one, which becomes a worker; both CLIs restart. */
      role?: 'orchestrator' | 'worker';
      /** @deprecated Send `role`. Read only when `role` is absent. */
      orchestratorMode?: boolean;
      cliPath?: string | null;
    }) => Promise<{ success: boolean; error?: string; agent?: AgentStatus }>;
    /** `{ success: false, cliRunning: true }` when a CLI still runs in the agent's terminal: nothing was typed. */
    start: (params: { id: string; prompt: string; options?: { model?: string; resume?: boolean; provider?: AgentProvider; localModel?: string } }) => Promise<{ success: boolean; cliRunning?: boolean; error?: string }>;
    get: (id: string) => Promise<AgentStatus | null>;
    list: () => Promise<AgentStatus[]>;
    /** Ends the agent's terminal and everything its CLI started; the agent reads `stopped`, by "you". */
    stop: (id: string, reason?: string) => Promise<{ success: boolean }>;
    remove: (id: string) => Promise<{ success: boolean }>;
    /** Into the agent's terminal. Asleep, a key wakes it (`woke: true`), a mouse or focus report does nothing. */
    sendInput: (params: { id: string; input: string }) => Promise<{ success: boolean; woke?: boolean; error?: string }>;
    /** An asleep agent's CLI started on its own conversation, nothing typed; refused for one that is not asleep. */
    wake: (id: string) => Promise<{ success: boolean; error?: string }>;
    resize: (params: { id: string; cols: number; rows: number }) => Promise<{ success: boolean }>;
    setSecondaryProject: (params: { id: string; secondaryProjectPath: string | null }) => Promise<{ success: boolean; error?: string; agent?: AgentStatus }>;
    onOutput: (callback: (event: AgentEvent) => void) => () => void;
    onError: (callback: (event: AgentEvent) => void) => () => void;
    onComplete: (callback: (event: AgentEvent) => void) => () => void;
    onToolUse: (callback: (event: AgentEvent) => void) => () => void;
    onStatus?: (callback: (event: { type: string; agentId: string; status: string; timestamp: string }) => void) => () => void;
    onTick?: (callback: (agents: AgentTickItem[]) => void) => () => void;
    /** What is waiting right now, for a panel that opened after the wait
     *  began: the event below only reaches a window already listening. An
     *  agent absent from the list is holding nothing. */
    messagesWaiting?: () => Promise<{ success: boolean; waiting: AgentMessageWaiting[] }>;
    /** A message that cannot go into this agent's terminal yet, because
     *  somebody is typing in it or has left something in it that Tars cannot
     *  put back as it was. Pushed on every change, `waiting: 0` when it is
     *  over. Mirror of `agent:message-waiting` in electron/preload.ts. */
    onMessageWaiting?: (callback: (waiting: AgentMessageWaiting) => void) => () => void;
    /** Restart the agent's CLI now, continuing its conversation under a new
     *  session id, whatever it is doing. A stop then a start begins a new
     *  conversation instead. Mirror of `agent:restart`. */
    restart?: (id: string) => Promise<{ success: boolean; error?: string }>;
    /** The restarts waiting right now, for a window that opened after the
     *  wait began. An agent absent from the list has none waiting. */
    pendingRestarts?: () => Promise<{ success: boolean; pending: AgentPendingRestart[] }>;
    /** Pushed when an agent's restart starts waiting, waits on something
     *  else, or stops waiting (`pending: null`). Mirror of
     *  `agent:restart-pending` in electron/preload.ts. */
    onRestartPending?: (callback: (event: {
      agentId: string;
      pending: Omit<AgentPendingRestart, 'agentId'> | null;
    }) => void) => () => void;
  };

  // Skills management
  skill: {
    install: (repo: string) => Promise<{ success: boolean; output?: string; message?: string }>;
    installStart: (params: { repo: string; cols?: number; rows?: number }) => Promise<{ id: string; repo: string }>;
    installWrite: (params: { id: string; data: string }) => Promise<{ success: boolean }>;
    installResize: (params: { id: string; cols: number; rows: number }) => Promise<{ success: boolean }>;
    installKill: (params: { id: string }) => Promise<{ success: boolean }>;
    listInstalled: () => Promise<string[]>;
    listInstalledAll: () => Promise<Record<string, string[]>>;
    linkToProvider: (params: { skillName: string; providerId: string }) => Promise<{ success: boolean; error?: string }>;
    /** The last skills.sh listing, at once, refreshed behind it when older than an hour; only the first ever call waits on the network. `fetchedAt` is when it was fetched (ms). */
    fetchMarketplace: () => Promise<{ skills: Array<{ rank: number; name: string; repo: string; installs: string; installsNum: number }> | null; fetchedAt?: number }>;
    onPtyData: (callback: (event: { id: string; data: string }) => void) => () => void;
    onPtyExit: (callback: (event: { id: string; exitCode: number }) => void) => () => void;
    onInstallOutput: (callback: (event: SkillInstallOutputEvent) => void) => () => void;
  };

  // Several Claude subscriptions (Settings). See ClaudeAccountsView.
  claudeAccounts?: {
    /** Answers at once; accounts never checked are asked about behind it, then onChanged. */
    list: () => Promise<ClaudeAccountsResult<ClaudeAccountsView>>;
    setEnabled: (enabled: boolean) => Promise<ClaudeAccountsResult<ClaudeAccountsView>>;
    setThresholds: (params: { fiveHour: number; weekly: number }) => Promise<ClaudeAccountsResult<ClaudeAccountsView>>;
    /** Creates the account's folder, signed out. Sign it in with loginStart. */
    add: (params: { label: string }) => Promise<ClaudeAccountsResult<{ account: ClaudeAccountState }>>;
    rename: (params: { id: ClaudeAccountId; label: string }) => Promise<ClaudeAccountsResult<ClaudeAccountsView>>;
    setAccountEnabled: (params: { id: ClaudeAccountId; enabled: boolean }) => Promise<ClaudeAccountsResult<ClaudeAccountsView>>;
    /** Every account id once, 'default' included, in the new order. */
    reorder: (ids: ClaudeAccountId[]) => Promise<ClaudeAccountsResult<ClaudeAccountsView>>;
    /** Signs out through Claude Code, then trashes the folder. Not 'default'. */
    remove: (id: ClaudeAccountId) => Promise<ClaudeAccountsResult<ClaudeAccountsView>>;
    /** Asks Claude Code again, about one account or all. */
    refresh: (id?: ClaudeAccountId) => Promise<ClaudeAccountsResult<ClaudeAccountsView>>;
    /** A terminal running `claude auth login --claudeai` for that account. */
    loginStart: (params: { id: ClaudeAccountId; cols?: number; rows?: number }) => Promise<ClaudeAccountsResult<{ ptyId: string }>>;
    loginWrite: (params: { ptyId: string; data: string }) => Promise<ClaudeAccountsResult>;
    loginResize: (params: { ptyId: string; cols: number; rows: number }) => Promise<ClaudeAccountsResult>;
    loginKill: (params: { ptyId: string }) => Promise<ClaudeAccountsResult>;
    onLoginData: (callback: (event: { ptyId: string; data: string }) => void) => () => void;
    /** The account is checked again after this; onChanged follows. */
    onLoginExit: (callback: (event: { ptyId: string; exitCode: number }) => void) => () => void;
    onChanged: (callback: (view: ClaudeAccountsView) => void) => () => void;
    /** An agent's account or pin changed, from any window or from main. */
    onAgentChanged: (callback: (event: ClaudeAccountAgentChange) => void) => () => void;
    /** Tars moved an agent to another account on its own (onAgentChanged follows with the new account). */
    onAgentMoved: (callback: (event: ClaudeAccountMove) => void) => () => void;
    /** Holds an agent to an account, or null for automatic. Pushed to every window by onAgentChanged. */
    setAgentAccount: (params: { agentId: string; accountId: ClaudeAccountId | null }) => Promise<ClaudeAccountsResult>;
  };

  // Plugin management (with in-app terminal)
  plugin?: {
    installStart: (params: { command: string; cols?: number; rows?: number }) => Promise<{ id: string; command: string }>;
    installWrite: (params: { id: string; data: string }) => Promise<{ success: boolean }>;
    installResize: (params: { id: string; cols: number; rows: number }) => Promise<{ success: boolean }>;
    installKill: (params: { id: string }) => Promise<{ success: boolean }>;
    onPtyData: (callback: (event: { id: string; data: string }) => void) => () => void;
    onPtyExit: (callback: (event: { id: string; exitCode: number }) => void) => () => void;
  };

  // File system
  fs: {
    listProjects: () => Promise<{ path: string; name: string; lastModified?: string; custom?: boolean }[]>;
    readTextFile: (filePath: string) => Promise<{ content: string; error?: string }>;
    writeTextFile: (params: { filePath: string; content: string }) => Promise<{ success: boolean; error?: string }>;
    readProjectFiles: (params: { paths: string[]; relative: string[] }) => Promise<{ files: Record<string, string> }>;
    addCustomProject: (projectPath: string) => Promise<{ success: boolean; projects?: string[]; error?: string }>;
    removeCustomProject: (projectPath: string) => Promise<{ success: boolean; projects?: string[]; error?: string }>;
  };

  // Claude data
  claude: {
    getData: () => Promise<{
      settings: unknown;
      stats: unknown;
      projects: unknown[];
      plugins: unknown[];
      skills: Array<{ name: string; source: 'project' | 'user' | 'plugin'; path: string; description?: string; projectName?: string }>;
      history: Array<{ display: string; timestamp: number; project?: string }>;
      activeSessions: string[];
      rateLimits: {
        five_hour?: { used_percentage: number; resets_at: number };
        seven_day?: { used_percentage: number; resets_at: number };
      } | null;
      /**
       * Every Claude account in use, in the order of Settings, with its own 5 h
       * and weekly counters: one pair of bars each. Empty while the accounts
       * option is off, when rateLimits (account 1's) is the only pair. A window
       * is null when nothing reported it or its reset has passed; resetsAt in
       * epoch seconds, updatedAt in epoch ms.
       */
      accountRateLimits: Array<{
        accountId: string;
        label: string;
        fiveHour: { usedPercentage: number; resetsAt: number } | null;
        sevenDay: { usedPercentage: number; resetsAt: number } | null;
        /** Per-model weeklies ("Fable"), read through Claude Code's get_usage; absent when none was read. */
        models?: Array<{ name: string; usedPercentage: number; resetsAt: number }>;
        updatedAt: number | null;
      }>;
      tokenStats: {
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCostUsd: number;
        extraCostUsd: number;
        sessionCount: number;
        modelTokens?: Record<string, { in: number; out: number }>;
        dailyCosts?: Record<string, { cost: number; extraCost: number }>;
      } | null;
    } | null>;
  };

  // Settings
  settings: {
    get: () => Promise<{
      enabledPlugins: Record<string, boolean>;
      env: Record<string, string>;
      hooks: Record<string, unknown>;
      includeCoAuthoredBy: boolean;
      permissions: { allow: string[]; deny: string[] };
    } | null>;
    save: (settings: {
      enabledPlugins?: Record<string, boolean>;
      env?: Record<string, string>;
      hooks?: Record<string, unknown>;
      includeCoAuthoredBy?: boolean;
      permissions?: { allow: string[]; deny: string[] };
    }) => Promise<{ success: boolean; error?: string }>;
    getInfo: () => Promise<{
      claudeVersion: string;
      configPath: string;
      settingsPath: string;
      platform: string;
      arch: string;
      nodeVersion: string;
      electronVersion: string;
    } | null>;
  };

  // App settings (notifications, etc.)
  app?: {
    getVersion: () => Promise<{ version: string }>;
  };

  /**
   * Spend from Tars's own ledger, ~/.dorothy/usage-ledger.jsonl, and nothing
   * else: one record per ACP turn, any provider. The Claude transcripts are not
   * in it; they come through `claude.getData`. A `claude` row here is a turn
   * the transcripts count as well, since the Claude ACP adapter runs the claude
   * binary, which writes its own transcript.
   */
  usage?: {
    byProvider: (sinceDays?: number) => Promise<{
      /** Per provider, over the last `sinceDays` 24-hour periods back from now, or all of the file. */
      providers: Array<{
        provider: string;
        inputTokens: number;
        outputTokens: number;
        costUSD: number;
        turns: number;
        models: string[];
        measured: boolean;
      }>;
      /** Cost per local day, every provider merged, over `sinceDays` (default 30). */
      dailyCost: Record<string, number>;
      /** Every turn the file holds, per local day, provider and model, whatever `sinceDays` says. */
      daily: Array<{
        /** Local `YYYY-MM-DD`, the same key as the transcripts' days. */
        date: string;
        provider: string;
        model: string | null;
        inputTokens: number;
        outputTokens: number;
        cachedReadTokens: number;
        cachedWriteTokens: number;
        /** As recorded: the agent's own figure, or the catalogue's at record time. */
        costUSD: number;
        turns: number;
      }>;
      /** The first local day still in the file, which is trimmed past 20 000 lines; null when it is empty. */
      oldest: string | null;
      /**
       * The turns of the last 48 hours, per hour, provider and model: a rolling 24 hours is the hours past now minus a day.
       * Its `claude` rows are Claude's ACP turns, which the transcripts already count: skip them, as `usageRows` does
       * for the days, or those turns count twice in the last 24 hours.
       */
      hourly: Array<{
        /** When the hour starts, in milliseconds since the epoch. */
        hour: number;
        provider: string;
        model: string | null;
        inputTokens: number;
        outputTokens: number;
        cachedReadTokens: number;
        cachedWriteTokens: number;
        costUSD: number;
        turns: number;
      }>;
    }>;
  };

  /** Search across every agent's output at once. */
  logs?: {
    search: (query: string, opts?: { agentIds?: string[]; projectPath?: string; limit?: number }) =>
      Promise<{ lines: LogLine[]; scannedAgents: number; truncated: boolean }>;
    tail: (agentId: string, lines?: number) => Promise<{ lines: string[]; agentName: string }>;
    fleet: () => Promise<{ agents: FleetEntry[] }>;
  };

  /** Browsing a project without a shell: walked and read directly. */
  project?: {
    listFiles: (root: string, maxDepth?: number) =>
      Promise<{ success: boolean; files?: string[]; error?: string }>;
    searchFiles: (root: string, query: string) =>
      Promise<{ success: boolean; files?: string[]; error?: string }>;
    searchContent: (root: string, query: string) =>
      Promise<{ success: boolean; hits?: { path: string; line: number; text: string }[]; error?: string }>;
  };

  /** What an agent changed: per-file stats plus the actual patch. */
  review?: {
    /** `listOnly`: the files and counts, with `patch` empty; read each file's patch with `file`. */
    diff: (repoPath: string, baseBranch?: string, opts?: { listOnly?: boolean }) =>
      Promise<{ success: boolean; diff?: ReviewDiff; error?: string }>;
    file: (repoPath: string, file: string, baseBranch?: string) =>
      Promise<{ success: boolean; patch?: string; error?: string }>;
    repo: (repoPath: string) => Promise<{ success: boolean; summary?: RepoSummary; error?: string }>;
  };

  /** Federated memory: every source probed for real, searchable from one place. */
  memoryHub?: {
    sources: (projectPath?: string) => Promise<{ sources: MemorySourceStatus[] }>;
    search: (
      query: string,
      opts?: { projectPath?: string; sources?: string[]; limit?: number },
    ) => Promise<{ hits: MemoryHit[]; errors: { source: string; error: string }[] }>;
  };

  /** Live model + price catalogue, refreshed from models.dev. */
  models?: {
    list: (provider: string) => Promise<{ models: CatalogModel[] }>;
    price: (modelId: string, provider?: string) => Promise<{ price: ModelCost | null }>;
    catalogStatus: () => Promise<{ loaded: boolean; fetchedAt: number | null; providers: number; models: number }>;
    refresh: () => Promise<{ loaded: boolean; fetchedAt: number | null; providers: number; models: number }>;
  };

  appSettings?: {
    get: () => Promise<{
      notificationsEnabled: boolean;
      notifyOnWaiting: boolean;
      notifyOnComplete: boolean;
      notifyOnStop: boolean;
      notifyOnError: boolean;
      telegramEnabled: boolean;
      telegramBotToken: string;
      telegramChatId: string;
      telegramAuthToken: string;
      telegramAuthorizedChatIds: string[];
      telegramRequireMention: boolean;
      /** The relay to the user's Telegram through their Hermes. On, the Tars bot's token is erased and the bot off. */
      hermesRelayEnabled?: boolean;
      slackEnabled: boolean;
      slackBotToken: string;
      slackAppToken: string;
      slackSigningSecret: string;
      slackChannelId: string;
      slackAllowedUserIds: string[];
      discordEnabled: boolean;
      discordBotToken: string;
      discordChannelId: string;
      discordAllowedUserIds: string[];
      discordRequireMention: boolean;
      /** Error reports to Sentry, off by default (services/error-reports in main). */
      errorReportsEnabled: boolean;
      jiraEnabled: boolean;
      jiraDomain: string;
      jiraEmail: string;
      jiraApiToken: string;
      socialDataEnabled: boolean;
      socialDataApiKey: string;
      tasmaniaEnabled: boolean;
      tasmaniaServerPath: string;
      defaultProvider?: string;
      opencodeEnabled?: boolean;
      opencodeDefaultModel?: string;
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
      veniceEnabled?: boolean;
      veniceApiKey?: string;
      ollamaBaseUrl?: string;
      ollamaCloudEnabled?: boolean;
      ollamaCloudApiKey?: string;
      customOpenAIEnabled?: boolean;
      customOpenAIBaseUrl?: string;
      customOpenAIApiKey?: string;
      customOpenAIModel?: string;
      notificationSounds?: {
        waiting?: string;
        complete?: string;
        stop?: string;
        error?: string;
      };
      terminalFontSize?: number;
      /** Resume idle agents once at launch (not on navigation). */
      autoStartAgentsOnLaunch?: boolean;
      terminalTheme?: 'dark' | 'light';
      statusLineEnabled?: boolean;
      hermesGatewayUrl?: string;
      hermesGatewayToken?: string;
      memoryGbrainEnabled?: boolean;
      memoryGbrainMcpUrl?: string;
      memoryGbrainAuthToken?: string;
      memoryHonchoEnabled?: boolean;
      memoryHonchoMcpUrl?: string;
      memoryHonchoApiKey?: string;
      memoryHonchoWorkspaceId?: string;
      favoriteProjects?: string[];
      hiddenProjects?: string[];
      defaultProjectPath?: string;
      /** Monthly ceiling per provider, in dollars. Set on the Usage page. */
      providerBudgets?: Record<string, number>;
  cliPaths?: {
        amp: string;
        claude: string;
        codex: string;
        gemini: string;
        grok: string;
        opencode: string;
        pi: string;
        gws: string;
        gcloud: string;
        gh: string;
        node: string;
        minimax: string;
        additionalPaths: string[];
      };
    }>;
    save: (settings: {
      notificationsEnabled?: boolean;
      notifyOnWaiting?: boolean;
      notifyOnComplete?: boolean;
      notifyOnStop?: boolean;
      notifyOnError?: boolean;
      telegramEnabled?: boolean;
      telegramBotToken?: string;
      telegramChatId?: string;
      telegramAuthToken?: string;
      telegramAuthorizedChatIds?: string[];
      telegramRequireMention?: boolean;
      hermesRelayEnabled?: boolean;
      slackEnabled?: boolean;
      slackBotToken?: string;
      slackAppToken?: string;
      slackSigningSecret?: string;
      slackChannelId?: string;
      slackAllowedUserIds?: string[];
      discordEnabled?: boolean;
      discordBotToken?: string;
      discordChannelId?: string;
      discordAllowedUserIds?: string[];
      discordRequireMention?: boolean;
      errorReportsEnabled?: boolean;
      jiraEnabled?: boolean;
      jiraDomain?: string;
      jiraEmail?: string;
      jiraApiToken?: string;
      socialDataEnabled?: boolean;
      socialDataApiKey?: string;
      tasmaniaEnabled?: boolean;
      tasmaniaServerPath?: string;
      defaultProvider?: string;
      notificationSounds?: {
        waiting?: string;
        complete?: string;
        stop?: string;
        error?: string;
      };
      terminalFontSize?: number;
      /** Resume idle agents once at launch (not on navigation). */
      autoStartAgentsOnLaunch?: boolean;
      terminalTheme?: 'dark' | 'light';
      statusLineEnabled?: boolean;
      hermesGatewayUrl?: string;
      hermesGatewayToken?: string;
      memoryGbrainEnabled?: boolean;
      memoryGbrainMcpUrl?: string;
      memoryGbrainAuthToken?: string;
      memoryHonchoEnabled?: boolean;
      memoryHonchoMcpUrl?: string;
      memoryHonchoApiKey?: string;
      memoryHonchoWorkspaceId?: string;
      veniceEnabled?: boolean;
      veniceApiKey?: string;
      ollamaBaseUrl?: string;
      ollamaCloudEnabled?: boolean;
      ollamaCloudApiKey?: string;
      customOpenAIEnabled?: boolean;
      customOpenAIBaseUrl?: string;
      customOpenAIApiKey?: string;
      customOpenAIModel?: string;
      favoriteProjects?: string[];
      hiddenProjects?: string[];
      defaultProjectPath?: string;
      providerBudgets?: Record<string, number>;
      cliPaths?: {
        amp: string;
        claude: string;
        codex: string;
        gemini: string;
        grok: string;
        opencode: string;
        pi: string;
        gws: string;
        gcloud: string;
        gh: string;
        node: string;
        minimax: string;
        additionalPaths: string[];
      };
    }) => Promise<{ success: boolean; error?: string }>;
    onUpdated?: (callback: (settings: unknown) => void) => () => void;
  };

  // Ollama (local LLM server): no API key, just a reachability check against
  // its native Anthropic-compatible endpoint (Ollama v0.14+).
  ollama?: {
    test: () => Promise<{ reachable: boolean }>;
  };

  // Telegram bot
  telegram?: {
    test: () => Promise<{ success: boolean; botName?: string; error?: string }>;
    sendTest: () => Promise<{ success: boolean; error?: string }>;
    generateAuthToken: () => Promise<{ success: boolean; token?: string; error?: string }>;
    removeAuthorizedChatId: (chatId: string) => Promise<{ success: boolean; error?: string }>;
  };

  // Slack bot
  slack?: {
    test: () => Promise<{ success: boolean; botName?: string; error?: string }>;
    sendTest: () => Promise<{ success: boolean; error?: string }>;
  };

  // Discord bot
  discord?: {
    /** Asks Discord who the saved token is: the bot's name, and the link that invites it to a server. */
    test: () => Promise<{ success: boolean; botName?: string; inviteUrl?: string; error?: string }>;
    /** Posts a test message to the channel the bot detected. */
    sendTest: () => Promise<{ success: boolean; error?: string }>;
    /** The link that invites the bot, made in main from a token as it is typed; null when it holds no bot id. */
    inviteUrl: (token: string) => Promise<string | null>;
  };

  // JIRA
  jira?: {
    test: () => Promise<{ success: boolean; displayName?: string; email?: string; error?: string }>;
  };

  // SocialData (Twitter/X)
  socialData?: {
    test: () => Promise<{ success: boolean; error?: string }>;
  };

  // X API (posting)
  xApi?: {
    test: () => Promise<{ success: boolean; username?: string; error?: string }>;
  };

  // Google Workspace (gws CLI)
  gws?: {
    detect: () => Promise<string>;
    detectGcloud: () => Promise<string>;
    authStatus: () => Promise<{
      authenticated: boolean;
      user: string | null;
      tokenValid: boolean;
      scopes: string[];
      authMethod: string;
      services: Record<string, 'none' | 'read' | 'write'>;
    }>;
    setup: () => Promise<{ success: boolean; error?: string }>;
    remove: () => Promise<{ success: boolean; error?: string }>;
    getMcpStatus: () => Promise<{ configured: boolean; error?: string }>;
    listSkills: () => Promise<string[]>;
  };

  // Tasmania (Local LLM)
  tasmania?: {
    test: () => Promise<{ success: boolean; serverExists: boolean; apiReachable: boolean; error?: string }>;
    getStatus: () => Promise<{
      status: 'stopped' | 'starting' | 'running' | 'error';
      backend: string | null;
      port: number | null;
      modelName: string | null;
      modelPath: string | null;
      endpoint: string | null;
      startedAt: number | null;
      error?: string;
    }>;
    getModels: () => Promise<{
      models: Array<{
        name: string;
        filename: string;
        path: string;
        sizeBytes: number;
        repo: string | null;
        quantization: string | null;
        parameters: string | null;
        architecture: string | null;
      }>;
      error?: string;
    }>;
    loadModel: (modelPath: string) => Promise<{ success: boolean; error?: string }>;
    stopModel: () => Promise<{ success: boolean; error?: string }>;
    getMcpStatus: () => Promise<{ configured: boolean; error?: string }>;
    setup: () => Promise<{ success: boolean; error?: string }>;
    remove: () => Promise<{ success: boolean; error?: string }>;
  };

  // Dialogs
  dialog: {
    openFolder: () => Promise<string | null>;
    openFiles: () => Promise<string[]>;
    openAudio: () => Promise<string | null>;
  };

  // Shell operations
  shell: {
    /**
     * Open Terminal.app in a directory.
     *
     * No `command`: the handler used to paste one into an AppleScript literal
     * and run it, and nothing supplied it. Declaring the parameter here is what
     * kept the dead call sites type-checking, so the signature stays as narrow
     * as the channel.
     */
    openTerminal: (params: { cwd: string }) => Promise<{ success: boolean; error?: string }>;
    /** A CLI's --version, run through execFile with an argv array. */
    version: (binary: string) => Promise<{ success: boolean; output?: string; error?: string }>;
    /** The current branch of a repository. */
    branch: (cwd: string) => Promise<{ success: boolean; output?: string; error?: string }>;
    /** Reveal a path in Finder, through Electron's own shell API. */
    reveal: (path: string) => Promise<{ success: boolean; error?: string }>;
    // Quick terminal PTY
    startPty?: (params: { cwd?: string; cols?: number; rows?: number }) => Promise<string>;
    writePty?: (params: { ptyId: string; data: string }) => Promise<{ success: boolean }>;
    resizePty?: (params: { ptyId: string; cols: number; rows: number }) => Promise<{ success: boolean }>;
    killPty?: (params: { ptyId: string }) => Promise<{ success: boolean }>;
    onPtyOutput?: (callback: (event: { ptyId: string; data: string }) => void) => () => void;
    onPtyExit?: (callback: (event: { ptyId: string; exitCode: number }) => void) => () => void;
  };

  // Orchestrator (Super Agent) management
  orchestrator?: {
    getStatus: () => Promise<{
      configured: boolean;
      orchestratorPath?: string;
      orchestratorExists?: boolean;
      currentConfig?: unknown;
      reason?: string;
      error?: string;
    }>;
    setup: () => Promise<{
      success: boolean;
      path?: string;
      error?: string;
    }>;
    remove: () => Promise<{
      success: boolean;
      error?: string;
    }>;
  };

  // Custom MCP server config
  mcp?: {
    list: (params: { provider: string }) => Promise<{
      servers: Array<{ name: string; command: string; args: string[]; env: Record<string, string> }>;
      error?: string;
    }>;
    update: (params: {
      provider: string;
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
    }) => Promise<{ success: boolean; error?: string }>;
    delete: (params: { provider: string; name: string }) => Promise<{ success: boolean; error?: string }>;
  };

  // CLI paths management
  cliPaths?: {
    /** The last detection, cached in main for the app run and the saved paths; `refresh: true` looks again (a login shell and a probe of every CLI). */
    detect: (options?: { refresh?: boolean }) => Promise<{
      amp: string;
      claude: string;
      codex: string;
      gemini: string;
      grok: string;
      qwencode: string;
      opencode: string;
      pi: string;
      gws: string;
      gcloud: string;
      gh: string;
      node: string;
      minimax: string;
    }>;
    get: () => Promise<{
      amp: string;
      claude: string;
      codex: string;
      gemini: string;
      grok: string;
      qwencode: string;
      opencode: string;
      pi: string;
      gws: string;
      gcloud: string;
      gh: string;
      node: string;
      minimax: string;
      additionalPaths: string[];
    }>;
    save: (paths: {
      amp: string;
      claude: string;
      codex: string;
      gemini: string;
      grok: string;
      qwencode: string;
      opencode: string;
      pi: string;
      gws: string;
      gcloud: string;
      gh: string;
      node: string;
      minimax: string;
      additionalPaths: string[];
    }) => Promise<{ success: boolean; error?: string }>;
  };

  // Vault
  vault?: {
    listDocuments: (params?: { folder_id?: string; tags?: string[] }) => Promise<{ documents: VaultDocumentElectron[]; error?: string }>;
    getDocument: (id: string) => Promise<{ document?: VaultDocumentElectron; attachments?: VaultAttachmentElectron[]; error?: string }>;
    createDocument: (params: {
      title: string;
      content: string;
      folder_id?: string;
      author: string;
      agent_id?: string;
      tags?: string[];
    }) => Promise<{ success: boolean; document?: VaultDocumentElectron; error?: string }>;
    updateDocument: (params: {
      id: string;
      title?: string;
      content?: string;
      tags?: string[];
      folder_id?: string | null;
    }) => Promise<{ success: boolean; document?: VaultDocumentElectron; error?: string }>;
    deleteDocument: (id: string) => Promise<{ success: boolean; error?: string }>;
    search: (params: { query: string; limit?: number }) => Promise<{ results: VaultDocumentElectron[]; error?: string }>;
    listFolders: () => Promise<{ folders: VaultFolderElectron[]; error?: string }>;
    createFolder: (params: { name: string; parent_id?: string }) => Promise<{ success: boolean; folder?: VaultFolderElectron; error?: string }>;
    deleteFolder: (params: { id: string; recursive?: boolean }) => Promise<{ success: boolean; error?: string }>;
    attachFile: (params: { document_id: string; file_path: string }) => Promise<{ success: boolean; attachment?: VaultAttachmentElectron; error?: string }>;
    onDocumentCreated: (callback: (doc: VaultDocumentElectron) => void) => () => void;
    onDocumentUpdated: (callback: (doc: VaultDocumentElectron) => void) => () => void;
    onDocumentDeleted: (callback: (event: { id: string }) => void) => () => void;
  };

  // Kanban board
  /** The agent bus. Mirror of the `bus` namespace in electron/preload.ts:
   *  its calls, and three pushes so the Chat page never polls. */
  bus?: {
    listRooms: () => Promise<{ rooms: BusRoom[]; error?: string }>;
    getRoom: (
      roomId: string,
      params?: { limit?: number; before?: string },
    ) => Promise<{
      success: boolean;
      room?: BusRoom;
      members?: BusMember[];
      threads?: BusThread[];
      messages?: BusMessage[];
      deliveries?: BusDelivery[];
      error?: string;
    }>;
    postMessage: (params: { roomId: string; text: string; mentions?: string[]; attachments?: string[] }) => Promise<{
      success: boolean;
      messageId?: string;
      threadId?: string;
      deliveries?: BusDelivery[];
      error?: string;
    }>;
    stopThread: (threadId: string) => Promise<{ success: boolean; thread?: BusThread; error?: string }>;
    setMembers: (
      roomId: string,
      memberIds: string[],
    ) => Promise<{ success: boolean; room?: BusRoom; error?: string }>;
    /** Send what is held for an agent that has no end of turn, oldest first.
     *  A human decision: it writes into a session whose state Tars does not
     *  know, which is why nothing does it automatically.
     *
     *  Two things to know before calling it. It writes into whatever session
     *  is live at the moment of the call, not the one the messages were held
     *  for: an agent killed and relaunched since the button was drawn still
     *  receives them, because a person aiming at an agent means the agent and
     *  not a session id. And one release runs at a time per agent: a second
     *  call while one is in flight is refused with a reason rather than
     *  queued, since both would write into the same terminal at once. */
    releaseNotSent: (agentId: string) => Promise<{
      success: boolean;
      deliveries?: BusDelivery[];
      error?: string;
    }>;
    /** Put files where every agent can read them, for a message to come.
     *  `attachments` are then passed by id to postMessage or sendNow. 12 MB a
     *  file; what is refused is named in `error`, the rest staged. */
    stageFiles: (params: {
      roomId: string;
      files: Array<{ name: string; mimeType: string; data: Uint8Array }>;
    }) => Promise<{ success: boolean; attachments: BusAttachment[]; error?: string }>;
    /** Send to one agent now: recorded as postMessage records it; a busy
     *  member that `canInterrupt` gets an Esc first, and the message is typed
     *  once its transcript records the interrupt (5 s at most), through the
     *  draft guard. `interrupted: false` when it was at rest (delivered as any
     *  message), cannot be interrupted, or the interrupt was not confirmed in
     *  time, when it is queued for the turn's end as `deliveries` says.
     *  `error` only when nothing was recorded. */
    sendNow: (params: { roomId: string; agentId: string; text: string; attachments?: string[] }) => Promise<{
      success: boolean;
      messageId?: string;
      threadId?: string;
      interrupted: boolean;
      deliveries?: BusDelivery[];
      error?: string;
    }>;
    onMessage: (callback: (message: BusMessage) => void) => () => void;
    onDelivery: (callback: (delivery: BusDelivery) => void) => () => void;
    onThread: (callback: (thread: BusThread) => void) => () => void;
  };

  kanban?: {
    list: () => Promise<{ tasks: KanbanTaskElectron[]; error?: string }>;
    get: (id: string) => Promise<{ success: boolean; task?: KanbanTaskElectron; error?: string }>;
    create: (params: {
      title: string;
      description: string;
      projectId: string;
      projectPath: string;
      requiredSkills?: string[];
      priority?: 'low' | 'medium' | 'high';
      labels?: string[];
    }) => Promise<{ success: boolean; task?: KanbanTaskElectron; error?: string }>;
    update: (params: {
      id: string;
      title?: string;
      description?: string;
      requiredSkills?: string[];
      priority?: 'low' | 'medium' | 'high';
      labels?: string[];
      progress?: number;
      assignedAgentId?: string | null;
    }) => Promise<{ success: boolean; task?: KanbanTaskElectron; error?: string }>;
    move: (params: {
      id: string;
      column: 'backlog' | 'planned' | 'ongoing' | 'done';
      order?: number;
    }) => Promise<{
      success: boolean;
      task?: KanbanTaskElectron;
      agentSpawned?: boolean;
      agentId?: string;
      error?: string;
    }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    reorder: (params: {
      taskIds: string[];
      column: 'backlog' | 'planned' | 'ongoing' | 'done';
    }) => Promise<{ success: boolean; error?: string }>;
    generate: (params: {
      prompt: string;
      availableProjects: Array<{ path: string; name: string }>;
    }) => Promise<{
      success: boolean;
      task?: {
        title: string;
        description: string;
        projectPath: string;
        projectId: string;
        priority: 'low' | 'medium' | 'high';
        labels: string[];
        requiredSkills: string[];
      };
      error?: string;
    }>;
    onTaskCreated: (callback: (task: KanbanTaskElectron) => void) => () => void;
    onTaskUpdated: (callback: (task: KanbanTaskElectron) => void) => () => void;
    onTaskDeleted: (callback: (event: { id: string }) => void) => () => void;
  };

  // Agent templates
  template?: {
    list: () => Promise<{ templates: AgentTemplate[]; error?: string }>;
    get: (id: string) => Promise<{ template: AgentTemplate | null }>;
    create: (input: AgentTemplateInput) => Promise<{ success: boolean; template?: AgentTemplate; error?: string }>;
    update: (patch: AgentTemplatePatch) => Promise<{ success: boolean; template?: AgentTemplate; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    duplicate: (id: string) => Promise<{ success: boolean; template?: AgentTemplate; error?: string }>;
    export: (ids: string[]) => Promise<{ success: boolean; payload?: TemplateExport; error?: string }>;
    import: (payload: unknown) => Promise<{ success: boolean; imported?: number; skipped?: number; errors?: string[]; templates?: AgentTemplate[]; error?: string }>;
  };

  // Hermes integration (remote scheduler wiring)
  hermes?: {
    getConnection: () => Promise<{ connection: HermesConnection; baseUrl: string; desktopConfigAvailable: boolean }>;
    saveConnection: (connection: HermesConnection) => Promise<{ success: boolean; error?: string }>;
    /** `tokenNotImported`: the connection came without the token Hermes Desktop keeps encrypted, which Tars cannot read. */
    importDesktopConnection: () => Promise<{ success: boolean; connection?: HermesConnection; baseUrl?: string; error?: string; tokenNotImported?: boolean }>;
    /** The relay's state now; `onRelayStatus` hears each change of it. */
    relayStatus: () => Promise<HermesRelayStatus>;
    onRelayStatus: (callback: (status: HermesRelayStatus) => void) => () => void;
    testConnection: (connection: HermesConnection) => Promise<{
      success: boolean;
      baseUrl?: string;
      status?: number;
      version?: string;
      gatewayState?: string;
      authRequired?: boolean;
      authFlows?: string[];
      authProviders?: string[];
      needsSignIn?: boolean;
      signedIn?: boolean;
      error?: string;
    }>;
    signIn: (params: { connection: HermesConnection; username: string; password: string; provider?: string }) => Promise<{ success: boolean; version?: string; gatewayState?: string; error?: string }>;
    signOut: (connection: HermesConnection) => Promise<{ success: boolean }>;
    crons: () => Promise<{ success: boolean; jobs?: unknown; error?: string; needsSignIn?: boolean }>;
    cronAction: (params: { action: 'pause' | 'resume' | 'trigger'; jobId: string; profile?: string }) => Promise<{ success: boolean; job?: unknown; error?: string }>;
    cronUpdate: (params: { jobId: string; updates: Record<string, unknown>; profile?: string }) => Promise<{ success: boolean; job?: unknown; error?: string; needsSignIn?: boolean }>;
    cronDelete: (params: { jobId: string; profile?: string }) => Promise<{ success: boolean; error?: string }>;
    kanbanBoard: (params?: { board?: string }) => Promise<{ success: boolean; board?: unknown; error?: string; needsSignIn?: boolean }>;
    kanbanGetTask: (params: { taskId: string }) => Promise<{ success: boolean; detail?: unknown; error?: string; needsSignIn?: boolean }>;
    kanbanCreateTask: (task: Record<string, unknown>) => Promise<{ success: boolean; task?: unknown; error?: string; needsSignIn?: boolean }>;
    kanbanUpdateTask: (params: { taskId: string; patch: Record<string, unknown> }) => Promise<{ success: boolean; task?: unknown; error?: string; needsSignIn?: boolean }>;
    kanbanDeleteTask: (params: { taskId: string }) => Promise<{ success: boolean; error?: string; needsSignIn?: boolean }>;
    kanbanAddComment: (params: { taskId: string; body: string }) => Promise<{ success: boolean; error?: string; needsSignIn?: boolean }>;
    getConnectionInfo: () => Promise<{
      apiPort: number;
      webhookPath: string;
      webhookLocalUrl: string;
      webhookTailnetUrl?: string;
      apiToken: string;
      tailscale: { installed: boolean; running: boolean; dnsName?: string; ip?: string; serveConfigured: boolean };
      serveCommand: string;
    }>;
    testWebhook: (params: { agentName?: string; agentId?: string; projectPath?: string }) => Promise<{ success: boolean; status?: number; response?: unknown; error?: string }>;
    /**
     * Three states, not two: unreachable, reachable but not signed in, and
     * signed in. `success` keeps its old meaning of "nothing more to do",
     * so a caller reading only that stays correct; `needsSignIn` is what
     * separates a gateway that answers from a session that works.
     */
    testGateway: (url: string) => Promise<{
      success: boolean;
      reachable: boolean;
      signedIn: boolean;
      needsSignIn?: boolean;
      status?: number;
      version?: string;
      error?: string;
    }>;
    mcpServers: () => Promise<
      | { success: true; servers: HermesMcpServer[] }
      | { success: false; error: string; needsSignIn?: boolean }
    >;
    memoryProviders: () => Promise<
      | { success: true; active: string; providers: HermesMemoryProvider[]; builtinBytes: number }
      | { success: false; error: string; needsSignIn?: boolean }
    >;
    setMemoryProvider: (provider: string) => Promise<
      { success: true; body?: unknown } | { success: false; error: string; needsSignIn?: boolean }
    >;
  };

  // Team templates (sets of agents deployed onto a project in one click)
  teamTemplate?: {
    list: () => Promise<{ teams: TeamTemplate[]; error?: string }>;
    create: (input: TeamTemplateInput) => Promise<{ success: boolean; team?: TeamTemplate; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
  };

  // Which providers enforce orchestrator mode rather than only asking for it
  provider?: {
    orchestratorSupport: () => Promise<Record<string, boolean>>;
  };

  // Overseer chat: Hermes watches every project's agents and reports back
  overseer?: {
    send: (message: string, attachments?: OverseerAttachment[]) => Promise<OverseerAskResult>;
    /** Opens the file picker, uploads what was chosen to the gateway, and
     *  returns the paths to name in the next message. `canceled` when the
     *  picker was dismissed, which is not a failure. */
    attachFiles: () => Promise<{
      success: boolean;
      attachments: OverseerAttachment[];
      canceled?: boolean;
      error?: string;
    }>;
    /** The upload attachFiles does, without its dialog: for a paste or a drop.
     *  12 MB a file; what is refused is named in `error`, the rest uploaded. */
    attachData: (files: Array<{ name: string; mimeType: string; data: Uint8Array }>) => Promise<{
      success: boolean;
      attachments: OverseerAttachment[];
      error?: string;
    }>;
    /** The gateway's `agent.reasoning_effort`. It belongs to the gateway, not
     *  to Tars, so it is read live rather than mirrored in app settings. */
    effort: () => Promise<{ success: boolean; effort?: string | null; options?: string[]; error?: string }>;
    setEffort: (effort: string) => Promise<{ success: boolean; error?: string }>;
    history: () => Promise<{ messages: OverseerMessage[]; busy: boolean }>;
    /** Empties the conversation, keeping settings and the standing job. The
     *  overseer's context is the conversation, so this is the way out of any
     *  loop it talks itself into. Refused while a turn is in flight. */
    clearHistory: () => Promise<{ success: boolean; cleared: number; error?: string }>;
    fleet: () => Promise<OverseerFleetSnapshot>;
    confirmAction: (params: { action: OverseerAction; approve: boolean }) => Promise<{ success: boolean; error?: string; mode?: string }>;
    pause: () => Promise<{ success: boolean; paused: boolean }>;
    resume: () => Promise<{ success: boolean; paused: boolean }>;
    /** `lastFailure` is why the last automatic check-in produced no briefing,
     *  null when the last one worked. An unattended cycle that keeps failing
     *  is otherwise invisible: nobody is waiting on a briefing to notice. */
    watchStatus: () => Promise<{
      paused: boolean;
      lastFailure: { reason: string; error: string; at: string } | null;
    }>;
    settings: () => Promise<OverseerSettings>;
    setSettings: (patch: Partial<OverseerSettings>) => Promise<{ success: boolean; settings: OverseerSettings; error?: string }>;
    autoActions: () => Promise<OverseerAutoRule[]>;
    modelOptions: () => Promise<
      | { success: true; provider: string; model: string; providers: OverseerModelProvider[] }
      | { success: false; error: string; needsSignIn?: boolean }
    >;
    onBriefing: (callback: (message: OverseerMessage) => void) => () => void;
  };

  // Updates
  updates?: {
    check: () => Promise<{ devMode?: boolean; error?: boolean; fallback?: boolean; currentVersion?: string } | null>;
    download: () => Promise<unknown>;
    quitAndInstall: () => Promise<{ started: boolean; error?: string }>;
    openExternal: (url: string) => Promise<{ success: boolean }>;
    onUpdateAvailable: (callback: (info: {
      currentVersion: string;
      latestVersion: string;
      releaseNotes: string;
      hasUpdate: boolean;
      downloadUrl?: string;
      releaseUrl?: string;
    }) => void) => () => void;
    onUpdateNotAvailable: (callback: (info: {
      currentVersion: string;
      latestVersion: string;
    }) => void) => () => void;
    onDownloadProgress: (callback: (progress: {
      percent: number;
      bytesPerSecond: number;
      transferred: number;
      total: number;
    }) => void) => () => void;
    onUpdateDownloaded: (callback: () => void) => () => void;
    onUpdateError: (callback: (error: string) => void) => () => void;
  };

  // Obsidian vault browsing & editing
  obsidian?: {
    scan: () => Promise<{
      vaults: Array<{
        vaultPath: string;
        name: string;
        files: (Omit<ObsidianFile, 'content'> & { preview?: string })[];
        tree: ObsidianFolder;
      }>;
    }>;
    readFile: (filePath: string, vaultPath: string) => Promise<{ file?: ObsidianFile; error?: string }>;
    writeFile: (filePath: string, content: string, vaultPath: string) => Promise<{ success?: boolean; error?: string }>;
    getVaultInfo: () => Promise<{ configured: boolean; vaultPaths: string[] }>;
    detectVault: (projectPath: string) => Promise<{ detected: boolean; vaultPath: string | null }>;
    addVault: (vaultPath: string) => Promise<{ success: boolean; error?: string }>;
    removeVault: (vaultPath: string) => Promise<{ success: boolean; error?: string }>;
  };

  // Native Claude memory (reads ~/.claude/projects/*/memory/)
  memory?: {
    listProjects: (extraProjectPaths?: string[]) => Promise<{ projects: ProjectMemory[]; error: string | null }>;
    readFile: (filePath: string) => Promise<{ content: string; error?: string }>;
    writeFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
    createFile: (memoryDir: string, fileName: string, content?: string) => Promise<{ success: boolean; file?: MemoryFile; error?: string }>;
    deleteFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  };

  // Tray menu events
  tray?: {
    onFocusAgent: (callback: (agentId: string) => void) => () => void;
    showMainWindow: () => Promise<{ success: boolean }>;
    quit: () => Promise<{ success: boolean }>;
  };

  // Get home path helper
  getHomePath?: () => string;

  // Platform info
  platform: string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
