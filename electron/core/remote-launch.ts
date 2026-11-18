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
