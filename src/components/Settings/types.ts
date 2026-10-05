export interface ClaudeSettings {
  enabledPlugins: Record<string, boolean>;
  env: Record<string, string>;
  hooks: Record<string, unknown>;
  includeCoAuthoredBy: boolean;
  permissions: { allow: string[]; deny: string[] };
}

export interface ClaudeInfo {
  claudeVersion: string;
  configPath: string;
  settingsPath: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  electronVersion: string;
}

export interface Skill {
  name: string;
  source: 'project' | 'user' | 'plugin';
  path: string;
  description?: string;
  projectName?: string;
}

export interface CLIPaths {
  claude: string;
  codex: string;
  gemini: string;
  grok: string;
  qwencode: string;
  opencode: string;
  amp: string;
  pi: string;
  gws: string;
  gcloud: string;
  gh: string;
  node: string;
  minimax: string;
  additionalPaths: string[];
}

export interface AppSettings {
  notificationsEnabled: boolean;
  notifyOnWaiting: boolean;
  notifyOnComplete: boolean;
  notifyOnStop: boolean;
  notifyOnError: boolean;
  telegramEnabled: boolean;
  telegramBotToken: string;
  /**
   * Telegram through Hermes (#285): on, main erases the bot's token and turns
   * the bot off.
   */
  hermesRelayEnabled?: boolean;
  telegramChatId: string; // Legacy - kept for backwards compatibility
  telegramAuthToken: string; // Secret token for authentication
  telegramAuthorizedChatIds: string[]; // List of authorized chat IDs
  telegramRequireMention: boolean; // Only respond when bot is @mentioned in groups
  slackEnabled: boolean;
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  slackChannelId: string;
  /**
   * The Slack member IDs the bot answers; empty answers nobody (#137).
   */
  slackAllowedUserIds: string[];
  /** The Discord bot (PR 193). Saving `discordEnabled` or `discordBotToken`
   *  restarts it; the members and the mention switch count at the next
   *  message. `discordChannelId` is the bot's to fill, never typed. */
  discordEnabled: boolean;
  discordBotToken: string;
  discordChannelId: string;
  /** Discord user IDs, 17 to 20 digits; empty answers nobody. */
  discordAllowedUserIds: string[];
  discordRequireMention: boolean;
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
  /** Error reports to Sentry: off unless the user turns them on. Main reads
   *  it at launch and follows every change, so off stops them at once. */
  errorReportsEnabled: boolean;
  /** Resume idle agents once at launch (not on navigation). */
  autoStartAgentsOnLaunch?: boolean;
  cliPaths: CLIPaths;
  defaultProvider?: string;
  obsidianVaultPaths?: string[];
  opencodeEnabled: boolean;
  opencodeDefaultModel: string;
  // External AI providers. Each injects ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY
  // into the claude PTY process. All keys fall back to openRouterApiKey.
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
  terminalTheme?: 'dark' | 'light';
  statusLineEnabled?: boolean;
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
  memoryHonchoWorkspaceId?: string;
  anthropicApiKey?: string;
  defaultClaudeModel?: string;
  favoriteProjects?: string[];
  hiddenProjects?: string[];
  defaultProjectPath?: string;
  /** Monthly ceiling per provider, in dollars. Set on the Usage page. */
  providerBudgets?: Record<string, number>;
}

export type SettingsSection = 'general' | 'terminal' | 'git' | 'notifications' | 'telegram' | 'slack' | 'discord' | 'socialdata' | 'tasmania' | 'google-workspace' | 'ai-providers' | 'claude-accounts' | 'permissions' | 'skills' | 'hermes' | 'memory' | 'mcp' | 'cli' | 'system';
