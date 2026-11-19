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
  remoteBootstrap, remoteCommand, remoteEnvFile, remoteHookSettings, remoteLaunchLine, remoteMcpConfig, remotePort,
  remoteStartCommand, sshArgv, type RemoteFile, type RemoteHost,
} from '../core/remote-launch';
import type { AgentStatus } from '../types';

/**
 * Agents whose CLI runs on one of the owner's remote hosts (2.0.7, item 14, part B): what runs ssh for them. What is
 * handed to ssh and the host is built in core/remote-launch.ts.
 *
 * A remote agent is still one terminal of this Tars: spawnAgentSession asks remoteLaunchFor, and spawnAgentPty, the
 * one place an agent's terminal starts, runs remoteTerminal with the environment it composed. The terminal is
 * `/bin/sh -c`: ssh prepares the host from a file Tars wrote for it in ~/.tars-private (0600, removed at once, it holds
 * the agent's token), then ssh -tt starts the CLI in tmux there, the API reached back through a reverse tunnel on the
 * host's loopback. A stop ends the tmux session (endRemoteSession).
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

export interface RemoteLaunch {
  host: RemoteHost;
  agentId: string;
  folder: string;
  /** The tunnel's port on the host. */
  rport: number;
  /** The agent's MCP role file (services/mcp-roles.ts), read for Tars's servers on its API. */
  mcpConfigPath?: string;
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
  return { ok: true, launch: { host, agentId: agent.id, folder: agent.remote.folder, rport: remotePort(agent.id), mcpConfigPath: o.mcpConfigPath } };
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
  files.push({ path: `agents/${launch.agentId}/mcp.json`, content: remoteMcpConfig(roleFile, { apiPort: API_PORT, rport: launch.rport }) });
  return files;
}

/** What ssh itself gets of the agent's environment on this computer: what it needs to find the owner's keys, no token. */
const SSH_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSH_AUTH_SOCK'];

/**
 * The agent's terminal for a launch on its host: the program, its arguments and its environment, and the file that
 * prepares the host (removed by the terminal at once; forgetPrepFile when the terminal ended before it could).
 * `env` is the environment spawnAgentPty composed for the CLI: it goes to the host, never to ssh here.
 */
export function remoteTerminal(launch: RemoteLaunch, cliCommand: string, env: Record<string, string | undefined>): {
  shell: string; args: string[]; env: Record<string, string>; prepFile: string;
} {
  const prepFile = privatePath('remote-launch', `${launch.agentId}-${crypto.randomBytes(8).toString('hex')}.sh`);
  fs.mkdirSync(path.dirname(prepFile), { recursive: true, mode: 0o700 });
  writeSecretFileSync(prepFile, remoteBootstrap({ agentId: launch.agentId, folder: launch.folder, files: remoteFiles(launch), env: remoteEnvFile(env, { rport: launch.rport }) }));
  const ssh = (o: { tty: boolean; rport?: number; command: string }) => ['ssh', ...sshConfigArgs(), ...sshArgv(launch.host, { apiPort: API_PORT, ...o })];
  const line = remoteLaunchLine({
    prepare: ssh({ tty: false, command: 'sh -s' }),
    prepFile,
    terminal: ssh({ tty: true, rport: launch.rport, command: remoteStartCommand({ agentId: launch.agentId, folder: launch.folder, cliCommand }) }),
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
 * End the agent's tmux session on its host (a stop, a removal): its CLI and what runs under it. Resolves whether ssh
 * said so; never throws, and gives up after 20 s.
 */
export function endRemoteSession(agent: Pick<AgentStatus, 'id' | 'remote'>): Promise<boolean> {
  const host = agent.remote ? remoteHosts().get(agent.remote.hostId) : undefined;
  if (!host) return Promise.resolve(false);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('ssh', [...sshConfigArgs(), ...sshArgv(host, { apiPort: API_PORT, tty: false, command: remoteCommand('stop', [agent.id]) })], { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 20_000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}
