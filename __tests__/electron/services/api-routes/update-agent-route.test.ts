import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';

/**
 * POST /api/agents/:id/update, what update_agent calls (2.0.4).
 *
 * The maintainer: an orchestrator sets an agent up end to end, on any CLI, and
 * changes its settings afterwards. create_agent took provider, model, effort,
 * permission mode and CLI path; after that only the window could change an
 * agent (agent:update). The route takes the window's path, shared
 * (core/agent-update.ts), and adds what an orchestrator calling it needs: who
 * may, the checks create_agent makes, and an answer saying when the change
 * applies and whether the conversation is kept.
 *
 * How it fails, written before the code (2026-10-19):
 *
 * Who may (2.0.7, the owner's word of 19/11: any agent retunes any agent's
 * harness, model and effort; the rest keeps the orchestrator's rule)
 * 1. A call that names nobody (the shared token) changes an agent.
 * 2. A worker changes another agent's settings beyond the inference ones, or
 *    its own: it must be refused as handing work is (worker_may_not_update),
 *    with nothing written; and its inference settings (provider, model, effort)
 *    are refused it, on any agent: they must be taken.
 * 3. The orchestrator changes another project's agent beyond the inference
 *    settings, allowCrossProject or not (other_project, nothing written); and
 *    another project's inference settings are refused: they must be taken, from
 *    a worker as from an orchestrator.
 * 3c. The owner's grant from the caller's project to the agent's leaves its
 *    settings beyond the inference ones refused: they must be taken from the
 *    project's orchestrator and the workers the grant names, and from no other.
 * 4. An orchestrator's settings beyond the inference ones change over the API:
 *    its own, or any by Tars's pass (orchestrator_settings). Its inference ones
 *    are refused: they must be taken, by any agent, and its live chats' runners
 *    must take them (restartRunnersOf), or they run on the old.
 * 4b. A call that names an inference setting beside another is judged by the
 *    inference rule alone: it must be judged by the strictest, nothing written.
 * 5. The callers that may are refused: the project's orchestrator on one of its
 *    workers, and Tars's own pass.
 * 6. A chat's runner is changed: its settings are its orchestrator's, taken at
 *    each launch (runs_on_orchestrator, naming the orchestrator to change).
 *
 * What may change
 * 7. role or orchestratorMode makes or unmakes an orchestrator over the API.
 * 8. projectPath moves an agent into another project.
 * 9. A field the route does not take (a worktree, a typo) is dropped, and the
 *    answer says the agent was updated.
 * 10. An update that names nothing answers that it updated the agent.
 * 11. A value create_agent refuses is taken here: an unknown provider, a
 *     permission mode, an effort, a model name, a CLI path that is no
 *     executable file, a skill name, an empty name or one with ", task t-",
 *     plan on a provider without plan mode, a key provider without its key.
 * 12. A value of the wrong type reaches the record (skills as a string).
 * 12b. A folder handed besides the project (secondaryProjectPath) that is
 *     ~/.tars-private, inside it, or holds it (the home folder, the root) is
 *     taken, by update_agent or by create_agent: the agent would be handed
 *     what agents are never handed (the Audit's L1 on #480).
 * 12c. The same folder is taken by the window's agent:update, which calls
 *     core/agent-update.ts without the route's check (the Audit's L4 on #480).
 *
 * When it applies (a running turn is never cut; 2.0.7: applied or queued)
 * 13. A change of provider or CLI path while a CLI works in the agent's
 *     terminal ends that terminal and whatever it was doing, or is refused and
 *     must be asked again: it must be queued (state queued, a change id),
 *     nothing written, the terminal alive.
 *     b. ...a launch under way in a bare shell is cut the same way;
 *     c. ...but right after stop_agent, the launch the stop ended still reads
 *        as one for CLI_BOOT_MS (15 s), and the change the orchestrator
 *        stopped the agent for is queued behind nothing (found while writing
 *        the E2E): it must be applied.
 *     d. ...and once the turn ends, the queued change is never applied, or is
 *        applied over a turn that began since: applied at the agent's next
 *        rest, its idle terminal ended for a new CLI, and the log keeps when.
 * 17. The answer does not say applied or queued, nor the change's id, nor when
 *     an applied one took effect.
 * 14. A change of provider keeps the model and the CLI path, which named the
 *     old CLI's: the next start runs claude on a codex model, or the codex
 *     binary for a claude agent.
 * 15. ...or drops the model and CLI path given with it.
 * 16. The answer does not say when the change applies, nor whether the
 *     conversation is kept, or says it wrong:
 *     a. claude, its CLI up and free: restarted now, on its conversation;
 *     b. claude in a turn: restarted once the turn ends, the turn not cut;
 *     c. codex up: at its next start, a new conversation, its terminal alive;
 *     d. no CLI up: at its next start, which continues the last conversation
 *        only on its first start since Tars opened;
 *     e. a change of CLI: at its next start, on a new conversation, even with
 *        an older conversation of the new CLI on disk;
 *     f. a name or skills only: nothing restarted, and the answer says the
 *        session in its terminal goes on under its old name and skills, its
 *        next session taking the new ones (the Audit's L2 on #480: it said
 *        "now", and "nothing it reads when it starts was changed").
 *
 * Several agents, the log and a revert (2.0.7)
 * 18. A batch fails whole on one refused agent, or applies a refused one: each
 *     agent is judged and answered on its own, under one batch id; a project's
 *     batch never reaches a chat's runner; a batch naming both ids and a
 *     project, neither, or an empty list is refused.
 * 19. A change is not logged, or logged without who, before, after, when.
 * 20. A revert of a queued change applies it, or writes anything: it must be
 *     cancelled; a revert of an applied change clobbers a setting another
 *     change moved since: it must set back only what is still at its value,
 *     and name the rest; a revert by a caller who may not make that change is
 *     taken.
 * 22. (the Audit's M1 on #595) The queue is walked on a copy: a change
 *     cancelled by its revert while another is applied is applied anyway, and
 *     one asked while another is applied is dropped until Tars's next start, or
 *     applied beside it. Each must be kept in its order, and a cancelled one
 *     never applied.
 * 23. (M2) A revert is judged by the settings the log holds, which for a
 *     provider change include the model and CLI path it cleared: the worker
 *     that changed a provider is refused its revert, and so is everyone on an
 *     orchestrator. A revert must be judged by what the change's caller named.
 * 24. (L3) The change log hands any agent another project's whole history,
 *     CLI paths, skills, names and folders: another project's changes must
 *     show their inference settings only, unless a grant opens that project.
 * 25. (L5) A value the log refuses (a name of 400 characters) is written to
 *     the agent, then the log throws: it must be refused before anything is
 *     written.
 * 26. (the re-audit's I1 on #595) Two changes asked of a free agent at the
 *     same moment are both applied, the second over the first's apply: the
 *     second must wait for it, queued, then apply.
 * 27. (#604's Audit, L1) The window is handed only the whole change: a
 *     provider change reads as resets of the model and CLI path nobody asked
 *     for. The event agent:retuned and the agent's lastRetune must carry what
 *     the caller named (`asked`), the implied resets left in `fields` only.
 * 21. The window's undo (agent.revertChange, 2.0.7) goes another way than
 *     revert_agent_change, or is filed under an agent or Tars: it must take
 *     the same engine, filed under the window; of a queued change it applies
 *     it instead of cancelling it; of an applied one it clobbers what another
 *     change moved since, or moves the agent back onto a worktree that is
 *     gone; asked of a change nobody knows, or of both a change and an agent,
 *     it answers ok. Each must be said, nothing written.
 */

