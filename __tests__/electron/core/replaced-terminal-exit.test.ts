import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The exit of a terminal an agent no longer names is not the agent finishing.
 *
 * A start replaces an agent's terminal: on Windows every start kills the shell
 * the agent waited in and opens its CLI in its place (decision D2), and on
 * every platform a restart or the local switch kills the old terminal. That
 * old terminal's exit arrives after, and it used to broadcast `agent:complete`
 * whatever the agent then named: the Kanban board (useElectronKanban, which
 * reads onComplete as "the task is done") moved the task the new CLI was just
 * starting into Done. The board's own agents (main.ts, created by the Kanban
 * automation) also set their status from it, until upstream 1.9.3 removed the
 * board and its automation.
 *
 * How it fails, written before the code (2026-09-25, win-reviewer's CHANGES):
 * 1. initAgentPty's exit broadcasts `agent:complete` (or sets a status) for a
 *    terminal the agent no longer names.
 * 2. It stops broadcasting it for the terminal the agent does name: the
 *    completion the windows read the agent back on (useElectron) is lost.
 * 3. (The board agent's exit in main.ts: gone with the old local Kanban board
 *    in upstream 1.9.3, and its case with it.)
 * 4. On Windows a start kills the shell an agent waits in although a CLI was
 *    typed there by hand and registered its session from it: the live
 *    session is ended without the tombstone spawnAgentSession lays, and its
 *    hooks go on posting into the new one. A session left over from an older
 *    terminal must not block the start.
 */

type ExitListener = (e: { exitCode: number; signal?: number }) => void;
type FakePty = {
  file: string;
  args: string[] | string;
  opts: { cwd: string; env: Record<string, string>; name: string };
  pid: number;
  process: string;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  exit(code: number): void;
};

const spawned: FakePty[] = [];
const broadcasts: Array<{ channel: string; payload: Record<string, unknown> }> = [];

vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string, args: string[] | string, opts: FakePty['opts']) => {
    const exits: ExitListener[] = [];
    const terminal: FakePty = {
      file, args, opts, pid: 8000 + spawned.length, process: opts.name,
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(() => ({ dispose() {} })),
      onExit: vi.fn((listener: ExitListener) => { exits.push(listener); return { dispose() {} }; }),
      exit: (exitCode) => { for (const listener of exits) listener({ exitCode, signal: 0 }); },
    };
    spawned.push(terminal);
    return terminal;
  }),
}));
let uuid = 0;
vi.mock('uuid', () => ({ v4: vi.fn(() => `uuid-${++uuid}`) }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: Record<string, unknown>) => { broadcasts.push({ channel, payload }); },
}));
vi.mock('../../../electron/utils/agents-tick', () => ({ scheduleTick: vi.fn() }));
vi.mock('../../../electron/services/agent-events', () => ({ emitAgentStatus: vi.fn() }));
vi.mock('../../../electron/services/tasmania-client', () => ({
  getTasmaniaStatus: vi.fn(async () => ({ status: 'stopped' })),
}));
vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { initAgentPty, agents, startCliInTerminal } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { toLaunch, type DirectLaunch } from '../../../electron/platform/launch';
import type { FsProbe } from '../../../electron/platform/fs-probe';
import type { AgentStatus } from '../../../electron/types';
import { moveTestHome } from '../../setup/test-home';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-replaced-exit-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-replaced-exit-project-'));
let restoreHome: () => void;

