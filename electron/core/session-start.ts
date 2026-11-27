/**
 * Why an agent's terminal is being opened, said by the path that opens it, just before it does (trace feature A3,
 * 27/11): the spawn itself (core/agent-pty.ts spawnAgentPty, where a traced session opens) is reached the same way by
 * every start, and cannot tell a delegated task from the owner's window or a restart.
 *
 * One note per agent, read once by the next spawn of its terminal, and only within START_NOTE_MS: a note whose start
 * opened no terminal (the agent's terminal was already open) is never read by a later, unrelated start. An agent
 * asleep at its spawn is woken whatever the note says (services/traces-runtime.ts).
 *
 * No `schedule`: Tars has no scheduler of its own. A job the user schedules in Hermes reaches an agent as a relay
 * message, through the same path as one they type there, and reads `channel`.
 */

export type StartTrigger =
  /** The owner, from the window (or a key typed into an asleep agent's pane). */
  | 'owner'
  /** A task handed over with a ref (run-task, delegate_task, a queued task's turn). */
  | 'task'
  /** A channel's message: Slack, Discord, the Hermes relay. */
  | 'channel'
  /** Started again after a restart: the agent's (restart_agent, the window's), or Tars's (its recovery). */
  | 'restart'
  /** Opened by an agent or by Tars with no task (start_agent with no prompt, a chat's runner). */
  | 'start';

/** What a traced session records: a start's own trigger, or what Tars reads at the spawn. */
export type SessionTrigger = StartTrigger | 'wake' | 'redelegation' | 'unknown';

export interface StartNote {
  trigger: StartTrigger;
  /** How, by kind only, never a name: window, key, api, slack, discord, hermes, chat, tars. */
  via?: string;
  /** The task's ref (`t-` and 8 hex), when it came with one. */
  taskRef?: string;
  /** The agent that handed the task over. */
  requesterAgentId?: string;
}

/** How long a note waits for its spawn: a launch's terminal opens within seconds of its start. */
export const START_NOTE_MS = 60_000;

const notes = new Map<string, StartNote & { at: number }>();

/** Why the next terminal of `agentId` opens: said just before the start that opens it. */
export function noteSessionStart(agentId: string, note: StartNote, now: number = Date.now()): void {
  notes.set(agentId, { ...note, at: now });
}

/** The note for this spawn, once; none past its window. */
export function takeSessionStart(agentId: string, now: number = Date.now()): StartNote | undefined {
  const note = notes.get(agentId);
  notes.delete(agentId);
  if (!note || now - note.at > START_NOTE_MS) return undefined;
  return {
    trigger: note.trigger, ...(note.via ? { via: note.via } : {}), ...(note.taskRef ? { taskRef: note.taskRef } : {}),
    ...(note.requesterAgentId ? { requesterAgentId: note.requesterAgentId } : {}),
  };
}