const mockPtyProcess = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() };

vi.mock('node-pty', () => ({ spawn: vi.fn(() => mockPtyProcess) }));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'test-uuid') }));
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
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
  endTerminalTree: vi.fn(async (t: { kill?: () => void }) => { t.kill?.(); }),
  fieldInUse: vi.fn(() => null),
}));

vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

// What the window is pushed, kept to read (agent:retuned).
vi.mock('../../../../electron/utils/broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../electron/utils/broadcast')>()),
  broadcastToAllWindows: vi.fn(),
}));

// What the restart module answers is set by each case: the module itself, its
// waits and its relaunch, is held by agent-restart's own tests and by the E2E.
vi.mock('../../../../electron/core/agent-restart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../electron/core/agent-restart')>()),
  restartForSettings: vi.fn(() => ({ action: 'next-launch', why: 'no CLI is running in its terminal' })),
}));

// The CLIs a cliPath names, on a POSIX disk in memory: this file runs as darwin
// or linux on every host (below).
const cliDisk = vi.hoisted(() => new Map<string, PosixEntry>());
vi.mock('fs', async (importOriginal) => (await import('../../platform/posix-fake-disk')).onPosixDisk(await importOriginal<typeof import('fs')>(), cliDisk));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pty from 'node-pty';
import { POSIX_ROOT, type PosixEntry } from '../../platform/posix-fake-disk';
import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { PRIVATE_DIR } from '../../../../electron/constants';
import { launchBegins, resetLaunches } from '../../../../electron/core/agent-launch';
import { agents, saveAgents } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';
import { restartForSettings } from '../../../../electron/core/agent-restart';
import { updateAgent } from '../../../../electron/core/agent-update';
import { checkQueued, resetRetune, revertAsWindow } from '../../../../electron/core/agent-retune';
import { changeById, resetChanges, type AgentChange } from '../../../../electron/services/agent-changes';
import { setGrant, resetGrants } from '../../../../electron/services/cross-project-grants';
import { broadcastToAllWindows } from '../../../../electron/utils/broadcast';
import { consumeResumeSessionId, resetResumeTracking, transcriptPath } from '../../../../electron/utils/resume-session';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });

const PROJECT = '/test/project';
const CODEX_BIN = `${POSIX_ROOT}/codex`;
const CLAUDE_BIN = `${POSIX_ROOT}/claude`;

/** A terminal with a CLI up in it, opened the way every agent terminal is (cliRunningIn reads what spawnAgentPty recorded). */
function liveCli(ptyId: string, binaryName: string) {
  const terminal = { write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), process: binaryName };
  vi.mocked(pty.spawn).mockReturnValueOnce(terminal as never);
  spawnAgentPty({ binaryName, shell: '/bin/bash', args: ['-l'], cwd: PROJECT, cols: 80, rows: 24, env: {} });
  ptyProcesses.set(ptyId, terminal as never);
  return terminal;
}

/** A terminal where the shell waits and no CLI runs. */
function bareShell(ptyId: string) {
  const terminal = { write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), process: 'bash' };
  vi.mocked(pty.spawn).mockReturnValueOnce(terminal as never);
  spawnAgentPty({ binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: PROJECT, cols: 80, rows: 24, env: {} });
  ptyProcesses.set(ptyId, terminal as never);
  return terminal;
}

function agent(overrides: Partial<AgentStatus>): AgentStatus {
  return {
    id: 'x', status: 'idle', projectPath: PROJECT, skills: [], output: [], lastActivity: new Date().toISOString(),
    ...overrides,
  } as AgentStatus;
}

function makeRouteApp(): RouteApp {
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  return app;
}

let ctx: RouteContext;
let settings: AppSettings;

type Caller = { callerAgentId?: string; internal?: boolean };

/** The route, called as `caller` (the lead by default), and its answer. */
async function update(id: string, body: Record<string, unknown>, caller: Caller = { callerAgentId: 'lead' }) {
  const app = makeRouteApp();
  registerAgentRoutes(app, ctx);
  const route = app.routes.find(r => r.method === 'POST' && String(r.pattern).includes('\\/update$'));
  expect(route, 'POST /api/agents/:id/update is registered').toBeDefined();
  const sendJson = vi.fn();
  const req = {
    method: 'POST', pathname: `/api/agents/${id}/update`, url: new URL(`http://localhost/api/agents/${id}/update`),
    body, raw: {} as never, res: {} as never, params: { id }, ...caller,
  } as RouteRequest;
  await route!.handler(req, sendJson, ctx);
  expect(sendJson).toHaveBeenCalledTimes(1);
  const [answer, status] = sendJson.mock.calls[0] as [Record<string, unknown>, number | undefined];
  return { answer, status: status ?? 200 };
}

/** POST /api/agents, what create_agent calls, as `caller` (the lead by default), and its answer. */
async function create(body: Record<string, unknown>, caller: Caller = { callerAgentId: 'lead' }) {
  const app = makeRouteApp();
  registerAgentRoutes(app, ctx);
  const route = app.routes.find(r => r.method === 'POST' && r.pattern === '/api/agents');
  expect(route, 'POST /api/agents is registered').toBeDefined();
  const sendJson = vi.fn();
  const req = {
    method: 'POST', pathname: '/api/agents', url: new URL('http://localhost/api/agents'),
    body, raw: {} as never, res: {} as never, params: {}, ...caller,
  } as RouteRequest;
  await route!.handler(req, sendJson, ctx);
  const [answer, status] = sendJson.mock.calls[0] as [Record<string, unknown>, number | undefined];
  return { answer, status: status ?? 200 };
}

