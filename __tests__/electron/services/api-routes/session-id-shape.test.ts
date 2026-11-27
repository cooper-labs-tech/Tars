import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

/**
 * The hooks route only takes a session id shaped like the ones the CLIs send.
 *
 * Claude Code and Gemini CLI name a session with a UUID, and the hooks forward
 * it verbatim. Tars then uses the id it registered as a file name:
 * `transcriptPath()` joins it into ~/.claude/projects/<project>/<id>.jsonl,
 * and the restart and resume paths hand it to `--resume`. Until now any
 * non-empty string was registered, so a post with its agent's own token could
 * make Tars read or watch a file outside the transcript directory.
 *
 * The ways this can fail, each a case below:
 *  1. An id that climbs out of the directory (`../../x`) is registered as the
 *     owner at SessionStart and saved.
 *  2. An id carrying a separator, a NUL, a newline or a space is registered.
 *  3. An id of any length is registered: a 5000 character one is kept.
 *  4. A UUID padded with whitespace is registered padded, so it never equals
 *     the id the transcript file carries. Refused, not trimmed: every hook
 *     Tars ships sends the id exactly as the CLI gave it.
 *  5. A forged id already on disk (agents.json written before this check)
 *     keeps owning the agent, and the real session is refused as stale.
 *  6. Over-correction: the ids the CLIs actually send stop working. A lowercase
 *     UUID (what claude writes) and an uppercase one must still register.
 *  7. Over-correction: an ordinary status post from the owner is refused.
 *  8. Over-correction (27/11): Hermes Agent names a session `local-` and 64
 *     lowercase hex digits (0.23.4, measured in its state.db), and Tars posts a
 *     Hermes agent's turns with that id (services/hermes-agent-turns.ts). Refused
 *     as not a UUID, every turn of a Hermes agent was lost: its status stayed
 *     running and its answer never arrived (the first run of
 *     e2e/hermes-agent.spec.ts).
 *  9. That shape opens a door: `local-` with a separator, another length, an
 *     uppercase prefix or digit, or anything after it is registered.
 *
 * The negative witness for 1 to 5 is the product before this change, which
 * registers every one of them.
 */

vi.mock('../../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  noteSessionRegistered: vi.fn(),
  noteTurnStarted: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

import { registerHooksRoutes } from '../../../../electron/services/api-routes/hooks-routes';
import { agents, saveAgents } from '../../../../electron/core/agent-manager';
import { transcriptPath } from '../../../../electron/utils/resume-session';
import { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import { AgentStatus, AppSettings } from '../../../../electron/types';

const LIVE = '6f1c2b9e-4d3a-4f8b-9c7e-1a2b3c4d5e6f';
const NEXT = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d';

function makeRouteApp(): RouteApp {
  return {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
}

let ctx: RouteContext;
let status: (body: Record<string, unknown>) => Promise<ReturnType<typeof vi.fn>>;

beforeEach(() => {
  agents.clear();
  vi.mocked(saveAgents).mockClear();
  const appSettings = { notifyOnWaiting: false } as AppSettings;
  ctx = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
    appSettings,
    getAppSettings: () => appSettings,
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(),
    agentStatusEmitter: new EventEmitter(),
  };
  const app = makeRouteApp();
  registerHooksRoutes(app, ctx);
  const handler = app.routes.find(r => r.pattern === '/api/hooks/status')!.handler;
  status = async (body) => {
    const sendJson = vi.fn();
    await handler({ body, params: {} } as RouteRequest, sendJson, ctx);
    return sendJson;
  };
});

function agent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  const a: AgentStatus = {
    id: 'a1',
    status: 'running',
    projectPath: '/work/project',
    skills: [],
    output: [],
    lastActivity: new Date().toISOString(),
    ...overrides,
  };
  agents.set(a.id, a);
  return a;
}

const sessionStart = (session_id: string) => status({ agent_id: 'a1', session_id, status: 'idle', source: 'startup' });

describe('a session id that is not a UUID', () => {
  it('1. is not registered when it climbs out of the transcript directory', async () => {
    const a = agent({ currentSessionId: undefined });
    const forged = '../../../../tmp/not-a-transcript';
    // What the forged id would have made Tars read: a file outside ~/.claude.
    const home = os.homedir();
    expect(path.relative(path.join(home, '.claude', 'projects'), transcriptPath(a.projectPath, forged, home)).startsWith('..')).toBe(true);

    const reply = await sessionStart(forged);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }), 400);
    expect(a.currentSessionId).toBeUndefined();
    expect(a.resumableSessionId).toBeUndefined();
    expect(saveAgents).not.toHaveBeenCalled();
  });

  it.each([
    ['a separator', `${LIVE}/x`],
    ['a NUL', `${LIVE}\u0000`],
    ['a newline', `${LIVE}\nx`],
    ['a space', 'not a uuid'],
    ['no dashes', LIVE.replace(/-/g, '')],
    ['a non hex digit', LIVE.replace(/^6/, 'g')],
  ])('2. is not registered when it carries %s', async (_what, forged) => {
    const a = agent({ currentSessionId: undefined });

    const reply = await sessionStart(forged);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }), 400);
    expect(a.currentSessionId).toBeUndefined();
  });

  it('3. is not registered when it is 5000 characters long', async () => {
    const a = agent({ currentSessionId: undefined });

    const reply = await sessionStart(LIVE + 'a'.repeat(5000 - LIVE.length));

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }), 400);
    expect(a.currentSessionId).toBeUndefined();
  });

  it('4. is not registered padded with whitespace', async () => {
    const a = agent({ currentSessionId: undefined });

    const reply = await sessionStart(` ${LIVE}\n`);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }), 400);
    expect(a.currentSessionId).toBeUndefined();
  });

  it('5. already on disk owns nothing: the real session adopts the agent', async () => {
    const a = agent({ currentSessionId: '../../../../tmp/forged-before-the-check', status: 'running' });

    const reply = await status({ agent_id: 'a1', session_id: LIVE, status: 'running' });

    expect(reply).not.toHaveBeenCalledWith(expect.objectContaining({ stale: true }));
    expect(a.currentSessionId).toBe(LIVE);
  });
});

