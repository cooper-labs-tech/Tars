import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { buildFullPath } from '../utils/path-builder';
import type { AppSettings } from '../types';
import { joinPathEntries, withPath } from '../platform';
import {
  CliNotRunnableError, findWindowsCli, stdioServerCommand, windowsCliDirs, windowsGcloudDirs, type CliLookup,
} from '../providers/cli-exec';
import { probeCli } from '../core/cli-probe';

const execAsync = promisify(exec);

/**
 * gws or gcloud on Windows: looked up in Node, PATHEXT and all, where Windows
 * installs them and then along the PATH, never through `which` (there is none)
 * nor as the extensionless sh shim npm writes beside gws.cmd. gcloud is the
 * Cloud SDK's gcloud.cmd, which gws starts, not Tars: it only has to be there.
 */
function findOnWindows(name: string, dirs: string[], lookup: CliLookup): string {
  const found = findWindowsCli(name, dirs, process.env, lookup);
  for (const r of found.rejected) console.warn(`[gws] ${name}: ${r.path ?? r.name} not used (${r.reason}): ${r.detail}`);
  return found.path ?? '';
}

// Scope patterns → friendly service names
const SCOPE_SERVICE_MAP: Record<string, string> = {
  gmail: 'gmail',
  drive: 'drive',
  spreadsheets: 'sheets',
  calendar: 'calendar',
  documents: 'docs',
  presentations: 'slides',
  tasks: 'tasks',
  chat: 'chat',
  contacts: 'people',
  people: 'people',
  forms: 'forms',
  keep: 'keep',
};

export type ServiceAccess = 'none' | 'read' | 'write';

export interface GwsAuthStatus {
  authenticated: boolean;
  user: string | null;
  tokenValid: boolean;
  scopes: string[];
  authMethod: string;
  services: Record<string, ServiceAccess>;
}

export interface GwsHandlerDependencies {
  getAppSettings: () => AppSettings;
  setAppSettings: (settings: AppSettings) => void;
  saveAppSettings: (settings: AppSettings) => void;
}

function deriveServicesFromScopes(scopes: string[]): Record<string, ServiceAccess> {
  const services: Record<string, ServiceAccess> = {
    gmail: 'none',
    drive: 'none',
    sheets: 'none',
    calendar: 'none',
    docs: 'none',
    slides: 'none',
    tasks: 'none',
    chat: 'none',
    people: 'none',
    forms: 'none',
    keep: 'none',
  };

  for (const scope of scopes) {
    const lower = scope.toLowerCase();
    const isReadonly = lower.includes('readonly');
    for (const [pattern, serviceName] of Object.entries(SCOPE_SERVICE_MAP)) {
      if (lower.includes(pattern)) {
        // Write access upgrades read; never downgrade write to read
        if (services[serviceName] === 'none') {
          services[serviceName] = isReadonly ? 'read' : 'write';
        } else if (services[serviceName] === 'read' && !isReadonly) {
          services[serviceName] = 'write';
        }
      }
    }
  }

  return services;
}

async function findGwsBinary(): Promise<string> {
  if (process.platform === 'win32') return findOnWindows('gws', windowsCliDirs(process.env), 'startable');
  const homeDir = os.homedir();
  const commonPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(homeDir, '.local/bin'),
  ];

  // Add nvm paths
  const nvmDir = path.join(homeDir, '.nvm/versions/node');
  if (fs.existsSync(nvmDir)) {
    try {
      const versions = fs.readdirSync(nvmDir);
      for (const version of versions) {
        commonPaths.push(path.join(nvmDir, version, 'bin'));
      }
    } catch {
      // Ignore
    }
  }

  for (const dir of commonPaths) {
    const gwsPath = path.join(dir, 'gws');
    if (fs.existsSync(gwsPath)) {
      return gwsPath;
    }
  }

  try {
    const { stdout } = await execAsync('which gws', {
      env: { ...process.env, PATH: `${commonPaths.join(':')}:${process.env.PATH}` },
    });
    if (stdout.trim()) return stdout.trim();
  } catch {
    // Ignore
  }

  return '';
}

async function findGcloudBinary(): Promise<string> {
  if (process.platform === 'win32') {
    return findOnWindows('gcloud', [...windowsGcloudDirs(process.env), ...windowsCliDirs(process.env)], 'present');
  }
  const homeDir = os.homedir();
  const commonPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(homeDir, '.local/bin'),
    // Homebrew google-cloud-sdk puts gcloud here
    '/opt/homebrew/share/google-cloud-sdk/bin',
    '/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin',
    path.join(homeDir, 'google-cloud-sdk/bin'),
  ];

  for (const dir of commonPaths) {
    const gcloudPath = path.join(dir, 'gcloud');
    if (fs.existsSync(gcloudPath)) {
      return gcloudPath;
    }
  }

  try {
    const fullPath = buildFullPath();
    const { stdout } = await execAsync('which gcloud', {
      env: { ...process.env, PATH: `${commonPaths.join(':')}:${fullPath}` },
    });
    if (stdout.trim()) return stdout.trim();
  } catch {
    // Ignore
  }

  return '';
}

