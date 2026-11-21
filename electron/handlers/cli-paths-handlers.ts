import { ipcMain } from 'electron';
import { defaultShell } from '../utils/default-shell';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import type { AppSettings, CLIPaths } from '../types';
import { dataPath } from '../constants';
import { getPath, joinPathEntries, pathEntries, realFs, type Env, type FsProbe } from '../platform';
import { findWindowsCli, windowsCliDirs, windowsCliFile, windowsGcloudDirs, type CliLookup } from '../providers/cli-exec';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Shared config file path that MCP can read
const CLI_PATHS_CONFIG_FILE = dataPath('cli-paths.json');

export interface CLIPathsHandlerDependencies {
  getAppSettings: () => AppSettings;
  setAppSettings: (settings: AppSettings) => void;
  saveAppSettings: (settings: AppSettings) => void;
}

type DetectedPaths = { amp: string; claude: string; codex: string; gemini: string; grok: string; qwencode: string; opencode: string; pi: string; kimi: string; gws: string; gcloud: string; gh: string; node: string; minimax: string };

/**
 * Detect CLI paths from the system.
 * If savedPaths is provided, manually-set paths are checked first and used if the binary exists.
 */
async function detectCLIPaths(savedPaths?: Partial<CLIPaths>): Promise<DetectedPaths> {
  // Windows has no login shell to ask, no `which`, and no CLI without an
  // extension: its own lookup, in Node, below. darwin/linux: as it always was.
  if (process.platform === 'win32') return detectWindowsCLIPaths(savedPaths, process.env);
  const homeDir = os.homedir();
  const paths = { amp: '', claude: '', codex: '', gemini: '', grok: '', qwencode: '', opencode: '', pi: '', kimi: '', gws: '', gcloud: '', gh: '', node: '', minimax: '' };

  // If a user manually set a path in settings, use it if the binary exists
  if (savedPaths) {
    const cliKeys = ['amp', 'claude', 'codex', 'gemini', 'grok', 'qwencode', 'opencode', 'pi', 'kimi', 'gws', 'gcloud', 'gh', 'node', 'minimax'] as const;
    for (const key of cliKeys) {
      const savedPath = savedPaths[key];
      if (savedPath && fs.existsSync(savedPath)) {
        paths[key] = savedPath;
      }
    }
  }

  // Try to get the full interactive shell PATH (includes .zshrc/.bashrc paths)
  let shellPath = process.env.PATH || '';
  try {
    // The user's shell as a file and its script as an argument: $SHELL is
    // never parsed by another shell.
    const shell = defaultShell();
    const { stdout } = await execFileAsync(shell, ['-ilc', 'echo $PATH'], { timeout: 5000 });
    if (stdout.trim()) {
      shellPath = stdout.trim();
    }
  } catch {
    // Fall back to process.env.PATH
  }

  // Common locations to check
  const commonPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(homeDir, '.local/bin'),
    path.join(homeDir, '.grok/bin'),       // Grok CLI default install dir
    path.join(homeDir, 'Library/pnpm'),   // pnpm global bin (macOS)
    path.join(homeDir, '.yarn/bin'),       // yarn global bin
  ];

  // Add directories from the shell PATH that aren't already included
  for (const dir of shellPath.split(':')) {
    if (dir && !commonPaths.includes(dir)) {
      commonPaths.push(dir);
    }
  }

  // Add nvm paths
  const nvmDir = path.join(homeDir, '.nvm/versions/node');
  if (fs.existsSync(nvmDir)) {
    try {
      const versions = fs.readdirSync(nvmDir);
      for (const version of versions) {
        commonPaths.push(path.join(nvmDir, version, 'bin'));
      }
    } catch {
      // Ignore errors
    }
  }

  // Check for claude
  if (!paths.claude) for (const dir of commonPaths) {
    const claudePath = path.join(dir, 'claude');
    if (fs.existsSync(claudePath)) {
      paths.claude = claudePath;
      break;
    }
  }

  // Try which command for claude
  if (!paths.claude) {
    try {
      const { stdout } = await execAsync('which claude', {
        env: { ...process.env, PATH: `${commonPaths.join(':')}:${process.env.PATH}` },
      });
      if (stdout.trim()) {
        paths.claude = stdout.trim();
      }
    } catch {
      // Ignore
    }
  }

  // Check for codex
  if (!paths.codex) for (const dir of commonPaths) {
    const codexPath = path.join(dir, 'codex');
    if (fs.existsSync(codexPath)) {
      paths.codex = codexPath;
      break;
    }
  }

  // Try which command for codex
  if (!paths.codex) {
    try {
      const { stdout } = await execAsync('which codex', {
        env: { ...process.env, PATH: `${commonPaths.join(':')}:${process.env.PATH}` },
      });
      if (stdout.trim()) {
        paths.codex = stdout.trim();
      }
    } catch {
      // Ignore
    }
  }

  // Check for gemini
  if (!paths.gemini) for (const dir of commonPaths) {
    const geminiPath = path.join(dir, 'gemini');
    if (fs.existsSync(geminiPath)) {
      paths.gemini = geminiPath;
      break;
    }
  }

  // Try which command for gemini
  if (!paths.gemini) {
    try {
      const { stdout } = await execAsync('which gemini', {
        env: { ...process.env, PATH: `${commonPaths.join(':')}:${process.env.PATH}` },
      });
      if (stdout.trim()) {
        paths.gemini = stdout.trim();
      }
    } catch {
      // Ignore
    }
  }

  // Check for grok
  if (!paths.grok) for (const dir of commonPaths) {
    const grokPath = path.join(dir, 'grok');
    if (fs.existsSync(grokPath)) {
      paths.grok = grokPath;
      break;
    }
  }

  // Try which command for grok
  if (!paths.grok) {
    try {
      const { stdout } = await execAsync('which grok', {
        env: { ...process.env, PATH: `${commonPaths.join(':')}:${process.env.PATH}` },
      });
      if (stdout.trim()) {
        paths.grok = stdout.trim();
      }
    } catch {
      // Ignore
    }
  }

  // Check for opencode
  if (!paths.opencode) for (const dir of commonPaths) {
    const opencodePath = path.join(dir, 'opencode');
    if (fs.existsSync(opencodePath)) {
      paths.opencode = opencodePath;
      break;
    }
  }

  // Try which command for opencode
  if (!paths.opencode) {
    try {
      const { stdout } = await execAsync('which opencode', {
        env: { ...process.env, PATH: `${commonPaths.join(':')}:${process.env.PATH}` },
      });
      if (stdout.trim()) {
        paths.opencode = stdout.trim();
      }
    } catch {
      // Ignore
    }
  }

  // Kimi Code, the binary kimi: along the same folders, the shell's PATH among them.
  if (!paths.kimi) for (const dir of commonPaths) {
    const kimiPath = path.join(dir, 'kimi');
    if (fs.existsSync(kimiPath)) {
      paths.kimi = kimiPath;
      break;
    }
  }

  // Check for amp
  if (!paths.amp) for (const dir of commonPaths) {
    const ampPath = path.join(dir, 'amp');
    if (fs.existsSync(ampPath)) {
      paths.amp = ampPath;
      break;
    }
  }

  // Try which command for amp
  if (!paths.amp) {
    try {
      const { stdout } = await execAsync('which amp', {
        env: { ...process.env, PATH: `${commonPaths.join(':')}:${process.env.PATH}` },
      });
      if (stdout.trim()) {
        paths.amp = stdout.trim();
      }
    } catch {
      // Ignore
    }
  }

  // Check for pi
  if (!paths.pi) for (const dir of commonPaths) {
    const piPath = path.join(dir, 'pi');
    if (fs.existsSync(piPath)) {
      paths.pi = piPath;
      break;
    }
  }

  // Try which command for pi
  if (!paths.pi) {
    try {
      const { stdout } = await execAsync('which pi', {
        env: { ...process.env, PATH: `${commonPaths.join(':')}:${process.env.PATH}` },
      });
      if (stdout.trim()) {
        paths.pi = stdout.trim();
      }
    } catch {
      // Ignore
    }
  }

  // Check for gws
  if (!paths.gws) for (const dir of commonPaths) {
    const gwsPath = path.join(dir, 'gws');
    if (fs.existsSync(gwsPath)) {
      paths.gws = gwsPath;
      break;
    }
  }

  // Try which command for gws
  if (!paths.gws) {
    try {
      const { stdout } = await execAsync('which gws', {
        env: { ...process.env, PATH: `${commonPaths.join(':')}:${process.env.PATH}` },
      });
      if (stdout.trim()) {
        paths.gws = stdout.trim();
      }
    } catch {
      // Ignore
    }
  }

  // Check for gcloud (also check gcloud-specific install locations)
  const gcloudPaths = [
    ...commonPaths,
    '/opt/homebrew/share/google-cloud-sdk/bin',
    '/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin',
    path.join(homeDir, 'google-cloud-sdk/bin'),
  ];
  if (!paths.gcloud) for (const dir of gcloudPaths) {
    const gcloudPath = path.join(dir, 'gcloud');
    if (fs.existsSync(gcloudPath)) {
      paths.gcloud = gcloudPath;
      break;
    }
  }

  // Try which command for gcloud
  if (!paths.gcloud) {
    try {
      const { stdout } = await execAsync('which gcloud', {
        env: { ...process.env, PATH: `${gcloudPaths.join(':')}:${process.env.PATH}` },
      });
      if (stdout.trim()) {
        paths.gcloud = stdout.trim();
      }
    } catch {
      // Ignore
    }
  }

  // Check for gh
  if (!paths.gh) for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
    const ghPath = path.join(dir, 'gh');
    if (fs.existsSync(ghPath)) {
      paths.gh = ghPath;
      break;
    }
  }

  // Try which command for gh
  if (!paths.gh) {
    try {
      const { stdout } = await execAsync('which gh', {
        env: { ...process.env, PATH: `${commonPaths.join(':')}:${process.env.PATH}` },
      });
      if (stdout.trim()) {
        paths.gh = stdout.trim();
      }
    } catch {
      // Ignore
    }
  }

  // Check for node
  if (!paths.node) for (const dir of commonPaths) {
    const nodePath = path.join(dir, 'node');
    if (fs.existsSync(nodePath)) {
      paths.node = nodePath;
      break;
    }
  }

  // Try which command for node
  if (!paths.node) {
    try {
      const { stdout } = await execAsync('which node', {
        env: { ...process.env, PATH: `${commonPaths.join(':')}:${process.env.PATH}` },
      });
      if (stdout.trim()) {
        paths.node = stdout.trim();
      }
    } catch {
      // Ignore
    }
  }

  // Check for Qwen Code (Alibaba): the CLI installs as `qwen`
  if (!paths.qwencode) for (const dir of commonPaths) {
    const qwenPath = path.join(dir, 'qwen');
    if (fs.existsSync(qwenPath)) {
      paths.qwencode = qwenPath;
      break;
    }
  }
  if (!paths.qwencode) {
    try {
      const { stdout } = await execAsync('which qwen', {
        env: { ...process.env, PATH: `${commonPaths.join(':')}:${process.env.PATH}` },
      });
      if (stdout.trim()) {
        paths.qwencode = stdout.trim();
      }
    } catch {
      // Ignore
    }
  }

  // Check for minimax
  if (!paths.minimax) for (const dir of commonPaths) {
    const minimaxPath = path.join(dir, 'minimax');
    if (fs.existsSync(minimaxPath)) {
      paths.minimax = minimaxPath;
      break;
    }
  }

  // Try which command for minimax
  if (!paths.minimax) {
    try {
      const { stdout } = await execAsync('which minimax', {
        env: { ...process.env, PATH: `${commonPaths.join(':')}:${process.env.PATH}` },
      });
      if (stdout.trim()) {
        paths.minimax = stdout.trim();
      }
    } catch {
      // Ignore
    }
  }

  return paths;
}

