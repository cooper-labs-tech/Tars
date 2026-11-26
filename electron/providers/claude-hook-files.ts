/**
 * The hook scripts (hooks/) Claude Code is told to run, by event: merged into ~/.claude/settings.json for an agent on
 * this computer (claude-provider.ts, configureHooks), and handed per launch, from their copies on the host, to one that
 * runs on a remote host (services/remote-agents.ts). A leaf module, so both read the one list.
 */
export const CLAUDE_HOOK_FILES: ReadonlyArray<{ type: string; file: string; matcher?: string }> = [
  { type: 'PostToolUse', file: 'post-tool-use.sh', matcher: '*' },
  { type: 'Stop', file: 'on-stop.sh', matcher: undefined },
  // A turn that ends on an API error fires this instead of Stop, and with no
  // listener the agent stayed `running` for good. See the script.
  { type: 'StopFailure', file: 'stop-failure.sh', matcher: undefined },
  { type: 'SessionStart', file: 'session-start.sh', matcher: '*' },
  { type: 'SessionEnd', file: 'session-end.sh', matcher: '*' },
  { type: 'Notification', file: 'notification.sh', matcher: '*' },
  { type: 'PermissionRequest', file: 'permission-request.sh', matcher: undefined },
  { type: 'TaskCompleted', file: 'task-completed.sh', matcher: undefined },
  { type: 'UserPromptSubmit', file: 'user-prompt-submit.sh', matcher: undefined },
];
