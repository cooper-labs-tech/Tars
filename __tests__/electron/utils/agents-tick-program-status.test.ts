import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * AgentStatus.programStatus on agents:tick (services/program-status, 2.0.5): the window reads an agent's full record
 * only on a count change, an error or a stop, so what the CLI said of itself over OSC 7501 reaches it on the tick,
 * which every chunk of the terminal schedules.
 *
 * How it fails, written before the code:
 * 1. The tick names its fields one by one and leaves programStatus out: the window never sees a blocked state, on a
 *    CLI with hooks (where only the record changes) or without.
 * 2. A blocked state reaches it without its kind or its message.
 * 3. A state the CLI cleared (a clear, a new shell prompt, a reset) stays on the tick: the card says blocked for an
 *    agent that is not.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-tick-program-status-'));
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json') };
});
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => tmp, getVersion: () => '2.0.5' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
  Notification: vi.fn(),
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: () => undefined }));

type AgentStatus = import('../../../electron/types').AgentStatus;
let manager: typeof import('../../../electron/core/agent-manager');
let tick: typeof import('../../../electron/utils/agents-tick');
let ps: typeof import('../../../electron/services/program-status');

const osc = (body: string) => `\x1b]7501;${body}\x07`;
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const terminal = { write: () => undefined };
const onTick = (id: string) => tick.buildTickPayload().find((a) => a.id === id) as (ReturnType<typeof tick.buildTickPayload>[number] & { programStatus?: unknown }) | undefined;

function agent(id: string, provider: string, status: AgentStatus['status']): AgentStatus {
  return { id, name: id, status, provider, ptyId: `pty-${id}`, projectPath: tmp, skills: [], output: [], lastActivity: new Date().toISOString() } as unknown as AgentStatus;
}

beforeEach(async () => {
  vi.resetModules();
  manager = await import('../../../electron/core/agent-manager');
  tick = await import('../../../electron/utils/agents-tick');
  ps = await import('../../../electron/services/program-status');
  manager.agents.clear();
});

describe('programStatus on agents:tick', () => {
  it('1, 2. carries a blocked state with its kind and message, on a CLI with hooks and on one without', () => {
    for (const [id, provider, status] of [['c', 'claude', 'running'], ['g', 'grok', 'idle']] as const) {
      const a = agent(id, provider, status);
      manager.agents.set(id, a);
      ps.readProgramStatus(a, a.ptyId!, terminal, osc(`state=blocked:kind=question:app=x:msg=${b64('Which branch?')}`));
      expect(onTick(id)?.programStatus).toMatchObject({ state: 'blocked', kind: 'question', msg: 'Which branch?' });
    }
  });

  it('3. drops a state the CLI cleared, by a clear or a new shell prompt', () => {
    const a = agent('g', 'grok', 'idle');
    manager.agents.set('g', a);
    ps.readProgramStatus(a, a.ptyId!, terminal, osc(`state=blocked:kind=auth:msg=${b64('Sign in')}`));
    expect(onTick('g')?.programStatus).toMatchObject({ state: 'blocked', kind: 'auth' });
    ps.readProgramStatus(a, a.ptyId!, terminal, osc('state=clear'));
    expect(onTick('g')?.programStatus).toBeUndefined();
    ps.readProgramStatus(a, a.ptyId!, terminal, osc('state=working'));
    expect(onTick('g')?.programStatus).toMatchObject({ state: 'working' });
    ps.readProgramStatus(a, a.ptyId!, terminal, '\x1b]133;A\x07');
    expect(onTick('g')?.programStatus).toBeUndefined();
  });
});
