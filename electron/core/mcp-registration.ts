/**
 * The start-up registration of the MCP servers, as a gate every launch waits on (the Audit's L1 on #657).
 *
 * A CLI's line is built from the configs that registration writes: codex's switches from its config.toml
 * (services/mcp-roles.ts codexRoleArgs), gemini's allow-list from its settings, claude's worker file from
 * ~/.claude/mcp.json. Tars runs it at start-up without waiting for it (setupMcpOrchestrator, main.ts), and the restart
 * recovery, the bots and the API can launch agents meanwhile. A line built before it ends reads the configs as they
 * were: on a jump from 2.0.4 or older, codex's still holds Tars's Telegram entry, the worker's line switches it off,
 * retireTelegramMcp takes the entry out before codex reads the file, and codex refuses to start ("invalid transport");
 * on a first start, X registered after the line was built stays on for that worker until its next launch.
 *
 * main.ts begins it before anything can launch; setupMcpOrchestrator ends it, whatever it did. Each place that builds a
 * launch line waits for it first (untilMcpRegistered). Nothing under way (a test, a tool, or once it ended): no wait.
 * The wait is bounded, so a registration that hangs delays launches and never stops them.
 */

/** How long a launch waits for a registration still under way, at most. */
export const MCP_REGISTRATION_WAIT_MS = 60_000;

let running: { promise: Promise<void>; end: () => void } | null = null;

/** A registration begins: from now on, a launch waits for its end. One already under way is that one. */
export function mcpRegistrationBegins(): void {
  if (running) return;
  let end = (): void => {};
  const promise = new Promise<void>((resolve) => { end = resolve; });
  running = { promise, end };
}

/** The registration ended, whether it registered everything or failed: every launch waiting goes on. */
export function mcpRegistrationEnds(): void {
  const ending = running;
  running = null;
  ending?.end();
}

/**
 * Waits, before a launch builds its line, for a registration under way to end: 'registered' when it did, 'timed-out'
 * at the bound, 'open' at once when none is under way.
 */
export async function untilMcpRegistered(maxMs: number = MCP_REGISTRATION_WAIT_MS): Promise<'open' | 'registered' | 'timed-out'> {
  const current = running;
  if (!current) return 'open';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<'timed-out'>((resolve) => { timer = setTimeout(() => resolve('timed-out'), maxMs); });
  const outcome = await Promise.race([current.promise.then(() => 'registered' as const), bound]);
  clearTimeout(timer);
  if (outcome === 'timed-out') {
    console.warn(`[mcp] the start-up registration of the MCP servers has not ended after ${Math.round(maxMs / 1000)} s: this launch goes on with the configs as they are`);
  }
  return outcome;
}
