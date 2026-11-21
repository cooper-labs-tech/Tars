import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

/**
 * What the renderer is handed for an agent's terminal, through IPC.
 *
 * agent:get gives a panel its terminal's screen as one chunk (a snapshot of
 * the terminal's mirror, core/terminal-mirror.ts) where it used to give the
 * kept tail of the stream, which after a long turn of a fullscreen Claude Code
 * held no frame. agent:list, agent:get and agents:tick say when a CLI left
 * fullscreen without telling its terminal. agent:resize is remembered even
 * when the agent has no terminal yet, and the next terminal is spawned at it:
 * the Audit measured a panel at 179x41 in front of a PTY still at 120x30.
 * agent:get opens no terminal: an agent with none is shown as one.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-agent-screen-${process.pid}-${Date.now()}`),
}));

type FakePty = {
  pid: number;
  process: string;
  cols: number;
  rows: number;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
};

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string, _args: string[], opts: { cols: number; rows: number }): FakePty => ({
    pid: 4242, process: file, cols: opts.cols, rows: opts.rows,
    write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn(),
  })),
}));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '1.7.9', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => {
    broadcasts.push({ channel, payload: JSON.parse(JSON.stringify(payload ?? null)) });
  },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const broadcasts: Array<{ channel: string; payload: unknown }> = [];

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents, initAgentPty } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { scheduleTick } from '../../../electron/utils/agents-tick';
import type { AgentStatus, AppSettings } from '../../../electron/types';

// Cached by the mirror module, which loads it the only way it loads on Node 22.
const { Terminal } = createRequire(import.meta.url)('xterm-headless') as typeof import('xterm-headless');

const project = path.join(tmpHome, 'project');

function deps(overrides: Record<string, unknown> = {}): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = {
    agents,
    ptyProcesses,
    saveAgents: vi.fn(),
    getAppSettings: () => ({} as AppSettings),
    initAgentPty: (agent: AgentStatus) => initAgentPty(agent, null, vi.fn(), vi.fn()),
    ...overrides,
  };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

/** What node-pty does with a chunk: every data listener, in order. */
function emit(terminal: FakePty, data: string) {
  for (const [listener] of terminal.onData.mock.calls) (listener as (d: string) => void)(data);
}

/** An agent whose terminal is open, spawned the way every agent terminal is. */
function agentWithTerminal(id: string): { agent: AgentStatus; terminal: FakePty } {
  const terminal = spawnAgentPty({
    binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: project, cols: 90, rows: 30,
    env: { CLAUDE_AGENT_ID: id },
  }) as unknown as FakePty;
  ptyProcesses.set(`pty-${id}`, terminal as never);
  const agent = {
    id, name: id, status: 'running', provider: 'claude', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(), ptyId: `pty-${id}`, ptyCwd: project,
  } as AgentStatus;
  agents.set(agent.id, agent);
  return { agent, terminal };
}

const get = (id: string) => handlers.get('agent:get')!({}, id) as Promise<AgentStatus>;
const resize = (id: string, cols: number, rows: number) =>
  handlers.get('agent:resize')!({}, { id, cols, rows }) as Promise<{ success: boolean; error?: string }>;

/** The visible text of a fresh panel written what agent:get handed over. */
function panelFrom(got: AgentStatus, cols: number, rows: number): string[] {
  const panel = new Terminal({ cols, rows, scrollback: 5000, convertEol: true, allowProposedApi: true, logLevel: 'off' });
  (panel as unknown as { _core: { writeSync(d: string): void } })._core.writeSync(got.output.join(''));
  const buffer = panel.buffer.active;
  const text = Array.from({ length: rows }, (_, y) => buffer.getLine(buffer.viewportY + y)!.translateToString(true));
  panel.dispose();
  return text;
}

/** A fullscreen frame painted once, then a long turn of spinner ticks. */
function fullscreenLongTurn(terminal: FakePty) {
  emit(terminal, '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?25l\x1b[H\x1b[2J');
  emit(terminal, '\x1b[H' + Array.from({ length: 20 }, (_, i) => `line ${i} of the conversation`).join('\r\n'));
  for (let i = 0; i < 700; i++) emit(terminal, `\x1b[H\r\x1b[40C\x1b[24B${i % 10}`);
}

