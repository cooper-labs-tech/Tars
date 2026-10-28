import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PRIVATE_DIR } from '../constants';
import { levelOf } from '../core/permission-ceiling';
import { shortIdOf, TMP_ROOT } from './agent-tmp';
import type { AgentStatus } from '../types';

/**
 * Tars answers yes itself, for an agent the owner set to bypass, to a file tool's question (Write, Edit, MultiEdit,
 * NotebookEdit) on an absolute path inside that agent's own folders (2.0.5, brief fix-permission-dialogs-2810.md,
 * item 2). Never to a shell command: those wait for the owner, and are refused at the delay with what to do instead
 * (permission-asks.ts).
 *
 * Why not a shell command (the orchestrator's decision of 28/10, after the Audit's two gates of #538): Tars read
 * commands with a reader of its own, and each gate found it allowing what the shell then ran outside the agent's
 * folders: six forms in bash, then thirteen in zsh (the agents' shell on macOS) and in both shells, one of them
 * writing .claude/settings.json, the file Claude Code reads its hooks from. A reader of its own will always differ
 * from the shell, and what Claude Code still asks in bypass is its last protection. The agents are told to write files
 * with the Write tool instead, which bypass does not ask about.
 *
 * The rule for a file tool: the path, absolute, resolves (links followed as far as they exist, `..` refused) inside
 * the agent's working folder (its worktree, or its project), its `t` or its `c` temporary folder
 * (services/agent-tmp.ts); never under ~/.tars-private, another agent's worktree or temporary folders; never its
 * own `.git`, `.claude` or `.mcp.json`, compared as the file system folds names: NFKC and lower case (`.mcp.jſon`
 * and `.CLAUDE` are those on APFS), and on Windows no part may end in a dot or a space, which Win32 drops.
 *
 * Not a boundary: an agent in bypass runs anything Claude Code does not ask about. This only decides which of its
 * questions Tars may answer for the owner. SECURITY.md says so.
 */

export type Places = {
  /** The agent's own folders, as given. */
  own: string[];
  /** Folders inside which nothing is answered: the private folder, the other agents'. */
  never: string[];
  platform: NodeJS.Platform;
};

export type Judgement = { allow: boolean; why: string };

/** The tools Tars may answer, and the field naming the file each writes. */
export const FILE_TOOLS: Readonly<Record<string, string>> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
/** What Claude Code itself keeps an agent's hands off: its hooks, its settings, its servers. */
const GUARDED = new Set(['.git', '.claude', '.mcp.json']);

/** A path, links followed as far as it exists, the rest as written. */
function realOf(p: string): string {
  let at = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(at), ...rest.reverse());
    } catch {
      const up = path.dirname(at);
      if (up === at) return p;
      rest.push(path.basename(at));
      at = up;
    }
  }
}

function within(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The folders the agent owns and those it must not touch; undefined when the agent is not in bypass, which Tars
 * never answers for.
 */
export function placesOf(
  agent: AgentStatus,
  fleet: Iterable<AgentStatus>,
  at: { home: string; privateDir: string; tmpRoot: string } = { home: os.homedir(), privateDir: PRIVATE_DIR, tmpRoot: TMP_ROOT },
  platform: NodeJS.Platform = process.platform,
): Places | undefined {
  if (levelOf(agent) !== 'bypass') return undefined;
  const work = agent.worktreePath || agent.projectPath;
  const mine = path.join(at.tmpRoot, shortIdOf(agent.id));
  const own = [work, path.join(mine, 't'), path.join(mine, 'c')];
  const others = [...fleet].filter(o => o.id !== agent.id)
    .flatMap(o => [o.worktreePath, path.join(at.tmpRoot, shortIdOf(o.id))])
    .filter((d): d is string => !!d);
  // A worktree two agents share is each one's own: it is not kept from either.
  const never = [at.privateDir, ...others].filter(n => !own.some(o => within(o, n)));
  return { own, never, platform };
}

/** Why this file is not the agent's own to write, or undefined when it is. */
function judgePath(file: string, places: Places): string | undefined {
  if (file.split(/[\\/]/).includes('..')) return `${file} climbs out with ..`;
  const real = realOf(path.resolve(file));
  const root = places.own.map(realOf).find(o => within(real, o));
  if (!root) return `${file} is outside its own folders`;
  if (places.never.map(realOf).some(n => within(real, n))) return `${file} is in a folder Tars keeps from it`;
  if (real === root) return `${file} is its folder itself`;
  const parts = path.relative(root, real).split(path.sep).filter(Boolean);
  // As the file system folds names: NFKC and lower case (APFS's `.mcp.jſon` is `.mcp.json`, `.CLAUDE` is `.claude`).
  if (parts.some(p => GUARDED.has(p.normalize('NFKC').toLowerCase()))) return `${file} is its own .git, .claude or .mcp.json, which Claude Code asks about on purpose`;
  // Win32 drops a trailing dot or space: `.claude.` is `.claude` there.
  if (places.platform === 'win32' && parts.some(p => /[. ]$/.test(p))) return `${file} has a name ending in a dot or a space, which Windows drops`;
  return undefined;
}

/** Whether Tars answers this call itself: a file tool on a path that is the agent's own, and nothing else. */
export function judgeCall(tool: string, fields: Record<string, string>, places: Places): Judgement {
  if (tool === 'Bash') return { allow: false, why: 'Tars never answers a shell command: the owner does' };
  const field = FILE_TOOLS[tool];
  if (!field) return { allow: false, why: `${tool} is not a tool Tars answers for` };
  const file = fields[field];
  if (!file || !path.isAbsolute(file)) return { allow: false, why: `${tool} names no absolute path` };
  const why = judgePath(file, places);
  return why ? { allow: false, why } : { allow: true, why: `${file} is inside its own folders` };
}
