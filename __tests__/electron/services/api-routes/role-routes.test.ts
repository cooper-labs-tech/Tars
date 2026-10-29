import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The API reads the role, never the name (core/agent-role.ts).
 *
 * spawnAgentSession, which every /start, /dispatch, /message reconnect and the
 * Hermes webhook go through, decided an orchestrator by the role or the name;
 * so did the bootstrap every session reads at start, and POST /api/agents set
 * the role of a new agent from its name. A worker called "Tars-Orchestrator"
 * was launched with the orchestration instructions and without its editing
 * tools, and an orchestrator renamed lost both on its next spawn.
 *
 * A chat's runner (ORCHESTRATOR-PER-CHAT.md v2.2, 4.2, PR D) is a worker with
 * `kind: 'chat'` that has the orchestrator's powers. How the API fails it,
 * written before the code (2026-10-12):
 * 1. A runner is launched as a worker: no instructions, its editing tools
 *    kept, and told an orchestrator reads its final message.
 * 2. Its bootstrap gives it a worker's rules instead of the orchestration rules.
 * 3. The team a bootstrap lists, any agent's, has a runner in it, so the
 *    orchestrator and its workers take a conversation for a teammate.
 * And written with their code (PR D, shown to bite by mutants):
 * 4. A runner is not told it is one chat among several, nor how its workers
 *    answer it; a worker is not told to answer "requester".
 */

const mockPtyProcess = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() };

vi.mock('node-pty', () => ({ spawn: vi.fn(() => mockPtyProcess) }));
vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test', getAppPath: () => process.cwd() },
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
vi.mock('../../../../electron/core/agent-restart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../electron/core/agent-restart')>()),
  noteLaunch: vi.fn(),
  restartForSettings: vi.fn(),
}));
vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import * as pty from 'node-pty';
import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { restartForSettings } from '../../../../electron/core/agent-restart';
import { getSuperAgentInstructionsPath } from '../../../../electron/utils';
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


const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-role-routes-'));
const TOOL_BLOCK = '--disallowed-tools "Edit" "Write" "NotebookEdit" "Task"';

afterAll(() => fs.rmSync(project, { recursive: true, force: true }));

function routes(): RouteApp {
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  registerAgentRoutes(app, {
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
  } as RouteContext);
  return app;
}

function agent(id: string, fields: Partial<AgentStatus> = {}): AgentStatus {
  const record = {
    id, name: id, status: 'idle', projectPath: project, skills: [], output: [],
    lastActivity: new Date().toISOString(), provider: 'claude', permissionMode: 'bypass',
    role: 'worker', orchestratorMode: false, ...fields,
  } as AgentStatus;
  agents.set(id, record);
  return record;
}

async function call(method: string, match: (pattern: string) => boolean, pathname: string,
  params: Record<string, string>, body: Record<string, unknown>, callerAgentId: string) {
  const route = routes().routes.find(r => r.method === method && match(String(r.pattern)))!;
  const answers: Array<{ body: Record<string, unknown>; status?: number }> = [];
  await route.handler({
    method, pathname, url: new URL(`http://localhost${pathname}`), body, raw: {} as never, res: {} as never,
    params, callerAgentId,
  } as unknown as RouteRequest, (json, status) => { answers.push({ body: json as Record<string, unknown>, status }); });
  return answers[0];
}

/** The command a /dispatch to an agent with no session typed into its new terminal. */
async function dispatchedCommand(id: string): Promise<string> {
  const answer = await call('POST', p => p.includes('dispatch'), `/api/agents/${id}/dispatch`,
    { id }, { message: 'Rebase onto main' }, id);
  expect(answer?.status ?? 200, JSON.stringify(answer?.body)).toBe(200);
  const spawn = vi.mocked(pty.spawn).mock.calls.at(-1)!;
  return (spawn[1] as string[])[2];
}

const bootstrap = async (id: string) =>
  (await call('GET', p => p.includes('bootstrap'), `/api/agents/${id}/bootstrap`, { id }, {}, id))!.body.context as string;

const createAgent = (body: Record<string, unknown>, caller: string) =>
  call('POST', p => p === '/api/agents', '/api/agents', {}, { projectPath: project, ...body }, caller);

beforeEach(() => {
  agents.clear();
  ptyProcesses.clear();
  vi.mocked(pty.spawn).mockClear();
  vi.mocked(restartForSettings).mockClear();
});