/** The file each key names on disk (Qwen Code installs as `qwen`), in the order the detection above reaches them. */
const WINDOWS_CLI_NAMES: Array<[keyof DetectedPaths, string]> = [
  ['claude', 'claude'], ['codex', 'codex'], ['gemini', 'gemini'], ['grok', 'grok'], ['opencode', 'opencode'],
  ['amp', 'amp'], ['pi', 'pi'], ['kimi', 'kimi'], ['gws', 'gws'], ['gcloud', 'gcloud'], ['gh', 'gh'], ['node', 'node'],
  ['qwencode', 'qwen'], ['minimax', 'minimax'],
];

/**
 * detectCLIPaths on Windows, where there is no `which`. The PATH is the process's
 * own (Windows has no login shell whose rc files add to it), read under
 * whatever spelling it has. Each CLI is looked up in Node, PATHEXT and all:
 * first where Windows installers put it, then along the PATH. A file must be
 * one Tars can start (a .exe, or an npm .cmd it can read through), never the
 * extensionless sh shim npm writes beside it; gcloud only has to be there
 * (gcloud.cmd is the Cloud SDK's own batch file, which gws starts, not Tars).
 * What was found and could not be used is logged.
 */
export function detectWindowsCLIPaths(savedPaths: Partial<CLIPaths> | undefined, env: Env, fs: FsProbe = realFs): DetectedPaths {
  const paths: DetectedPaths = { amp: '', claude: '', codex: '', gemini: '', grok: '', qwencode: '', opencode: '', pi: '', kimi: '', gws: '', gcloud: '', gh: '', node: '', minimax: '' };
  const lookupFor = (key: keyof DetectedPaths): CliLookup => (key === 'gcloud' ? 'present' : 'startable');
  const installDirs = windowsCliDirs(env);

  for (const [key, name] of WINDOWS_CLI_NAMES) {
    const savedPath = savedPaths?.[key];
    if (typeof savedPath === 'string' && savedPath && 'path' in windowsCliFile(savedPath, env, lookupFor(key), fs)) {
      paths[key] = savedPath;
      continue;
    }
    const dirs = key === 'gcloud' ? [...windowsGcloudDirs(env), ...installDirs] : installDirs;
    const found = findWindowsCli(name, dirs, env, lookupFor(key), fs);
    for (const r of found.rejected) console.warn(`[cli-paths] ${name}: ${r.path ?? r.name} not used (${r.reason}): ${r.detail}`);
    if (found.path) paths[key] = found.path;
  }
  return paths;
}

