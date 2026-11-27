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
 * launch line waits for it first (untilMcpRegistered). Nothing under way (a test, a tool, or once it opened): no wait.
 *
 * The bound is the registration's own, from its begin (the Audit's L-b on #657): a registration that never ends opens
 * the gate once, at MCP_REGISTRATION_WAIT_MS, for every launch waiting then and every later one, and says so once.
 * Those launches go on with the configs as they are, which for a codex worker is the race this gate closes.
 *
 * The card reads it too (core/agent-launch.ts, sessionStarting): a launch waiting here is starting, and its boot time
 * counts from the moment the gate opened (the Audit's L-a on #657).
 */

/** How long after its begin a registration still holds launches, at most. */
export const MCP_REGISTRATION_WAIT_MS = 60_000;

type Opened = 'registered' | 'timed-out';

let running: { promise: Promise<Opened>; open: (how: Opened) => void; timer: ReturnType<typeof setTimeout> } | null = null;
let beganAt: number | undefined;
let openedAt: number | undefined;

/** Opens the gate: every launch waiting goes on, and every later one at once. */
function openGate(how: Opened): void {
  const was = running;
  if (!was) return;
  running = null;
  openedAt = Date.now();
  clearTimeout(was.timer);
  if (how === 'timed-out') {
    console.warn(`[mcp] the start-up registration of the MCP servers has not ended after ${Math.round(MCP_REGISTRATION_WAIT_MS / 1000)} s: launches go on with the configs as they are`);
  }
  was.open(how);
}

/** A registration begins: from now on, a launch waits for its end, or for its bound. One already under way is that one. */
export function mcpRegistrationBegins(): void {
  if (running) return;
  let open: (how: Opened) => void = () => {};
  const promise = new Promise<Opened>((resolve) => { open = resolve; });
  const timer = setTimeout(() => openGate('timed-out'), MCP_REGISTRATION_WAIT_MS);
  timer.unref?.();
  running = { promise, open, timer };
  beganAt = Date.now();
}

/** The registration ended, whether it registered everything or failed: every launch waiting goes on. */
export function mcpRegistrationEnds(): void {
  openGate('registered');
}

/**
 * Waits, before a launch builds its line, for a registration under way to end: 'registered' when it did, 'timed-out'
 * when its bound was reached first, 'open' at once when none is under way.
 */
export async function untilMcpRegistered(): Promise<'open' | Opened> {
  const current = running;
  if (!current) return 'open';
  return current.promise;
}

/** Whether a registration holds launches now. */
export function mcpRegistrationUnderWay(): boolean {
  return running !== null;
}

/** When the gate last opened, by the registration's end or by its bound; undefined before the first. */
export function mcpGateOpenedAt(): number | undefined {
  return openedAt;
}

/** When the last registration began; undefined before the first. */
export function mcpRegistrationBeganAt(): number | undefined {
  return beganAt;
}