describe('a session the API starts', () => {
  it('launches an orchestrator with its instructions and without editing tools, whatever its name', async () => {
    agent('lead', { name: 'Tars-Lead', role: 'orchestrator', orchestratorMode: true });

    const command = await dispatchedCommand('lead');

    expect(command).toContain(`--append-system-prompt-file '${getSuperAgentInstructionsPath()}'`);
    expect(command).toContain(TOOL_BLOCK);
    expect(command).toContain('orchestrator of project');
  });

  it('launches a worker as a worker, even one called orchestrator', async () => {
    agent('named', { name: 'Tars-Orchestrator' });

    const command = await dispatchedCommand('named');

    expect(command).not.toContain('--append-system-prompt-file');
    expect(command).not.toContain('--disallowed-tools');
    expect(command).toContain('worker of project');
    expect(command).toContain('an orchestrator reads your final message');
  });

  it("1. launches a chat's runner with the orchestrator's instructions and without editing tools", async () => {
    agent('lead', { name: 'Tars-Lead', role: 'orchestrator', orchestratorMode: true });
    agent('runner', { name: 'Tars-Lead · Release 1.9.4', kind: 'chat', chatId: 'c-2', teamOrchestratorId: 'lead' });

    const command = await dispatchedCommand('runner');

    expect(command).toContain(`--append-system-prompt-file '${getSuperAgentInstructionsPath()}'`);
    expect(command).toContain(TOOL_BLOCK);
    expect(command).not.toContain('an orchestrator reads your final message');
  });
});

describe('the bootstrap a session reads at start', () => {
  it('gives the orchestration rules to the role, not to the name', async () => {
    agent('lead', { name: 'Tars-Lead', role: 'orchestrator', orchestratorMode: true });
    agent('named', { name: 'Tars-Orchestrator' });

    const lead = await bootstrap('lead');
    const named = await bootstrap('named');

    expect(lead).toContain('## Orchestration rules');
    expect(lead).toContain('orchestrator of project');
    expect(named).toContain('## Working rules');
    expect(named).not.toContain('## Orchestration rules');
  });

  it("2. gives a chat's runner the orchestration rules", async () => {
    agent('lead', { name: 'Tars-Lead', role: 'orchestrator', orchestratorMode: true });
    agent('runner', { name: 'Tars-Lead · Release 1.9.4', kind: 'chat', chatId: 'c-2', teamOrchestratorId: 'lead' });

    const runner = await bootstrap('runner');

    expect(runner).toContain('## Orchestration rules');
    expect(runner).not.toContain('## Working rules');
  });

  it("4. tells a runner it is one chat among several, and a worker how to answer whoever asked it", async () => {
    agent('lead', { name: 'Tars-Lead', role: 'orchestrator', orchestratorMode: true });
    agent('backend', { name: 'Backend' });
    agent('runner', { name: 'Tars-Lead · Release 1.9.4', kind: 'chat', chatId: 'c-2', teamOrchestratorId: 'lead' });

    const [lead, backend, runner] = [await bootstrap('lead'), await bootstrap('backend'), await bootstrap('runner')];

    expect(runner).toContain("You are the orchestrator in one of the project's chats");
    expect(runner).toContain('orchestrator of project');
    expect(runner).not.toContain('worker of project');
    expect(runner).toContain('send_message to "requester"');
    expect(backend).toContain('send_message to "requester"');
    expect(lead).not.toContain('You are the orchestrator in');
    // A runner no test launched before (a launch on its way would hold the dispatch),
    // and shell-quoted in the command, where the apostrophe is escaped.
    agent('runner-4', { name: 'Tars-Lead · Docs', kind: 'chat', chatId: 'c-4', teamOrchestratorId: 'lead' });
    expect(await dispatchedCommand('runner-4')).toContain('You are the orchestrator in one of the project');
  });

  it("3. leaves the chats' runners out of the team it lists, whoever reads it", async () => {
    agent('lead', { name: 'Tars-Lead', role: 'orchestrator', orchestratorMode: true });
    agent('backend', { name: 'Backend' });
    agent('runner', { name: 'Tars-Lead · Release 1.9.4', kind: 'chat', chatId: 'c-2', teamOrchestratorId: 'lead' });
    agent('runner-3', { name: 'Tars-Lead · Docs', kind: 'chat', chatId: 'c-3', teamOrchestratorId: 'lead' });

    const [lead, backend, runner] = [await bootstrap('lead'), await bootstrap('backend'), await bootstrap('runner')];

    expect(lead).toContain('"Backend"');
    expect(backend).toContain('"Tars-Lead"');
    expect(runner).toContain('"Backend"');
    for (const context of [lead, backend, runner]) {
      expect(context).not.toContain('Release 1.9.4" (id');
      expect(context).not.toContain('Tars-Lead · Docs');
    }
  });
});

