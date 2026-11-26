import * as path from 'path';
import { DATA_DIR } from '../constants';
import { writeSharedJsonSync } from '../utils/shared-file';
import { administratorSettings, underAdministrator } from './qwen-code';

/**
 * The system settings of every gemini Tars starts: its own update flow off (27/11).
 *
 * Read in gemini-cli 0.71.1's published code: at start it checks npm for a newer version when
 * `general.enableAutoUpdateNotification` is on, and when `general.enableAutoUpdate` is on too it runs its update
 * command itself (`npm install -g @google/gemini-cli@<version>`, detached, through a shell), into the user's own npm
 * prefix, from a terminal Tars started. Both default to true, and gemini reads no environment variable for either:
 * only its settings. So Tars hands it a system settings file of its own, through GEMINI_CLI_SYSTEM_SETTINGS_PATH
 * (gemini's getSystemSettingsPath), and never writes the user's ~/.gemini/settings.json for it.
 *
 * That variable names gemini's system slot, where an administrator's file goes, and the system scope wins over the
 * user's and the project's. As for Qwen Code (qwen-code.ts writeQwenAgentSettings): the administrator's file, read
 * again at each launch, goes over Tars's, their keys winning; one that cannot be read stops the agent from starting,
 * and says why.
 */
const TARS_GEMINI_SETTINGS = { general: { enableAutoUpdate: false, enableAutoUpdateNotification: false } };

/** Tars's file, the one GEMINI_CLI_SYSTEM_SETTINGS_PATH names for an agent's gemini. */
export function geminiSystemSettingsFile(dataDir = DATA_DIR): string {
  return path.join(dataDir, 'gemini', 'system-settings.json');
}

/**
 * Where an administrator's gemini system settings are: the file GEMINI_CLI_SYSTEM_SETTINGS_PATH names in the
 * environment Tars was started with, unless it is Tars's own (a Tars started from a gemini agent's terminal inherits
 * it), else gemini's own default for the platform (0.71.1's getSystemSettingsPath).
 */
export function geminiAdministratorFile(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, dataDir?: string): string {
  const named = env.GEMINI_CLI_SYSTEM_SETTINGS_PATH?.trim();
  if (named && path.resolve(named) !== path.resolve(geminiSystemSettingsFile(dataDir))) return named;
  if (platform === 'darwin') return '/Library/Application Support/GeminiCli/settings.json';
  if (platform === 'win32') return 'C:\\ProgramData\\gemini-cli\\settings.json';
  return '/etc/gemini-cli/settings.json';
}

/** Writes Tars's file, the administrator's settings over it, and returns its path. Throws when theirs cannot be read. */
export function writeGeminiSystemSettings(opts: { adminFile?: string; dataDir?: string } = {}): string {
  const file = geminiSystemSettingsFile(opts.dataDir);
  const admin = administratorSettings(opts.adminFile ?? geminiAdministratorFile(process.platform, process.env, opts.dataDir), 'Gemini CLI');
  writeSharedJsonSync(file, admin ? underAdministrator(TARS_GEMINI_SETTINGS, admin) : TARS_GEMINI_SETTINGS);
  return file;
}