/** Every field of the record but what a clock or a counter moves: what "nothing written" compares. */
const recordOf = (id: string) => JSON.parse(JSON.stringify({ ...agents.get(id)!, lastActivity: undefined }));

beforeEach(() => {
  resetLaunches();
  resetResumeTracking();
  resetRetune();
  resetChanges();
  agents.clear();
  ptyProcesses.clear();
  cliDisk.clear();
  cliDisk.set(POSIX_ROOT, { kind: 'dir', mode: 0o755 });
  cliDisk.set(CODEX_BIN, { kind: 'file', mode: 0o755 });
  cliDisk.set(CLAUDE_BIN, { kind: 'file', mode: 0o755 });
  cliDisk.set(`${POSIX_ROOT}/notes.txt`, { kind: 'file', mode: 0o644 });
  vi.mocked(saveAgents).mockClear();
  vi.mocked(restartForSettings).mockClear();
  vi.mocked(restartForSettings).mockImplementation(() => ({ action: 'next-launch', why: 'no CLI is running in its terminal' }));

  settings = {} as AppSettings;
  ctx = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
    appSettings: settings,
    getAppSettings: () => settings,
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'new-pty-id'),
    agentStatusEmitter: new EventEmitter(),
  };

  agents.set('lead', agent({ id: 'lead', name: 'Lead', role: 'orchestrator' }));
  agents.set('w1', agent({ id: 'w1', name: 'Coder', role: 'worker', provider: 'codex', model: 'gpt-old', cliPath: CODEX_BIN }));
  agents.set('w2', agent({ id: 'w2', name: 'Tester', role: 'worker', provider: 'claude', model: 'sonnet' }));
  agents.set('far', agent({ id: 'far', name: 'Far', role: 'worker', projectPath: '/other/project' }));
  agents.set('far-lead', agent({ id: 'far-lead', name: 'Far lead', role: 'orchestrator', projectPath: '/other/project' }));
  agents.set('runner', agent({ id: 'runner', name: 'Main', role: 'worker', kind: 'chat', chatId: 'c1' } as Partial<AgentStatus>));
});

describe('who may change an agent', () => {
  it('1. refuses a call that names nobody', async () => {
    const before = recordOf('w2');
    const { status } = await update('w2', { model: 'opus' }, {});
    expect(status).toBe(403);
    expect(recordOf('w2')).toEqual(before);
  });

  it('2. refuses a worker anything beyond the inference settings, on another agent and on itself, with worker_may_not_update', async () => {
    for (const id of ['w2', 'w1']) {
      const before = recordOf(id);
      const { answer, status } = await update(id, { permissionMode: 'plan' }, { callerAgentId: 'w1' });
      expect(status).toBe(403);
      expect(answer.code).toBe('worker_may_not_update');
      expect(String(answer.error)).toMatch(/orchestrator/);
      expect(recordOf(id)).toEqual(before);
    }
    expect(saveAgents).not.toHaveBeenCalled();
  });

  it("2. takes a worker's change of another agent's inference settings, and of its own", async () => {
    const other = await update('w2', { model: 'opus', effort: 'high' }, { callerAgentId: 'w1' });
    expect(other.status, String(other.answer.error)).toBe(200);
    expect(other.answer).toMatchObject({ state: 'applied', changeId: expect.stringMatching(/^chg-[0-9a-f]{8}$/) });
    expect(agents.get('w2')).toMatchObject({ model: 'opus', effort: 'high' });
    const own = await update('w1', { effort: 'low' }, { callerAgentId: 'w1' });
    expect(own.status).toBe(200);
    expect(agents.get('w1')!.effort).toBe('low');
  });

  it('3. refuses another project beyond the inference settings, whatever allowCrossProject says', async () => {
    for (const body of [{ permissionMode: 'plan' }, { permissionMode: 'plan', allowCrossProject: true }]) {
      const { answer, status } = await update('far', body);
      expect(status).toBe(403);
      expect(answer.code).toBe('other_project');
    }
    expect(agents.get('far')!.permissionMode).toBeUndefined();
  });

  it("3. takes another project's inference settings, from its orchestrator and from a worker", async () => {
    expect((await update('far', { model: 'opus' })).status).toBe(200);
    expect((await update('far', { effort: 'max' }, { callerAgentId: 'w1' })).status).toBe(200);
    expect(agents.get('far')).toMatchObject({ model: 'opus', effort: 'max' });
  });

  it("3c. takes another project's settings beyond the inference ones through the owner's grant, from those it names only", async () => {
    agents.set('w3', agent({ id: 'w3', name: 'Other worker', role: 'worker' }));
    setGrant({ from: PROJECT, to: '/other/project', workers: ['w1'] });
    try {
      expect((await update('far', { permissionMode: 'normal' }, { callerAgentId: 'w1' })).status).toBe(200);
      expect((await update('far', { skills: ['testing'] })).status).toBe(200);
      const refused = await update('far', { permissionMode: 'plan' }, { callerAgentId: 'w3' });
      expect(refused.status).toBe(403);
      expect(agents.get('far')).toMatchObject({ permissionMode: 'normal', skills: ['testing'] });
      // Never an orchestrator's, grant or not.
      expect((await update('far-lead', { permissionMode: 'normal' }, { callerAgentId: 'w1' })).answer.code).toBe('orchestrator_settings');
    } finally {
      resetGrants();
    }
  });

  it("4. refuses an orchestrator's settings beyond the inference ones, its own and Tars's pass's", async () => {
    const own = await update('lead', { permissionMode: 'plan' });
    expect(own.status).toBe(403);
    expect(own.answer.code).toBe('orchestrator_settings');
    expect(String(own.answer.error)).toMatch(/Agents page/);
    const far = await update('far-lead', { name: 'Renamed' }, { internal: true });
    expect(far.status).toBe(403);
    expect(far.answer.code).toBe('orchestrator_settings');
    expect(agents.get('lead')!.permissionMode).toBeUndefined();
    expect(agents.get('far-lead')!.name).toBe('Far lead');
  });

  it("4. takes an orchestrator's inference settings, from any agent, of any project", async () => {
    expect((await update('lead', { model: 'opus' }, { callerAgentId: 'far' })).status).toBe(200);
    expect((await update('far-lead', { effort: 'high' }, { callerAgentId: 'w1' })).status).toBe(200);
    expect(agents.get('lead')!.model).toBe('opus');
    expect(agents.get('far-lead')!.effort).toBe('high');
  });

  it('4b. judges a call by the strictest setting it names, and writes nothing', async () => {
    const before = recordOf('w2');
    const { answer, status } = await update('w2', { model: 'opus', permissionMode: 'plan' }, { callerAgentId: 'w1' });
    expect(status).toBe(403);
    expect(answer.code).toBe('worker_may_not_update');
    expect(String(answer.error)).toMatch(/permissionMode/);
    expect(recordOf('w2')).toEqual(before);
  });

  it("5. lets the project's orchestrator change one of its workers, and Tars's own pass any worker", async () => {
    expect((await update('w2', { model: 'opus' })).status).toBe(200);
    expect(agents.get('w2')!.model).toBe('opus');
    expect((await update('far', { name: 'Far away' }, { internal: true })).status).toBe(200);
    expect(agents.get('far')!.name).toBe('Far away');
  });

  it("6. refuses a chat's runner, naming its orchestrator: its settings are the orchestrator's", async () => {
    for (const caller of [{ callerAgentId: 'lead' }, { internal: true }, { callerAgentId: 'w1' }]) {
      const { answer, status } = await update('runner', { model: 'opus' }, caller);
      expect(status).toBe(403);
      expect(answer.code).toBe('runs_on_orchestrator');
      expect(String(answer.error)).toContain('Lead');
    }
    expect(agents.get('runner')!.model).toBeUndefined();
  });
});

