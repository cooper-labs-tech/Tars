import * as crypto from 'crypto';

/**
 * An agent whose CLI runs on a remote Linux host over ssh (2.0.7, item 14; reports/remote-agents/PLAN.md): what Tars
 * hands ssh and the host. Pure: the launch (services/remote-agents.ts) runs it.
 *
 * - A host is the owner's: an alias of their ~/.ssh/config (or user@host) and a work root on it. No key, no path to
 *   one, no password: ssh finds those in the owner's config and agent.
 * - ssh never forwards the owner's agent, never prompts (BatchMode), ends when its tunnel cannot open, and takes the
 *   target after "--": a target is never an option.
 * - The API reaches back through a reverse tunnel bound to the host's loopback, on a port of its own per agent.
 * - The host gets one command, the wrapper Tars installed (`~/.tars-remote/bin/tars-remote`), every word quoted.
 * - The CLI's environment goes in a file, over ssh's stdin, never on a command line: only what the CLI needs, with
 *   the tunnel's address.
 * - At each launch, the agent's terminal first sends the host Tars's wrapper, its hook scripts, the agent's hooks and
 *   MCP files and its environment, over ssh's stdin (remoteBootstrap), then starts the CLI there in tmux
 *   (remoteLaunchLine, remoteStartCommand). The host's own Claude Code settings are never written.
 */

export interface RemoteHost {
  id: string;
  name: string;
  /** An alias of the owner's ssh config, or user@host. */
  sshTarget: string;
  /** An absolute path on the host where the agents' folders are made. */
  workRoot: string;
}

export type RemoteHostParse =
  | { ok: true; host: RemoteHost }
  | { ok: false; error: string; code: 'invalid_host' | 'invalid_id' | 'invalid_name' | 'invalid_target' | 'invalid_work_root' | 'no_credentials_here' };

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** user@host, host, an alias, an IPv4 or a bracketed IPv6: no space, quote, shell sign, or leading dash. */
const TARGET = /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9][A-Za-z0-9._-]*|\[[0-9A-Fa-f:.]+\])$/;
const CREDENTIAL_KEYS = ['identityFile', 'identity', 'key', 'privateKey', 'password', 'passphrase'];

export function parseRemoteHost(raw: unknown): RemoteHostParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'invalid_host', error: 'A host is { id, name, sshTarget, workRoot }.' };
  const r = raw as Record<string, unknown>;
  if (CREDENTIAL_KEYS.some((k) => k in r)) {
    return { ok: false, code: 'no_credentials_here', error: 'A host holds no key, path to a key or password: ssh finds them in your own ssh config and agent.' };
  }
  if (typeof r.id !== 'string' || !ID.test(r.id)) return { ok: false, code: 'invalid_id', error: 'id is 1 to 40 lowercase letters, digits or dashes.' };
  if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 80 || /[\u0000-\u001f\u007f]/.test(r.name)) {
    return { ok: false, code: 'invalid_name', error: 'name is 1 to 80 characters on one line.' };
  }
  if (typeof r.sshTarget !== 'string' || !TARGET.test(r.sshTarget) || r.sshTarget.length > 200) {
    return { ok: false, code: 'invalid_target', error: 'sshTarget is an alias of your ssh config, or user@host: no space, quote, shell sign, or leading dash.' };
  }
  const root = r.workRoot;
  if (typeof root !== 'string' || !root.startsWith('/') || root.length > 300 || /[\u0000-\u001f\u007f'"`$\\]/.test(root)
    || root.split('/').some((seg) => seg === '..')) {
    return { ok: false, code: 'invalid_work_root', error: 'workRoot is an absolute path on the host, with no "..", quote, backslash or $.' };
  }
  return { ok: true, host: { id: r.id, name: r.name.trim(), sshTarget: r.sshTarget, workRoot: root.replace(/\/+$/, '') || '/' } };
}

/** Where an agent runs when it runs on a host: the host's id and the folder on it, under its work root. */
export interface AgentRemote { hostId: string; folder: string }

export type AgentRemoteParse =
  | { ok: true; remote: AgentRemote | null }
  | { ok: false; error: string; code: 'invalid_remote' | 'unknown_host' | 'invalid_folder' };

