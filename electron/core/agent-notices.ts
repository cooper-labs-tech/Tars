/**
 * A line for whoever reads an agent's kept output (the Logs page), from code below the agent store: a provider cannot
 * import core/agent-manager.ts, which imports the providers. agent-manager.ts sets where the lines go, the agent's kept
 * output as a `[Tars]` line, as hooks-routes.ts writes a refused session's; until then, the console.
 */
type Sink = (agentId: string, line: string) => void;

let sink: Sink = (agentId, line) => console.log(`[notice] ${agentId}: ${line}`);

export function setAgentNoticeSink(next: Sink): void {
  sink = next;
}

/** Tell the agent's kept output `line` (one sentence, in the window's words). */
export function agentNotice(agentId: string, line: string): void {
  sink(agentId, line);
}
