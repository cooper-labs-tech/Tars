import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { API_PORT, privatePath } from '../constants';
import { remoteHosts } from './remote-hosts';
import { getHooksPath } from '../utils/hooks-path';
import { writeSecretFileSync } from '../utils/secret-file';
import { CLAUDE_HOOK_FILES } from '../providers/claude-hook-files';
import {
  PORT_MARK, remoteBootstrap, remoteCommand, remoteEnvFile, remoteHookSettings, remoteLaunchLine, remoteMcpConfig,
  remotePort, remoteStartCommand, sshArgv, type AgentRemote, type RemoteFile, type RemoteHost,
} from '../core/remote-launch';
import type { AgentStatus } from '../types';

/**
 * Agents whose CLI runs on one of the owner's remote hosts (2.0.7, item 14, part B): what runs ssh for them. What is
 * handed to ssh and the host is built in core/remote-launch.ts.
 *
 * A remote agent is still one terminal of this Tars: spawnAgentSession asks remoteLaunchFor, and spawnAgentPty, the
 * one place an agent's terminal starts, runs remoteTerminal with the environment it composed. The terminal is
 * `/bin/sh -c`: ssh prepares the host from a file Tars wrote for it in ~/.tars-private (0600, removed at once, it holds
 * the agent's token), the host choosing a free port for the tunnel among the agent's; then ssh -tt starts the CLI in
 * tmux there, Tars reached back through a reverse tunnel from the host's loopback to the tunnel's own listener here
 * (api-server.ts), which answers nothing without the token of an agent placed on a host. A stop, a removal and a change
 * of place end the tmux session (endRemoteSession).
 *
 * Not in this part (reports/remote-agents/PLAN.md): re-attaching after a dropped connection with the token kept and the
 * hooks' spool, the worktree on the host, the readers of the CLI's own files there, the window's views.
 */

/**
 * Test runs only, never a packaged build: the ssh config of the sandbox's home. ssh takes its home from the password
 * database, not from HOME, so a sandboxed Tars would otherwise read the owner's own ~/.ssh/config.
 */
export function sshConfigArgs(): string[] {
  const file = process.env.DOROTHY_E2E_SSH_CONFIG;
  return process.env.DOROTHY_E2E === '1' && app?.isPackaged !== true && file ? ['-F', file] : [];
}

/** How many ports the host is offered for an agent's tunnel, in its own order (the Audit's L4 on #600). */
const PORT_CANDIDATES = 6;

export interface RemoteLaunch {
  host: RemoteHost;
  agentId: string;
  folder: string;
  /** The tunnel's candidate ports on the host: it takes the first nothing listens on. */
  ports: number[];
  /** The agent's MCP role file (services/mcp-roles.ts), read for Tars's servers on its API. */
  mcpConfigPath?: string;
  /** The port of the tunnel's own listener on this computer (api-tunnel.ts), which the tunnel reaches. */
  apiPort?: number;
}

export type RemoteLaunchAsk = { ok: true; launch: RemoteLaunch } | { ok: false; status: number; code: string; error: string };

/**
 * Where an agent's next CLI runs: undefined on this computer; else the launch on its host, or why it cannot be one.
 * Only a worker runs elsewhere (an orchestrator and a chat's runner keep their instructions and tools here), only Claude
 * Code (its hooks and MCP servers are handed per launch, claude-provider.ts), and only from macOS or Linux.
 */