/** Inline repaints on the alternate screen it never left: QA's signature. */
function leftFullscreen(terminal: FakePty) {
  fullscreenLongTurn(terminal);
  for (let i = 0; i < 12; i++) emit(terminal, '\x1b[2K\x1b[1A'.repeat(3) + `\x1b[2K\x1b[G> inline ${i}\r\n  body\r\n  status`);
}

async function tickFor(id: string): Promise<Record<string, unknown> | undefined> {
  broadcasts.length = 0;
  scheduleTick();
  await vi.advanceTimersByTimeAsync(600);
  const tick = broadcasts.filter(b => b.channel === 'agents:tick').at(-1)?.payload as Array<Record<string, unknown>> | undefined;
  return tick?.find(item => item.id === id);
}

beforeEach(() => {
  vi.useFakeTimers();
  fs.mkdirSync(project, { recursive: true });
  handlers.clear();
  broadcasts.length = 0;
  agents.clear();
  ptyProcesses.clear();
  registerIpcHandlers(deps());
});

afterEach(async () => {
  await vi.runAllTimersAsync();
  vi.useRealTimers();
});

describe('agent:get', () => {
  it('hands a panel its terminal\'s screen as one chunk, the frame whole after a long turn of spinner ticks', async () => {
    const { agent, terminal } = agentWithTerminal('agent-long-turn');
    fullscreenLongTurn(terminal);

    const got = await get(agent.id);

    expect(got.output).toHaveLength(1);
    expect(got.output[0].startsWith('\x1bc')).toBe(true);
    const screen = panelFrom(got, 90, 30);
    expect(screen.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i} of the conversation`));
    // The stored agent keeps its own record: nothing about the copy is saved.
    expect(agent.output).toEqual([]);
  });

  it('falls back to the kept output for a terminal with no mirror', async () => {
    const terminal = { pid: 1, process: 'bash', write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
    ptyProcesses.set('pty-plain', terminal as never);
    agents.set('agent-plain', {
      id: 'agent-plain', name: 'plain', status: 'idle', provider: 'claude', projectPath: project,
      skills: [], output: ['kept ', 'tail'], lastActivity: new Date().toISOString(), ptyId: 'pty-plain',
    } as AgentStatus);

    expect((await get('agent-plain')).output).toEqual(['kept ', 'tail']);
  });

  // How agent:get fails an agent with no terminal, written before the code
  // (QA's final-e2e reconnaissance, 2026-09-24):
  // 1. It opens one. A login bash printed its banner into the agent's output,
  //    and the Chat's fleet list read "idle · The default interactive shell
  //    is now zsh." for every idle agent anyone had looked at.
  // 2. It hands over the stored tail of the terminal the agent had before:
  //    after an app restart, fragments of a fullscreen turn that died with
  //    the app, which drew garbage on a normal screen (QA, 2026-09-23).
  // 3. Its copy names a terminal that is gone, so the Dashboard's panel takes
  //    the agent for live and skips its "(Session idle)" line.
  it('opens no terminal for an agent that has none, and hands over nothing to replay', async () => {
    agents.set('agent-restored', {
      id: 'agent-restored', name: 'restored', status: 'idle', provider: 'claude', projectPath: project,
      skills: [], output: ['\x1b[H\r\x1b[40C\x1b[24B7', 'fragments of a turn that died with the app'],
      lastActivity: new Date().toISOString(),
    } as AgentStatus);
    const pty = await import('node-pty');
    const spawnsBefore = vi.mocked(pty.spawn).mock.calls.length;

    const got = await get('agent-restored');

    expect(vi.mocked(pty.spawn).mock.calls.length, 'a terminal was opened').toBe(spawnsBefore);
    expect(ptyProcesses.size).toBe(0);
    expect(got).toMatchObject({ output: [], cliRunning: false, leftFullscreen: false });
    expect(got.ptyId).toBeUndefined();
    const stored = agents.get('agent-restored')!;
    expect(stored.ptyId).toBeUndefined();
    expect(stored.output).toEqual(['\x1b[H\r\x1b[40C\x1b[24B7', 'fragments of a turn that died with the app']);
  });

  it('says there is no terminal when the one the agent names has gone', async () => {
    agents.set('agent-gone', {
      id: 'agent-gone', name: 'gone', status: 'completed', provider: 'claude', projectPath: project,
      skills: [], output: ['the last words'], lastActivity: new Date().toISOString(), ptyId: 'pty-exited',
    } as AgentStatus);
    const pty = await import('node-pty');
    const spawnsBefore = vi.mocked(pty.spawn).mock.calls.length;

    const got = await get('agent-gone');

    expect(vi.mocked(pty.spawn).mock.calls.length, 'a terminal was opened').toBe(spawnsBefore);
    expect(got.ptyId, 'names a terminal that is gone').toBeUndefined();
    expect(got.output).toEqual([]);
  });
});

describe('the left-fullscreen flag', () => {
  it('is set on agent:get, agent:list and agents:tick for a CLI repainting inline on an alternate screen it never left', async () => {
    const { agent, terminal } = agentWithTerminal('agent-flipped');
    leftFullscreen(terminal);

    expect(await get(agent.id)).toMatchObject({ leftFullscreen: true });
    const listed = (await handlers.get('agent:list')!({})) as AgentStatus[];
    expect(listed.find(a => a.id === agent.id)).toMatchObject({ leftFullscreen: true, output: [] });
    expect(await tickFor(agent.id)).toMatchObject({ leftFullscreen: true });
    // A copy for the renderer: the stored agent carries nothing to persist.
    expect(agent.leftFullscreen).toBeUndefined();
  });

  it('is false for a fullscreen CLI, and clears when the terminal really leaves the alternate screen', async () => {
    const { agent, terminal } = agentWithTerminal('agent-fullscreen');
    fullscreenLongTurn(terminal);
    expect(await tickFor(agent.id)).toMatchObject({ leftFullscreen: false });

    leftFullscreen(terminal);
    expect(await tickFor(agent.id)).toMatchObject({ leftFullscreen: true });
    emit(terminal, '\x1b[?1049l\x1b[?1000l\x1b[?1006l$ ');
    expect(await tickFor(agent.id)).toMatchObject({ leftFullscreen: false });
    expect(await get(agent.id)).toMatchObject({ leftFullscreen: false });
  });
});

describe('agent:resize', () => {
  it('remembers the size of a panel whose agent has no terminal yet, and the next terminal it gets has it', async () => {
    agents.set('agent-unsized', {
      id: 'agent-unsized', name: 'unsized', status: 'idle', provider: 'claude', projectPath: project,
      skills: [], output: [], lastActivity: new Date().toISOString(),
    } as AgentStatus);

    // The Dashboard sizes its panel before the agent has a terminal: the one
    // a start then opens, through initAgentPty, is spawned at that size.
    expect(await resize('agent-unsized', 179, 41)).toMatchObject({ success: false, error: 'PTY not found' });
    const agent = agents.get('agent-unsized')!;
    agent.ptyId = await initAgentPty(agent, null, vi.fn(), vi.fn());

    const terminal = ptyProcesses.get(agent.ptyId) as unknown as FakePty;
    expect([terminal.cols, terminal.rows]).toEqual([179, 41]);
    emit(terminal, 'x'.repeat(170) + '|');
    expect(panelFrom(await get('agent-unsized'), 179, 41)[0]).toBe('x'.repeat(170) + '|');
  });

  it('resizes the terminal and its mirror together', async () => {
    const { agent, terminal } = agentWithTerminal('agent-resized');

    expect(await resize(agent.id, 60, 20)).toMatchObject({ success: true });
    expect(terminal.resize).toHaveBeenCalledWith(60, 20);
    // Laid out at the new width by the mirror, as by the program: to the right
    // edge, one column back, a mark. A mirror left at 90 columns puts it at 89,
    // which a 60 column panel clamps to its last column, not the one before.
    emit(terminal, '\x1b[999C\x1b[DQ');
    const screen = panelFrom(await get(agent.id), 60, 20);
    expect(screen[0]).toBe(' '.repeat(58) + 'Q');
  });

  it('refuses a size no terminal can have, and keeps nothing of it', async () => {
    const { agent, terminal } = agentWithTerminal('agent-bad-size');

    expect(await resize(agent.id, 0, 20)).toMatchObject({ success: false, error: 'Invalid size' });
    expect(await resize(agent.id, 80.5, 20)).toMatchObject({ success: false, error: 'Invalid size' });
    expect(terminal.resize).not.toHaveBeenCalled();
    ptyProcesses.delete(agent.ptyId!);
    agent.ptyId = await initAgentPty(agent, null, vi.fn(), vi.fn());
    const respawned = ptyProcesses.get(agent.ptyId) as unknown as FakePty;
    expect([respawned.cols, respawned.rows]).toEqual([120, 30]);
  });
});