describe('the ids the CLIs actually send', () => {
  it('6. a lowercase UUID registers, and so does an uppercase one', async () => {
    const a = agent({ currentSessionId: undefined });
    await sessionStart(LIVE);
    expect(a.currentSessionId).toBe(LIVE);

    agents.clear();
    const b = agent({ currentSessionId: undefined });
    await sessionStart(NEXT.toUpperCase());
    expect(b.currentSessionId).toBe(NEXT.toUpperCase());
  });

  it('8. a Hermes Agent session id registers, and its owner drives its status', async () => {
    const hermes = `local-${'0123456789abcdef'.repeat(4)}`;
    const a = agent({ currentSessionId: undefined });
    await sessionStart(hermes);
    expect(a.currentSessionId).toBe(hermes);
    const fromOwner = await status({ agent_id: 'a1', session_id: hermes, status: 'idle' });
    expect(fromOwner).not.toHaveBeenCalledWith(expect.anything(), 400);
    expect(a.status).toBe('idle');
  });

  it.each([
    ['a separator', `local-${'ab'.repeat(31)}/x`],
    ['a climb', 'local-../../../../tmp/x'],
    ['63 digits', `local-${'a'.repeat(63)}`],
    ['65 digits', `local-${'a'.repeat(65)}`],
    ['an uppercase prefix', `LOCAL-${'a'.repeat(64)}`],
    ['an uppercase digit', `local-${'A'.repeat(64)}`],
    ['a suffix', `local-${'a'.repeat(64)}.jsonl`],
  ])('9. a Hermes-like id with %s is not registered', async (_what, forged) => {
    const a = agent({ currentSessionId: undefined });
    const reply = await sessionStart(forged);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }), 400);
    expect(a.currentSessionId).toBeUndefined();
  });

  it('7. the owner still drives its status, and another UUID is still stale', async () => {
    const a = agent({ currentSessionId: LIVE, status: 'running' });

    const fromOwner = await status({ agent_id: 'a1', session_id: LIVE, status: 'waiting' });
    expect(fromOwner).not.toHaveBeenCalledWith(expect.anything(), 400);
    expect(a.status).toBe('waiting');

    const fromOther = await status({ agent_id: 'a1', session_id: NEXT, status: 'idle' });
    expect(fromOther).toHaveBeenCalledWith(expect.objectContaining({ stale: true }));
    expect(a.status).toBe('waiting');
  });
});