/**
 * The folders cli-paths.json's fullPath starts with, after the user's own:
 * where CLIs are installed on this platform. On darwin/linux the list it has
 * always been.
 */
function defaultCliDirs(homeDir: string): string[] {
  if (process.platform === 'win32') return windowsCliDirs(process.env);
  const defaultPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(homeDir, '.local/bin'),
    path.join(homeDir, 'Library/pnpm'),
    path.join(homeDir, '.yarn/bin'),
  ];

  // Add nvm paths
  const nvmDir = path.join(homeDir, '.nvm/versions/node');
  if (fs.existsSync(nvmDir)) {
    try {
      const versions = fs.readdirSync(nvmDir);
      for (const version of versions) {
        defaultPaths.push(path.join(nvmDir, version, 'bin'));
      }
    } catch {
      // Ignore
    }
  }
  return defaultPaths;
}

/**
 * The process PATH as entries: `;`-separated on Windows, whose every drive
 * holds a colon, under whatever spelling the variable has there. darwin/linux:
 * split on `:` exactly as before, an unset PATH giving one empty entry.
 */
function processPathEntries(): string[] {
  if (process.platform === 'win32') return pathEntries(getPath(process.env, 'win32'), 'win32');
  return (process.env.PATH || '').split(':');
}

/**
 * Save CLI paths to the shared config file that MCP can read
 */
