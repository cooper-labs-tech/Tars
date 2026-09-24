import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAllProviders } from '../providers';

/**
 * Get the path to the bundled hooks directory
 * @returns {string} The absolute path to the hooks directory
 */
export function getHooksPath(): string {
  let appPath = app.getAppPath();
  // If running from asar, use unpacked path
  if (appPath.includes('app.asar')) {
    appPath = appPath.replace('app.asar', 'app.asar.unpacked');
  }
  return path.join(appPath, 'hooks');
}

/**
 * Configure hooks for all providers that support them.
 * Each provider configures its own hooks via its configureHooks() method.
 */
export async function configureStatusHooks(): Promise<void> {
  try {
    const hooksDir = getHooksPath();

    if (!fs.existsSync(hooksDir)) {
      console.log('Hooks directory not found at', hooksDir);
      return;
    }

    // Delegate to each provider that supports native hooks
    for (const provider of getAllProviders()) {
      const hookConfig = provider.getHookConfig();
      if (hookConfig.supportsNativeHooks) {
        try {
          await provider.configureHooks(hooksDir);
        } catch (err) {
          console.error(`Failed to configure ${provider.displayName} hooks:`, err);
        }
      }
    }
  } catch (err) {
    console.error('Failed to configure status hooks:', err);
  }
}

/** Where the hooks of 1.7.9 and before wrote their logs: shared /tmp, readable by every user. */
export const LEGACY_HOOK_LOGS = ['/tmp/dorothy-hooks.log', '/tmp/dorothy-hooks-debug.log'];

/**
 * Remove the logs the hooks wrote in /tmp before 1.8.0 moved them to
 * ~/.dorothy/logs at 0600: about 4 MB of session ids and prompts' first words,
 * readable by any user of the machine (the Audit, gate of #135). Only regular
 * files this user owns, nothing followed, and only when HOME is the user's own:
 * a sandbox or a test would otherwise delete the logs a Tars on 1.7.9 writes.
 */
export function removeLegacyHookLogs(files = LEGACY_HOOK_LOGS): string[] {
  const removed: string[] = [];
  let ownHome: string;
  try {
    ownHome = os.userInfo().homedir;
  } catch {
    return removed;
  }
  if (path.resolve(os.homedir()) !== path.resolve(ownHome)) return removed;
  const uid = process.getuid?.();
  for (const file of files) {
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.uid !== uid) continue;
      fs.unlinkSync(file);
      removed.push(file);
    } catch {
      // Not there: the usual case once this has run.
    }
  }
  if (removed.length > 0) console.log(`[hooks] removed the logs of the old hooks: ${removed.join(', ')}`);
  return removed;
}
