import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * What /dispatch and /message answer when the terminal is not free.
 *
 * Measured by the QA on 2026-09-20: an Up arrow typed into a worker's
 * terminal, then `POST /dispatch`, which answered 200 with mode `message` and
 * status `running`; thirty seconds later the CLI had received nothing, and
 * the task arrived 5.3 s after a Ctrl+C. The message was not lost, which is
 * the point of the queue, but the route said it had been sent and the caller
 * had no way of knowing otherwise.
 *
 * Everything here is real: the real route, the real writer, the real draft
 * model. The terminal is a recorder, which is where the bytes end up.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
let ptyCounter = 0;
vi.mock('uuid', () => ({ v4: vi.fn(() => `pty-spawned-${++ptyCounter}`) }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { broadcasts.push({ channel, payload }); },
}));
vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));
vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));
vi.mock('../../../../electron/services/acp/delegate', () => ({
  canDelegateOverAcp: () => false,
  delegateOverAcp: vi.fn(),
}));

const broadcasts: Array<{ channel: string; payload: unknown }> = [];

import * as pty from 'node-pty';
import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';
import {
  PROGRAMMATIC_SUBMIT_DELAY_MS, TYPING_PAUSE_MS, messagesWaiting, ptyProcesses, resetTerminalInput, writeHumanInput,
} from '../../../../electron/core/pty-manager';
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


const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-dispatch-draft-'));

let routes: RouteApp;
let ctx: RouteContext;
let written: string[];
let terminal: { write: (data: string) => void; process: string; onExit: () => { dispose(): void } };

/** Calls a route the way the server does, and returns what it answered. */
async function call(method: string, url: string, body: Record<string, unknown> = {}, caller?: string, internal = false) {
  const pathname = url.split('?')[0];
  for (const route of routes.routes) {
    if (route.method !== method) continue;
    const m = typeof route.pattern === 'string' ? (route.pattern === pathname ? [pathname] : null) : pathname.match(route.pattern);
    if (!m) continue;
    const answers: Array<{ data: Record<string, unknown>; status: number }> = [];
    const req = {
      method, pathname, url: new URL(`http://localhost${url}`), body,
      raw: { headers: {}, on: () => {} }, res: {}, params: m[1] ? { id: m[1] } : {},
      callerAgentId: caller, internal,
    } as unknown as RouteRequest;
    await route.handler(req, (data, status = 200) => { answers.push({ data: data as Record<string, unknown>, status }); }, ctx);
    return answers.at(-1);
  }
  throw new Error(`no route for ${method} ${url}`);
}

beforeEach(() => {
  vi.useFakeTimers();
  agents.clear();
  ptyProcesses.clear();
  broadcasts.length = 0;
  written = [];
  // A CLI up in the worker's terminal, opened the way every agent terminal
  // is: the routes type into a session only where cliRunningIn finds one.
  // onExit: spawnAgentPty drops what a terminal held when it exits (#128).
  terminal = { write: (data: string) => { written.push(data); }, process: '2.1.280', onExit: () => ({ dispose() {} }) };
  vi.mocked(pty.spawn).mockReturnValueOnce(terminal as never);
  spawnAgentPty({ binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: project, cols: 80, rows: 24, env: {} });
  ptyProcesses.set('pty-worker', terminal as never);

  routes = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  const settings = {} as AppSettings;
  ctx = {
    mainWindow: null, appSettings: settings, getAppSettings: () => settings,
    getTelegramBot: () => null, getSlackApp: () => null,
    slackResponseChannel: null, slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(), sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'unused'),
    agentStatusEmitter: new EventEmitter(),
  } as RouteContext;
  registerAgentRoutes(routes, ctx);

  agents.set('orch', {
    id: 'orch', name: 'Orchestrator', status: 'idle', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(),
  } as AgentStatus);
  agents.set('worker', {
    id: 'worker', name: '1212-Backend', status: 'running', projectPath: project, ptyCwd: project,
    skills: [], output: [], ptyId: 'pty-worker', currentSessionId: 'sess-w',
    lastActivity: new Date().toISOString(),
  } as AgentStatus);
});

afterEach(() => {
  resetTerminalInput(terminal as never);
  vi.useRealTimers();
});