describe('what may change', () => {
  it('7. refuses role and orchestratorMode: an orchestrator is made in the Agents page', async () => {
    for (const body of [{ role: 'orchestrator' }, { role: 'worker' }, { orchestratorMode: true }]) {
      const before = recordOf('w2');
      const { answer, status } = await update('w2', { ...body, model: 'opus' });
      expect(status).toBe(403);
      expect(String(answer.error)).toMatch(/Agents page/);
      expect(recordOf('w2')).toEqual(before);
    }
  });

  it('8. refuses projectPath: an agent does not move to another project over the API', async () => {
    const { status } = await update('w2', { projectPath: '/other/project' });
    expect(status).toBe(403);
    expect(agents.get('w2')!.projectPath).toBe(PROJECT);
  });

  it('9. refuses a field it does not take, naming the fields it does', async () => {
    for (const body of [{ modle: 'opus' }, { savedPrompt: 'go' }]) {
      const before = recordOf('w2');
      const { answer, status } = await update('w2', body);
      expect(status).toBe(400);
      expect(String(answer.error)).toMatch(/provider/);
      expect(String(answer.error)).toMatch(/effort/);
      expect(recordOf('w2')).toEqual(before);
    }
    // A worktree is taken since 2.0.7, as a branch of the project's worktrees: the window's own shape is not.
    const before = recordOf('w2');
    const { answer, status } = await update('w2', { worktree: { enabled: true, branchName: 'x' } });
    expect(status).toBe(400);
    expect(String(answer.error)).toMatch(/worktree is the branch/);
    expect(recordOf('w2')).toEqual(before);
  });

  it('10. refuses an update that names nothing', async () => {
    const { status } = await update('w2', {});
    expect(status).toBe(400);
  });

  it('11. refuses what create_agent refuses, and writes nothing', async () => {
    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [{ provider: 'gpt-everything' }, /Unknown provider/],
      [{ permissionMode: 'yolo' }, /permission mode/i],
      [{ effort: 'extreme' }, /effort/i],
      [{ model: 'opus; rm -rf ~' }, /model/i],
      [{ cliPath: 'codex' }, /absolute/i],
      [{ cliPath: `${POSIX_ROOT}/notes.txt` }, /cliPath/],
      [{ skills: ['../../etc'] }, /skill/],
      [{ name: '' }, /name/i],
      [{ name: 'Coder, task t-1a2b3c4d' }, /task t-/],
      [{ provider: 'codex', permissionMode: 'plan' }, /no plan mode/],
      [{ provider: 'deepseek' }, /No API key configured for provider "deepseek"/],
    ];
    for (const [body, why] of refused) {
      const before = recordOf('w2');
      const { answer, status } = await update('w2', body);
      expect(status, JSON.stringify(body)).toBe(400);
      expect(String(answer.error), JSON.stringify(body)).toMatch(why);
      expect(recordOf('w2'), JSON.stringify(body)).toEqual(before);
    }
    expect(saveAgents).not.toHaveBeenCalled();
  });

  it('11. takes a key provider once its key is set', async () => {
    settings.deepSeekApiKey = 'sk-test-not-a-real-key';
    const { status } = await update('w2', { provider: 'deepseek' });
    expect(status).toBe(200);
    expect(agents.get('w2')!.provider).toBe('deepseek');
  });

  it('12. refuses a value of the wrong type', async () => {
    for (const body of [{ skills: 'react' }, { model: 42 }, { name: ['x'] }, { effort: true }]) {
      const before = recordOf('w2');
      const { status } = await update('w2', body);
      expect(status, JSON.stringify(body)).toBe(400);
      expect(recordOf('w2')).toEqual(before);
    }
  });
});

describe('the folder handed besides the project', () => {
  const never = [PRIVATE_DIR, path.join(PRIVATE_DIR, 'claude-accounts.json'), `${PRIVATE_DIR}/`, os.homedir(), path.parse(os.homedir()).root];

  it('12b. update_agent refuses ~/.tars-private, a folder inside it or one that holds it, and writes nothing', async () => {
    for (const folder of never) {
      const before = recordOf('w2');
      const { answer, status } = await update('w2', { secondaryProjectPath: folder });
      expect(status, folder).toBe(400);
      expect(String(answer.error), folder).toMatch(/tars-private/);
      expect(recordOf('w2'), folder).toEqual(before);
    }
    expect(saveAgents).not.toHaveBeenCalled();
  });

  it('12b. create_agent refuses the same, and creates nothing', async () => {
    for (const folder of never) {
      const { answer, status } = await create({ projectPath: PROJECT, name: 'Helper', secondaryProjectPath: folder });
      expect(status, folder).toBe(400);
      expect(String(answer.error), folder).toMatch(/tars-private/);
    }
    expect([...agents.keys()].sort()).toEqual(['far', 'far-lead', 'lead', 'runner', 'w1', 'w2']);
  });

  it('12c. the window\'s agent:update refuses the same, and writes nothing', async () => {
    for (const folder of never) {
      const before = recordOf('w2');
      const result = await updateAgent({ id: 'w2', secondaryProjectPath: folder });
      expect(result.success, folder).toBe(false);
      expect(result.success ? '' : result.error, folder).toMatch(/tars-private/);
      expect(recordOf('w2'), folder).toEqual(before);
    }
    expect(saveAgents).not.toHaveBeenCalled();
  });
});

