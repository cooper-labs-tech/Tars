import {
  Brain,
  Settings,
  GitCommit,
  Bell,
  Send,
  Shield,
  Puzzle,
  Monitor,
  Terminal,
  Twitter,
  Cloud,
  Plug,
  Zap,
  MessagesSquare,
  Users,
} from 'lucide-react';
import { SlackIcon } from './SlackIcon';
import { TasmaniaIcon } from './TasmaniaIcon';
import type { SettingsSection } from './types';

/** A leaf is one sub-page: its own title and its own one-line subtitle in the page header. */
export interface SettingsLeaf {
  id: SettingsSection;
  label: string;
  /** Sentence shown under the sub-page title. One line, no trailing context. */
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

export interface SettingsGroup {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  children: SettingsLeaf[];
}

/**
 * Seventeen flat entries meant scrolling a list to find anything, and five of
 * them were a single vendor. Same seventeen screens, six doors.
 */
export const SECTION_GROUPS: SettingsGroup[] = [
  {
    id: 'general',
    label: 'General',
    icon: Settings,
    children: [
      { id: 'general', label: 'Preferences', description: 'How Tars behaves before anything else.', icon: Settings },
      { id: 'terminal', label: 'Terminal', description: 'Type size and theme for every terminal Tars opens.', icon: Terminal },
      { id: 'notifications', label: 'Notifications', description: 'What Tars tells you about, and when it stays quiet.', icon: Bell },
      { id: 'system', label: 'System', description: 'Updates, the machine, and what it already provides.', icon: Monitor },
    ],
  },
  {
    id: 'ai',
    label: 'AI & Providers',
    icon: Zap,
    children: [
      { id: 'ai-providers', label: 'Providers', description: 'Every CLI and API Tars can run. They are all equal here.', icon: Zap },
      { id: 'claude-accounts', label: 'Claude accounts', description: 'Several Claude subscriptions, and when your agents move between them.', icon: Users },
      { id: 'cli', label: 'CLI Paths', description: 'Where each command line tool lives on this machine.', icon: Terminal },
      { id: 'permissions', label: 'Permissions', description: 'How far an agent may go before it asks you.', icon: Shield },
    ],
  },
  {
    id: 'hermes',
    label: 'Hermes',
    icon: Send,
    children: [
      { id: 'hermes', label: 'Connection', description: 'Where your Hermes gateway lives.', icon: Send },
      { id: 'hermes-gateways', label: 'Gateways', description: 'Each Hermes that hands Tars work: the address it posts to, its secret, and the projects it may reach.', icon: Send },
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    icon: Plug,
    children: [
      { id: 'telegram', label: 'Telegram', description: 'Reach your agents from a Telegram chat.', icon: Send },
      { id: 'slack', label: 'Slack', description: 'Reach your agents from a Slack workspace.', icon: SlackIcon },
      { id: 'discord', label: 'Discord', description: 'Same commands, in your server.', icon: MessagesSquare },
      { id: 'socialdata', label: 'X (Twitter)', description: 'Read and post on X with your own keys.', icon: Twitter },
      { id: 'google-workspace', label: 'Google Workspace', description: 'Gmail, Calendar and Drive, through your own account.', icon: Cloud },
    ],
  },
  {
    id: 'extensions',
    label: 'Extensions',
    icon: Puzzle,
    children: [
      { id: 'skills', label: 'Skills & Plugins', description: 'Everything installed on top of the agents you already have.', icon: Puzzle },
      { id: 'mcp', label: 'Custom MCP', description: 'Servers Tars did not install, listed as they are.', icon: Plug },
      { id: 'tasmania', label: 'Tasmania', description: 'The Tasmania server, and where it runs from.', icon: TasmaniaIcon },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    icon: GitCommit,
    children: [
      { id: 'git', label: 'Git', description: 'How Tars commits, branches and worktrees on your behalf.', icon: GitCommit },
      { id: 'memory', label: 'Memory Backends', description: 'Where memory goes once it leaves the files on disk.', icon: Brain },
    ],
  },
];

/** Flat view of the same sections, for deep-links and the mobile picker. */
export const SECTIONS: SettingsLeaf[] = SECTION_GROUPS.flatMap(g => g.children);

/** The privacy policy Cooper Labs publishes, as the repository holds it. */
export const PRIVACY_POLICY_URL = 'https://github.com/cooper-labs-tech/Tars/blob/main/landing/src/content/privacy.md';

export const DEFAULT_APP_SETTINGS = {
  notificationsEnabled: true,
  notifyOnWaiting: true,
  notifyOnComplete: true,
  notifyOnStop: true,
  notifyOnError: true,
  slackEnabled: false,
  slackBotToken: '',
  slackAppToken: '',
  slackSigningSecret: '',
  slackChannelId: '',
  slackAllowedUserIds: [],
  // Main's own defaults (#193): off, no token, and a mention required.
  discordEnabled: false,
  discordBotToken: '',
  discordChannelId: '',
  discordAllowedUserIds: [] as string[],
  discordRequireMention: true,
  socialDataEnabled: false,
  socialDataApiKey: '',
  xPostingEnabled: false,
  xApiKey: '',
  xApiSecret: '',
  xAccessToken: '',
  xAccessTokenSecret: '',
  tasmaniaEnabled: false,
  tasmaniaServerPath: '',
  gwsEnabled: false,
  gwsSkillsInstalled: false,
  verboseModeEnabled: false,
  chromeEnabled: false,
  autoCheckUpdates: true,
  errorReportsEnabled: false,
  autoStartAgentsOnLaunch: true,
  newInterface: false,
  opencodeEnabled: false,
  opencodeDefaultModel: '',
  openRouterEnabled: false,
  openRouterApiKey: '',
  deepSeekEnabled: false,
  deepSeekApiKey: '',
  mimoEnabled: false,
  mimoApiKey: '',
  moonshotEnabled: false,
  moonshotApiKey: '',
  qwenEnabled: false,
  qwenApiKey: '',
  zhipuEnabled: false,
  zhipuApiKey: '',
  minimaxEnabled: false,
  minimaxApiKey: '',
  nvidiaEnabled: false,
  nvidiaApiKey: '',
  nousPortalEnabled: false,
  nousPortalApiKey: '',
  veniceEnabled: false,
  veniceApiKey: '',
  ollamaBaseUrl: '',
  ollamaCloudEnabled: false,
  ollamaCloudApiKey: '',
  customOpenAIEnabled: false,
  customOpenAIBaseUrl: '',
  customOpenAIApiKey: '',
  customOpenAIModel: '',
  obsidianVaultPaths: [] as string[],
  terminalFontSize: 11,
  terminalTheme: 'dark' as const,
  // statusLineEnabled is absent on purpose, as in the main process defaults:
  // unset means the switch was never touched. A false here reads as a choice
  // the moment anything sends these settings back whole.
  hermesGatewayUrl: '',
  hermesGatewayToken: '',
  memoryGbrainEnabled: false,
  memoryGbrainMcpUrl: '',
  memoryGbrainAuthToken: '',
  memoryHonchoEnabled: false,
  memoryHonchoMcpUrl: 'https://mcp.honcho.dev',
  memoryHonchoApiKey: '',
  memoryHonchoWorkspaceId: '',
  favoriteProjects: [] as string[],
  hiddenProjects: [] as string[],
  cliPaths: {
    claude: '',
    codex: '',
    gemini: '',
    grok: '',
    qwencode: '',
    opencode: '',
    amp: '',
    pi: '',
    gws: '',
    gcloud: '',
    gh: '',
    node: '',
    minimax: '',
    additionalPaths: [],
  },
};
