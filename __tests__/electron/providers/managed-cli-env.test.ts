import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The managed environment reaches every agent, on both spawn paths.
 *
 * Two functions start an agent's CLI: initAgentPty, for a restored or
 * renderer-started agent, and spawnAgentSession, for every API-driven one,
 * which is every orchestrator delegation, /dispatch, /message and /start. They
 * assembled their environments separately, so DISABLE_AUTOUPDATER shipped on
 * the first and was missing from the second, and half the fleet kept updating
 * itself mid-session. armTaskStartWatch had gone the same way one change
 * earlier: the pattern is the bug, not either omission.
 *
 * So the env belongs to spawnAgentPty now, the one place that actually starts
 * the process, and the tests below assert that rather than the variable: what
 * has to hold is that a caller CANNOT skip it, which is why the last one reads
 * the source for a direct pty.spawn.
 *
 * On the variable itself: the auto-updater is not what loses a dispatch, and
 * saying so is the point of the comment on managedCliEnv. It is off because
 * Tars updates claude itself, once (services/cli-updater.ts, and its tests in
 * cli-updater.test.ts), where the updater inside each session downloaded every
 * release once per session and asked each one for a restart.
 */

const spawnCalls: Array<{ args: string[]; env: Record<string, string> }> = [];

vi.mock('node-pty', () => ({
  spawn: vi.fn((_shell: string, args: string[], opts: { env: Record<string, string> }) => {
    spawnCalls.push({ args, env: opts.env });
    return { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn(), pid: 1, resize: vi.fn() };
  }),
}));

vi.mock('uuid', () => ({ v4: vi.fn(() => 'test-uuid') }));

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: vi.fn(),
  Notification: vi.fn(),
}));

// Reached during a spawn; none of it is what these tests are about. Note that
// core/agent-pty is deliberately NOT mocked: it is the code under test, and
// it is its own module precisely so a suite that stubs out pty-manager still
// spawns through it.
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/utils/agents-tick', () => ({ scheduleTick: vi.fn() }));
vi.mock('../../../electron/services/agent-events', () => ({ emitAgentStatus: vi.fn() }));
vi.mock('../../../electron/services/tasmania-client', () => ({
  getTasmaniaStatus: vi.fn(async () => ({ status: 'stopped' })),
}));
vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { managedCliEnv } from '../../../electron/providers/cli-provider';
import { getAllProviders, getProvider } from '../../../electron/providers';
import { initAgentPty, agents } from '../../../electron/core/agent-manager';
import { registerAgentRoutes } from '../../../electron/services/api-routes/agent-routes';
import type { RouteApp, RouteContext, RouteRequest } from '../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../electron/types';

// The launch these hold is darwin and linux's: a line typed into the shell, or
// `bash -l -c`. On a Windows host they read it as linux; the win32 launch (the
// CLI as the terminal's process) is held by launch-call-sites.test.ts and
// agent-terminal-win32.test.ts.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });


/**
 * The CLIs that are not the claude binary and have their own updaters.
 *
 * Hand-written on purpose, and the only line here that a new provider has to
 * touch. Deriving it from the registry is the obvious idea after it has lagged
 * twice, and it is the wrong one: the assertion below would then compare the
 * registry with itself and hold for any classification at all, including a
 * foreign CLI quietly handed Claude's managed environment. The list is not
 * bookkeeping, it is the second opinion that makes the assertion mean
 * something.
 *
 * What deserved fixing was the diagnostics. Adding a provider used to fail as
 * two sorted arrays that differ somewhere, which says nothing about what to do
 * about it. It now fails naming the provider and asking the question that
 * decides: does this CLI run the claude binary?
 */
const FOREIGN_BINARIES = ['amp', 'codex', 'gemini', 'grok', 'opencode', 'pi', 'qwen'];

/**
 * What a CLI running the claude binary is given, written out rather than read
 * from managedCliEnv for the same reason as the list above. The mouse clicks
 * variable is there because a Tars terminal passes Claude Code the wheel and
 * never a click: without it Claude's hint offers a click that does nothing.
 */
const CLAUDE_MANAGED_ENV = { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_MOUSE_CLICKS: '1' };

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-managed-env-'));

function agent(overrides: Partial<AgentStatus>): AgentStatus {
  return {
    id: 'agent-under-test',
    name: 'Agent Under Test',
    status: 'idle',
    projectPath: cwd,
    skills: [],
    output: [],
    lastActivity: new Date().toISOString(),
    ...overrides,
  } as AgentStatus;
}

/**
 * The variables this suite is about, read from the product rather than typed
 * out, so a second managed variable is isolated the day it is added.
 */
/**
 * The administrator lockdown, which Tars deliberately never sets. Named once
 * and used both to isolate and to assert, so the two cannot drift apart.
 */