describe('when it applies: a running turn is never cut', () => {
  afterEach(() => {
    fs.rmSync(path.join(os.homedir(), '.claude'), { recursive: true, force: true });
  });

  it('13. queues a change of CLI while a CLI works in the terminal, writes nothing and leaves it alone', async () => {
    const terminal = liveCli('pty-w1', 'codex');
    agents.get('w1')!.ptyId = 'pty-w1';
    agents.get('w1')!.status = 'running';
    for (const [i, body] of [{ provider: 'claude' }, { cliPath: CLAUDE_BIN }, { provider: 'claude', model: 'opus' }].entries()) {
      const before = recordOf('w1');
      const { answer, status } = await update('w1', body);
      expect(status, JSON.stringify(body)).toBe(200);
      // The first waits for the turn, the others behind it, in the order they were asked.
      expect(answer).toMatchObject({ state: 'queued', waitingFor: i === 0 ? 'turn' : 'earlier change', changeId: expect.stringMatching(/^chg-/) });
      expect(String(answer.text)).toMatch(/never cut/);
      expect({ ...recordOf('w1'), lastRetune: undefined }).toEqual({ ...before, lastRetune: undefined });
    }
    expect(terminal.kill).not.toHaveBeenCalled();
    expect(ptyProcesses.get('pty-w1')).toBe(terminal);
  });

  it('13b. queues a change of CLI while a launch is under way in a bare shell, the launch untouched', async () => {
    const shell = bareShell('pty-w1');
    agents.get('w1')!.ptyId = 'pty-w1';
    launchBegins('w1');
    const { answer, status } = await update('w1', { provider: 'claude' });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ state: 'queued', waitingFor: 'launch' });
    expect(shell.kill).not.toHaveBeenCalled();
    expect(agents.get('w1')!.provider).toBe('codex');
  });

  it('13d. applies a queued change once the turn ends, ending the idle terminal for a new CLI, and logs when', async () => {
    const terminal = liveCli('pty-w1', 'codex');
    Object.assign(agents.get('w1')!, { ptyId: 'pty-w1', status: 'running' });
    const asked = await update('w1', { provider: 'claude', model: 'opus' }, { callerAgentId: 'far' });
    expect(asked.answer.state).toBe('queued');
    await checkQueued();
    expect(agents.get('w1')!.provider).toBe('codex');
    expect(terminal.kill).not.toHaveBeenCalled();
    agents.get('w1')!.status = 'waiting';
    agents.get('w1')!.waitingReason = 'idle';
    const before = Date.now();
    await checkQueued();
    expect(agents.get('w1')).toMatchObject({ provider: 'claude', model: 'opus' });
    expect(terminal.kill).toHaveBeenCalled();
    const logged = changeById(String(asked.answer.changeId))!;
    expect(logged).toMatchObject({ state: 'applied', by: { kind: 'agent', id: 'far' }, before: { provider: 'codex', model: 'gpt-old' }, after: { provider: 'claude', model: 'opus' } });
    expect(Date.parse(logged.effectiveAt!)).toBeGreaterThanOrEqual(before - 5);
  });

  it('17. says applied, the change id and when it took effect', async () => {
    const { answer } = await update('w2', { effort: 'max' });
    expect(answer).toMatchObject({ state: 'applied', changeId: expect.stringMatching(/^chg-[0-9a-f]{8}$/), effectiveAt: expect.any(String) });
    expect(String(answer.text)).toMatch(/^Applied at /);
  });

  it('13c. takes a change of CLI right after stop_agent: the launch the stop ended starts nothing', async () => {
    launchBegins('w1');
    // What stop_agent leaves (core/agent-stop.ts): no terminal, `stopped`, and the launch still marked for CLI_BOOT_MS.
    Object.assign(agents.get('w1')!, { status: 'stopped', ptyId: undefined, stoppedAt: new Date().toISOString(), stoppedBy: 'Lead' });
    const { answer, status } = await update('w1', { provider: 'claude' });
    expect(status, String(answer.error)).toBe(200);
    expect(answer).toMatchObject({ applies: 'next-start', session: 'new' });
    expect(agents.get('w1')!.provider).toBe('claude');
  });

  it('14. a change of provider clears the model and CLI path of the old CLI', async () => {
    const { answer, status } = await update('w1', { provider: 'claude' });
    expect(status).toBe(200);
    const record = agents.get('w1')!;
    expect(record.provider).toBe('claude');
    expect(record.model).toBeUndefined();
    expect(record.cliPath).toBeUndefined();
    expect(answer.changed).toEqual(expect.arrayContaining(['provider', 'model', 'cliPath']));
  });

  it('15. a change of provider keeps the model, effort and CLI path given with it', async () => {
    const { status } = await update('w1', { provider: 'claude', model: 'opus', effort: 'high', cliPath: CLAUDE_BIN });
    expect(status).toBe(200);
    expect(agents.get('w1')).toMatchObject({ provider: 'claude', model: 'opus', effort: 'high', cliPath: CLAUDE_BIN });
  });

  it('16a. claude up and free: restarted now, on its conversation', async () => {
    liveCli('pty-w2', 'claude');
    Object.assign(agents.get('w2')!, { ptyId: 'pty-w2', resumableSessionId: '11111111-2222-3333-4444-555555555555' });
    vi.mocked(restartForSettings).mockReturnValueOnce({ action: 'restarted' });
    const { answer, status } = await update('w2', { model: 'opus', effort: 'max' });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ applies: 'now', session: 'kept' });
    expect(String(answer.text)).toMatch(/same conversation/);
    expect(vi.mocked(restartForSettings).mock.calls[0]).toEqual(['w2', ['model', 'effort']]);
  });

  it('16b. claude in a turn: queued, nothing written, the turn not cut; restarted on it once the turn ends', async () => {
    const terminal = liveCli('pty-w2', 'claude');
    Object.assign(agents.get('w2')!, { ptyId: 'pty-w2', status: 'running', resumableSessionId: '11111111-2222-3333-4444-555555555555' });
    const { answer, status } = await update('w2', { effort: 'low' });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ state: 'queued', applies: 'when-free', waitingFor: 'turn' });
    expect(String(answer.text)).toMatch(/turn ends/);
    expect(terminal.kill).not.toHaveBeenCalled();
    expect(agents.get('w2')!.effort).toBeUndefined();
    expect(restartForSettings).not.toHaveBeenCalled();
    Object.assign(agents.get('w2')!, { status: 'waiting', waitingReason: 'idle' });
    vi.mocked(restartForSettings).mockReturnValueOnce({ action: 'restarted' });
    await checkQueued();
    expect(agents.get('w2')!.effort).toBe('low');
    expect(vi.mocked(restartForSettings).mock.calls[0]).toEqual(['w2', ['effort']]);
  });

  it('16c. codex in a turn: queued, its terminal alive; once at rest, written and its idle terminal ended', async () => {
    const terminal = liveCli('pty-w1', 'codex');
    Object.assign(agents.get('w1')!, { ptyId: 'pty-w1', status: 'running' });
    const { answer, status } = await update('w1', { model: 'gpt-new', effort: 'high' });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ state: 'queued', waitingFor: 'turn' });
    expect(terminal.kill).not.toHaveBeenCalled();
    expect(agents.get('w1')).toMatchObject({ model: 'gpt-old', ptyId: 'pty-w1' });
    Object.assign(agents.get('w1')!, { status: 'waiting', waitingReason: 'idle' });
    await checkQueued();
    expect(agents.get('w1')).toMatchObject({ model: 'gpt-new', effort: 'high', ptyId: undefined, status: 'idle' });
    expect(terminal.kill).toHaveBeenCalled();
  });

  it('16d. no CLI up: at its next start, which continues the conversation only on the first start since Tars opened', async () => {
    const session = '11111111-2222-3333-4444-555555555555';
    agents.get('w2')!.resumableSessionId = session;
    const transcript = transcriptPath(PROJECT, session);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{}\n');

    const first = await update('w2', { model: 'opus' });
    expect(first.answer).toMatchObject({ applies: 'next-start', session: 'kept' });

    expect(consumeResumeSessionId(agents.get('w2')!)).toBe(session); // that first start
    const later = await update('w2', { model: 'haiku' });
    expect(later.answer).toMatchObject({ applies: 'next-start', session: 'new' });
  });

  it('16e. a change of CLI: at its next start, on a new conversation, even with an older one of the new CLI on disk', async () => {
    const session = '11111111-2222-3333-4444-555555555555';
    const shell = bareShell('pty-w1');
    Object.assign(agents.get('w1')!, { ptyId: 'pty-w1', resumableSessionId: session });
    const transcript = transcriptPath(PROJECT, session);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{}\n');

    const { answer, status } = await update('w1', { provider: 'claude', model: 'opus' });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ applies: 'next-start', session: 'new' });
    expect(String(answer.text)).toMatch(/new conversation/);
    // The shell it waited in had the old CLI's environment: ended, as the window ends it.
    expect(shell.kill).toHaveBeenCalled();
    expect(consumeResumeSessionId(agents.get('w1')!)).toBeNull();
  });

  it('16f. a name or skills only: nothing restarted, its running session keeps the old ones until its next start', async () => {
    liveCli('pty-w2', 'claude');
    agents.get('w2')!.ptyId = 'pty-w2';
    vi.mocked(restartForSettings).mockImplementation((_id, changed) => (changed.length === 0
      ? { action: 'next-launch', why: 'nothing the CLI reads at launch changed' }
      : { action: 'restarted' }));
    const { answer, status } = await update('w2', { name: 'Reviewer', skills: ['react'] });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ applies: 'next-start', session: 'kept' });
    expect(String(answer.text)).toMatch(/goes on under its old name and skills/);
    expect(String(answer.text)).toMatch(/next session/);
    expect(String(answer.text)).not.toMatch(/Nothing it reads when it starts/);
    expect(agents.get('w2')).toMatchObject({ name: 'Reviewer', skills: ['react'] });
    expect(vi.mocked(restartForSettings).mock.calls.filter(([, changed]) => changed.length > 0)).toEqual([]);

    const character = await update('w2', { character: 'wizard' });
    expect(character.answer).toMatchObject({ applies: 'now', session: 'kept' });
  });

  it('answers with the agent as GET /api/agents/:id shows it, without its output buffer', async () => {
    agents.get('w2')!.output = ['chunk-1', 'chunk-2'];
    const { answer } = await update('w2', { model: 'opus' });
    const shown = answer.agent as Record<string, unknown>;
    expect(shown).toMatchObject({ id: 'w2', model: 'opus', outputChunks: 2 });
    expect(shown.output).toBeUndefined();
  });
});