describe('GET /api/agents, what list_agents reads', () => {
  // PR D, written with its code and shown to bite by a mutant (4.2: runners are
  // not the team; list_agents shows them as the asker of a worker's task).
  it("lists the team without the chats' runners, and each worker's asker, a chat's runner included", async () => {
    agent('lead', { name: 'Tars-Lead', role: 'orchestrator', orchestratorMode: true });
    agent('runner', { name: 'Tars-Lead · Release 1.9.4', kind: 'chat', chatId: 'c-2', teamOrchestratorId: 'lead' });
    agent('backend', { name: 'Backend', requestedBy: { agentId: 'runner', ptyId: 'pty-x' } });
    const answer = await call('GET', p => p === '/api/agents', '/api/agents', {}, {}, 'lead');
    const listed = (answer!.body.agents as Array<{ id: string; askedBy?: { id: string; name: string; chat?: boolean } }>);
    expect(listed.map(a => a.id).sort()).toEqual(['backend', 'lead']);
    expect(listed.find(a => a.id === 'backend')?.askedBy).toEqual({ id: 'runner', name: 'Tars-Lead · Release 1.9.4', chat: true });
    expect(listed.find(a => a.id === 'lead')?.askedBy).toBeUndefined();
  });
});

describe('POST /api/agents', () => {
  it('creates a worker whatever the name says', async () => {
    agent('caller');

    const answer = await createAgent({ name: 'Build Orchestrator' }, 'caller');

    expect(answer!.status ?? 200).toBe(200);
    expect(answer!.body.agent).toMatchObject({ role: 'worker', orchestratorMode: false });
  });

  // The QA's gate of #123: a worker's own token made itself a "Rogue"
  // orchestrator, which demoted and restarted the current one, and with
  // allowCrossProject did the same in another project, in bypass. Only the
  // Agents page makes or unmakes an orchestrator.
  it.each([
    ['a worker', 'caller'],
    ['the orchestrator itself', 'current'],
  ])('refuses to make an orchestrator for %s, and the current one keeps the role', async (_who, caller) => {
    agent('caller');
    const current = agent('current', { role: 'orchestrator', orchestratorMode: true });

    const answer = await createAgent({ name: 'Rogue', role: 'orchestrator' }, caller);

    expect(answer!.status).toBe(403);
    expect(String(answer!.body.error)).toContain('Agents page');
    expect(agents.size, 'an agent was created').toBe(2);
    expect(current).toMatchObject({ role: 'orchestrator', orchestratorMode: true });
    expect(restartForSettings).not.toHaveBeenCalled();
  });

  it("refuses the toggle's old field the same way", async () => {
    const current = agent('current', { role: 'orchestrator', orchestratorMode: true });
    agent('caller');

    const answer = await createAgent({ name: 'Rogue', orchestratorMode: true }, 'caller');

    expect(answer!.status).toBe(403);
    expect(agents.size).toBe(2);
    expect(current.role).toBe('orchestrator');
  });

  it('refuses it in another project too, crossing on purpose and in bypass', async () => {
    agent('caller');
    const elsewhere = path.join(path.dirname(project), 'other-project');
    fs.mkdirSync(elsewhere, { recursive: true });
    const theirs = agent('theirs', { projectPath: elsewhere, role: 'orchestrator', orchestratorMode: true });

    const answer = await createAgent(
      { name: 'Rogue3', role: 'orchestrator', projectPath: elsewhere, allowCrossProject: true, permissionMode: 'bypass' },
      'caller',
    );

    expect(answer!.status).toBe(403);
    expect(String(answer!.body.error)).toContain('Agents page');
    expect(theirs.role).toBe('orchestrator');
    expect(restartForSettings).not.toHaveBeenCalled();
  });

  it('refuses a role that is neither, and creates nothing', async () => {
    agent('caller');

    const answer = await createAgent({ name: 'X', role: 'boss' }, 'caller');

    expect(answer).toEqual({ body: { error: 'Invalid role: boss' }, status: 400 });
    expect(agents.size).toBe(1);
  });
});
