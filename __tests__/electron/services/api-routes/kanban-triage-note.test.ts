import '../../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The note the error triage sends a project's orchestrator when it has filed
 * Sentry's errors on that project's board (services/error-triage.ts). It is
 * Tars's own note, typed through the kanban's queue like the landing note of a
 * task an agent filed.
 *
 * How it can fail, written before the code:
 * 1. it reaches another project's orchestrator, or a worker of the project;
 * 2. it is typed under an agent's name, or under any sender but Tars;
 * 3. it is typed mid-turn or into a permission dialog, or it starts an
 *    orchestrator whose CLI is not running: it is never typed then, and never
 *    starts anybody;
 * 4. a project named with a trailing slash reaches nobody, or a project with
 *    no orchestrator throws.
 * 5. it says the note went when nobody got it: an orchestrator whose CLI does
 *    not run, or none at all, must be told apart from a note typed, so that the
 *    error triage keeps the note it owes (since the user's go-ahead,
 *    DESIGN-RELAIS-HERMES-V2.md on #242).
 * 6. it says the note went before it is in the terminal (the Audit's gate of
 *    #292): held in memory for a turn's end, which a quit of Tars loses; a
 *    dispatch refused (a CLI still starting, a dialog); or a message waiting in
 *    the terminal's queue behind a draft, until it is written. Only a note
 *    written into the terminal is "typed"; anything else is "not-now", and the
 *    triage's own list, on disk, gives it again at the next rest.
 */

vi.mock('../../../../electron/core/agent-manager', () => ({ agents: new Map(), saveAgents: vi.fn() }));
vi.mock('../../../../electron/utils/kanban-generate', () => ({ generateTaskFromPrompt: vi.fn() }));
vi.mock('../../../../electron/core/pty-manager', () => ({ ptyProcesses: new Map() }));
vi.mock('../../../../electron/core/agent-pty', () => ({ cliRunningIn: (pty: unknown) => !!pty }));
const dispatched = vi.hoisted(() => [] as Array<{ agentId: string; message: string; from: string; sender: unknown }>);
/** How the dispatch goes: written at once, refused, or held in the terminal's queue and then written or dropped. */
const dispatch = vi.hoisted(() => ({ mode: 'written' as 'written' | 'refused' | 'held' | 'gone', later: [] as Array<{ written(): void; dropped(): void }> }));
vi.mock('../../../../electron/services/api-routes/agent-routes', () => ({
  performDispatch: vi.fn(async (
    agent: { id: string },
    opts: { message: string; from: string; sender: unknown; onWritten?: () => void; onDropped?: () => void },
    _ctx: unknown, sendJson: (d: unknown, s?: number) => void,
  ) => {
    if (dispatch.mode === 'refused') return void sendJson({ error: 'still starting' }, 409);
    dispatched.push({ agentId: agent.id, message: opts.message, from: opts.from, sender: opts.sender });
    if (dispatch.mode === 'held') {
      dispatch.later.push({ written: () => opts.onWritten?.(), dropped: () => opts.onDropped?.() });
      return void sendJson({ success: true, mode: 'message', held: true }, 200);
    }
    // A terminal that refuses the write (gone, or its queue full) calls nobody back.
    if (dispatch.mode !== 'gone') opts.onWritten?.();
    sendJson({ success: true, mode: 'message' }, 200);
  }),
}));

import { registerKanbanRoutes, tellOrchestratorAsTars } from '../../../../electron/services/api-routes/kanban-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { agentStatusEmitter } from '../../../../electron/services/agent-events';
import type { RouteApp, RouteContext } from '../../../../electron/services/api-routes/types';
import type { AgentStatus } from '../../../../electron/types';

const TARS = '/work/tars';
const OTHER = '/work/other';
const NOTE = 'Sentry reported an error in Tars that nobody has looked at yet: kanban task t_1 (TARS-1), parked.';

function agent(id: string, projectPath: string, extra: Partial<AgentStatus> = {}): AgentStatus {
  return { id, name: id, projectPath, status: 'idle', ptyId: `pty-${id}`, ...extra } as AgentStatus;
}

function put(...list: AgentStatus[]) {
  for (const a of list) {
    agents.set(a.id, a);
    if (a.ptyId) (ptyProcesses as Map<string, unknown>).set(a.ptyId, { pid: 1 });
  }
}

beforeEach(() => {
  agents.clear();
  (ptyProcesses as Map<string, unknown>).clear();
  dispatched.length = 0;
  dispatch.mode = 'written';
  dispatch.later.length = 0;
  const app = { routes: [], add() {}, get() {}, post() {}, put() {}, delete() {} } as unknown as RouteApp;
  registerKanbanRoutes(app, {} as RouteContext);
});

describe("the error triage's note", () => {
  it("1, 2. reaches the project's orchestrator alone, as Tars", async () => {
    // The worker and the other project's orchestrator first: found first, they would be the ones told.
    put(
      agent('qa-tars', TARS, { role: 'worker' }),
      agent('orch-other', OTHER, { role: 'orchestrator' }),
      agent('orch-tars', TARS, { role: 'orchestrator' }),
    );

    expect(await tellOrchestratorAsTars(TARS, NOTE)).toBe('typed');

    expect(dispatched).toEqual([{ agentId: 'orch-tars', message: NOTE, from: 'Tars', sender: { kind: 'tars' } }]);
  });

  it('3, 6. mid-turn, it is not typed and not held: "not-now", and nothing is typed at the rest either', async () => {
    const orch = agent('orch-tars', TARS, { role: 'orchestrator', status: 'running' });
    put(orch);

    expect(await tellOrchestratorAsTars(TARS, NOTE)).toBe('not-now');

    orch.status = 'idle';
    agentStatusEmitter.emit('fleet-change', orch.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(dispatched).toEqual([]);
  });

  it('3, 6. in a permission dialog, the same', async () => {
    put(agent('orch-tars', TARS, { role: 'orchestrator', status: 'waiting', waitingReason: 'permission' }));

    expect(await tellOrchestratorAsTars(TARS, NOTE)).toBe('not-now');
    expect(dispatched).toEqual([]);
  });

  it('3. never starts an orchestrator whose CLI is not running', async () => {
    put(agent('orch-tars', TARS, { role: 'orchestrator', ptyId: undefined }));

    expect(await tellOrchestratorAsTars(TARS, NOTE), '5. not delivered: the triage keeps it').toBe('not-running');
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(dispatched).toEqual([]);
  });

  it('4. finds the orchestrator of a project named with a trailing slash, and does nothing where there is none', async () => {
    put(agent('orch-tars', TARS, { role: 'orchestrator' }));

    expect(await tellOrchestratorAsTars(OTHER, NOTE), '5. nobody to tell').toBe('no-orchestrator');
    expect(await tellOrchestratorAsTars(`${TARS}/`, NOTE)).toBe('typed');

    expect(dispatched.map(d => d.agentId)).toEqual(['orch-tars']);
  });

  it('6. a dispatch refused is "not-now"', async () => {
    put(agent('orch-tars', TARS, { role: 'orchestrator' }));
    dispatch.mode = 'refused';

    expect(await tellOrchestratorAsTars(TARS, NOTE)).toBe('not-now');
  });

  it('6. a write the terminal refuses, which calls nobody back, is "not-now", not a wait for ever', async () => {
    put(agent('orch-tars', TARS, { role: 'orchestrator' }));
    dispatch.mode = 'gone';

    expect(await tellOrchestratorAsTars(TARS, NOTE)).toBe('not-now');
  });

  it("6. held in the terminal's queue, it is \"typed\" when written, and \"not-now\" when dropped", async () => {
    put(agent('orch-tars', TARS, { role: 'orchestrator' }));
    dispatch.mode = 'held';

    let first: string | undefined;
    const written = tellOrchestratorAsTars(TARS, NOTE).then(d => { first = d; });
    await vi.waitFor(() => expect(dispatch.later).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(first, 'nothing said while it waits in the queue').toBeUndefined();
    dispatch.later[0].written();
    await written;
    expect(first).toBe('typed');

    const dropped = tellOrchestratorAsTars(TARS, NOTE);
    await vi.waitFor(() => expect(dispatch.later).toHaveLength(2));
    dispatch.later[1].dropped();
    expect(await dropped).toBe('not-now');
  });
});