export function remoteLaunchFor(
  agent: Pick<AgentStatus, 'id' | 'name' | 'remote'>,
  o: { providerId: string; leads: boolean; mcpConfigPath?: string; platform?: NodeJS.Platform },
): RemoteLaunchAsk | undefined {
  if (!agent.remote) return undefined;
  const who = agent.name || agent.id;
  const host = remoteHosts().get(agent.remote.hostId);
  if (!host) {
    return { ok: false, status: 409, code: 'remote_host_gone', error: `${who} is placed on a remote host the owner no longer has (${agent.remote.hostId}): place it again, or bring it back to this computer (update_agent with remote null).` };
  }
  if ((o.platform ?? process.platform) === 'win32') {
    return { ok: false, status: 409, code: 'remote_platform', error: `${who} runs on ${host.name}, which Tars reaches from macOS or Linux only in this version.` };
  }
  if (o.providerId !== 'claude') {
    return { ok: false, status: 409, code: 'remote_cli', error: `${who} runs on ${host.name}: only Claude Code runs on a remote host in this version, not a provider of another CLI or one that re-points its binary.` };
  }
  if (o.leads) {
    return { ok: false, status: 409, code: 'remote_lead', error: `${who} has an orchestrator's powers: an orchestrator and a chat's runner run on this computer, only a worker on a remote host.` };
  }
  const ports = [...new Set(Array.from({ length: PORT_CANDIDATES }, (_, i) => remotePort(agent.id, i)))];
  return { ok: true, launch: { host, agentId: agent.id, folder: agent.remote.folder, ports, mcpConfigPath: o.mcpConfigPath } };
}

/** The wrapper this build ships (electron/resources/tars-remote.sh). */
function wrapperPath(): string {
  return path.join(__dirname, '..', '..', 'resources', 'tars-remote.sh').replace('app.asar', 'app.asar.unpacked');
}

/** What a launch puts on the host: the wrapper, Tars's hook scripts and what they source, the agent's two files. */
function remoteFiles(launch: RemoteLaunch): RemoteFile[] {
  const files: RemoteFile[] = [{ path: 'bin/tars-remote', content: fs.readFileSync(wrapperPath(), 'utf8'), executable: true }];
  const hooks = getHooksPath();
  for (const name of new Set(['tars-hook.sh', ...CLAUDE_HOOK_FILES.map((h) => h.file)])) {
    const file = path.join(hooks, name);
    if (fs.existsSync(file)) files.push({ path: `hooks/${name}`, content: fs.readFileSync(file, 'utf8'), executable: true });
  }
  let roleFile: string | undefined;
  try {
    roleFile = launch.mcpConfigPath ? fs.readFileSync(launch.mcpConfigPath, 'utf8') : undefined;
  } catch {
    roleFile = undefined;
  }
  files.push({ path: `agents/${launch.agentId}/settings.json`, content: remoteHookSettings(CLAUDE_HOOK_FILES) });
  // The MCP file with PORT_MARK: the wrapper writes mcp.json from it once the tunnel's port is known.
  files.push({ path: `agents/${launch.agentId}/mcp.tmpl`, content: remoteMcpConfig(roleFile, { apiPort: API_PORT }) });
  return files;
}

/** What ssh itself gets of the agent's environment on this computer: what it needs to find the owner's keys, no token. */
const SSH_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSH_AUTH_SOCK'];

/** Where the files that prepare a host wait, each for the moment its launch takes. */
export const PREP_DIR = () => privatePath('remote-launch');

/**
 * The agent's terminal for a launch on its host: the program, its arguments and its environment, and the file that
 * prepares the host (removed by the terminal at once; forgetPrepFile when the terminal ended before it could).
 * `env` is the environment spawnAgentPty composed for the CLI: it goes to the host, never to ssh here.
 */