describe('several agents, the log and a revert', () => {
  async function call(method: 'GET' | 'POST', pathname: string, body: Record<string, unknown> = {}, caller: Caller = { callerAgentId: 'lead' }) {
    const app = makeRouteApp();
    registerAgentRoutes(app, ctx);
    const url = new URL(`http://localhost${pathname}`);
    const route = app.routes.find(r => r.method === method && (r.pattern === url.pathname || (r.pattern instanceof RegExp && r.pattern.test(url.pathname))));
    expect(route, `${method} ${pathname} is registered`).toBeDefined();
    const sendJson = vi.fn();
    const req = { method, pathname: url.pathname, url, body, raw: {} as never, res: {} as never, params: {}, ...caller } as RouteRequest;
    await route!.handler(req, sendJson, ctx);
    const [answer, status] = sendJson.mock.calls[0] as [Record<string, unknown>, number | undefined];
    return { answer, status: status ?? 200 };
  }

  it("18. answers each agent of a batch on its own, under one batch id, and never reaches a chat's runner", async () => {
    const { answer, status } = await call('POST', '/api/agents/update', { project: PROJECT, effort: 'high' }, { callerAgentId: 'far' });
    expect(status).toBe(200);
    const results = answer.results as Array<{ id: string; state: string }>;
    expect(answer.batchId).toMatch(/^b-[0-9a-f]{8}$/);
    expect(results.map((r) => r.id).sort()).toEqual(['lead', 'w1', 'w2']);
    for (const r of results) expect(r.state).toBe('applied');
    expect(agents.get('runner')!.effort).toBeUndefined();
    const mixed = await call('POST', '/api/agents/update', { ids: ['w1', 'lead', 'nobody'], permissionMode: 'normal' });
    const byId = Object.fromEntries((mixed.answer.results as Array<{ id: string; state: string; code?: string }>).map((r) => [r.id, r]));
    expect(byId.w1.state).toBe('applied');
    expect(byId.lead).toMatchObject({ state: 'refused', code: 'orchestrator_settings' });
    expect(byId.nobody.state).toBe('refused');
  });

  it.each([
    ['both ids and a project', { ids: ['w1'], project: PROJECT, effort: 'low' }],
    ['neither', { effort: 'low' }],
    ['an empty list', { ids: [], effort: 'low' }],
  ])('18. refuses a batch naming %s', async (_what, body) => {
    const { status, answer } = await call('POST', '/api/agents/update', body);
    expect(status).toBe(400);
    expect(answer.code).toBe('invalid_batch');
  });

  it('19. logs who, before, after and when, readable by any agent', async () => {
    await update('w2', { model: 'opus' }, { callerAgentId: 'far' });
    const { answer } = await call('GET', '/api/agent-changes?agentId=w2', {}, { callerAgentId: 'w1' });
    expect((answer.changes as AgentChange[])[0]).toMatchObject({
      agentId: 'w2', by: { kind: 'agent', id: 'far', name: 'Far', projectPath: '/other/project' },
      fields: ['model'], before: { model: 'sonnet' }, after: { model: 'opus' }, state: 'applied',
    });
  });

  it('20. cancels a queued change, writing nothing', async () => {
    liveCli('pty-w2', 'claude');
    Object.assign(agents.get('w2')!, { ptyId: 'pty-w2', status: 'running' });
    const queued = await update('w2', { effort: 'low' }, { callerAgentId: 'w1' });
    const { answer } = await call('POST', '/api/agent-changes/revert', { changeId: queued.answer.changeId }, { callerAgentId: 'w1' });
    expect((answer.results as Array<{ state: string }>)[0].state).toBe('cancelled');
    Object.assign(agents.get('w2')!, { status: 'waiting', waitingReason: 'idle' });
    await checkQueued();
    expect(agents.get('w2')!.effort).toBeUndefined();
    expect(changeById(String(queued.answer.changeId))!.state).toBe('cancelled');
  });

  it('20. sets back only what is still at its value, names the rest, and refuses a caller who may not change it', async () => {
    const first = await update('w2', { model: 'opus', effort: 'high' }, { callerAgentId: 'w1' });
    await update('w2', { effort: 'max' }, { callerAgentId: 'far' });
    const { answer } = await call('POST', '/api/agent-changes/revert', { changeId: first.answer.changeId }, { callerAgentId: 'w1' });
    expect((answer.results as Array<{ state: string; leftAlone?: string[] }>)[0]).toMatchObject({ state: 'applied', leftAlone: ['effort'] });
    expect(agents.get('w2')).toMatchObject({ model: 'sonnet', effort: 'max' });
    const renamed = await update('w2', { name: 'Tester two' });
    const refused = await call('POST', '/api/agent-changes/revert', { changeId: renamed.answer.changeId }, { callerAgentId: 'w1' });
    expect((refused.answer.results as Array<{ state: string; code?: string }>)[0]).toMatchObject({ state: 'refused', code: 'worker_may_not_update' });
    expect(agents.get('w2')!.name).toBe('Tester two');
  });
});

