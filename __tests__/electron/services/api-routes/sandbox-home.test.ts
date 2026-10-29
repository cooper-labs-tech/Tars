import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * A Tars started with HOME pointed elsewhere gives its agents that home.
 *
 * scripts/sandbox.sh, and the Frontend's sandbox that proved the chat loop,
 * start Tars with HOME on a throwaway directory so that nothing they do reaches
 * the real ~/.claude or ~/.tars. os.homedir() follows HOME. Electron's home
 * path does not on macOS: measured on 2026-09-16, a bare Electron started with
 * HOME on a temp directory answered os.homedir() with that directory and
 * app.getPath('home') with the account's own home. spawnAgentSession used the second, so
 * a sandboxed agent was started with the real ~/.claude/mcp.json while the
 * sandboxed app registered its servers in its own.
 *
 * Here Electron answers with a home of its own that also holds an mcp.json, as
 * the real account does, and HOME points at the sandbox. The spawned command
 * must name the sandbox's file.
 */

const dirs = vi.hoisted(() => ({ electronHome: '', sandboxHome: '', project: '' }));
const spawned: string[][] = [];

vi.mock('node-pty', () => ({
  spawn: vi.fn((_shell: string, args: string[]) => {
    spawned.push(args);
    return { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn(), pid: 1 };
  }),
}));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'pty-sandbox') }));
vi.mock('electron', () => ({
  // What Electron answers on macOS whatever HOME says: the account's home.
  app: { getPath: (name: string) => (name === 'home' ? dirs.electronHome : os.tmpdir()), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
}));
vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));
vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));

import { performDispatch } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import type { RouteContext } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';
import { moveTestHome } from '../../../setup/test-home';

dirs.electronHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-electron-home-'));
dirs.sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-sandbox-home-'));
dirs.project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-sandbox-project-'));

function mcpConfigIn(home: string): string {
  const file = path.join(home, '.claude', 'mcp.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }));
  return file;
}

let restoreHome: () => void;
let ctx: RouteContext;

beforeEach(() => {
  spawned.length = 0;
  agents.clear();
  // spawnAgentSession pre-accepts workspace trust by writing ~/.claude.json,
  // so HOME is moved before anything runs, and checked rather than assumed.
  restoreHome = moveTestHome(dirs.sandboxHome);
  expect(os.homedir(), 'HOME is not redirected, and a spawn would write the real ~/.claude.json').toBe(dirs.sandboxHome);
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
    initAgentPtyCallback: vi.fn(async () => 'unused'),
    agentStatusEmitter: new EventEmitter(),
  } as RouteContext;
});

afterEach(() => {
  restoreHome();
});

describe('an agent spawned by a Tars whose HOME is a sandbox', () => {
  it("is given the sandbox's MCP config, never the one Electron's home points at", async () => {
    const sandboxConfig = mcpConfigIn(dirs.sandboxHome);
    mcpConfigIn(dirs.electronHome);
    agents.set('a1', {
      id: 'a1', status: 'idle', provider: 'claude', projectPath: dirs.project,
      skills: [], output: [], lastActivity: new Date().toISOString(),
    } as AgentStatus);
    const sendJson = vi.fn();

    await performDispatch(agents.get('a1')!, { message: 'the task' }, ctx, sendJson);

    expect(sendJson.mock.calls.at(-1)?.[1] ?? 200, JSON.stringify(sendJson.mock.calls)).toBe(200);
    expect(spawned, 'no agent process was spawned').toHaveLength(1);
    const command = spawned[0].join(' ');
    // A worker's file, by its role (services/mcp-roles.ts), written beside the sandbox's own.
    expect(command).toContain(`--mcp-config '${path.join(path.dirname(sandboxConfig), 'mcp-worker.json')}'`);
    expect(command, "the agent was handed the account's MCP config").not.toContain(dirs.electronHome);
  });
});

// The launch these hold is darwin and linux's: a line typed into the shell, or
// `bash -l -c`. On a Windows host they read it as linux, once the home above
// has moved as the host names it; the win32 launch (the CLI as the terminal's
// process) is held by launch-call-sites.test.ts and agent-terminal-win32.test.ts.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterEach(() => { Object.defineProperty(process, 'platform', hostPlatform); });