const BAD_PATH = /[\u0000-\u001f\u007f'"`$\\]/;

/**
 * An agent's placement as asked (the window, or its project's orchestrator): a host the owner added, and a folder
 * strictly under that host's work root (its project's folder name there when none is said); null brings it back to
 * this computer.
 */
export function parseAgentRemote(raw: unknown, hosts: RemoteHost[], projectPath: string): AgentRemoteParse {
  if (raw === null) return { ok: true, remote: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'invalid_remote', error: 'remote is { hostId, folder? }, or null to run on this computer.' };
  const { hostId, folder } = raw as { hostId?: unknown; folder?: unknown };
  const host = typeof hostId === 'string' ? hosts.find((h) => h.id === hostId) : undefined;
  if (!host) return { ok: false, code: 'unknown_host', error: 'hostId names none of the owner\'s remote hosts: only the owner adds one, in the window.' };
  const name = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? 'project';
  const asked = folder === undefined ? `${host.workRoot}/${BAD_PATH.test(name) ? 'project' : name}` : folder;
  if (typeof asked !== 'string' || !asked.startsWith(`${host.workRoot}/`) || BAD_PATH.test(asked) || asked.length > 400
    || asked.split('/').some((seg) => seg === '..' || seg === '.')) {
    return { ok: false, code: 'invalid_folder', error: `folder is an absolute path under the host's work root (${host.workRoot}/...), with no "..", quote, backslash or $.` };
  }
  return { ok: true, remote: { hostId: host.id, folder: asked.replace(/\/+$/, '') } };
}

/** Where the tunnel's ports are taken on the host. */
const PORT_BASE = 41000;
const PORT_SPAN = 2000;

/** The agent's tunnel port on the host: the same at every launch, the next one at `attempt` when that one was taken. */
export function remotePort(agentId: string, attempt = 0): number {
  const n = crypto.createHash('sha256').update(agentId).digest().readUInt32BE(0);
  return PORT_BASE + ((n + attempt * 7919) % PORT_SPAN);
}

/** A word for a POSIX shell, single-quoted. */
export function posixQuote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`;
}

/** The one command the host runs: the wrapper, found from $HOME, and each argument quoted. */
export function remoteCommand(sub: string, args: string[]): string {
  return ['"$HOME"/.tars-remote/bin/tars-remote', posixQuote(sub), ...args.map(posixQuote)].join(' ');
}

/**
 * ssh's arguments. `rport` opens the reverse tunnel to this Tars's API on the host's loopback; `tty` asks the host for
 * a terminal (the agent's PTY), else none (a command whose output is read).
 */
export function sshArgv(host: Pick<RemoteHost, 'sshTarget'>, o: { rport?: number; apiPort: number; tty: boolean; command: string }): string[] {
  return [
    ...(o.tty ? ['-tt'] : ['-T']),
    '-o', 'BatchMode=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15',
    ...(o.rport !== undefined ? ['-o', 'ExitOnForwardFailure=yes', '-R', `127.0.0.1:${o.rport}:127.0.0.1:${o.apiPort}`] : []),
    '--', host.sshTarget, o.command,
  ];
}

/**
 * What the CLI on the host is handed of its environment, and nothing of this Mac's own (its PATH, home, temporary
 * folders, the slot's shim, the state mod's local copy, an account folder, the ssh agent's socket).
 */
export const REMOTE_ENV_KEYS: readonly string[] = [
  'CLAUDE_MGR_API_TOKEN', 'TARS_INSTANCE_ID', 'CLAUDE_AGENT_ID', 'CLAUDE_AGENT_NAME', 'CLAUDE_PROJECT_PATH', 'CLAUDE_SKILLS',
  'CLAUDE_PROVIDER', 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_MOUSE_CLICKS',
  'TARS_CHATS_READ', 'CLAUDE_CHROME_CLASSIFIER_FLOOR', 'TARS_CLAUDE_ACCOUNT',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'API_TIMEOUT_MS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'MAX_THINKING_TOKENS', 'DISABLE_PROMPT_CACHING',
];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The environment file the wrapper sources on the host, then deletes: `export KEY='value'` lines. */
export function remoteEnvFile(env: Record<string, string | undefined>, o: { rport: number }): string {
  const lines: string[] = [];
  for (const key of REMOTE_ENV_KEYS) {
    const value = env[key];
    if (value === undefined || !NAME.test(key)) continue;
    lines.push(`export ${key}=${posixQuote(value)}`);
  }
  lines.push(`export CLAUDE_MGR_API_URL=${posixQuote(`http://127.0.0.1:${o.rport}`)}`);
  return `${lines.join('\n')}\n`;
}

/** An agent's id as the wrapper takes it (tars-remote.sh, valid_id). */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** The variable the wrapper sets for the CLI's command line: the agent's own folder of Tars's files on the host. */
export const REMOTE_AGENT_DIR_VAR = 'TARS_REMOTE_AGENT_DIR';

/**
 * Claude Code's flags for a CLI on a host (2.1.327 takes both): its hooks and Tars's MCP servers from the files Tars put
 * in the agent's folder there. Constant text that the host's shell reads: nothing in it comes from an agent or the owner.
 */
export const REMOTE_CLAUDE_FLAGS = ` --settings "$${REMOTE_AGENT_DIR_VAR}"/settings.json --mcp-config "$${REMOTE_AGENT_DIR_VAR}"/mcp.json`;

/** A hook as Claude Code is told to run it (claude-provider.ts, CLAUDE_HOOK_FILES). */
export interface HookSpec { type: string; file: string; matcher?: string }

const HOOK_FILE = /^[a-z0-9][a-z0-9-]*\.sh$/;

/**
 * The --settings file of a CLI on a host: Tars's hooks, run from the copies installed in ~/.tars-remote/hooks, and
 * nothing else of Claude Code's settings.
 */
export function remoteHookSettings(specs: readonly HookSpec[]): string {
  const hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string; timeout: number }> }>> = {};
  for (const { type, file, matcher } of specs) {
    if (!HOOK_FILE.test(file) || !/^[A-Za-z]+$/.test(type)) continue;
    (hooks[type] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: `"$HOME"/.tars-remote/hooks/${file}`, timeout: 30 }] });
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

/**
 * The --mcp-config file of a CLI on a host: each of Tars's servers this Tars serves over its API (the HTTP entries of
 * the agent's role file, services/mcp-roles.ts), reached through the agent's tunnel, with the agent's token by name as
 * Tars writes it (services/mcp-shared.ts). Nothing else of that file: a server started as a program is a program of
 * this Mac, and an HTTP entry anywhere else is the owner's, with whatever its headers hold.
 */
export function remoteMcpConfig(localConfig: string | undefined, o: { apiPort: number; rport: number }): string {
  let servers: Record<string, unknown> = {};
  try {
    const found = (JSON.parse(localConfig ?? '') as { mcpServers?: unknown } | null)?.mcpServers;
    if (found && typeof found === 'object' && !Array.isArray(found)) servers = found as Record<string, unknown>;
  } catch {
    // Not JSON: no server, rather than a guess.
  }
  const out: Record<string, { type: 'http'; url: string; headers: { Authorization: string } }> = {};
  for (const [name, entry] of Object.entries(servers)) {
    const e = (entry ?? {}) as { type?: unknown; url?: unknown };
    if (!/^[A-Za-z0-9._-]+$/.test(name) || e.type !== 'http' || e.url !== `http://127.0.0.1:${o.apiPort}/api/mcp/${name}`) continue;
    // ${CLAUDE_MGR_API_TOKEN}: expanded by the CLI from its own environment, as services/mcp-shared.ts writes it.
    out[name] = { type: 'http', url: `http://127.0.0.1:${o.rport}/api/mcp/${name}`, headers: { Authorization: 'Bearer ${CLAUDE_MGR_API_TOKEN}' } };
  }
  return `${JSON.stringify({ mcpServers: out }, null, 2)}\n`;
}