describe("the window's undo (agent.revertChange)", () => {
  it('21. sets an applied change back through the engine, filed under the window, and names what moved since', async () => {
    const first = await update('w2', { model: 'opus', effort: 'high' }, { callerAgentId: 'far' });
    await update('w2', { effort: 'max' }, { callerAgentId: 'w1' });
    const undone = await revertAsWindow({ changeId: String(first.answer.changeId) });
    expect(undone).toMatchObject({ ok: true, state: 'applied', leftAlone: ['effort'] });
    expect(agents.get('w2')).toMatchObject({ model: 'sonnet', effort: 'max' });
    const logged = changeById((undone as { revertChangeId: string }).revertChangeId)!;
    expect(logged).toMatchObject({ by: { kind: 'window' }, revertOf: first.answer.changeId, before: { model: 'opus' }, after: { model: 'sonnet' } });
  });

  it("21. undoes an agent's last change by its id, and cancels a queued one, writing nothing", async () => {
    liveCli('pty-w2', 'claude');
    Object.assign(agents.get('w2')!, { ptyId: 'pty-w2', status: 'running' });
    await update('w2', { effort: 'low' }, { callerAgentId: 'w1' });
    expect(await revertAsWindow({ agentId: 'w2' })).toEqual({ ok: true, state: 'cancelled' });
    Object.assign(agents.get('w2')!, { status: 'waiting', waitingReason: 'idle' });
    await checkQueued();
    expect(agents.get('w2')!.effort).toBeUndefined();
  });

  it('21. leaves a worktree that is gone alone, and says so', async () => {
    Object.assign(agents.get('w2')!, { worktreePath: `${PROJECT}/.worktrees/gone`, branchName: 'gone' });
    const moved = await update('w2', { worktree: null });
    expect(moved.status, String(moved.answer.error)).toBe(200);
    const undone = await revertAsWindow({ changeId: String(moved.answer.changeId) });
    expect(undone).toMatchObject({ ok: false });
    expect(String((undone as { error: string }).error)).toMatch(/worktree/);
    expect(agents.get('w2')!.worktreePath).toBeUndefined();
  });

  it.each([
    ['a change nobody knows', { changeId: 'chg-00000000' }],
    ['an agent with no change', { agentId: 'w1' }],
    ['both a change and an agent', { changeId: 'chg-00000000', agentId: 'w1' }],
    ['neither', {}],
  ])('21. refuses %s, saying why', async (_what, sel) => {
    const answer = await revertAsWindow(sel as never);
    expect(answer.ok).toBe(false);
    expect((answer as { error: string }).error.length).toBeGreaterThan(0);
  });
});

