import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { transcriptProjectDirName } from '../platform/claude-project-dir';
import { codexHome, codexRolloutOf } from '../providers/codex-cli';

/**
 * Whether an agent's last session can actually be resumed.
 *
 * `claude --resume <id>` reads the conversation back from
 * `~/.claude/projects/<encoded-path>/<id>.jsonl`. If that file is not there,
 * the binary exits with an error instead of starting, so an agent whose
 * transcript has been cleaned up would simply stop launching. Restarting into
 * a fresh conversation is a worse outcome than resuming and a much better one
 * than not starting at all, so the id is only ever used once the file backing
 * it has been found.
 *
 * The project directory name is Claude Code's own encoding: every `/` and `.`
 * in the path becomes `-` (see decode-project-path.ts, which reverses it).
 * On Windows, every character that is not a letter or a digit, as Claude
 * names the folder there (platform/claude-project-dir.ts).
 * Encoding is lossy, so several paths can encode to the same directory name;
 * that is fine here, because the session id is a UUID and the check is only
 * asking whether this exact transcript exists.
 *
 * A codex agent's session is codex's rollout instead (2.0.4): kept in codex's
 * own home under the day it began, whatever the folder, and continued there by
 * `codex resume <id>` (providers/codex-cli.ts).
 */

/** Claude Code's project directory name for a filesystem path. */
export function encodeProjectDirName(projectPath: string, platform: NodeJS.Platform = process.platform): string {
  return transcriptProjectDirName(projectPath, platform);
}

export function transcriptPath(projectPath: string, sessionId: string, homeDir = os.homedir()): string {
  return path.join(homeDir, '.claude', 'projects', encodeProjectDirName(projectPath), `${sessionId}.jsonl`);
}

/**
 * A path as Tars saved it, then its real path when that differs.
 *
 * Claude Code files a transcript under the real path of the directory it runs
 * in, and a project reached through a symlink (anything under /tmp, which is
 * /private/tmp on macOS, or a linked checkout) encodes to another directory:
 * looked for under the saved spelling alone, its conversation was never
 * resumed, and every restart silently started a new one (QA's gate of #138).
 * A path that no longer exists has only its saved spelling.
 */
export function spellingsOf(root: string): string[] {
  try {
    const real = fs.realpathSync(root);
    return real === root ? [root] : [root, real];
  } catch {
    return [root];
  }
}

/**
 * Every directory a session's transcript may be filed under, in the order to
 * try: each path as Tars saved it, then its real path when that differs (see
 * spellingsOf). Every reader of a transcript goes through this: #138 fixed the
 * resume alone, and four other readers kept looking under the saved spelling
 * only (QA's re-check of #138).
 */
export function transcriptRoots(...paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((p): p is string => !!p).flatMap(spellingsOf))];
}

/**
 * The session id to resume, or null.
 *
 * Null covers every reason not to resume: no id recorded, an id that is not a
 * session id, or a transcript that is no longer on disk.
 */
export function resolveResumeSessionId(
  agent: { provider?: string; resumableSessionId?: string; forkedFromSessionId?: string; projectPath?: string; worktreePath?: string },
  homeDir = os.homedir(),
): string | null {
  // Qwen Code's transcripts are its own (services/qwen-code.ts, which this cannot import: it is below the providers).
  const fileOf = agent.provider === 'qwen-code'
    ? (root: string, id: string) => path.join(homeDir, '.qwen', 'projects', (process.platform === 'win32' ? root.toLowerCase() : root).replace(/[^a-zA-Z0-9]/g, '-'), 'chats', `${id}.jsonl`)
    : (root: string, id: string) => transcriptPath(root, id, homeDir);
  // The session itself, or, while a fork has no transcript of its own yet, the
  // session it continues: the conversation is that one's, untouched.
  for (const candidate of [agent.resumableSessionId, agent.forkedFromSessionId]) {
    const sessionId = candidate?.trim();
    if (!sessionId) continue;
    // A UUID and nothing else. This value reaches a command line, and the
    // shape check is what keeps it from being anything but an id.
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(sessionId)) continue;

    if (agent.provider === 'codex') {
      if (codexRolloutOf(sessionId, codexHome(process.env, homeDir))) return sessionId;
      continue;
    }

    // An agent with its own worktree ran there, so that is where its transcript
    // was written. Both are checked because an agent can be moved onto a
    // worktree after the session that is being resumed.
    const roots = [agent.worktreePath, agent.projectPath].filter((p): p is string => !!p);
    for (const root of roots) {
      for (const spelling of spellingsOf(root)) {
        try {
          if (fs.existsSync(fileOf(spelling, sessionId))) return sessionId;
        } catch {
          // An unreadable home directory is not a reason to fail the start.
        }
      }
    }
  }
  return null;
}