export function remoteTerminal(launch: RemoteLaunch, cliCommand: string, env: Record<string, string | undefined>): {
  shell: string; args: string[]; env: Record<string, string>; prepFile: string;
} {
  if (launch.apiPort === undefined) throw new Error('the tunnel has no listener to reach on this computer');
  const apiPort = launch.apiPort;
  const prepFile = path.join(PREP_DIR(), `${launch.agentId}-${crypto.randomBytes(8).toString('hex')}.sh`);
  fs.mkdirSync(PREP_DIR(), { recursive: true, mode: 0o700 });
  writeSecretFileSync(prepFile, remoteBootstrap({
    agentId: launch.agentId, folder: launch.folder, files: remoteFiles(launch), env: remoteEnvFile(env), ports: launch.ports,
  }));
  const ssh = (o: { tty: boolean; rport?: string; command: string }) => ['ssh', ...sshConfigArgs(), ...sshArgv(launch.host, { apiPort, ...o })];
  const line = remoteLaunchLine({
    prepare: ssh({ tty: false, command: 'sh -s' }),
    prepFile,
    terminal: ssh({ tty: true, rport: PORT_MARK, command: remoteStartCommand({ agentId: launch.agentId, folder: launch.folder, cliCommand }) }),
  });
  const sshEnv: Record<string, string> = {};
  for (const key of SSH_ENV_KEYS) if (env[key] !== undefined) sshEnv[key] = env[key] as string;
  return { shell: '/bin/sh', args: ['-c', line], env: sshEnv, prepFile };
}

/** The prepare file of a terminal that ended before removing it. */
export function forgetPrepFile(file: string): void {
  try { fs.rmSync(file, { force: true }); } catch { /* gone */ }
}

/**
 * At Tars's start (the Audit's I-e on #600): the files that prepare a host left by a Tars that died between writing one
 * and its terminal's start. No launch is under way yet, and the token each holds died with that Tars. How many went.
 */
export function sweepPrepFiles(): number {
  let names: string[];
  try {
    names = fs.readdirSync(PREP_DIR());
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    try {
      fs.rmSync(path.join(PREP_DIR(), name), { force: true });
      removed++;
    } catch { /* left for the next start */ }
  }
  return removed;
}

/** What ending a session on a host came to: ended, or why not, in ssh's words when it was ssh. */
export type RemoteEnd = { ended: true; host: string } | { ended: false; host?: string; why: string };

/**
 * End the agent's tmux session on a host (a stop, a removal, a change of place): its CLI and what runs under it.
 * `place` is the place to end, the agent's own by default; a change of place passes the former one. Never throws; gives
 * up after 20 s.
 */
export function endRemoteSession(agent: Pick<AgentStatus, 'id' | 'remote'>, place: AgentRemote | undefined = agent.remote): Promise<RemoteEnd> {
  if (!place) return Promise.resolve({ ended: false, why: 'it is placed on no remote host' });
  const host = remoteHosts().get(place.hostId);
  if (!host) return Promise.resolve({ ended: false, why: `its host (${place.hostId}) is no longer one of the owner's hosts` });
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('ssh', [...sshConfigArgs(), ...sshArgv(host, { apiPort: API_PORT, tty: false, command: remoteCommand('stop', [agent.id]) })], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      resolve({ ended: false, host: host.name, why: `ssh could not start: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    let said = '';
    child.stderr?.on('data', (d) => { said = (said + String(d)).slice(-400); });
    const words = () => said.trim().split('\n').filter(Boolean).pop() ?? '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ended: false, host: host.name, why: 'the host did not answer in 20 s' });
    }, 20_000);
    child.on('error', (err) => { clearTimeout(timer); resolve({ ended: false, host: host.name, why: `ssh could not start: ${err.message}` }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ended: true, host: host.name } : { ended: false, host: host.name, why: words() || `ssh ended with ${code}` });
    });
  });
}

/**
 * Whether the tunnel's own listener takes a call (the Audit's gate of #600): only from an agent placed on a host, by
 * its own token, on every route, /api/health and /api/local-file included. Never the shared token, Tars's own pass,
 * a Hermes gateway's secret, an agent of this computer, or no token at all.
 */
export function tunnelAdmits(
  caller: { ok: boolean; agentId?: string },
  agentOf: (id: string) => { remote?: unknown } | undefined,
): boolean {
  if (!caller.ok || !caller.agentId) return false;
  return !!agentOf(caller.agentId)?.remote;
}
