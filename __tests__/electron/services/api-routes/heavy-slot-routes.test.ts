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
 * And who may ask for `gate`, a release gate's priority (2.0.7, the Audit's L1 on #579: an orchestrator no longer runs
 * the work, its QA runs the gate):
 * S4. The agent its project's orchestrator handed the work to as a gate (its live requestedBy link, `gate`) is clamped
 *     to `normal`.
 * S8. (The Audit's L4 on #579.) Any work an orchestrator handed, not as a gate, lets its worker put any run first.
 * S5. A worker whose work came from another worker, or from another project's orchestrator, may take it.
 * S6. A link left from another terminal (a past session's) still counts.
 * S7. The orchestrator itself, or a chat's runner, loses it.
 */

const { fleet, terminals, asked } = vi.hoisted(() => ({
  fleet: new Map<string, Record<string, unknown>>(),
  terminals: new Map<string, { pid: number }>(),
  asked: [] as Array<Record<string, unknown>>,
}));
vi.mock('../../../../electron/core/agent-manager', () => ({ agents: fleet }));
vi.mock('../../../../electron/core/pty-manager', () => ({ ptyProcesses: terminals }));
vi.mock('../../../../electron/core/agent-role', () => ({ hasOrchestratorPowers: (a: { role?: string; kind?: string }) => a.role === 'orchestrator' || a.kind === 'chat' }));
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

describe('who may ask for a release gate\'s priority', () => {
  beforeEach(() => {
    fleet.set('lead', { id: 'lead', name: 'Harbor Lead', role: 'orchestrator', projectPath: '/w/harbor', ptyId: 'pty-lead' });
    fleet.set('other-lead', { id: 'other-lead', name: 'Dock Lead', role: 'orchestrator', projectPath: '/w/dock' });
    fleet.set('peer', { id: 'peer', name: 'Harbor Peer', role: 'worker', projectPath: '/w/harbor' });
    fleet.set('runner', { id: 'runner', name: 'Harbor chat', role: 'worker', kind: 'chat', projectPath: '/w/harbor', ptyId: 'pty-runner' });
    terminals.set('pty-lead', { pid: 4200 });
    terminals.set('pty-runner', { pid: 4300 });
  });
  const gateBy = async (caller: string) => {
    asked.length = 0;
    expect((await ask({ pid: terminals.get(fleet.get(caller)!.ptyId as string)!.pid + 1, priority: 'gate' }, caller)).status).toBe(200);
    return asked[0].mayGate;
  };

  it('S4. the agent its project\'s orchestrator handed the work to as a gate may take it', async () => {
    fleet.get('a')!.requestedBy = { agentId: 'lead', ptyId: 'pty-a', gate: true };
    expect(await gateBy('a')).toBe(true);
  });

  it('S8. work its orchestrator handed, not as a gate, does not put a run first', async () => {
    fleet.get('a')!.requestedBy = { agentId: 'lead', ptyId: 'pty-a' };
    expect(await gateBy('a')).toBe(false);
  });

  it('S5. work from another worker, or from another project\'s orchestrator, is not a gate', async () => {
    fleet.get('a')!.requestedBy = { agentId: 'peer', ptyId: 'pty-a', gate: true };
    expect(await gateBy('a')).toBe(false);
    fleet.get('a')!.requestedBy = { agentId: 'other-lead', ptyId: 'pty-a', gate: true };
    expect(await gateBy('a')).toBe(false);
    delete fleet.get('a')!.requestedBy;
    expect(await gateBy('a')).toBe(false);
  });

  it('S6. a link left from a past session\'s terminal does not count', async () => {
    fleet.get('a')!.requestedBy = { agentId: 'lead', ptyId: 'pty-gone', gate: true };
    expect(await gateBy('a')).toBe(false);
  });

  it('S7. the orchestrator itself, and a chat\'s runner, keep it', async () => {
    expect(await gateBy('lead')).toBe(true);
    expect(await gateBy('runner')).toBe(true);
  });
});