const LOCKDOWN_KEY = 'DISABLE_UPDATES';

/**
 * Every variable this suite makes a claim about, and therefore must not
 * inherit: the ones the product sets, read from the product, plus the one it
 * promises not to set. DISABLE_UPDATES was the same defect one variable over -
 * a developer on an IT-managed laptop, where the lockdown is exactly what is
 * set, saw this suite go red for a property it holds perfectly well.
 */
const MANAGED_KEYS = [...Object.keys(managedCliEnv('claude')), LOCKDOWN_KEY];
let ambient: Record<string, string | undefined> = {};

// The isolation below is derived from the function under test, so an empty
// managedCliEnv would quietly turn it into a no-op. It cannot cause a false
// pass - the assertions that need those keys fail first - but it would fail
// for the wrong reason, so the coupling says so out loud.
it('has something to isolate, or the setup below is a no-op', () => {
  expect(MANAGED_KEYS).toContain('DISABLE_AUTOUPDATER');
  expect(MANAGED_KEYS).toContain(LOCKDOWN_KEY);
});

beforeEach(() => {
  spawnCalls.length = 0;
  agents.clear();

  // initAgentPty spreads process.env into the spawn, which is correct: a PTY
  // inherits the user's environment. It also means "Tars did not add this" and
  // "this is not present" are different statements, and every assertion below
  // is about the first. Tars has run its own agents with DISABLE_AUTOUPDATER=1
  // since 1.7.0, so this suite was green in CI and red in any terminal Tars
  // had started, including the one a Tars agent runs these tests in. A test
  // whose result depends on who launches it guards nothing.
  //
  // Neutralised rather than excused: adding the variable to some allowed list
  // would make the codex case assert that Tars sets it or that the shell does,
  // which is not a property anyone wants.
  ambient = {};
  for (const key of MANAGED_KEYS) {
    ambient[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  // Restored exactly, absent stays absent: this process goes on to run the
  // rest of the suite, and in a Tars terminal it inherited the variable for a
  // reason.
  for (const [key, value] of Object.entries(ambient)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('which CLIs the variable is for', () => {
  it('covers every provider that re-points the claude binary, and no others', () => {
    const claudeFamily: string[] = [];
    const foreign: string[] = [];

    for (const provider of getAllProviders()) {
      const vars = managedCliEnv(provider.binaryName);
      if (provider.binaryName === 'claude') {
        expect(vars, `${provider.id} runs claude and must have it`).toEqual(CLAUDE_MANAGED_ENV);
        claudeFamily.push(provider.id);
      } else {
        // Setting it on a binary that never reads it would only look like
        // coverage. codex/gemini/grok/opencode/pi update themselves.
        expect(vars, `${provider.id} does not run claude and must not have it`).toEqual({});
        foreign.push(provider.binaryName);
      }
    }

    // Pinned so the scope cannot drift silently. A new claude-family provider
    // moves the first count; a new foreign one moves the second list. Either
    // way somebody has to say which it is, which is the whole point.
    const unclassified = [...new Set(foreign)].filter(b => !FOREIGN_BINARIES.includes(b));
    expect(
      unclassified,
      `${unclassified.join(', ')}: new CLI(s) here. Does it run the claude binary? `
      + 'If yes its provider should report binaryName "claude" and it is covered already. '
      + 'If no, it has its own updater: add it to FOREIGN_BINARIES above.',
    ).toEqual([]);
    expect([...new Set(foreign)].sort()).toEqual(FOREIGN_BINARIES);
    expect(
      claudeFamily.length,
      'a provider joined or left the claude family; confirm it re-points the claude binary',
    ).toBe(14);
  });

  it("follows the registry's own fallback, so 'local' is covered too", () => {
    // `local` is a claude sub-mode: getProvider falls back to claude for it and
    // for any unknown id, and this reads the same binaryName the spawn does.
    expect(managedCliEnv(getProvider('local').binaryName)).toEqual(CLAUDE_MANAGED_ENV);
  });
});

describe('the renderer and restore path', () => {
  it('puts the variable in the env handed to the spawn', async () => {
    await initAgentPty(agent({ provider: 'claude' }), null, vi.fn(), vi.fn());

    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].env.DISABLE_AUTOUPDATER).toBe('1');
    expect(spawnCalls[0].env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS).toBe('1');
  });

  it('leaves it out for a CLI that does not read it', async () => {
    await initAgentPty(agent({ id: 'codex-agent', provider: 'codex' }), null, vi.fn(), vi.fn());

    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].env.DISABLE_AUTOUPDATER).toBeUndefined();
    expect(spawnCalls[0].env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS).toBeUndefined();
  });
});

describe('the API path, which is every delegation and dispatch', () => {
  /** Drive the real POST /api/agents/:id/start, the way the MCP tools do. */
  async function startViaApi(a: AgentStatus): Promise<unknown> {
    agents.set(a.id, a);

    type Handler = (req: RouteRequest, sendJson: (payload: unknown, status?: number) => void) => unknown;
    const routes: Array<{ method: string; pattern: RegExp | string; handler: Handler }> = [];
    const app = {
      routes,
      add(method: string, pattern: RegExp | string, handler: Handler) { routes.push({ method, pattern, handler }); },
      get(p: RegExp | string, h: Handler) { this.add('GET', p, h); },
      post(p: RegExp | string, h: Handler) { this.add('POST', p, h); },
      put(p: RegExp | string, h: Handler) { this.add('PUT', p, h); },
      delete(p: RegExp | string, h: Handler) { this.add('DELETE', p, h); },
    } as unknown as RouteApp;

    const ctx = {
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      appSettings: {} as AppSettings,
      getAppSettings: () => ({} as AppSettings),
      getTelegramBot: () => null,
      getSlackApp: () => null,
      slackResponseChannel: null,
      slackResponseThreadTs: null,
      handleStatusChangeNotificationCallback: vi.fn(),
      sendNotificationCallback: vi.fn(),
      initAgentPtyCallback: vi.fn(async () => 'new-pty-id'),
      agentStatusEmitter: new EventEmitter(),
    } as unknown as RouteContext;

    registerAgentRoutes(app, ctx);
    const route = routes.find(r => r.method === 'POST' && String(r.pattern).includes('start$'));
    expect(route, 'POST /api/agents/:id/start is no longer registered').toBeTruthy();

    let answer: unknown;
    const req = {
      method: 'POST',
      pathname: `/api/agents/${a.id}/start`,
      url: new URL(`http://localhost/api/agents/${a.id}/start`),
      body: { prompt: 'do the thing' },
      raw: { headers: {} },
      res: {},
      params: { id: a.id },
      // Resolved by the server from the bearer token: the routes that drive an
      // agent refuse a caller that is nobody. An agent of the same project is
      // what the MCP tools present.
      callerAgentId: a.id,
    } as unknown as RouteRequest;

    await route!.handler(req, (payload: unknown) => { answer = payload; });
    return answer;
  }

  it('gets the variable too, which it did not when it built its own env', async () => {
    // The defect: spawnAgentSession assembled spawnEnv itself and never
    // included this, so every orchestrator delegation ran with the updater on.
    const answer = await startViaApi(agent({ id: 'api-agent', provider: 'claude' }));

    expect(answer, 'the route refused before it could spawn').toMatchObject({ success: true });
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].env.DISABLE_AUTOUPDATER).toBe('1');
    expect(spawnCalls[0].env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS).toBe('1');
  });

  it('survives into a real process started with that env', async () => {
    await startViaApi(agent({ id: 'api-real-env', provider: 'claude' }));
    expect(spawnCalls.length).toBe(1);

    // The env the API path built, handed to a process that actually starts.
    // node-pty is rebuilt against Electron's ABI, so spawning one here would
    // test the build rather than the behaviour; a PTY and a pipe inherit the
    // environment identically, and what matters is that the CLI would read it.
    const seen = execFileSync(process.execPath, ['-e', 'process.stdout.write(process.env.DISABLE_AUTOUPDATER ?? "")'], {
      env: spawnCalls[0].env,
      encoding: 'utf-8',
    });

    expect(seen).toBe('1');
  });

  it('does not reach for the administrator lockdown', async () => {
    await startViaApi(agent({ id: 'api-lockdown', provider: 'claude' }));

    // DISABLE_UPDATES is checked first by the binary and also makes an
    // explicitly typed `claude update` refuse. These are real terminals the
    // user can take over, so a command they type stays theirs.
    expect(spawnCalls[0].env[LOCKDOWN_KEY]).toBeUndefined();
  });
});

describe('a third spawn path could not miss it', () => {
  it('starts no agent CLI except through spawnAgentPty', async () => {
    // The property, and the reason this was a class rather than an oversight.
    // Both agent spawn sites now go through one function, so the managed env
    // is applied on the line that starts the process instead of by each
    // caller. A new call site that reaches for node-pty directly is the exact
    // shape of the bug, and would be invisible to every test above.
    const fsp = await import('node:fs/promises');
    for (const file of ['electron/core/agent-manager.ts', 'electron/services/api-routes/agent-routes.ts']) {
      const source = await fsp.readFile(file, 'utf-8');
      expect(
        /pty\.spawn\s*\(/.test(source),
        `${file} spawns a PTY directly instead of through spawnAgentPty`,
      ).toBe(false);
      expect(source).toContain('spawnAgentPty(');
    }
  });
});
