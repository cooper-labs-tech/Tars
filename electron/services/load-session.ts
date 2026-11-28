import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { parse as parseToml } from 'smol-toml';
import { isUnsafePathSegment } from '../platform/windows-names';
import { tarsMcpServerNames } from './mcp-roles';

/**
 * What a load task's session is given (trace feature C3, part 2): the branch of its worktree, the environment that
 * blocks every push from it, and nothing an earlier session wrote (the no-memory rule, below).
 *
 * The push block goes through the session's environment alone, never the shared git config and never a hook (the
 * orchestrator's rule): git reads `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` as config given on
 * the command line, and `url.<base>.pushInsteadOf` with an empty value matches every URL, so a push to a named remote
 * or to a URL goes to the helper `tars-load-push-blocked`, which does not exist, and fails. A fetch is not rewritten.
 * Measured on 27/11 against a bare repository (load-session.test.ts).
 */

const BLOCK_KEY = 'url.tars-load-push-blocked://.pushInsteadOf';

/** The variables that block every push, after the GIT_CONFIG entries the environment already has. */
export function pushBlockEnv(env: Record<string, string | undefined>): Record<string, string> {
  const raw = env.GIT_CONFIG_COUNT;
  // A count git would refuse makes every git command fail: ours replaces it.
  const n = raw !== undefined && /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
  return { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: BLOCK_KEY, [`GIT_CONFIG_VALUE_${n}`]: '' };
}

/**
 * The branch of one arrival of a task: `load/<run>/<task id>-<n>`, one per arrival, since a task may run more than once
 * in a window, at once even (its max_runs). The task id is made a single segment the worktree guard takes
 * (utils/worktree-path.ts) on every system: any character but letters, digits, `.`, `_` and `-` becomes `-`, runs of
 * dots become one `-`, it starts with a letter or a digit, and it holds at most 80 characters.
 */
export function loadBranchOf(runId: string, taskId: string, n: number): string {
  let id = taskId.normalize('NFC').replace(/[^A-Za-z0-9._-]/g, '-').replace(/\.{2,}/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 80);
  if (!id || isUnsafePathSegment(`${id}-${n}`, 'win32')) id = `t-${id}`;
  return `load/${runId}/${id}-${n}`;
}

/*
 * The no-memory rule: a load session starts with nothing an earlier session wrote, whether Tars hands it or the CLI
 * keeps it. Tars hands a load agent no memory block and no guide in its prompt (ipc-handlers.ts launchInTerminal), no
 * room (bus-store.ts), no observation of its own tool uses (memory-routes.ts) and an emptied TMPDIR (agent-tmp.ts);
 * each CLI is given, below, the switches of its own memory and of Tars's MCP servers, every one of which is a channel
 * to other sessions. Read from each CLI's package and measured on 28/11 against the real codex 0.163.0, qwen-code
 * 0.25.2 and opencode 1.19.6, fenced (#691's body). A session in bypass can still read or write any file on purpose:
 * SECURITY.md says so.
 */

/** codex 0.163: its memories (`[features].memories`, `[memories]`), off for this run. */
const CODEX_MEMORY_OFF = ['features.memories=false', 'memories.generate_memories=false', 'memories.use_memories=false'];

/**
 * codex: its memories off, and each Tars server its config.toml defines, never another: a switch for a server the file
 * does not define makes an entry with nothing to run, and codex refuses to start on it ("invalid transport", measured
 * on 0.163.0; #657 keeps the same rule for a worker). A file smol-toml cannot parse, which codex may still read: every
 * Tars server switched off, so codex refuses to start rather than start one of them.
 * With #657: keep #657's reading of the file (its definedInText) in place of this one.
 */
export function codexLoadArgs(configFile: string): string[] {
  let defined: (name: string) => boolean = () => false;
  let text: string | undefined;
  try { text = fs.readFileSync(configFile, 'utf-8'); } catch { /* no file: no server defined */ }
  if (text !== undefined) {
    try {
      const servers = parseToml(text).mcp_servers;
      const table = servers && typeof servers === 'object' ? servers : {};
      defined = name => Object.prototype.hasOwnProperty.call(table, name);
    } catch {
      defined = () => true;
    }
  }
  const servers = tarsMcpServerNames().filter(defined).map(name => `mcp_servers.${name}.enabled=false`);
  return [...CODEX_MEMORY_OFF, ...servers].flatMap(value => ['-c', value]);
}

/** qwen-code 0.25.2: its three memory tools, excluded from a load session. */
export const LOAD_MEMORY_TOOLS: readonly string[] = ['save_memory', 'manage_memory', 'search_memory'];

