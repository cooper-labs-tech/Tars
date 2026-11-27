import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * AgentStatus.launching: the launch window main tracks since #134 (#159,
 * the Chat's direction A, the `starting` word).
 *
 * How it fails, written before the code (2026-09-24):
 * 1. The renderer infers "starting" from the status, which does not move when
 *    a launch begins (a restart keeps `idle`, a start from a window sets
 *    `running` before any CLI exists): it has to be the window main keeps,
 *    sessionStarting, not a guess beside it.
 * 2. It is sent only with a status change, so a launch that begins or ends
 *    without one (a restart, a launch given up after 15 s) is never heard of,
 *    and the word stays or never shows.
 * 3. It keeps saying starting after the launch was given up, or after the
 *    session came up (SessionStart), until something unrelated ticks.
 * 4. (2026-11-27, the Audit's L-a on #657, written before the code) A launch
 *    held for the start-up registration of the MCP servers
 *    (core/mcp-registration.ts) is begun before it waits: its 15 s run out
 *    while it still waits, the card goes back to its earlier state with nothing
 *    said, and a /dispatch or a message then no longer sees it starting (the
 *    session started over a launch of 23/09). It reads starting while the
 *    registration is under way, and has its 15 s from the moment the gate
 *    opened, by the registration's end or by the bound.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-launching-'));
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json') };
});
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => tmp, getVersion: () => '1.8.0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));
const pushed = vi.hoisted(() => [] as Array<{ channel: string; payload: unknown }>);
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { pushed.push({ channel, payload }); },
}));

type AgentStatus = import('../../../electron/types').AgentStatus;
let manager: typeof import('../../../electron/core/agent-manager');
let launch: typeof import('../../../electron/core/agent-launch');

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-09-24T09:00:00.000Z') });
  pushed.length = 0;
  vi.resetModules();
  manager = await import('../../../electron/core/agent-manager');
  launch = await import('../../../electron/core/agent-launch');
  await import('../../../electron/utils/agents-tick');
  manager.agents.clear();
  launch.resetLaunches();
  manager.agents.set('a', {
    id: 'a', name: 'A', status: 'idle', projectPath: tmp, output: [], skills: [], provider: 'claude',
    lastActivity: new Date().toISOString(),
  } as AgentStatus);
});

afterEach(() => {
  manager.stopAgentAutosave();
  vi.useRealTimers();
});

/** What the last agents:tick said about agent a. */
const lastTick = () => (pushed.filter(p => p.channel === 'agents:tick').at(-1)?.payload as Array<{ id: string; launching?: boolean }> | undefined)
  ?.find(t => t.id === 'a');

describe('an agent whose launch is on its way', () => {
  it('reads launching on agents:tick as soon as the launch begins, with no status change', async () => {
    launch.launchBegins('a');
    await vi.advanceTimersByTimeAsync(600);

    expect(lastTick()?.launching).toBe(true);
    expect(manager.agents.get('a')!.status).toBe('idle');
  });

  it('stops reading launching once the launch is given up, told by a tick of its own', async () => {
    const l = launch.launchBegins('a');
    await vi.advanceTimersByTimeAsync(600);
    launch.launchAbandoned('a', l);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(lastTick()?.launching).toBe(false);
  });

  it('stops reading launching when the window closes on its own, 15 s on with no CLI', async () => {
    launch.launchBegins('a');
    await vi.advanceTimersByTimeAsync(600);
    expect(lastTick()?.launching).toBe(true);

    await vi.advanceTimersByTimeAsync(16_000);

    expect(lastTick()?.launching).toBe(false);
  });

  it('4. reads launching while the start-up registration holds it past 15 s, then 15 s from the gate\'s opening', async () => {
    const gate = await import('../../../electron/core/mcp-registration');
    gate.mcpRegistrationBegins();
    launch.launchBegins('a');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lastTick()?.launching, 'the card dropped a launch still waiting for the registration').toBe(true);
    expect(launch.sessionStarting(manager.agents.get('a')!), 'a dispatch would start a session over the launch').toBe(true);

    gate.mcpRegistrationEnds();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(launch.sessionStarting(manager.agents.get('a')!)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(launch.sessionStarting(manager.agents.get('a')!), 'no CLI 15 s after the gate opened: given up').toBe(false);
    expect(lastTick()?.launching).toBe(false);
  });

  it('4. reads launching for the whole bound of a registration that never ends, then 15 s', async () => {
    const gate = await import('../../../electron/core/mcp-registration');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    gate.mcpRegistrationBegins();
    launch.launchBegins('a');
    await vi.advanceTimersByTimeAsync(gate.MCP_REGISTRATION_WAIT_MS - 1_000);
    expect(launch.sessionStarting(manager.agents.get('a')!)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000 + 14_000);
    expect(launch.sessionStarting(manager.agents.get('a')!), 'the launch goes on at the bound: its 15 s start there').toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(launch.sessionStarting(manager.agents.get('a')!)).toBe(false);
  });

  it('is false for an agent nobody is launching', async () => {
    const { scheduleTick } = await import('../../../electron/utils/agents-tick');
    scheduleTick();
    await vi.advanceTimersByTimeAsync(600);

    expect(lastTick()?.launching).toBe(false);
  });
});
