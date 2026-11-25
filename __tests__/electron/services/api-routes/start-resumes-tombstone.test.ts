import '../../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * A session Tars itself resumes belongs to that launch, and a hook from the
 * process it killed is still refused (the orchestrator's item 3 of 19/10).
 * `--resume <id>` keeps the id, and every launch that ends a CLI first makes
 * that CLI's session a tombstone (`lastKilledSessionId`), whose posts
 * hooks-routes.ts refuses as stale: a launch that resumes its own tombstone
 * under that id is never seen by Tars.
 *
 * Here the API's own launch (spawnAgentSession): the route, the resume rule
 * and the provider's command are the app's; the terminal is a stand-in that
 * records the command it is given.
 *
 * Every way it can fail, written before the code:
 *  R1. Asleep, then stopped (a stop of an asleep agent ends no CLI: the
 *      tombstone is still the one the sleep left), then started: the start
 *      resumes the session it slept in under its id, and that session stays a
 *      tombstone, so its SessionStart is refused.
 *  R2. A start into a terminal whose CLI exited, its session still the
 *      agent's, that resumes that same session (its first start of this run,
 *      after a launch that did not spend the resume: a restart, a chat's
 *      runner): it resumes under the id it has just tombstoned, and is
 *      refused; or it lifts the tombstone, and the ended CLI's late posts are
 *      taken for the new session's.
 *  R3. A start that resumes nothing, or another session, touches the tombstone.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../../electron/core/agent-pty', async (original) => ({
  ...(await original<typeof import('../../../../electron/core/agent-pty')>()),
  // A terminal whose CLI exited is left a shell: no CLI runs in it.
  cliRunningIn: (p: unknown) => !!p && !(p as { exited?: boolean }).exited,
  spawnAgentPty: vi.fn(),
}));
vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));

import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { fallAsleep } from '../../../../electron/core/agent-asleep';
import { resetLaunches } from '../../../../electron/core/agent-launch';
import { resetResumeTracking, transcriptPath } from '../../../../electron/utils/resume-session';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

const SLEPT = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER = '0b8e4f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-start-resumes-'));

let routes: RouteApp;
let commands: string[];

beforeEach(() => {
  agents.clear();
  ptyProcesses.clear();
  resetLaunches();
  resetResumeTracking();
  commands = [];
  vi.mocked(spawnAgentPty).mockImplementation((o) => {
    commands.push((o.args ?? []).join(' '));
    return { pid: 4343, write: vi.fn(), onExit: vi.fn(), onData: vi.fn(), kill: vi.fn(), resize: vi.fn() } as never;
  });
  for (const sid of [SLEPT, OTHER]) {
    const file = transcriptPath(project, sid, os.homedir());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
  }
  routes = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  registerAgentRoutes(routes, {
    mainWindow: null,
    appSettings: {} as AppSettings,
    getAppSettings: () => ({}) as AppSettings,
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'unused'),
    agentStatusEmitter: new EventEmitter(),
  } as RouteContext);
});

/** POST /api/agents/dev/start, from Tars. */
function start(prompt: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const u = new URL('http://localhost/api/agents/dev/start');
  const route = routes.routes.find(r => r.method === 'POST' && typeof r.pattern !== 'string' && r.pattern.test(u.pathname))!;
  const match = (route.pattern as RegExp).exec(u.pathname)!;
  return new Promise((resolve) => {
    const req = { method: 'POST', pathname: u.pathname, url: u, body: { prompt }, raw: { headers: {}, on: () => {} }, res: {}, params: { id: match[1] }, internal: true } as unknown as RouteRequest;
    void route.handler(req, (data, status = 200) => resolve({ data: data as Record<string, unknown>, status }), {} as RouteContext);
  });
}

function dev(over: Partial<AgentStatus>): AgentStatus {
  const agent = {
    id: 'dev', name: 'Build Agent', status: 'idle', provider: 'claude', projectPath: project, skills: [], output: [],
    lastActivity: new Date().toISOString(), ...over,
  } as AgentStatus;
  agents.set('dev', agent);
  return agent;
}

const resumes = (command: string | undefined) => /--resume '?([0-9a-f-]{36})/.exec(command ?? '')?.[1];

describe('a start that resumes a session Tars ended', () => {
  it('(R1) asleep, then stopped, then started: it resumes the session it slept in, and that session is no tombstone any more', async () => {
    const agent = dev({ status: 'running', ptyId: 'pty-old', currentSessionId: SLEPT, resumableSessionId: SLEPT });
    fallAsleep(agent, undefined, Date.now());
    expect(agent.lastKilledSessionId).toBe(SLEPT);
    // Stopped while asleep, as agent-stop.ts does: no CLI to end, no session to tombstone.
    Object.assign(agent, { status: 'stopped', stoppedBy: 'You', stoppedAt: new Date().toISOString() });

    const started = await start('go on');
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    expect(resumes(commands[0])).toBe(SLEPT);
    expect(commands[0]).not.toContain('--fork-session');
    expect(agent.lastKilledSessionId, 'the session it resumes is its own').toBeUndefined();
  });

  it('(R2) a start into the shell its CLI left, resuming that CLI\'s session, continues it under a new id, the ended one still a tombstone', async () => {
    const terminal = { pid: 4242, exited: true, write: vi.fn(), onExit: vi.fn(), onData: vi.fn(), kill: vi.fn() };
    ptyProcesses.set('pty-live', terminal as never);
    // Its CLI, on SLEPT from a launch that did not spend this run's resume, exited.
    const agent = dev({ status: 'waiting', ptyId: 'pty-live', currentSessionId: SLEPT, resumableSessionId: SLEPT });

    const started = await start('go on');
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    expect(resumes(commands[0])).toBe(SLEPT);
    expect(commands[0], 'continued under a new id').toContain('--fork-session');
    expect(agent.lastKilledSessionId, 'the ended CLI\'s posts are still refused').toBe(SLEPT);
    expect(agent.forkedFromSessionId, 'the conversation to resume until the fork writes its own').toBe(SLEPT);
  });

  it('(R3) a start that resumes another session than the tombstone leaves both as they are', async () => {
    const agent = dev({ status: 'stopped', resumableSessionId: OTHER, lastKilledSessionId: SLEPT });

    const started = await start('go on');
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    expect(resumes(commands[0])).toBe(OTHER);
    expect(commands[0]).not.toContain('--fork-session');
    expect(agent.lastKilledSessionId).toBe(SLEPT);
  });
});