/** A file Tars puts on a host, its path under ~/.tars-remote. */
export interface RemoteFile { path: string; content: string; executable?: boolean }

const REMOTE_FILE_PATH = /^(?:bin|hooks|agents\/[A-Za-z0-9][A-Za-z0-9-]{0,63})\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The line that ends a file's base64: base64 never holds an underscore. */
const FILE_END = 'TARS_FILE_END';

/**
 * What `sh -s` on the host reads from ssh's stdin to prepare a launch: Tars's files, the agent's folder trusted in the
 * host's Claude Code, then the agent's environment, last. Nothing of it is on a command line of either machine. Each
 * file is written whole (a new name, then renamed over the old one), readable by the host's user only; its content
 * goes as base64, so the shell never reads a byte of it.
 *
 * The trust: Claude Code asks "Do you trust the files in this folder?" in a folder it has not been told to trust, bypass
 * or not, and the agent's first task would be taken as the answer. Tars accepts it for the agent's own folder before
 * the CLI starts, as it does on this computer (ensureProjectTrusted), in the host's ~/.claude.json, with jq, which
 * Tars's hooks need there anyway; that key of that folder, and nothing else of the file.
 */
export function remoteBootstrap(o: { agentId: string; folder: string; files: RemoteFile[]; env: string }): string {
  if (!AGENT_ID.test(o.agentId)) throw new Error(`not an agent id Tars hands a host: ${o.agentId}`);
  if (!o.folder.startsWith('/') || BAD_PATH.test(o.folder)) throw new Error(`not a folder Tars hands a host: ${o.folder}`);
  const dir = `agents/${o.agentId}`;
  const lines = ['set -e', 'umask 077', 'R="$HOME/.tars-remote"', `mkdir -p "$R/bin" "$R/hooks" "$R/${dir}"`];
  const trust = () => {
    const folder = posixQuote(o.folder);
    lines.push(
      'T="$HOME/.claude.json"',
      '[ -s "$T" ] || printf \'{}\\n\' > "$T"',
      `D=$(cd ${folder} 2>/dev/null && pwd -P || printf '%s' ${folder})`,
      `jq --arg d ${folder} --arg r "$D" '.projects[$d].hasTrustDialogAccepted = true | .projects[$r].hasTrustDialogAccepted = true' "$T" > "$T.tars-new"`,
      'mv -f "$T.tars-new" "$T"',
    );
  };
  const put = (file: RemoteFile) => {
    if (!REMOTE_FILE_PATH.test(file.path)) throw new Error(`not a path Tars writes on a host: ${file.path}`);
    const b64 = Buffer.from(file.content, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\n').trimEnd();
    const next = `"$R/${file.path}.tars-new"`;
    lines.push(`base64 -d > ${next} <<'${FILE_END}'`, ...(b64 ? [b64] : []), FILE_END,
      `chmod ${file.executable ? '700' : '600'} ${next}`, `mv -f ${next} "$R/${file.path}"`);
  };
  for (const file of o.files) {
    if (file.path === `${dir}/env`) throw new Error('the environment goes last, as env');
    put(file);
  }
  trust();
  put({ path: `${dir}/env`, content: o.env });
  return `${lines.join('\n')}\n`;
}

/**
 * The command the host runs in the agent's terminal: the wrapper's start, which ends a session of the agent's left
 * there and starts this one in tmux. The CLI's command line goes as one word of base64.
 */
export function remoteStartCommand(o: { agentId: string; folder: string; cliCommand: string }): string {
  if (!AGENT_ID.test(o.agentId)) throw new Error(`not an agent id Tars hands a host: ${o.agentId}`);
  return remoteCommand('start', [o.agentId, o.folder, Buffer.from(o.cliCommand, 'utf8').toString('base64')]);
}

/**
 * What the agent's terminal runs on this computer (`/bin/sh -c`): the host prepared first, `prepare` reading the file
 * Tars wrote for it (0600, it holds the agent's token) on its stdin; the file removed whatever the outcome; then, only
 * when that went well, the terminal's own ssh in its place. Each ssh says in the terminal why it failed, in its words.
 */
export function remoteLaunchLine(o: { prepare: string[]; prepFile: string; terminal: string[] }): string {
  const words = (argv: string[]) => argv.map(posixQuote).join(' ');
  const file = posixQuote(o.prepFile);
  return `${words(o.prepare)} < ${file}; s=$?; rm -f ${file}; [ "$s" -eq 0 ] || exit "$s"; exec ${words(o.terminal)}`;
}