/**
 * qwen-code: its memory tools excluded, one `--exclude-tools` each, and every Tars server disabled for this run (a name
 * it does not have is accepted), as pairs, the servers last: an option follows each exclusion, so none takes the prompt
 * for a tool's name (measured on 0.25.2: the repeated form excludes each, the session gets its prompt).
 */
export function qwenLoadArgs(): string[] {
  return [
    ...LOAD_MEMORY_TOOLS.flatMap(tool => ['--exclude-tools', tool]),
    ...tarsMcpServerNames().flatMap(name => ['--disable-mcp-server', name]),
  ];
}

/**
 * qwen-code: its own memories off, in the agent's system settings file (qwen-code.ts), which qwen merges last. Its
 * managed auto memory is on by default, with a user tier every project and worktree shares: measured, a memory planted
 * there reaches the model without these and never with them. `mem0: null` drops a mem0 provider set anywhere.
 */
export const QWEN_LOAD_MEMORY = {
  enableManagedAutoMemory: false, enableManagedAutoDream: false, enableAutoSkill: false,
  enableTeamMemory: false, enableTeamMemorySync: false, enableStructuredMemoryRecall: false, mem0: null,
} as const;

/** pi 1.0.4 and later: no MCP for this run. pi keeps no memory of its own. */
export const PI_LOAD_ARGS: readonly string[] = ['--no-mcp'];

/**
 * A load session's environment, over what its terminal is given: the push block for every CLI, and for opencode,
 * every Tars server off in its config content, which it merges after its global file (an entry for a server that file
 * does not define is accepted, measured on 1.19.6), its endpoint's provider kept, and Claude Code's files
 * (~/.claude/CLAUDE.md, its skills) not read.
 */
export function loadSessionEnv(provider: string, env: Record<string, string | undefined>): Record<string, string> {
  const out = pushBlockEnv(env);
  if (provider !== 'opencode') return out;
  let content: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) content = parsed;
  } catch { /* Tars's own content, always JSON: without it, opencode has no endpoint and stops */ }
  const mcp = content.mcp && typeof content.mcp === 'object' ? content.mcp as Record<string, unknown> : {};
  content.mcp = { ...mcp, ...Object.fromEntries(tarsMcpServerNames().map(name => [name, { enabled: false }])) };
  return { ...out, OPENCODE_CONFIG_CONTENT: JSON.stringify(content), OPENCODE_DISABLE_CLAUDE_CODE: '1' };
}

/** What a load session started from: the hash of its prompt and of the instruction files its CLI loads at every start. */
export interface LoadStartContext {
  sha256: string;
  /** Each file, `~` for the home folder, and the hash of its content, or null when there is none. */
  files: Array<{ path: string; sha256: string | null }>;
}

/** The instruction files each CLI loads at every start, outside the project, from its own folder. */
function globalInstructionFiles(provider: string, home: string, env: NodeJS.ProcessEnv): string[] {
  switch (provider) {
    case 'codex': {
      const dir = env.CODEX_HOME || path.join(home, '.codex');
      return ['AGENTS.override.md', 'AGENTS.md'].map(f => path.join(dir, f));
    }
    case 'qwen-code': {
      const dir = env.QWEN_HOME || path.join(home, '.qwen');
      return ['QWEN.md', 'AGENTS.md'].map(f => path.join(dir, f));
    }
    case 'pi': {
      const dir = env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent');
      return ['AGENTS.md', 'CLAUDE.md', 'SYSTEM.md', 'APPEND_SYSTEM.md'].map(f => path.join(dir, f));
    }
    case 'opencode':
      return [path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'AGENTS.md')];
    default:
      return [];
  }
}

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

/**
 * A load session's starting context: the prompt typed into it, as Tars composed it, and the instruction files its CLI
 * loads at every start. Two sessions of the same task share it; a memory block in the prompt, or a line an earlier
 * session wrote into one of those files, changes it. Recorded with the session's trace (traces-runtime.ts).
 */
export function startContextOf(provider: string, prompt: string, where: { home: string; env: NodeJS.ProcessEnv } = { home: os.homedir(), env: process.env }): LoadStartContext {
  const files = globalInstructionFiles(provider, where.home, where.env).map((file) => {
    let content: Buffer | undefined;
    try { content = fs.readFileSync(file); } catch { /* none */ }
    const shown = file === where.home || file.startsWith(`${where.home}${path.sep}`) ? `~${file.slice(where.home.length)}` : file;
    return { path: shown, sha256: content === undefined ? null : sha256(content) };
  });
  return { sha256: sha256(JSON.stringify({ provider, prompt, files })), files };
}
