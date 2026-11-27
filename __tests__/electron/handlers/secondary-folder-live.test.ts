import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A secondary folder set from the agent's window while its CLI runs: nothing is typed into any CLI, and the answer
 * says when the folder reaches it, at its next start, or that its CLI is never handed one (the Audit's point on #636
 * at 6970bc906: the window typed `/add-dir <path>` into every CLI, and grok 1.0.92 took it as a prompt; then its M1 at
 * f68f7901c: main's own `/add-dir` into Claude Code asks a question nobody answers).
 *
 * Measured, each read in its own binary or bundle, none run:
 * - Claude Code 2.1.332 registers `/add-dir` twice. The `local` one ("Added <path> as a working directory for this
 *   session", asking nothing) is enabled by `ge()`, which its module chunk-bhankhfx.js defines as
 *   `return!n().host.launchOptions.isInteractive()`: non-interactive sessions only, and hidden in the others. An
 *   agent's terminal, interactive, gets the `local-jsx` one, which shows the folder's trust question if it needs one,
 *   else "Yes, for this session" / "Yes, and remember this directory" / "No", and adds nothing until it is answered.
 * - gemini 0.70.0: `/directory add <path>` opens its MultiFolderTrustDialog for a folder set after its start, its
 *   trust store being read once per process (loadTrustedFolders caches it).
 * - Qwen Code 0.28.4: `/directory add <path>` writes the folder into the project's own settings
 *   (context.includeDirectories, Workspace scope), which clearing the folder in Tars would never undo.
 * - grok 1.0.92 and codex 0.163.0: none (each has `/cd <path>`, which moves the session elsewhere).
 * - OpenCode, Pi, Amp: not installed here, not measured.
 *
 * Which launch lines hand the folder, read in each provider's buildInteractiveCommand: claude's, codex's (--add-dir),
 * gemini's and Qwen Code's (--include-directories). grok's says it does not; OpenCode's, Pi's and Amp's name none;
 * the thirteen API-key providers on the claude binary hand ~/.tars only.
 *
 * How it fails, written before the code (25/11):
 * 1. A live command typed that asks a question nobody answers: Claude Code's interactive /add-dir holds the agent's
 *    terminal on its question, which holds every message and delegation to it, and a message let through before the
 *    screen is read could answer it. The answer says the folder was added while nothing was.
 * 2. Any other CLI typed a line: grok and codex take it as a prompt, gemini opens a dialog nobody answers, Qwen Code
 *    writes the user's project settings.
 * 3. The answer says the folder applies at the next start for a CLI whose launch line never hands it (grok, OpenCode,
 *    Pi, Amp, the API-key providers), or says it is never handed to one whose line does.
 * 4. The answer and the provider's own launch line disagree: a provider taught to hand the folder, or to stop, and
 *    the answer left as it was.
 * 5. A registered provider in neither list.
 * 6. A cleared folder answered as anything but the next start.
 * 7. ~/.tars-private, a folder inside it or one holding it, taken by agent:setSecondaryProject, or stored by the
 *    window's agent:create, as agent:update refuses it.
 * 8. An id no provider has (a record from an older or newer Tars), or `local`, answered by its name rather than by the
 *    provider Tars runs for it: getProvider falls back to claude, whose line hands the folder (the Audit's I-2 on #636
 *    at 5a2c458b4).
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
import { resetLaunches } from '../../../electron/core/agent-launch';
import { getAllProviders, getProvider } from '../../../electron/providers';
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

/** The providers whose launch line hands the agent its secondary folder, and the ones whose line never does. */
const HANDED: AgentProvider[] = ['claude', 'local', 'codex', 'gemini', 'qwen-code'];
const NOT_HANDED: AgentProvider[] = [
  'grok', 'opencode', 'pi', 'amp',
  'openrouter', 'deepseek', 'mimo', 'moonshot', 'qwen', 'zhipu', 'minimax', 'nvidia', 'nous-portal', 'ollama', 'venice', 'ollama-cloud', 'custom-openai',
];

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

describe('nothing typed into any CLI that runs, and the answer says when the folder reaches it (1 to 3)', () => {
  it.each(HANDED)('1 to 3. %s: nothing typed, at its next start', async (provider) => {
    const { agent, terminal } = agentOn(provider);
    const answer = await setFolder(agent.id, folder);
    expect(answer.success, JSON.stringify(answer)).toBe(true);
    expect(answer.appliesAt).toBe('next-start');
    expect(await typedInto(terminal)).toBe('');
    expect(agents.get(agent.id)!.secondaryProjectPath).toBe(folder);
  });

  it.each(NOT_HANDED)('2 and 3. %s: nothing typed, and its CLI is never handed it', async (provider) => {
    const { agent, terminal } = agentOn(provider);
    const answer = await setFolder(agent.id, folder);
    expect(answer.success, JSON.stringify(answer)).toBe(true);
    expect(answer.appliesAt).toBe('not-handed');
    expect(await typedInto(terminal)).toBe('');
    expect(agents.get(agent.id)!.secondaryProjectPath).toBe(folder);
  });
});

describe("the answer agrees with each provider's own launch line (4, 5)", () => {
  it.each([...HANDED, ...NOT_HANDED])('4. %s: the folder on its line exactly when the answer says the next start', async (provider) => {
    const { agent } = agentOn(provider, { cli: false });
    const answer = await setFolder(agent.id, folder);
    const line = getProvider(provider).buildInteractiveCommand({ agentId: agent.id, binaryPath: '/opt/bin/cli', prompt: 'go', secondaryProjectPath: folder } as never);
    expect(answer.appliesAt, line).toBe(line.includes(folder) ? 'next-start' : 'not-handed');
  });

  it('5. every registered provider is in one list', () => {
    const listed = new Set<string>([...HANDED, ...NOT_HANDED]);
    expect(getAllProviders().map((p) => p.id).filter((id) => !listed.has(id))).toEqual([]);
  });

  it.each(['no-such-cli', 'local'])('8. %s answers as the provider Tars runs for it, claude, whose line hands the folder', async (id) => {
    const { agent } = agentOn(id as AgentProvider, { cli: false });
    const answer = await setFolder(agent.id, folder);
    const line = getProvider(id as AgentProvider).buildInteractiveCommand({ agentId: agent.id, binaryPath: '/opt/bin/cli', prompt: 'go', secondaryProjectPath: folder } as never);
    expect(getProvider(id as AgentProvider).id).toBe('claude');
    expect(line).toContain(folder);
    expect(answer.appliesAt).toBe('next-start');
  });
});

describe('a cleared folder (6)', () => {
  it.each(['claude', 'grok'] as const)('6. %s: nothing typed, the next start', async (provider) => {
    const { agent, terminal } = agentOn(provider);
    agent.secondaryProjectPath = folder;
    const answer = await setFolder(agent.id, null);
    expect(answer.success).toBe(true);
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

  it("7. the window's agent:create refuses it too, and creates nothing", async () => {
    fs.mkdirSync(PRIVATE_DIR, { recursive: true });
    const before = agents.size;
    const created = handlers.get('agent:create')!({}, { projectPath: project, skills: [], secondaryProjectPath: PRIVATE_DIR });
    await expect(created).rejects.toThrow(/tars-private/);
    expect(agents.size).toBe(before);
  });
});