const CLAUDE_EXE = 'C:\\Users\\Sam Lee\\.local\\bin\\claude.exe';
const disk: FsProbe = {
  isFile: (p) => p.toLowerCase() === CLAUDE_EXE.toLowerCase(),
  readFile: (p) => { throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' }); },
};

function agentNamed(id: string): AgentStatus {
  const agent = {
    id, name: id, status: 'idle', provider: 'claude', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(),
  } as AgentStatus;
  agents.set(id, agent);
  return agent;
}

function launchFor(agent: AgentStatus): DirectLaunch {
  return toLaunch("'claude' -- 'the task'", project, { Path: 'C:\\Users\\Sam Lee\\.local\\bin', CLAUDE_AGENT_ID: agent.id }, 'win32', { fs: disk }) as DirectLaunch;
}

const completes = (ptyId?: string) => broadcasts.filter(b => b.channel === 'agent:complete' && (ptyId === undefined || b.payload.ptyId === ptyId));

beforeEach(() => {
  spawned.length = 0;
  broadcasts.length = 0;
  agents.clear();
  ptyProcesses.clear();
  restoreHome = moveTestHome(home);
});

afterEach(() => {
  restoreHome();
});

describe('an agent terminal opened by initAgentPty', () => {
  it('1. once replaced, exits without a completion and without touching the agent', async () => {
    const agent = agentNamed('agent-restarted');
    const notify = vi.fn();
    const oldId = await initAgentPty(agent, null, notify, vi.fn());
    agent.ptyId = 'the-terminal-that-replaced-it';

    spawned[0].exit(1);

    expect(completes(oldId), 'the replaced terminal announced a completion').toEqual([]);
    expect(agent.status).toBe('idle');
    expect(notify).not.toHaveBeenCalled();
    expect(ptyProcesses.has(oldId)).toBe(false);
  });

  it('2. still announces the exit of the terminal the agent names', async () => {
    const agent = agentNamed('agent-finished');
    const notify = vi.fn();
    agent.ptyId = await initAgentPty(agent, null, notify, vi.fn());

    spawned[0].exit(0);

    expect(completes(agent.ptyId)).toHaveLength(1);
    expect(completes(agent.ptyId)[0].payload).toMatchObject({ agentId: agent.id, exitCode: 0 });
    expect(agent.status).toBe('completed');
    expect(notify).toHaveBeenCalledWith(agent, 'completed');
  });

  it('1, 2. on Windows: the killed shell says nothing, the CLI that replaced it does', async () => {
    const agent = agentNamed('agent-windows-start');
    const open = (a: AgentStatus) => initAgentPty(a, null, vi.fn(), vi.fn());
    agent.ptyId = await open(agent);
    const shellId = agent.ptyId;

    await startCliInTerminal(agent, launchFor(agent), { ptyProcesses, initAgentPty: open });
    spawned[0].exit(1);
    expect(completes(shellId), 'the shell a start killed announced a completion').toEqual([]);
    expect(agent.status).toBe('idle');

    spawned[1].exit(0);
    expect(completes(agent.ptyId)).toHaveLength(1);
  });
});

describe('a start on Windows, with a CLI typed by hand into the waiting shell', () => {
  async function waitingShell(id: string): Promise<{ agent: AgentStatus; open: (a: AgentStatus) => Promise<string> }> {
    const agent = agentNamed(id);
    const open = (a: AgentStatus) => initAgentPty(a, null, vi.fn(), vi.fn());
    agent.ptyId = await open(agent);
    return { agent, open };
  }

  it('4. refuses to kill a shell a session registered from, and leaves everything as it was', async () => {
    const { agent, open } = await waitingShell('agent-typed-by-hand');
    const shellId = agent.ptyId!;
    // What the SessionStart hook of a claude typed into that shell records.
    agent.currentSessionId = '11111111-2222-4333-8444-555555555555';
    agent.sessionPtyId = shellId;

    await expect(startCliInTerminal(agent, launchFor(agent), { ptyProcesses, initAgentPty: open }))
      .rejects.toThrow(/typed into its terminal.*stop the agent/i);

    expect(spawned[0].kill).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
    expect(agent.ptyId).toBe(shellId);
    expect(ptyProcesses.get(shellId)).toBe(spawned[0]);
    expect(agent.currentSessionId).toBe('11111111-2222-4333-8444-555555555555');
    expect(agent.lastKilledSessionId).toBeUndefined();
  });

  it('4. starts when the session was registered from an older terminal', async () => {
    const { agent, open } = await waitingShell('agent-after-its-cli-ended');
    agent.currentSessionId = '11111111-2222-4333-8444-555555555555';
    agent.sessionPtyId = 'the-cli-that-exited';

    await startCliInTerminal(agent, launchFor(agent), { ptyProcesses, initAgentPty: open });

    expect(spawned[0].kill).toHaveBeenCalledTimes(1);
    expect(ptyProcesses.get(agent.ptyId!)).toBe(spawned[1]);
  });
});
