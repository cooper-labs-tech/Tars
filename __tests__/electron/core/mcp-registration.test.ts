import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A launch waits for the start-up registration of the MCP servers (the Audit's L1 on #657).
 *
 * A CLI's line is built from the configs the registration writes: codex's switches from its config.toml
 * (services/mcp-roles.ts codexRoleArgs), gemini's allow-list from its settings, claude's worker file from
 * ~/.claude/mcp.json. At start-up Tars runs that registration without waiting for it (setupMcpOrchestrator, main.ts),
 * while the restart recovery, the bots and the API may already launch agents. A line built before it ends reads the
 * configs as they were: on a jump from 2.0.4 or older, codex's still holds Tars's Telegram entry, the worker's line
 * switches it off, retireTelegramMcp then takes the entry out before codex reads the file, and codex refuses to start
 * ("invalid transport"); on a first start, X registered after the line was built stays on for that worker. main.ts
 * said "Registration only has to finish before an agent starts"; nothing held a launch to it.
 *
 * How it fails, written before the code (2026-11-27):
 * 1. A launch issued while the registration runs goes on at once (the race).
 * 2. A launch waits when no registration is under way: in a test, or once it ended, every launch pays for nothing.
 * 3. A registration that never ends (a CLI that hangs while registering) holds every launch for good: the wait is
 *    bounded, and its end says so.
 * 4. A registration that failed holds launches: it ends the wait the same as one that succeeded.
 * 5. Every launch waiting is released by the one end, not only the first.
 */

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.useRealTimers(); });

async function gate() {
  return import('../../../electron/core/mcp-registration');
}

describe('a launch and the start-up registration', () => {
  it('2. with no registration under way, a launch goes on at once', async () => {
    const { untilMcpRegistered } = await gate();
    await expect(untilMcpRegistered()).resolves.toBe('open');
  });

  it('1, 5. while the registration runs, every launch waits, and its end releases them all', async () => {
    const { mcpRegistrationBegins, mcpRegistrationEnds, untilMcpRegistered } = await gate();
    mcpRegistrationBegins();
    const released: string[] = [];
    const first = untilMcpRegistered().then((how) => { released.push(`first:${how}`); });
    const second = untilMcpRegistered().then((how) => { released.push(`second:${how}`); });
    await new Promise((r) => setTimeout(r, 30));
    expect(released, 'a launch went on while the registration ran').toEqual([]);
    mcpRegistrationEnds();
    await Promise.all([first, second]);
    expect(released.sort()).toEqual(['first:registered', 'second:registered']);
  });

  it('2. once the registration ended, a launch goes on at once, and a later begin holds nothing', async () => {
    const { mcpRegistrationBegins, mcpRegistrationEnds, untilMcpRegistered } = await gate();
    mcpRegistrationBegins();
    mcpRegistrationEnds();
    await expect(untilMcpRegistered()).resolves.toBe('open');
    mcpRegistrationBegins();
    await expect(untilMcpRegistered()).resolves.toBe('open');
  });

  it('3. a registration that never ends holds a launch for the bound only, and says so', async () => {
    vi.useFakeTimers();
    const { mcpRegistrationBegins, untilMcpRegistered, MCP_REGISTRATION_WAIT_MS } = await gate();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mcpRegistrationBegins();
    let outcome: string | undefined;
    void untilMcpRegistered().then((how) => { outcome = how; });
    await vi.advanceTimersByTimeAsync(MCP_REGISTRATION_WAIT_MS - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('timed-out');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('registration'));
    warn.mockRestore();
  });

  it('4. an end is an end, whatever the registration did: a failed one releases the launches too', async () => {
    const { mcpRegistrationBegins, mcpRegistrationEnds, untilMcpRegistered } = await gate();
    mcpRegistrationBegins();
    const waiting = untilMcpRegistered();
    // setupMcpOrchestrator ends it in a finally, after a throw as after a success.
    try { throw new Error('a CLI could not register'); } catch { /* logged by the caller */ } finally { mcpRegistrationEnds(); }
    await expect(waiting).resolves.toBe('registered');
  });
});
