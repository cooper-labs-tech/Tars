import type { AgentCharacter, AgentProvider } from '@/types/electron';
import type { AgentPermissionMode, AgentEffort } from '@/types/agent';
import type { ClaudeSkill } from '@/lib/claude-code';

export interface Project {
  path: string;
  name: string;
}

export interface WorktreeConfig {
  enabled: boolean;
  branchName: string;
}

export interface EditAgentData {
  id: string;
  name?: string;
  character?: AgentCharacter;
  projectPath: string;
  secondaryProjectPath?: string;
  skills: string[];
  /** @deprecated use permissionMode instead */
  skipPermissions?: boolean;
  permissionMode?: AgentPermissionMode;
  effort?: AgentEffort;
  provider?: AgentProvider;
  model?: string;
  localModel?: string;
  /** The branch its folder is on, read from git: its project's when it has no worktree of its own. */
  branchName?: string;
  /** Its own worktree, when it has one. */
  worktreePath?: string;
  obsidianVaultPaths?: string[];
  savedPrompt?: string;
  /** The Orchestrator toggle. */
  role?: 'orchestrator' | 'worker';
  cliPath?: string;
}

/** Which half of the "One agent | A team" switch the overlay opens on. */
export type CreationMode = 'agent' | 'team';

export interface NewChatModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (
    projectPath: string,
    skills: string[],
    prompt: string,
    model?: string,
    worktree?: WorktreeConfig,
    character?: AgentCharacter,
    name?: string,
    secondaryProjectPath?: string,
    permissionMode?: AgentPermissionMode,
    provider?: AgentProvider,
    localModel?: string,
    obsidianVaultPaths?: string[],
    effort?: AgentEffort,
    role?: 'orchestrator' | 'worker',
    cliPath?: string,
  ) => void | Promise<boolean | void | { error: string }>;
  onUpdate?: (id: string, updates: {
    projectPath?: string;
    skills?: string[];
    secondaryProjectPath?: string | null;
    permissionMode?: AgentPermissionMode;
    effort?: AgentEffort;
    name?: string;
    character?: AgentCharacter;
    model?: string | null;
    provider?: AgentProvider;
    localModel?: string | null;
    savedPrompt?: string | null;
    obsidianVaultPaths?: string[];
    worktree?: WorktreeConfig;
    role?: 'orchestrator' | 'worker';
    cliPath?: string | null;
  }) => void | Promise<boolean | void | { error: string }>;
  /** Called after a team is deployed, with the ids of the agents created. */
  onTeamDeployed?: (agentIds: string[]) => void;
  editAgent?: EditAgentData | null;
  projects: Project[];
  onBrowseFolder?: () => Promise<string | null>;
  installedSkills?: string[];
  allInstalledSkills?: ClaudeSkill[];
  onRefreshSkills?: () => void;
  initialProjectPath?: string;
  /**
   * @deprecated The wizard's four steps collapsed into one screen, so there is
   * nothing left to jump to. Accepted so the three existing call sites
   * (agents/projects pages, TerminalsView) keep compiling unchanged; read by
   * nothing. Same pattern as `existingSuperAgent` below.
   */
  initialStep?: number;
  initialOrchestrator?: boolean;
  /** Opens on the team half of the switch instead of the agent half. Ignored in edit mode - editing an existing single agent has no team equivalent. */
  initialMode?: CreationMode;
  /**
   * @deprecated The template-chip row this opened from the create screen is
   * gone in the one-screen redesign (the frame has no room for it, and no
   * other surface calls it). `TemplatesManagerDialog` itself is untouched -
   * this prop is kept, and ignored, only so agents/page.tsx keeps compiling.
   */
  onManageTemplates?: () => void;
  /** @deprecated Still accepted so the call site compiles; not read. See NewChatModal/index.tsx. */
  existingSuperAgent?: { id: string; name?: string } | null;
}
