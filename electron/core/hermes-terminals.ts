import * as path from 'path';
import { endpointAgentOf, endpointLaunchForAgent } from '../services/traces-runtime';
import {
  HERMES_WORKER_POLICY, findHermesGateway, hermesProfileDir, hermesRoleRefusal, hermesRoot, removeHermesSecrets, stopHermesGateway,
  sweepHermesSecrets, writeHermesProfile, type HermesWorkerPolicy,
} from '../services/hermes-home';
import { hermesMcpServers } from '../providers/hermes-provider';
import { getProvider } from '../providers';
import { readAppSettingsFromDisk } from '../providers/cli-provider';
import { ORCHESTRATOR_ONLY_MCP } from '../services/mcp-roles';
import { TARS_MCP_ENV } from '../services/mcp-orchestrator-env';
import { hermesTurnWatch } from '../services/hermes-agent-turns';
import { buildFullPath } from '../utils/path-builder';
import { hasOrchestratorPowers } from './agent-role';
import { HermesGatewaySupervisor, awaitGatewayTelling, commandOf, homeOf, startHermesGatewayProcess, startedAt, stopTarsHermesGatewayPid } from './hermes-gateway';
import * as fs from 'fs';
import type { AppSettings } from '../types';

/**
 * The Hermes agents' terminals (services/hermes-home.ts says why each is a profile with a `.env`):
 * - at the spawn of a Hermes agent's terminal, shell or CLI (core/agent-pty.ts), its profile is written: the endpoint,
 *   its approvals, Tars's MCP servers for its role with their non-secret values, and the `.env` with this terminal's
 *   two tokens;
 * - at its exit, the `.env` goes, unless a newer terminal of the same agent wrote its own since (a restart spawns the
 *   new terminal before the old one's exit is heard);
 * - at the first of them, Tars starts the gateway every Hermes agent shares, with no agent's identity
 *   (core/hermes-gateway.ts), and each terminal's chat waits until it holds its home (hermesGatewayReady);
 * - when no Hermes terminal is left, and at quit, Tars's Hermes gateway is stopped by its pid, checked first;
 * - at Tars's start, every profile's `.env` is swept (no terminal survives a quit) and a gateway a previous run left
 *   is stopped.
 */

/** The agents with a Hermes terminal open, and the endpoint token of the terminal whose `.env` is on disk. */
const live = new Map<string, string>();

const gatewayChecks = { commandOf, homeOf, startedAt };
const gateway = new HermesGatewaySupervisor({
  find: () => findHermesGateway(hermesRoot(), gatewayChecks),
  recorded: () => {
    try {
      const pid = (JSON.parse(fs.readFileSync(path.join(hermesRoot(), 'gateway.pid'), 'utf8')) as { pid?: unknown }).pid;
      return typeof pid === 'number' ? pid : null;
    } catch {
      return null;
    }
  },
  start: (binary) => startHermesGatewayProcess(binary, { root: hermesRoot(), path: buildFullPath() }),
  terminals: () => live.size,
});

/** The Hermes binary an agent's chat runs: its own, else the one the settings name (agent-routes.ts does the same). */
function hermesBinaryOf(agentId: string): string {
  return endpointAgentOf(agentId)?.cliPath || getProvider('hermes').resolveBinaryPath(readAppSettingsFromDisk() as AppSettings);
}

/** How long a Hermes chat waits for the gateway to hold its home: its first start syncs Hermes's packages first. */
const GATEWAY_READY_MS = 15 * 60_000;

/**
 * Before a Hermes agent's chat starts (core/agent-manager.ts, launchIntoTerminal): the gateway Tars started holds its
 * home, so the chat attaches to it rather than start one with its terminal's environment. True when it does; false at
 * the timeout, or when nothing of Tars's is starting (the chat then starts its own, as Hermes does). `say` puts a
 * line in the agent's terminal when the wait lasts longer than a moment.
 */
export function hermesGatewayReady(say?: (line: string) => void, timeoutMs: number = GATEWAY_READY_MS): Promise<boolean> {
  const ready = gateway.ready(timeoutMs);
  return say ? awaitGatewayTelling(ready, say) : ready;
}

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
  void gateway.ensure(hermesBinaryOf(agentId)).catch(err => console.error(`[hermes] the gateway was not started: ${(err as Error).message}`));
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

/**
 * Tars's Hermes gateway, by the pid its record names, once checked (services/hermes-home.ts, stopHermesGateway): the
 * one Tars started, or one a chat started when Tars's was gone. Its exit is not one Tars starts it again after.
 */
export async function stopTarsHermesGateway(): Promise<void> {
  gateway.stopping();
  try {
    const outcome = await stopHermesGateway(hermesRoot(), { ...gatewayChecks, stop: stopTarsHermesGatewayPid });
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