/** The Up arrow the QA typed: history, which this cannot follow. */
function anUnfollowableKey(): void {
  writeHumanInput(terminal as never, '\x1b[A');
  // His own key reached the terminal, as it must. What follows is about what
  // Tars writes on top of it.
  written.length = 0;
}

describe('POST /dispatch into a terminal that is not free', () => {
  it('says the message is held, instead of answering as if it had been typed', async () => {
    anUnfollowableKey();

    const answer = await call('POST', '/api/agents/worker/dispatch', { message: 'run the suite' }, 'orch');

    expect(answer?.status).toBe(200);
    expect(answer?.data.mode).toBe('message');
    expect(answer?.data.held, 'the route answered as if the task had been typed in').toBe(true);
    expect(String(answer?.data.heldReason)).toContain('typing');
    expect(written, 'nothing reached the terminal').toEqual([]);
  });

  it('names the sender in the notice, so the panel can say who is waiting', async () => {
    anUnfollowableKey();

    await call('POST', '/api/agents/worker/dispatch', { message: 'run the suite' }, 'orch');
    vi.advanceTimersByTime(TYPING_PAUSE_MS);

    expect(messagesWaiting()).toEqual([{ agentId: 'worker', waiting: 1, from: ['Orchestrator'] }]);
  });

  it('says nothing about holding when the terminal is free, as before', async () => {
    const answer = await call('POST', '/api/agents/worker/dispatch', { message: 'run the suite' }, 'orch');

    expect(answer?.data.held).toBeUndefined();
    expect(written.join('')).toContain('run the suite');
    expect(messagesWaiting()).toEqual([]);
  });

  it('delivers it once the person clears the field, without being asked again', async () => {
    anUnfollowableKey();
    await call('POST', '/api/agents/worker/dispatch', { message: 'run the suite' }, 'orch');

    writeHumanInput(terminal as never, '\x03');
    vi.advanceTimersByTime(TYPING_PAUSE_MS + 1000);

    expect(written.join('')).toContain('run the suite');
    expect(messagesWaiting()).toEqual([]);
  });
});

describe('POST /message into a terminal that is not free', () => {
  it('says so too, on the route the MCP client uses most', async () => {
    anUnfollowableKey();

    const answer = await call('POST', '/api/agents/worker/message', { message: 'one more thing' }, 'orch');

    expect(answer?.data.success).toBe(true);
    expect(answer?.data.held, 'the route answered as if the message had been typed in').toBe(true);
    expect(written).toEqual([]);
  });
});

describe('who a dispatch is from', () => {
  // A dispatch reached Claude Code 2.1.280 as <pasted_content> with no word
  // outside it, not even who sent it. The line before it is typed where the
  // receiver reads its user's own words, so it names the agent whose token made
  // the call, by id, and never takes a name for an identity.
  const BRIEF = 'Gate PR #126.\nRead the report first.\nThen run the suite.\nThen answer.';

  it('is typed before the paste, as the agent whose token made the call', async () => {
    const answer = await call('POST', '/api/agents/worker/dispatch', { message: BRIEF }, 'orch');
    vi.advanceTimersByTime(PROGRAMMATIC_SUBMIT_DELAY_MS + 100);

    expect(answer?.data.mode).toBe('message');
    // With the id of the request it hands over (PR A, core/task-requests.ts).
    expect(written[0]).toMatch(/^Message from agent "Orchestrator" \("orch"\), task t-[0-9a-f]{8}: $/);
    expect(written[1]).toBe(`\x1b[200~${BRIEF}\x1b[201~`);
  });

  it('stays an agent, however the agent is named', async () => {
    agents.get('orch')!.name = 'JeanBrasse';

    await call('POST', '/api/agents/worker/message', { message: BRIEF }, 'orch');
    vi.advanceTimersByTime(PROGRAMMATIC_SUBMIT_DELAY_MS + 100);

    expect(written[0]).toMatch(/^Message from agent "JeanBrasse" \("orch"\), task t-[0-9a-f]{8}: $/);
  });

  it('is Tars when Tars makes the call itself (the super chat)', async () => {
    await call('POST', '/api/agents/worker/dispatch', { message: BRIEF }, undefined, true);
    vi.advanceTimersByTime(PROGRAMMATIC_SUBMIT_DELAY_MS + 100);

    expect(written[0]).toBe('Message from Tars: ');
  });
});
