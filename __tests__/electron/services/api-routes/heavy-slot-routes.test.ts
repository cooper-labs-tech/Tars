import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The heavy-run slot's ask route (POST /api/heavy-slot/ask) with the shared MCP servers (2.0.5, #537 with #541, the
 * orchestrator's decision for the train): heavy_slot_take ran in the agent's own copy of the orchestrator server,
 * a child of its CLI, and leased `process.ppid`, the CLI. Shared, the server is Tars's child: its parent is Tars.
 *
 * How it fails, written before the code (28/10):
 * S1. The tool's ask (`untilTurnEnds`) leases the pid the server sends: Tars's own process from a shared server, which
 *     is refused (H13), or any pid a caller names. It must lease the asking agent's terminal, resolved from its token,
 *     whatever pid comes with it or none.
 * S2. An agent with no terminal gets a lease on nothing: refused, as before.
 * S3. A `tars-slot run` ask, held by its own run's process, loses its pid to the terminal's: its lease would then
 *     outlive the run and end with the turn. It keeps the pid it sends.
 */

const { fleet, terminals, asked } = vi.hoisted(() => ({
  fleet: new Map<string, Record<string, unknown>>(),
  terminals: new Map<string, { pid: number }>(),
  asked: [] as Array<Record<string, unknown>>,
}));
vi.mock('../../../../electron/core/agent-manager', () => ({ agents: fleet }));
vi.mock('../../../../electron/core/pty-manager', () => ({ ptyProcesses: terminals }));
vi.mock('../../../../electron/core/agent-role', () => ({ hasOrchestratorPowers: () => false }));
vi.mock('../../../../electron/services/heavy-slot-runtime', () => ({
  askSlot: async (a: Record<string, unknown>) => { asked.push(a); return { id: 't1', granted: true }; },
  giveSlotBack: vi.fn(), slotStatus: vi.fn(), slotTicketOf: vi.fn(),
}));

import { registerHeavySlotRoutes } from '../../../../electron/services/api-routes/heavy-slot-routes';

async function ask(body: Record<string, unknown>, callerAgentId = 'a') {
  const routes: Array<{ pattern: unknown; handler: (...x: unknown[]) => unknown }> = [];
  registerHeavySlotRoutes({ post: (p: unknown, h: never) => routes.push({ pattern: p, handler: h }), get: () => undefined } as never);
  const route = routes.find(r => r.pattern === '/api/heavy-slot/ask')!;
  let answer: { body: Record<string, unknown>; status: number } = { body: {}, status: 0 };
  await route.handler({ body, callerAgentId, params: {}, headers: {} }, (b: Record<string, unknown>, s?: number) => { answer = { body: b, status: s ?? 200 }; });
  return answer;
}

beforeEach(() => {
  asked.length = 0;
  fleet.clear();
  terminals.clear();
  fleet.set('a', { id: 'a', name: 'Harbor Worker', projectPath: '/w/harbor', ptyId: 'pty-a' });
  fleet.set('n', { id: 'n', name: 'No Terminal', projectPath: '/w/harbor' });
  terminals.set('pty-a', { pid: 4100 });
});

describe('the ask route and the shared servers', () => {
  it('S1. the tool\'s ask leases the agent\'s terminal, whatever pid comes with it, or none', async () => {
    for (const body of [{ pid: process.pid, untilTurnEnds: true }, { untilTurnEnds: true }, { pid: 77, untilTurnEnds: true }]) {
      expect((await ask(body)).status, JSON.stringify(body)).toBe(200);
    }
    expect(asked.map(a => [a.pid, a.untilTurnEnds])).toEqual([[4100, true], [4100, true], [4100, true]]);
  });

  it('S2. an agent with no terminal is refused', async () => {
    expect((await ask({ untilTurnEnds: true }, 'n')).status).toBe(403);
    expect(asked).toEqual([]);
  });

  it('S3. a tars-slot run keeps its own pid', async () => {
    expect((await ask({ pid: 4123, label: 'npm test' })).status).toBe(200);
    expect(asked[0]).toMatchObject({ pid: 4123, untilTurnEnds: false });
  });
});
