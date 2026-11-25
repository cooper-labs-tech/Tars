import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A secondary folder set from the agent's window while its CLI runs: main types the CLI's own command for it, and only
 * the one it was measured to take cleanly (the Audit's point on #636 at 6970bc906: the window typed `/add-dir <path>`
 * into every CLI, and grok 1.0.92 took it as a prompt and started a turn).
 *
 * Measured on 25/11, each read in its own binary or bundle, none run:
 * - Claude Code 2.1.332: `/add-dir <path>` ("Add a working directory"), immediate when given a path, which it answers
 *   "Added <path> as a working directory for this session", asking nothing. Every provider on the claude binary has it.
 * - gemini 0.70.0: `/directory add <path>`, but its trust store is read once per process (loadTrustedFolders caches
 *   it), so a folder set after its start is untrusted to it and opens its MultiFolderTrustDialog, which nobody answers
 *   in an agent's terminal. Nothing typed: the folder goes on its line, trusted by Tars, at its next start.
 * - Qwen Code 0.28.4: `/directory add <path>`, asking nothing, but it writes the folder into the project's own
 *   settings (context.includeDirectories, Workspace scope), a file of the user's repository that clearing the folder in
 *   Tars would never undo. Nothing typed.
 * - grok 1.0.92: no such command (its `/cd <path>` moves the session to another folder). Nothing typed.
 * - codex 0.163.0: none either (`--add-dir` at launch, `/cd`). Nothing typed.
 * - OpenCode, Pi, Amp: not installed here, not measured. Nothing typed.
 *
 * How it fails, written before the code (25/11):
 * 1. A CLI with no command Tars may type gets a line typed: grok and codex take it as a prompt, gemini opens a dialog
 *    nobody answers, Qwen Code writes the user's project settings.
 * 2. Claude Code, or a provider on the claude binary, running with its field free, gets nothing typed, or a line
 *    other than its own `/add-dir <folder>` and one Enter: the folder waits for a restart it does not need.
 * 3. A line typed where no CLI runs (the shell would run it as a command), or while a launch is on its way.
 * 4. A folder holding a control character typed: its newline would submit the rest of the path as a prompt.
 * 5. The answer does not say when the folder applies, or says it wrong: `now` only when the line went in, or waits in
 *    the writer for the field; `next-start` otherwise, so the window can say so.
 * 6. A cleared folder typed as anything: no CLI has a command that takes one away.
 * 7. ~/.tars-private, a folder inside it or one holding it, taken here as agent:update refuses it: typed live, it
 *    would hand an agent what agents are never handed.
 * 8. A dialog on the agent's screen: the line goes in and its Enter answers the dialog.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-secondary-live-${process.pid}-${Date.now()}`),
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
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents, initAgentPty } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { launchBegins, resetLaunches } from '../../../electron/core/agent-launch';
import { getProvider } from '../../../electron/providers';
import { PRIVATE_DIR } from '../../../electron/constants';
import type { AgentProvider, AgentStatus, AppSettings } from '../../../electron/types';

const project = path.join(tmpHome, 'project');
const folder = path.join(tmpHome, 'shared lib');

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = {
    agents,
    ptyProcesses,
    saveAgents: vi.fn(),
    getAppSettings: () => ({} as AppSettings),
    initAgentPty: (agent: AgentStatus) => initAgentPty(agent, null, vi.fn(), vi.fn()),
  };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

let seq = 0;

/** An agent on `provider` in a terminal spawned as every agent's is, its CLI up in it unless `cli` is false. */
function agentOn(provider: AgentProvider, { cli = true, status = 'idle' }: { cli?: boolean; status?: string } = {}) {
  const id = `a${++seq}`;
  const binaryName = getProvider(provider).binaryName;
  const terminal = spawnAgentPty({
    binaryName, shell: '/bin/bash', args: ['-l'], cwd: project, cols: 90, rows: 30, env: { CLAUDE_AGENT_ID: id },
  }) as unknown as FakePty;
  if (cli) terminal.process = binaryName;
  ptyProcesses.set(`pty-${id}`, terminal as never);
  const agent = {
    id, name: id, status, provider, projectPath: project, skills: [], output: [],
    lastActivity: new Date().toISOString(), ptyId: `pty-${id}`, ptyCwd: project,
  } as AgentStatus;
  agents.set(id, agent);
  return { agent, terminal };
}

type Answer = { success: boolean; error?: string; appliesAt?: string; agent?: AgentStatus };
const setFolder = (id: string, secondaryProjectPath: string | null) =>
  handlers.get('agent:setSecondaryProject')!({}, { id, secondaryProjectPath }) as Promise<Answer>;