export function registerGwsHandlers(deps: GwsHandlerDependencies): void {
  const { getAppSettings, setAppSettings, saveAppSettings } = deps;

  // Detect gws binary
  ipcMain.handle('gws:detect', async () => {
    return findGwsBinary();
  });

  // Detect gcloud binary
  ipcMain.handle('gws:detectGcloud', async () => {
    return findGcloudBinary();
  });

  // Get auth status from gws CLI
  ipcMain.handle('gws:authStatus', async () => {
    const result: GwsAuthStatus = {
      authenticated: false,
      user: null,
      tokenValid: false,
      scopes: [],
      authMethod: 'none',
      services: deriveServicesFromScopes([]),
    };

    try {
      const gwsPath = await findGwsBinary();
      if (!gwsPath) return result;

      // Include gcloud's directory in PATH so gws can find it
      const gcloudPath = await findGcloudBinary();
      const gcloudDir = gcloudPath ? path.dirname(gcloudPath) : '';
      const fullPath = joinPathEntries([gcloudDir, buildFullPath()].filter(Boolean), process.platform);

      const env = withPath(process.env, fullPath, process.platform) as NodeJS.ProcessEnv;

      // An argv on every system, never a line for a shell, which would read a
      // `"`, `&`, `$(...)` or %VAR% in the path: probeCli resolves an npm
      // gws.cmd to node and its script on Windows. A CLI probe
      // (core/cli-probe.ts): ended with what it started at its time and at
      // the quit (the Audit's P3 on probe orphans).
      const { stdout } = await probeCli(gwsPath, ['auth', 'status', '--json'], { env, timeoutMs: 10000 });

      const data = JSON.parse(stdout.trim());
      // Real gws auth status output:
      // { user, token_valid, has_refresh_token, auth_method, scopes, scope_count, ... }
      result.authenticated = data.authenticated ?? data.has_refresh_token ?? data.token_valid ?? (data.status === 'success');
      result.user = data.user ?? data.account ?? data.email ?? null;
      result.tokenValid = data.token_valid ?? data.tokenValid ?? result.authenticated;
      result.scopes = data.scopes ?? [];
      result.authMethod = data.auth_method ?? data.authMethod ?? (result.authenticated ? 'oauth2' : 'none');
      result.services = deriveServicesFromScopes(result.scopes);
    } catch (err) {
      // gws auth status failed (not signed in, output not JSON). Return
      // defaults; a gws that cannot even be started is said.
      if (err instanceof CliNotRunnableError) console.warn(`[gws] auth status not run: ${err.message}`);
    }

    return result;
  });

  // Register gws as MCP server with all providers
  // gws mcp -s <services> starts an MCP server over stdio
  // Each service adds 10-80 tools; keep under client tool limits (~50-100)
  const DEFAULT_MCP_SERVICES = 'drive,gmail,calendar,sheets,docs';

  ipcMain.handle('gws:setup', async (_event, services?: string) => {
    try {
      const gwsPath = await findGwsBinary();
      if (!gwsPath) {
        return { success: false, error: 'gws binary not found. Install it first.' };
      }

      const svc = services || DEFAULT_MCP_SERVICES;
      const { getAllProviders } = await import('../providers');
      const providers = getAllProviders();
      // What each CLI will start: on Windows an npm gws.cmd, which no CLI's
      // spawn can start, is written as node.exe and its script.
      const server = stdioServerCommand(gwsPath, ['mcp', '-s', svc]);
      if (server.unresolved) console.warn(`[gws] ${gwsPath} not resolved (${server.unresolved.reason}): ${server.unresolved.detail}`);

      for (const provider of providers) {
        try {
          await provider.registerMcpServer('google-workspace', server.command, server.args);
        } catch (err) {
          console.error(`[${provider.id}] Failed to register gws MCP:`, err);
        }
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Remove gws MCP from all providers
  ipcMain.handle('gws:remove', async () => {
    try {
      const { getAllProviders } = await import('../providers');
      const providers = getAllProviders();

      for (const provider of providers) {
        try {
          await provider.removeMcpServer('google-workspace');
        } catch (err) {
          console.error(`[${provider.id}] Failed to remove gws MCP:`, err);
        }
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Check if gws MCP is registered with at least one provider
  ipcMain.handle('gws:getMcpStatus', async () => {
    try {
      const gwsPath = await findGwsBinary();
      const { getAllProviders } = await import('../providers');
      const providers = getAllProviders();
      // Asked for what gws:setup wrote: on Windows the script (or the exe) an
      // npm gws.cmd starts, not the .cmd. darwin/linux: the path found.
      const server = stdioServerCommand(gwsPath || '', []);
      const registeredAs = server.args[0] ?? server.command;

      let configured = false;
      for (const provider of providers) {
        try {
          if (provider.isMcpServerRegistered('google-workspace', registeredAs)) {
            configured = true;
            break;
          }
        } catch {
          // Skip provider on error
        }
      }

      return { configured };
    } catch (err) {
      return { configured: false, error: String(err) };
    }
  });

  // List installed gws skills across all providers
  ipcMain.handle('gws:listSkills', async () => {
    try {
      const { getAllProviders } = await import('../providers');
      const providers = getAllProviders();

      const skills = new Set<string>();
      for (const provider of providers) {
        try {
          for (const skill of provider.getInstalledSkills()) {
            if (skill.startsWith('gws-')) {
              skills.add(skill);
            }
          }
        } catch {
          // Skip provider on error
        }
      }

      return Array.from(skills).sort();
    } catch {
      return [];
    }
  });
}
