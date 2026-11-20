/**
 * The terminal agent:start opens for a local model (Tasmania) says its end to
 * the window only while it is the agent's (the follow-ups of 06/10, after #323
 * and #329; electron/handlers/ipc-handlers.ts).
 *
 * #323 stopped a replaced terminal's agent:complete in initAgentPty; this path
 * opens its own terminal, guarded the status the same way, and still sent the
 * agent:complete whatever the answer: a stop clears the agent's terminal
 * before it ends it, and the window read that exit as the agent's task done.
 * Since #329 the window fetches the fleet on the stop's own status event, so
 * nothing needs it.
 *
 * How it fails, written before the code (2026-10-06):
 * 1. The terminal a stop ended (the agent having no terminal) sends
 *    agent:complete, or changes the agent's status.
 * 2. A terminal the agent has replaced sends it.
 * 3. Over-correction: the agent's own terminal ending no longer does.
 *
 * The handler is the real one; node-pty and Tasmania's status are replaced.
 */
import '../../setup/home-guard';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The terminal these hold is darwin and linux's: the local switch's shell,
// which the launch is typed into and which is then the agent's own. On a
// Windows host they read it as linux; on win32 that shell is killed for the
// CLI started in its place (held by launch-call-sites.test.ts, 8), and the
// CLI's terminal ends as initAgentPty's (exit-of-a-replaced-terminal.test.ts).
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-local-exit-${process.pid}-${Date.now()}`,
}));

type Exit = (event: { exitCode: number }) => void;
type FakePty = { pid: number; process: string; exits: Exit[]; write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };
const spawned = vi.hoisted(() => [] as FakePty[]);
const fakePty = (): FakePty => {
  const exits: Exit[] = [];
  return {
    pid: 4242, process: 'bash', exits, write: vi.fn(), kill: vi.fn(),
    // @ts-expect-error the rest of node-pty's surface, as far as Tars reads it
    onData: vi.fn(() => ({ dispose() {} })), onExit: vi.fn((fn: Exit) => { exits.push(fn); return { dispose() {} }; }), resize: vi.fn(),
  };
};

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn(() => { const t = fakePty(); spawned.push(t); return t; }) }));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.3', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: Record<string, unknown>) => { sent.push({ channel, payload }); },
}));
vi.mock('../../../electron/services/tasmania-client', () => ({
  getTasmaniaStatus: vi.fn(async () => ({ status: 'running', endpoint: 'http://127.0.0.1:9/v1', modelName: 'local-model' })),
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const project = path.join(tmpHome, 'project');

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = { agents, ptyProcesses, saveAgents: vi.fn(), getAppSettings: () => ({} as AppSettings) };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

const completes = () => sent.filter(s => s.channel === 'agent:complete');

/** A local agent at its shell, started: agent:start opens it a new terminal. Returns that terminal and its id. */
async function startedOnLocal(): Promise<{ agent: AgentStatus; terminal: FakePty; ptyId: string }> {
  const old = fakePty();
  ptyProcesses.set('pty-old', old as never);
  const agent = {
    id: 'a1', name: 'Local', status: 'idle', provider: 'local', localModel: 'local-model', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(), ptyId: 'pty-old', ptyCwd: project, permissionMode: 'bypass',
  } as unknown as AgentStatus;
  agents.set('a1', agent);
  const launch = handlers.get('agent:start')!({}, { id: 'a1', prompt: '', options: {} });
  await vi.advanceTimersByTimeAsync(2000);
  await launch.catch(() => undefined);
  const terminal = spawned[spawned.length - 1];
  expect(terminal, 'agent:start opened no terminal for the local model').toBeDefined();
  expect(agent.ptyId).not.toBe('pty-old');
  sent.length = 0;
  return { agent, terminal, ptyId: agent.ptyId! };
}
const exit = (t: FakePty, exitCode: number) => { for (const fn of t.exits) fn({ exitCode }); };

beforeEach(() => {
  vi.useFakeTimers();
  fs.mkdirSync(project, { recursive: true });
  handlers.clear();
  sent.length = 0;
  spawned.length = 0;
  agents.clear();
  ptyProcesses.clear();
  registerIpcHandlers(deps());
});

afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
});

describe("the end of the terminal agent:start opened for a local model", () => {
  it('1. after a stop cleared it, sends no agent:complete and leaves the agent stopped', async () => {
    const { agent, terminal } = await startedOnLocal();
    agent.ptyId = undefined;
    agent.status = 'stopped';

    exit(terminal, 0);

    expect(completes()).toEqual([]);
    expect(agent.status).toBe('stopped');
  });

  it('2. after the agent got another terminal, sends no agent:complete', async () => {
    const { agent, terminal } = await startedOnLocal();
    agent.ptyId = 'pty-next';
    agent.status = 'running';

    exit(terminal, 0);

    expect(completes()).toEqual([]);
    expect(agent.status).toBe('running');
  });

  it("3. of the agent's own terminal, is still its news", async () => {
    const { agent, terminal, ptyId } = await startedOnLocal();

    exit(terminal, 0);

    expect(completes()).toHaveLength(1);
    expect(completes()[0].payload).toMatchObject({ agentId: 'a1', ptyId, exitCode: 0 });
    expect(agent.status).toBe('completed');
  });
});
