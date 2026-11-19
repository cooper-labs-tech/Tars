import { readTurnAnswer, type AnswerTask } from './terminal-answer';

/**
 * Every ended task's answer, whatever CLI ran it and whoever asked for it (2.0.7; an orchestrator's reports of 19/11:
 * a turn the owner typed, a message and a queued message kept no answer, so get_agent_output gave the agent's last
 * delegation's, however old, and a delegation's own read took a turn's narration for its report).
 *
 * Read once per task (task-watch.ts at its end, agent-routes.ts runInTerminal for the delegation that follows it, the
 * same promise): from the transcript for the CLIs whose transcript Tars reads (Claude Code, the providers that run its
 * binary, Qwen Code), waiting for its last message (terminal-answer.ts readTurnAnswer); for the others (codex and pi,
 * whose own session logs Tars reads, gemini's AfterAgent hook), the output their watcher or hook posted during the
 * task, before the idle that ended it. Never an output posted before the task began: that is an earlier turn's.
 */

/** The last output posted for each agent (/api/hooks/output), and when. In memory: a task is read as it ends. */
const posted = new Map<string, { text: string; at: number }>();

export function noteOutputPosted(agentId: string, text: string, at = Date.now()): void {
  posted.set(agentId, { text, at });
}

/** The output posted for the agent at or after `since` (a task's start), or undefined. */
export function postedOutputSince(agentId: string, since: number): string | undefined {
  const last = posted.get(agentId);
  return last && last.at >= since ? last.text : undefined;
}

/** The reads made or in flight, by task id; the oldest go first past READS_KEPT. */
const reads = new Map<string, Promise<string | null>>();
const pending = new Set<string>();
const READS_KEPT = 500;

export type AnswerOfTask = AnswerTask & { id: string; agentId: string; outcome: string };

/**
 * The task's answer, read once: the same promise to every caller. `transcript`: whether its CLI writes a transcript
 * Tars reads (hasClaudeHooks); `configDir`, its Claude account's folder after the first.
 */
export function answerOfTask(
  task: AnswerOfTask,
  how: { transcript: boolean; configDir?: string; homeDir?: string; settleMs?: number; stepMs?: number },
): Promise<string | null> {
  const known = reads.get(task.id);
  if (known) return known;
  const said = postedOutputSince(task.agentId, task.startedAt);
  pending.add(task.id);
  const read = (async () => {
    try {
      if (!how.transcript) return said ?? null;
      return (await readTurnAnswer({ ...task, ...(how.configDir ? { configDir: how.configDir } : {}) }, {
        ...(said ? { lastSaid: said } : {}), homeDir: how.homeDir, settleMs: how.settleMs, stepMs: how.stepMs,
      })) ?? said ?? null;
    } catch (err) {
      console.warn(`[task-answers] ${task.id}'s answer could not be read:`, err instanceof Error ? err.message : err);
      return said ?? null;
    } finally {
      pending.delete(task.id);
    }
  })();
  reads.set(task.id, read);
  while (reads.size > READS_KEPT) reads.delete(reads.keys().next().value as string);
  return read;
}

/** Whether the task's answer is being read: a caller that asks for the task meanwhile waits for it. */
export function answerPending(taskId: string): boolean {
  return pending.has(taskId);
}

/** Test seam. */
export function forgetAnswers(): void {
  posted.clear();
  reads.clear();
  pending.clear();
}