function saveCLIPathsConfig(paths: CLIPaths): void {
  const configDir = path.dirname(CLI_PATHS_CONFIG_FILE);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Build full PATH string from configured paths, with this platform's
  // separator: `C:\tools` joined with `:` read back as `C` and `\tools`.
  const allPaths = [...new Set([
    ...paths.additionalPaths,
    ...defaultCliDirs(os.homedir()),
    ...processPathEntries(),
  ])];

  const config = {
    ...paths,
    fullPath: joinPathEntries(allPaths, process.platform),
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(CLI_PATHS_CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Load CLI paths config from file
 */
function loadCLIPathsConfig(): CLIPaths | null {
  try {
    if (fs.existsSync(CLI_PATHS_CONFIG_FILE)) {
      const content = fs.readFileSync(CLI_PATHS_CONFIG_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // Ignore
  }
  return null;
}

type DetectedCLIPaths = Awaited<ReturnType<typeof detectCLIPaths>>;

/**
 * The last detection, for the paths saved when it ran.
 *
 * A detection starts a login shell (the user's .zshrc, nvm and all) and probes
 * a dozen CLIs: 114 to 762 ms measured by the Audit on 2026-09-23, paid by every
 * Settings section and every "+ Agent" and "+ Team" dialog, which all asked
 * again. What it finds changes when a CLI is installed or moved, not between
 * two dialogs, so it runs once per app run and again when the saved paths
 * change or somebody asks (`refresh`, the Detect button). Calls made while it
 * runs share it.
 */
let detection: { savedPaths: string; result: Promise<DetectedCLIPaths> } | null = null;

export function detectCLIPathsCached(savedPaths: Partial<CLIPaths> | undefined, refresh = false): Promise<DetectedCLIPaths> {
  const key = JSON.stringify(savedPaths ?? {});
  if (!refresh && detection?.savedPaths === key) return detection.result;
  const current = { savedPaths: key, result: detectCLIPaths(savedPaths) };
  detection = current;
  current.result.catch(() => {
    if (detection === current) detection = null;
  });
  return current.result;
}

/** Test seam. */
export function resetCLIPathsDetection(): void {
  detection = null;
}

/**
 * Register CLI paths IPC handlers
 */
export function registerCLIPathsHandlers(deps: CLIPathsHandlerDependencies): void {
  const { getAppSettings, setAppSettings, saveAppSettings } = deps;

  // Detect CLI paths (use saved settings as overrides if binary exists at
  // saved path), from the last detection unless asked to look again.
  ipcMain.handle('cliPaths:detect', async (_event, options?: { refresh?: boolean }) => {
    const settings = getAppSettings();
    return detectCLIPathsCached(settings.cliPaths, options?.refresh === true);
  });

  // Get CLI paths from app settings
  ipcMain.handle('cliPaths:get', async () => {
    const settings = getAppSettings();
    return settings.cliPaths || { amp: '', claude: '', codex: '', gemini: '', grok: '', qwencode: '', opencode: '', pi: '', kimi: '', gws: '', gcloud: '', gh: '', node: '', minimax: '', additionalPaths: [] };
  });

  // Save CLI paths
  ipcMain.handle('cliPaths:save', async (_event, paths: CLIPaths) => {
    try {
      const settings = getAppSettings();
      const updatedSettings = { ...settings, cliPaths: paths };
      setAppSettings(updatedSettings);
      saveAppSettings(updatedSettings);

      // Also save to shared config file for MCP
      saveCLIPathsConfig(paths);

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}

/**
 * Get CLI paths config for use by other parts of the app
 */
export function getCLIPathsConfig(): CLIPaths & { fullPath: string } {
  const config = loadCLIPathsConfig();
  if (config) {
    return config as CLIPaths & { fullPath: string };
  }

  // Return defaults
  const defaultPaths = defaultCliDirs(os.homedir());

  return {
    amp: '',
    claude: '',
    codex: '',
    gemini: '',
    grok: '',
    qwencode: '',
    opencode: '',
    pi: '',
    kimi: '',
    gws: '',
    gcloud: '',
    gh: '',
    node: '',
    minimax: '',
    additionalPaths: [],
    fullPath: joinPathEntries([...new Set([...defaultPaths, ...processPathEntries()])], process.platform),
  };
}

/**
 * Get the full PATH string including configured and default paths
 */
export function getFullPath(): string {
  const config = getCLIPathsConfig();
  return config.fullPath;
}
