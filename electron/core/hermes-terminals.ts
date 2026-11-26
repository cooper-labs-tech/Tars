import { execFile } from 'child_process';
import * as path from 'path';
import { endpointAgentOf, endpointLaunchForAgent } from '../services/traces-runtime';
import * as fs from 'fs';
import {
  HERMES_WORKER_POLICY, hermesProfileDir, hermesRoleRefusal, hermesRoot, removeHermesSecrets, stopHermesGateway, sweepHermesSecrets,
  writeHermesProfile, type HermesWorkerPolicy,
} from '../services/hermes-home';
import { hermesMcpServers } from '../providers/hermes-provider';
import { ORCHESTRATOR_ONLY_MCP } from '../services/mcp-roles';
import { TARS_MCP_ENV } from '../services/mcp-orchestrator-env';
import { hermesTurnWatch } from '../services/hermes-agent-turns';
import { hasOrchestratorPowers } from './agent-role';
import { envValue, killTree } from '../platform';

/**
 * The Hermes agents' terminals (services/hermes-home.ts says why each is a profile with a `.env`):
 * - at the spawn of a Hermes agent's terminal, shell or CLI (core/agent-pty.ts), its profile is written: the endpoint,
 *   its approvals, Tars's MCP servers for its role with their non-secret values, and the `.env` with this terminal's
 *   two tokens;
 * - at its exit, the `.env` goes, unless a newer terminal of the same agent wrote its own since (a restart spawns the
 *   new terminal before the old one's exit is heard);
 * - when no Hermes terminal is left, and at quit, Tars's Hermes gateway is stopped by its pid, checked first;
 * - at Tars's start, every profile's `.env` is swept (no terminal survives a quit) and a gateway a previous run left
 *   is stopped.
 */

/** The agents with a Hermes terminal open, and the endpoint token of the terminal whose `.env` is on disk. */
const live = new Map<string, string>();

/** The variables of Tars's MCP servers that are not secrets, as the terminal's environment holds them. */
const NOT_SECRET = TARS_MCP_ENV.filter(v => v !== 'CLAUDE_MGR_API_TOKEN');

export function openHermesTerminal(
  agentId: string,
  o: { apiToken?: string; endpointToken?: string; env: Record<string, string | undefined> },
  policy: HermesWorkerPolicy = HERMES_WORKER_POLICY,
): void {
  const endpoint = endpointLaunchForAgent(agentId, 'hermes')?.profile;
  if (!endpoint || !o.endpointToken) throw new Error('A Hermes agent runs on an inference endpoint: choose one, and one of its models, in the agent\'s settings.');
  if (!o.apiToken) throw new Error('A Hermes agent\'s terminal has no token of its own.');
  const agent = endpointAgentOf(agentId);
  const orchestrator = !!agent && hasOrchestratorPowers(agent);
  // The owner's choice for workers (SECURITY.md § 10), before anything is written.
  const refusal = hermesRoleRefusal(orchestrator, policy);
  if (refusal) throw new Error(refusal);
  const servers = Object.fromEntries(Object.entries(hermesMcpServers()).filter(([name]) => orchestrator || !ORCHESTRATOR_ONLY_MCP.includes(name)));
  const values: Record<string, string> = {};
  for (const name of NOT_SECRET) {
    const value = o.env[name];
    if (value) values[name] = value;
  }
  writeHermesProfile(hermesRoot(), agentId, {
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
    permissionMode: agent?.permissionMode,
    mcpServers: servers,
    mcpValues: values,
  }, { OPENAI_BASE_URL: endpoint.baseUrl, OPENAI_API_KEY: o.endpointToken, CLAUDE_MGR_API_TOKEN: o.apiToken });
  live.set(agentId, o.endpointToken);
  hermesTurnWatch.noteLaunch(agentId);
}