describe('the Audit of #595: the queue, the revert, the log', () => {
  async function call(method: 'GET' | 'POST', pathname: string, body: Record<string, unknown> = {}, caller: Caller = { callerAgentId: 'lead' }) {
    const app = makeRouteApp();
    registerAgentRoutes(app, ctx);
    const url = new URL(`http://localhost${pathname}`);
    const route = app.routes.find(r => r.method === method && (r.pattern === url.pathname || (r.pattern instanceof RegExp && r.pattern.test(url.pathname))));
    const sendJson = vi.fn();
    const req = { method, pathname: url.pathname, url, body, raw: {} as never, res: {} as never, params: {}, ...caller } as RouteRequest;
    await route!.handler(req, sendJson, ctx);
    const [answer, status] = sendJson.mock.calls[0] as [Record<string, unknown>, number | undefined];
    return { answer, status: status ?? 200 };
  }

  function queueTwo() {
    liveCli('pty-w2', 'claude');
    Object.assign(agents.get('w2')!, { ptyId: 'pty-w2', status: 'running' });
  }

  it('22. never applies a change its revert cancelled while an earlier one was being applied', async () => {
    queueTwo();
    const c1 = await update('w2', { model: 'opus' }, { callerAgentId: 'w1' });
    const c2 = await update('w2', { effort: 'max' }, { callerAgentId: 'w1' });
    expect([c1.answer.state, c2.answer.state]).toEqual(['queued', 'queued']);
    Object.assign(agents.get('w2')!, { status: 'waiting', waitingReason: 'idle' });
    // The revert of c2 lands while c1 is applied (its restart is asked for inside the apply).
    vi.mocked(restartForSettings).mockImplementationOnce(() => {
      void revertAsWindow({ changeId: String(c2.answer.changeId) });
      return { action: 'restarted' };
    });
    await checkQueued();
    await checkQueued();
    expect(agents.get('w2')!.model).toBe('opus');
    expect(agents.get('w2')!.effort).toBeUndefined();
    expect(changeById(String(c2.answer.changeId))!.state).toBe('cancelled');
  });

  it('22. keeps a change asked while another is applied, and applies it after, in order', async () => {
    queueTwo();
    const c1 = await update('w2', { model: 'opus' }, { callerAgentId: 'w1' });
    Object.assign(agents.get('w2')!, { status: 'waiting', waitingReason: 'idle' });
    let c2: { answer: Record<string, unknown> } | undefined;
    vi.mocked(restartForSettings).mockImplementationOnce(() => {
      void update('w2', { effort: 'max' }, { callerAgentId: 'w1' }).then((a) => { c2 = a; });
      return { action: 'restarted' };
    });
    await checkQueued();
    await vi.waitFor(() => expect(c2).toBeDefined());
    expect(c2!.answer.state).toBe('queued');
    await checkQueued();
    expect(agents.get('w2')).toMatchObject({ model: 'opus', effort: 'max' });
    expect(changeById(String(c1.answer.changeId))!.state).toBe('applied');
    expect(changeById(String(c2!.answer.changeId))!.state).toBe('applied');
  });

  it('23. lets the worker that changed a provider revert it, on a worker and on an orchestrator, and Tars\'s pass too', async () => {
    const onWorker = await update('w2', { provider: 'codex' }, { callerAgentId: 'w1' });
    expect(onWorker.status, String(onWorker.answer.error)).toBe(200);
    const back = await call('POST', '/api/agent-changes/revert', { changeId: onWorker.answer.changeId }, { callerAgentId: 'w1' });
    expect((back.answer.results as Array<{ state: string }>)[0].state).toBe('applied');
    expect(agents.get('w2')).toMatchObject({ provider: 'claude', model: 'sonnet' });
    const onLead = await update('lead', { provider: 'codex' }, { callerAgentId: 'far' });
    expect(onLead.status, String(onLead.answer.error)).toBe(200);
    const byTars = await call('POST', '/api/agent-changes/revert', { changeId: onLead.answer.changeId }, { internal: true });
    expect((byTars.answer.results as Array<{ state: string }>)[0].state).toBe('applied');
    expect(agents.get('lead')!.provider ?? 'claude').toBe('claude');
  });

  it("24. shows another project's changes by their inference settings only, its own whole", async () => {
    await update('far', { model: 'opus' });
    await update('far', { name: 'Far renamed' }, { callerAgentId: 'far-lead' });
    await update('w2', { name: 'Tester renamed' });
    const fromFar = await call('GET', '/api/agent-changes', {}, { callerAgentId: 'far' });
    const changes = fromFar.answer.changes as AgentChange[];
    const mine = changes.filter((c) => c.projectPath === '/other/project');
    expect(mine.map((c) => c.fields).sort()).toEqual([['model'], ['name']]);
    const theirs = changes.filter((c) => c.projectPath === PROJECT);
    expect(theirs).toEqual([]);
    const fromHere = await call('GET', '/api/agent-changes', {}, { callerAgentId: 'w1' });
    const farSeen = (fromHere.answer.changes as AgentChange[]).filter((c) => c.projectPath === '/other/project');
    expect(farSeen.map((c) => c.fields)).toEqual([['model']]);
  });

  it('26. makes the second of two changes asked at once wait for the first, then applies it', async () => {
    const [a, b] = await Promise.all([
      update('w2', { model: 'opus' }, { callerAgentId: 'w1' }),
      update('w2', { effort: 'max' }, { callerAgentId: 'far' }),
    ]);
    expect(a.answer.state).toBe('applied');
    expect(b.answer).toMatchObject({ state: 'queued', waitingFor: 'earlier change' });
    await checkQueued();
    expect(agents.get('w2')).toMatchObject({ model: 'opus', effort: 'max' });
    expect(changeById(String(b.answer.changeId))!.state).toBe('applied');
  });

  it('27. hands the window what the caller named, apart from what a provider change implied', async () => {
    vi.mocked(broadcastToAllWindows).mockClear();
    const { answer } = await update('w2', { provider: 'codex' }, { callerAgentId: 'w1' });
    const change = changeById(String(answer.changeId))!;
    expect(change.fields).toEqual(['cliPath', 'model', 'provider']);
    expect(agents.get('w2')!.lastRetune).toMatchObject({ fields: ['cliPath', 'model', 'provider'], asked: ['provider'] });
    const pushed = vi.mocked(broadcastToAllWindows).mock.calls.filter(([channel]) => channel === 'agent:retuned').map(([, event]) => event as Record<string, unknown>);
    expect(pushed.at(-1)).toMatchObject({ changeId: answer.changeId, asked: ['provider'], fields: ['cliPath', 'model', 'provider'] });
  });

  it('25. refuses a value the log does not keep before writing anything', async () => {
    const before = recordOf('w2');
    const { status } = await update('w2', { name: 'n'.repeat(400) });
    expect(status).toBe(400);
    expect(recordOf('w2')).toEqual(before);
  });
});
