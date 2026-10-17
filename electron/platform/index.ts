/**
 * The platform layer: every decision that differs between darwin/linux and
 * win32 in how Tars starts and ends processes, and how it names, compares,
 * guards and replaces files. Callers import from here and
 * pass no `if (win32)` of their own. darwin and linux get what they got
 * before this layer existed, byte for byte.
 */
export { realFs, type FsProbe, type Env } from './fs-probe';
export { envValue, getPath, withPath, pathEntries, joinPathEntries, unquoteEntry } from './path-env';
export { resolveShell, shellArgs, agentShell } from './shell';
export {
  resolveCliBinary, findOnPath, isPlainAbsolute, pathExts, DEFAULT_PATHEXT,
  type CliBinary, type CliBinaryFailure, type CliBinaryFailureReason,
} from './cli-binary';
export { windowsCliFile, findWindowsCli, windowsCliDirs, windowsGcloudDirs, type CliLookup } from './windows-cli';
export { cliEnv, stdioServerCommand, nodeServerCommand } from './cli-env';
export { childEnv } from './child-env';
export { posixWords, PosixWordsError, type PosixWordsErrorCode } from './posix-words';
export {
  buildWindowsCommandLine, quoteWindowsArg, quoteWindowsProgram, WindowsCommandLineError, WINDOWS_COMMAND_LINE_MAX,
  type WindowsCommandLineErrorCode,
} from './windows-command-line';
export { toLaunch, LaunchError, type Launch, type PosixLaunch, type DirectLaunch, type LaunchErrorCode } from './launch';
export { killTree, KillTreeError, type KillTreeResult, type KillTreeDeps, type KillTreeErrorCode } from './kill-tree';
export { samePath, isUnder, isInsideWorktreesDir, isFilesystemRoot, pathKey } from './path-compare';
export { isUnsafePathSegment } from './windows-names';
export { errorReportsAvailable } from './error-reports';
export { processExists } from './process-exists';
export { processStartOf } from './process-start';
export { projectName } from './project-name';
export {
  encodeClaudeProjectDir, claudeProjectDirNames, decodeWindowsClaudeProjectDir, memoryProjectDirName, knownProjectsByFolder,
  transcriptProjectDirName,
  type DecodeDeps,
} from './claude-project-dir';
export { windowsSoundCommand, type SoundCommand } from './sound';
export { credentialStoreDirs } from './credential-stores';
export {
  renameReplacingSync, rmRetryingSync, unlinkRetryingSync, RENAME_RETRY_BUDGET_MS, REMOVE_RETRY_BUDGET_MS,
  type RenameDeps, type RemoveDeps,
} from './rename-replacing';
export {
  restrictToOwnerSync, restrictToOwner, restrictDirToOwner, ownerOnlyDirSync, closesByAccessList, parseWhoamiUserSid, SYSTEM_SID,
  type OwnerOnlyResult, type OwnerOnlyDeps, type OwnerOnlyOptions,
} from './owner-only';
export { detectShells, type DetectedShells, type ShellChoice, type ShellChoiceId } from './shell-choices';
export {
  TITLE_BAR_OVERLAY_HEIGHT, WINDOWS_APP_USER_MODEL_ID, TRAY_PANEL_MARGIN,
  isWindowsShell, titleBarOptions, parseTitleBarOverlay, closeAction, isClickThatClosedPanel, taskbarEdge, trayPanelPosition,
  type Rect, type DisplayArea, type TaskbarEdge,
} from './desktop-shell';
export {
  hermesDesktopConfigPath, tailscaleCandidates, tasmaniaTokenPath, type TasmaniaToken,
} from './integration-paths';
