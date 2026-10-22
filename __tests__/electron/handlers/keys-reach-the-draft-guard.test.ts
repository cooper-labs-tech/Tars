import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The keys a person types are the only way Tars can know what is in a field.
 *
 * `agent:input` is the one channel they arrive on, and for a long time it
 * wrote them straight into the terminal. That is why a note from an agent
 * could be submitted together with a half-written sentence: nothing upstream
 * had any idea there was one.
 *
 * So this drives the real IPC handler, not the writer underneath it. Put the
 * keys back on `ptyProcess.write` and everything below still works and this
 * is the only thing that notices, which is the whole point of it.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-keys-guard-${process.pid}-${Date.now()}`),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '1.7.7', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents } from '../../../electron/core/agent-manager';
import {
  TYPING_PAUSE_MS,
  draftOf,
  ptyProcesses,
  resetTerminalInput,
  writeProgrammaticInput,
} from '../../../electron/core/pty-manager';
import type { AgentStatus, AppSettings } from '../../../electron/types';

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = {
    agents, ptyProcesses, saveAgents: vi.fn(), getAppSettings: () => ({} as AppSettings),
  };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

const written: string[] = [];
const terminal = { write: (data: string) => { written.push(data); } };
const typeIntoTheAgent = (text: string) =>
  Promise.all([...text].map(ch => handlers.get('agent:input')!({}, { id: 'orch', input: ch })));

beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  written.length = 0;
  agents.clear();
  ptyProcesses.clear();
  registerIpcHandlers(deps());
  ptyProcesses.set('pty-orch', terminal as never);
  agents.set('orch', {
    id: 'orch', name: 'Orchestrator', status: 'idle', provider: 'claude',
    projectPath: tmpHome, skills: [], output: [], ptyId: 'pty-orch',
    lastActivity: new Date().toISOString(),
  } as AgentStatus);
});

afterEach(() => {
  resetTerminalInput(terminal as never);
  vi.useRealTimers();
});

describe('what a panel can read when it opens', () => {
  it('is handed the messages already waiting, through the same channel as the rest', async () => {
    await typeIntoTheAgent('je pense');
    await handlers.get('agent:input')!({}, { id: 'orch', input: '\t' });
    writeProgrammaticInput(terminal as never, 'the suite is green', true, { agentId: 'orch', from: 'Tars-QA' });
    vi.advanceTimersByTime(TYPING_PAUSE_MS);

    const answer = await handlers.get('agent:messagesWaiting')!({}) as {
      success: boolean; waiting: Array<{ agentId: string; waiting: number; from: string[] }>;
    };

    expect(answer.success).toBe(true);
    expect(answer.waiting).toEqual([{ agentId: 'orch', waiting: 1, from: ['Tars-QA'] }]);
  });
});

describe('what the renderer types on agent:input', () => {
  it('reaches the terminal, unchanged and in order', async () => {
    await typeIntoTheAgent('salut');
    expect(written.join('')).toBe('salut');
  });

  it('is what the field is known from, so a note can be kept out of it', async () => {
    await typeIntoTheAgent('je pense quil faut');
    expect(draftOf(terminal as never)).toEqual({ text: 'je pense quil faut', cursor: 18, state: 'known' });

    written.length = 0;
    writeProgrammaticInput(terminal as never, '[Tars] Tars-QA has completed', true);
    // Held while he types, and while his draft is in the field (it is never
    // set aside since 22/10): it goes once he has sent it, never with it.
    expect(written).toEqual([]);
    vi.advanceTimersByTime(TYPING_PAUSE_MS * 4);
    expect(written).toEqual([]);
    await typeIntoTheAgent('\r');
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    expect(written).toEqual(['\r', '[Tars] Tars-QA has completed']);
  });
});