/** At the terminal's exit. `endpointToken` names the terminal: an older one's exit leaves a newer one's `.env`. */
export function closeHermesTerminal(agentId: string, endpointToken: string | undefined): void {
  if (!endpointToken || live.get(agentId) !== endpointToken) return;
  live.delete(agentId);
  hermesTurnWatch.forget(agentId);
  try {
    removeHermesSecrets(hermesRoot(), agentId);
  } catch (err) {
    console.error(`[hermes] the .env of ${agentId} was not removed: ${(err as Error).message}`);
  }
  if (live.size === 0) void stopTarsHermesGateway();
}

/** At Tars's start, before any terminal: the `.env` a crash left, and the gateway. */
export async function sweepHermesAtStart(): Promise<void> {
  try {
    const swept = sweepHermesSecrets(hermesRoot(), id => live.has(id));
    if (swept.length) console.log(`[hermes] removed the .env of ${swept.length} profile(s) a previous run left`);
  } catch (err) {
    console.error(`[hermes] the profiles' .env were not swept: ${(err as Error).message}`);
  }
  if (live.size === 0) await stopTarsHermesGateway();
}

/** At quit, once the terminals have ended: no `.env` outlives Tars, nor the gateway its terminals shared. */
export async function endHermesOnQuit(): Promise<void> {
  live.clear();
  await sweepHermesAtStart();
}

/** The command line under a pid: /bin/ps on macOS and Linux, Win32_Process on Windows; null when none. */
function commandOf(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const root = envValue(process.env, 'SystemRoot', 'win32') || 'C:\\Windows';
      const powershell = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`;
      execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000 }, (err, out) => resolve(err ? null : (String(out).trim() || null)));
    } else {
      execFile('/bin/ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5_000, env: { ...process.env, LC_ALL: 'C' } }, (err, out) => resolve(err ? null : (String(out).trim() || null)));
    }
  });
}

/**
 * The HERMES_HOME of a process's own environment (macOS and Linux), null when it has none or it cannot be read:
 * Linux /proc/<pid>/environ, exact; macOS `/bin/ps -E`, which prints the command and then the environment, readable
 * for a same-user process that is no platform binary (SECURITY.md § 3 and § 10), the last HERMES_HOME= being the
 * environment's.
 */
function homeOf(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    return fs.promises.readFile(`/proc/${pid}/environ`, 'utf8')
      .then(text => text.split('\0').find(v => v.startsWith('HERMES_HOME='))?.slice('HERMES_HOME='.length) || null)
      .catch(() => null);
  }
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, out) => {
      if (err) return resolve(null);
      const found = [...String(out).matchAll(/ HERMES_HOME=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|\n|$)/g)];
      resolve(found.length ? found[found.length - 1][1] : null);
    });
  });
}

/** When a process started (Windows, Win32_Process.CreationDate), null when it cannot be read. */
function startedAt(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    const root = envValue(process.env, 'SystemRoot', 'win32') || 'C:\\Windows';
    const powershell = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToUniversalTime().ToString('o')`;
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000 }, (err, out) => {
      const at = err ? NaN : Date.parse(String(out).trim());
      resolve(Number.isFinite(at) ? at : null);
    });
  });
}

/** Tars's Hermes gateway, by the pid its record names, once checked (services/hermes-home.ts, stopHermesGateway). */
export async function stopTarsHermesGateway(): Promise<void> {
  try {
    const outcome = await stopHermesGateway(hermesRoot(), {
      commandOf,
      homeOf,
      startedAt,
      stop: async (pid) => {
        if (process.platform === 'win32') await killTree(pid);
        else process.kill(pid, 'SIGTERM');
      },
    });
    if (outcome === 'stopped') console.log('[hermes] stopped the gateway of Tars\'s Hermes home');
    else if (outcome !== 'none') console.warn(`[hermes] the gateway record of Tars's Hermes home was left alone: ${outcome}`);
  } catch (err) {
    console.error(`[hermes] the gateway was not stopped: ${(err as Error).message}`);
  }
}

/** Where a Hermes agent's sessions are read (services/hermes-agent-turns.ts). */
export function hermesStateDbOf(agentId: string): string {
  return path.join(hermesProfileDir(hermesRoot(), agentId), 'state.db');
}
