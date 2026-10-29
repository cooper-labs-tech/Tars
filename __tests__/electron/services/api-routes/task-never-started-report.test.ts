import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';

/**
 * A task that never started, reported (2.0.4, F1 and F3 of the maintainer's go of 2026-10-18): when an agent's tool
 * delivered it, as that tool's error (`never-started`, the tool, the CLI); when the window or a bot did, as an error
 * Tars handled. The setup is task-never-started.test.ts's: the real dispatch, the real watch, fake timers.
 *
 * How it fails, written before the code (2026-10-19):
 * 1. A task an agent's MCP call delivered (delegate_task, through the API) never starts and nothing is reported, or it
 *    is reported without its tool, or as any tool but the one the call named.
 * 2. One the window started is reported as an agent's tool error (no agent called a tool), or not at all.
 * 3. The agent's name or the task's words are in what is reported.
 * 4. Over-correction: a task that did start is reported.
 */

const mockPtys: { onData: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }[] = [];
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const inst = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() };
    mockPtys.push(inst);
    return inst;
  }),
}));

let uuidCounter = 0;
vi.mock('uuid', () => ({ v4: vi.fn(() => `pty-${++uuidCounter}`) }));

vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test', getAppPath: () => process.cwd() },
  BrowserWindow: vi.fn(),
}));

// agent-manager is the real module now: armTaskStartWatch lives in it, so
// mocking it away would mock away the thing under test. Only the pieces that
// reach outside the process are stubbed.
vi.mock('../../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => broadcasts.push({ channel, payload }),
}));

vi.mock('../../../../electron/core/pty-manager', () => ({
  launchPrompt: (_sender: unknown, data: string) => data,
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
}));

/** Every IPC broadcast the main process made, which is what the windows see. */
const broadcasts: { channel: string; payload: unknown }[] = [];

vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));
vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));

import * as pty from 'node-pty';
import { performDispatch } from '../../../../electron/services/api-routes/agent-routes';
import { resetLaunches } from '../../../../electron/core/agent-launch';
import { agents, noteSessionRegistered, noteTurnStarted } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import type { RouteContext } from '../../../../electron/services/api-routes/types';
import { AgentStatus, AppSettings } from '../../../../electron/types';
import { inApiCall } from '../../../../electron/services/api-routes/call-context';
import { setReportSinks } from '../../../../electron/services/error-reports/handled';

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });

/** Comfortably past the ten minute grace period, plus the tick's own delay. */
const PAST_THE_GRACE = 700_000;
const NAME = 'Zephyrine';
const TASK = 'refactor the billing module for Acme Corp';

let ctx: RouteContext;
let handled: Error[];
let toolErrors: Array<{ code: string; tool: string; cli: string }>;

beforeEach(() => {
  resetLaunches();
  agents.clear();
  ptyProcesses.clear();
  mockPtys.length = 0;
  uuidCounter = 0;
  broadcasts.length = 0;
  vi.mocked(pty.spawn).mockClear();
  handled = [];
  toolErrors = [];
  setReportSinks({ handled: e => handled.push(e), agentTool: e => toolErrors.push(e) });
  ctx = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
    appSettings: {} as AppSettings,
    getAppSettings: () => ({} as AppSettings),
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'new-pty-id'),
    agentStatusEmitter: new EventEmitter(),
  } as RouteContext;
});

afterEach(() => {
  vi.useRealTimers();
  setReportSinks(null);
});

function putAgent(over: Partial<AgentStatus> & { id: string }): AgentStatus {
  const agent = { status: 'idle', projectPath: process.cwd(), skills: [], output: [], lastActivity: new Date().toISOString(), ...over } as AgentStatus;
  agents.set(agent.id, agent);
  return agent;
}

async function dispatchThenWait(agent: AgentStatus, call?: { tool?: string; fromMcp: boolean; agentId?: string }, during?: () => void): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const dispatch = () => performDispatch(agent, { message: TASK }, ctx, vi.fn());
    await (call ? inApiCall(call, dispatch) : dispatch());
    during?.();
    await vi.advanceTimersByTimeAsync(PAST_THE_GRACE);
  } finally {
    vi.useRealTimers();
  }
}

describe('a task that never started, reported', () => {
  it("1, 3. delivered by an agent's tool: that tool's error, its code, its tool, the CLI, nothing else", async () => {
    const agent = putAgent({ id: 'w1', name: NAME, provider: 'claude' });
    await dispatchThenWait(agent, { tool: 'delegate_task', fromMcp: true, agentId: 'lead' });
    expect(agent.status).toBe('error');
    expect(toolErrors).toEqual([{ code: 'never-started', tool: 'delegate_task', cli: 'claude' }]);
    expect(handled).toEqual([]);
    expect(JSON.stringify(toolErrors)).not.toMatch(new RegExp(`${NAME}|Acme`));
  });

  it("2, 3. started from the window: an error Tars handled, named by the CLI, without the agent's name or the task", async () => {
    const agent = putAgent({ id: 'w2', name: NAME, provider: 'claude' });
    await dispatchThenWait(agent);
    expect(toolErrors).toEqual([]);
    expect(handled).toHaveLength(1);
    expect(handled[0].name).toBe('TaskNeverStarted');
    expect(handled[0].message).toBe('claude: the task never started, 600 s after it was sent');
  });

  it('4. a task that started is not reported', async () => {
    const agent = putAgent({ id: 'w3', name: NAME, provider: 'claude' });
    await dispatchThenWait(agent, { tool: 'delegate_task', fromMcp: true, agentId: 'lead' }, () => {
      agent.currentSessionId = 'b0f3a2c4-5d6e-4f70-8a91-b2c3d4e5f607';
      agent.sessionRegisteredAt = new Date(Date.now() + 1_000).toISOString();
      noteSessionRegistered(agent);
      noteTurnStarted(agent);
    });
    expect(toolErrors).toEqual([]);
    expect(handled).toEqual([]);
  });
});
