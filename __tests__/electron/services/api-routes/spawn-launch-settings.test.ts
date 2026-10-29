import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A session the API starts (/start, /dispatch to an agent with no live
 * session, /message reconnecting, the Hermes webhook: all spawnAgentSession)
 * runs on the agent's model and effort.
 *
 * It ran on the model the agent's previous session had last answered on,
 * read from that session's transcript, ahead of the model the agent was set
 * to: every agent moved to a new model in the Agents page came back on the old
 * one the next time an orchestrator started it. And an agent set to medium ran
 * at whatever effort Claude Code had last saved for that model, because medium
 * was the one level never passed.
 *
 * The spawn is real down to spawnAgentPty; node-pty records the command.
 */

const mockPtyProcess = {
  onData: vi.fn(),
  onExit: vi.fn(),
  kill: vi.fn(),
  write: vi.fn(),
};

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockPtyProcess),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));
vi.mock('../../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  initAgentPty: vi.fn(),
  killStalePty: vi.fn(),
  ensureProjectTrusted: vi.fn(),
  appendAgentOutput: vi.fn(),
  armTaskStartWatch: vi.fn(),
}));
vi.mock('../../../../electron/core/pty-manager', () => ({
  launchPrompt: (_sender: unknown, data: string) => data,
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
}));
vi.mock('../../../../electron/utils/path-builder', () => ({
  buildFullPath: vi.fn(() => '/usr/bin'),
}));

import * as pty from 'node-pty';
import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { encodeProjectDirName } from '../../../../electron/utils/resume-session';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

// The launch these hold is darwin and linux's: a line typed into the shell, or
// `bash -l -c`. On a Windows host they read it as linux; the win32 launch (the
// CLI as the terminal's process) is held by launch-call-sites.test.ts and
// agent-terminal-win32.test.ts.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });


const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-spawn-settings-'));
const LAST_SESSION = '5f0c2d4e-8a61-4b7e-9d3a-2c1b0e9f7a64';

afterAll(() => fs.rmSync(project, { recursive: true, force: true }));

/** The previous session's transcript, where the model it last answered on is read. */
function lastSessionAnsweredOn(model: string): void {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectDirName(project));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${LAST_SESSION}.jsonl`),
    JSON.stringify({ type: 'assistant', message: { model, content: [] } }) + '\n');
}

function routes(): RouteApp {
  return {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
}

const ctx: RouteContext = {
  mainWindow: null,
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
};

let seq = 0;

/** POST /api/agents/:id/dispatch to an agent with no session, from itself. */
async function dispatch(fields: Partial<AgentStatus>): Promise<string> {
  const id = `agent-${++seq}`;
  agents.set(id, {
    id, name: 'Worker', status: 'idle', projectPath: project, skills: [], output: [],
    lastActivity: new Date().toISOString(), provider: 'claude', permissionMode: 'bypass',
    ...fields,
  } as AgentStatus);
  const app = routes();
  registerAgentRoutes(app, ctx);
  const route = app.routes.find(r => r.method === 'POST' && String(r.pattern).includes('dispatch'))!;
  const req = {
    method: 'POST', pathname: `/api/agents/${id}/dispatch`, url: new URL('http://localhost/'),
    body: { message: 'Rebase onto main' }, raw: {} as never, res: {} as never,
    params: { id }, callerAgentId: id,
  } as unknown as RouteRequest;
  const answers: Array<{ body: unknown; status?: number }> = [];
  await route.handler(req, (body, status) => { answers.push({ body, status }); });
  expect(answers[0]?.status ?? 200, JSON.stringify(answers[0]?.body)).toBe(200);
  const call = vi.mocked(pty.spawn).mock.calls.at(-1)!;
  // bash -l -c '<the command>'
  return (call[1] as string[])[2];
}

beforeEach(() => {
  agents.clear();
  ptyProcesses.clear();
  vi.mocked(pty.spawn).mockClear();
});

/**
 * The cases that resume a conversation read its transcript under Claude's
 * folder for the project, named as darwin and linux name it (resume-session.ts:
 * `/` and `.` to `-`). This file runs as linux on any host; on a Windows
 * host the project is a Windows path, whose `:` and `\` no folder name can
 * hold, so the transcript those cases resume from has nowhere to go. They run
 * on macOS and Linux; the Windows name is held by resume-session.test.ts.
 */
const NO_POSIX_TRANSCRIPT_FOLDER = process.platform === 'win32';

describe('a session the API starts', () => {
  it.skipIf(NO_POSIX_TRANSCRIPT_FOLDER)("runs on the agent's model, not on the one its last session answered on", async () => {
    lastSessionAnsweredOn('claude-opus-5');

    const command = await dispatch({ model: 'claude-opus-5-5', effort: 'max', resumableSessionId: LAST_SESSION });

    expect(command).toContain(" --model 'claude-opus-5-5'");
    expect(command).not.toContain("--model 'claude-opus-5'");
    expect(command).toContain(' --effort max');
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('passes effort %s as it is set', async (effort) => {
    const command = await dispatch({ model: 'claude-opus-5-5', effort });

    expect(command).toContain(` --effort ${effort} `);
  });

  it('passes no model for Default and no effort when none is set', async () => {
    const command = await dispatch({ model: 'default', effort: undefined });

    expect(command).not.toContain('--model');
    expect(command).not.toContain('--effort');
  });
});
