/**
 * A line for whoever reads an agent's kept output (the Logs page), from code below the agent store: a provider cannot
 * import core/agent-manager.ts, which imports the providers. agent-manager.ts sets where the lines go, the agent's kept
 * output as a `[Tars]` line, as hooks-routes.ts writes a refused session's; until then, the console.
 *
 * Each line is also a notice the window reads (2.0.7, services/agent-notice-log.ts): kept with its kind, told to every
 * window as it is written (agent:notice), since while the agent has a terminal Logs and its panel read that terminal's
 * screen, which these lines never reach.
 */

/**
 * What a notice is about, which sets its tone in the window. Its writer's word, never read from the sentence:
 * - conversation-restart: the agent's conversation starts over (a Goose agent whose servers changed, a Cline restart);
 * - session-refused: the hook route refused a session that was not the agent's own CLI's (hooks-routes.ts);
 * - other: any other line.
 */
export type AgentNoticeKind = 'conversation-restart' | 'session-refused' | 'other';

export const AGENT_NOTICE_KINDS: readonly AgentNoticeKind[] = ['conversation-restart', 'session-refused', 'other'];

/** A notice as the window reads it: `line` is the sentence, without the output's "[Tars] ". */
export interface AgentNotice {
  id: string;
  agentId: string;
  /** When it was written, in ms. */
  at: number;
  line: string;
  kind: AgentNoticeKind;
  /** When a window marked it seen, in ms. */
  seenAt?: number;
}

type Sink = (agentId: string, line: string, kind: AgentNoticeKind) => void;

let sink: Sink = (agentId, line) => console.log(`[notice] ${agentId}: ${line}`);

export function setAgentNoticeSink(next: Sink): void {
  sink = next;
}

/** Tell the agent's kept output `line` (one sentence, in the window's words), of its writer's `kind`. */
export function agentNotice(agentId: string, line: string, kind: AgentNoticeKind = 'other'): void {
  sink(agentId, line, kind);
}