/**
 * Agents already started in this run of the app.
 *
 * Resuming is for the first start after a restart, which is the case that used
 * to lose the work. Once an agent has been started here, later starts behave
 * as they always have: a fresh conversation, because that is what a user
 * pressing Start a second time is asking for. Without this, every dispatch
 * would silently reopen an old conversation.
 */
const startedThisRun = new Set<string>();

/** The id to resume for this start, or null. Returns an id at most once per
 *  agent per app run. */
export function consumeResumeSessionId(
  agent: { id: string; provider?: string; resumableSessionId?: string; projectPath?: string; worktreePath?: string },
  homeDir?: string,
): string | null {
  const first = !startedThisRun.has(agent.id);
  startedThisRun.add(agent.id);
  if (!first) return null;
  return resolveResumeSessionId(agent, homeDir);
}

/**
 * Whether the next start of this agent continues its last conversation, as
 * consumeResumeSessionId would answer it, without counting as that start:
 * update_agent says so before the start happens.
 */
export function nextStartResumes(
  agent: { id: string; resumableSessionId?: string; forkedFromSessionId?: string; projectPath?: string; worktreePath?: string },
  homeDir?: string,
): boolean {
  return !startedThisRun.has(agent.id) && resolveResumeSessionId(agent, homeDir) !== null;
}

/**
 * Whether a launch given this resume option continues a conversation, as the window's launcher resolves it
 * (handlers/ipc-handlers.ts, launchInTerminal), without counting as that start: a session id continues that session
 * when its transcript is there, null continues none, and no option the last session, once per run or after a sleep.
 * What decides whether a start takes the agent's first task (core/first-task.ts, the Audit's L3 on #584: a wake gives
 * no option and continues the conversation all the same).
 */
export function launchResumes(
  agent: { id: string; provider?: string; resumableSessionId?: string; forkedFromSessionId?: string; projectPath?: string; worktreePath?: string },
  named: string | null | undefined,
  homeDir?: string,
): boolean {
  if (named === null) return false;
  if (named === undefined) return nextStartResumes(agent, homeDir);
  return resolveResumeSessionId({ ...agent, resumableSessionId: named }, homeDir) !== null;
}

/**
 * The next start of this agent resumes its conversation again, as the first of
 * a run does: it was put to sleep (core/agent-asleep.ts), and woken, it must
 * pick up where it was, whichever sender wakes it and however often this run
 * has started it before.
 */
/**
 * A launch that names the session it resumes, or that it resumes none (a
 * restart, a chat's runner relaunched by its chat), is the run's first launch
 * too: the next start resumes nothing, as after any other. Left unspent, a
 * stop then a start resumed the session the stop had just made the agent's
 * tombstone, under its own id, and Tars refused every post of it (the Audit's
 * M1 on #475).
 */
export function spendResume(agentId: string): void {
  startedThisRun.add(agentId);
}

export function resumeOnNextStart(agentId: string): void {
  startedThisRun.delete(agentId);
}

/**
 * The next start of this agent begins a new conversation, even the first of a
 * run: update_agent moved it to another CLI, and no CLI continues another
 * one's. Its last session is another CLI's, or one the new CLI had before the
 * move, which is not the conversation the agent was having.
 */
export function newConversationOnNextStart(agentId: string): void {
  startedThisRun.add(agentId);
}

/** Test seam: forget which agents have started. */
export function resetResumeTracking(): void {
  startedThisRun.clear();
}