/** What reached the terminal once the writer's Enter is due, its paste markers taken off. */
async function typedInto(terminal: FakePty): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return terminal.write.mock.calls.map(([d]) => String(d)).join('').replace(/\x1b\[20[01]~/g, '');
}

const ON_CLAUDE: AgentProvider[] = ['claude', 'local', 'openrouter', 'deepseek', 'moonshot', 'qwen', 'zhipu', 'minimax', 'ollama', 'custom-openai'];
const WITHOUT: AgentProvider[] = ['gemini', 'qwen-code', 'grok', 'codex', 'opencode', 'pi', 'amp'];

beforeEach(() => {
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(folder, { recursive: true });
  agents.clear();
  ptyProcesses.clear();
  resetLaunches();
  handlers.clear();
  registerIpcHandlers(deps());
});
afterEach(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); });

describe("the CLI's own command, typed by main into a session that runs (1, 2, 5)", () => {
  it.each(ON_CLAUDE)('2. %s, on the claude binary: /add-dir <folder> and one Enter, and the answer says now', async (provider) => {
    const { agent, terminal } = agentOn(provider);
    const answer = await setFolder(agent.id, folder);
    expect(answer.success, JSON.stringify(answer)).toBe(true);
    expect(answer.appliesAt).toBe('now');
    expect(await typedInto(terminal)).toBe(`/add-dir ${folder}\r`);
  });

  it.each(WITHOUT)('1. %s: nothing typed, and the answer says the next start', async (provider) => {
    const { agent, terminal } = agentOn(provider);
    const answer = await setFolder(agent.id, folder);
    expect(answer.success, JSON.stringify(answer)).toBe(true);
    expect(answer.appliesAt).toBe('next-start');
    expect(await typedInto(terminal)).toBe('');
    expect(agents.get(agent.id)!.secondaryProjectPath).toBe(folder);
  });
});

describe('where nothing may be typed (3, 4, 6, 8)', () => {
  it('3. no CLI in the terminal, its shell at the prompt: nothing typed, the next start', async () => {
    const { agent, terminal } = agentOn('claude', { cli: false });
    const answer = await setFolder(agent.id, folder);
    expect(answer.appliesAt).toBe('next-start');
    expect(await typedInto(terminal)).toBe('');
  });

  it('3. a launch on its way: nothing typed, the next start', async () => {
    const { agent, terminal } = agentOn('claude');
    launchBegins(agent.id);
    const answer = await setFolder(agent.id, folder);
    expect(answer.appliesAt).toBe('next-start');
    expect(await typedInto(terminal)).toBe('');
  });

  it('3. no terminal at all: the next start', async () => {
    const { agent } = agentOn('claude');
    agent.ptyId = undefined;
    expect((await setFolder(agent.id, folder)).appliesAt).toBe('next-start');
  });

  it('4. a folder holding a newline: nothing typed, the next start', async () => {
    const odd = path.join(tmpHome, 'two\nlines');
    fs.mkdirSync(odd);
    const { agent, terminal } = agentOn('claude');
    const answer = await setFolder(agent.id, odd);
    expect(answer.appliesAt).toBe('next-start');
    expect(await typedInto(terminal)).toBe('');
  });

  it('6. a cleared folder: nothing typed, the next start', async () => {
    const { agent, terminal } = agentOn('claude');
    agent.secondaryProjectPath = folder;
    const answer = await setFolder(agent.id, null);
    expect(answer.success).toBe(true);
    expect(answer.appliesAt).toBe('next-start');
    expect(await typedInto(terminal)).toBe('');
  });

  it('8. a dialog the agent shows: nothing typed, the next start', async () => {
    const { agent, terminal } = agentOn('claude', { status: 'waiting' });
    agent.waitingReason = 'permission';
    const answer = await setFolder(agent.id, folder);
    expect(answer.appliesAt).toBe('next-start');
    expect(await typedInto(terminal)).toBe('');
  });
});

describe('~/.tars-private is never handed this way (7)', () => {
  it('7. refuses it, a folder inside it and one holding it, types nothing and keeps the folder the agent had', async () => {
    fs.mkdirSync(path.join(PRIVATE_DIR, 'inner'), { recursive: true });
    const { agent, terminal } = agentOn('claude');
    for (const refused of [PRIVATE_DIR, path.join(PRIVATE_DIR, 'inner'), tmpHome]) {
      const answer = await setFolder(agent.id, refused);
      expect(answer.success, refused).toBe(false);
      expect(answer.error ?? '', refused).toMatch(/tars-private/);
    }
    expect(agents.get(agent.id)!.secondaryProjectPath).toBeUndefined();
    expect(await typedInto(terminal)).toBe('');
  });
});
