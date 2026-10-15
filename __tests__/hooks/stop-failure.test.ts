import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * An agent whose turn failed says so, in the CLI's own words.
 *
 * The night of 2026-09-16, eleven sessions out of twenty-eight registered and
 * never did any work, five of them in the same minute, and Tars reported every
 * one as `running`. Measured afterwards with claude 2.1.268 in a HOME holding
 * no credential: the CLI does not exit, SessionStart fires, the task becomes a
 * turn and UserPromptSubmit fires, then the turn ends at once on "Not logged in
 * · Please run /login". Stop never fires. StopFailure does, and nothing listened
 * to it, so the agent kept the `running` its turn had begun with.
 *
 * These run the real hook script on the payload that CLI sent, hand what it
 * posts to the real status route, and assert on the agent record, with the real
 * agent-manager so that a later turn clearing the failure is the real code too.
 */

// As turn-started.test.ts: agent-manager is real, only what reaches outside the
// process is stubbed. saveAgents is inert until loadAgents has run.
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({ onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() })),
}));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'pty-1') }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
}));
vi.mock('../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { registerHooksRoutes } from '../../electron/services/api-routes/hooks-routes';
import { agents } from '../../electron/core/agent-manager';
import { ClaudeProvider } from '../../electron/providers/claude-provider';
import { nodeHookCommand } from '../../electron/utils/hook-command';
import type { RouteApp, RouteContext, RouteRequest } from '../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../electron/types';
import { sid } from '../fixtures/session-id';
import { moveTestHome } from '../setup/test-home';
import { shHooksNotShipped } from '../setup/platform-limits';

const HOOKS_DIR = path.join(__dirname, '../../hooks');
const HOOK = path.join(HOOKS_DIR, 'stop-failure.sh');
const NOTIFICATION_HOOK = path.join(HOOKS_DIR, 'notification.sh');
const PROMPT_HOOK = path.join(HOOKS_DIR, 'user-prompt-submit.sh');
const SESSION = 'd684e49b-3c9c-483b-a162-ea96d695ae01';
const CLI_MESSAGE = 'Not logged in · Please run /login';

/**
 * What claude 2.1.268 handed its StopFailure hook from a HOME with no
 * credential, field for field. Only the two paths are shortened; the script
 * reads neither.
 */
const MEASURED_STOP_FAILURE = {
  session_id: SESSION,
  transcript_path: `/private/tmp/nologin/home/.claude/projects/-private-tmp-nologin-proj/${SESSION}.jsonl`,
  cwd: '/private/tmp/nologin/proj',
  prompt_id: 'bead9762-d893-4869-a352-258c68caf2fb',
  effort: { level: 'high' },
  hook_event_name: 'StopFailure',
  error: 'authentication_failed',
  last_assistant_message: CLI_MESSAGE,
};

/**
 * What came next on the same kind of bench, re-measured on 2.1.268: left alone,
 * the CLI raised its idle prompt 60 seconds after the failure (+61.79 s), and a
 * prompt typed into that terminal afterwards (+75.66 s) began a new turn.
 */
const MEASURED_IDLE_PROMPT = {
  session_id: SESSION,
  transcript_path: MEASURED_STOP_FAILURE.transcript_path,
  cwd: MEASURED_STOP_FAILURE.cwd,
  prompt_id: MEASURED_STOP_FAILURE.prompt_id,
  hook_event_name: 'Notification',
  message: 'Claude is waiting for your input',
  notification_type: 'idle_prompt',
};

const MEASURED_NEXT_PROMPT = {
  session_id: SESSION,
  transcript_path: MEASURED_STOP_FAILURE.transcript_path,
  cwd: MEASURED_STOP_FAILURE.cwd,
  prompt_id: 'b2ec308d-0ae6-4503-8e19-fad5bfe601e4',
  permission_mode: 'default',
  hook_event_name: 'UserPromptSubmit',
  prompt: 'reply with the single word OK again',
};

const tmp =fs.mkdtempSync(path.join(os.tmpdir(), 'tars-stop-failure-'));
let server: http.Server;
let port: number;
let received: { url: string; body: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url ?? '', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>(r => { server.close(() => r()); });
  fs.rmSync(tmp, { recursive: true, force: true });
});

let ctx: RouteContext;

beforeEach(() => {
  received = [];
  agents.clear();
  const appSettings = {} as AppSettings;
  ctx = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
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
  } as RouteContext;
});

function putAgent(over: Partial<AgentStatus> = {}): AgentStatus {
  const agent = {
    id: 'a1',
    name: 'Tars-Backend',
    status: 'running',
    projectPath: '/test',
    skills: [],
    output: [],
    currentSessionId: SESSION,
    lastActivity: new Date().toISOString(),
    ...over,
  } as AgentStatus;
  agents.set(agent.id, agent);
  return agent;
}

/** A post to a hook route, handled by the real code. Returns what the route answered. */
function send(url: string, body: Record<string, unknown>): Record<string, unknown> {
  const app = { routes: [] as RouteApp['routes'] } as RouteApp;
  app.add = (method, pattern, handler) => { app.routes.push({ method, pattern, handler }); };
  app.get = (p, h) => app.add('GET', p, h);
  app.post = (p, h) => app.add('POST', p, h);
  app.put = (p, h) => app.add('PUT', p, h);
  app.delete = (p, h) => app.add('DELETE', p, h);
  registerHooksRoutes(app, ctx);
  const route = app.routes.find(r => r.pattern === url);
  if (!route) throw new Error(`${url} is not registered`);
  let answer: Record<string, unknown> = {};
  route.handler({ body, params: {} } as RouteRequest, data => { answer = data as Record<string, unknown>; }, ctx);
  return answer;
}

/** A post to /api/hooks/status, handled by the real route. */
function post(body: Record<string, unknown>): Record<string, unknown> {
  return send('/api/hooks/status', body);
}

/**
 * Run a real hook script the way the CLI does, pointed at the capturing server
 * through the variable Tars puts in every agent's environment. Returns the
 * posts this run made, in order.
 */
async function runHook(script: string, payload: Record<string, unknown>): Promise<{ url: string; body: Record<string, unknown> }[]> {
  const from = received.length;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/bash', [script], {
      env: { ...process.env, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_AGENT_ID: 'a1', HOME: tmp },
    });
    child.stdout.resume();
    child.stderr.resume();
    child.on('error', reject);
    child.on('exit', () => resolve());
    child.stdin.end(JSON.stringify(payload));
  });
  return received.slice(from).map(({ url, body }) => ({ url, body: JSON.parse(body) }));
}

/** The real StopFailure hook, each post it made delivered to the real route. */
async function failTurn(payload: Record<string, unknown>): Promise<void> {
  for (const { url, body } of await runHook(HOOK, payload)) {
    expect(url).toBe('/api/hooks/status');
    post(body);
  }
}

describe.skipIf(shHooksNotShipped())('a turn that fails on an API error', () => {
  it('puts the agent in error with the words the CLI wrote instead of an answer', async () => {
    const agent = putAgent();
    // The order the CLI measured: the turn begins, then fails.
    post({ agent_id: 'a1', session_id: SESSION, status: 'running', event: 'UserPromptSubmit' });
    expect(agent.status).toBe('running');

    await failTurn(MEASURED_STOP_FAILURE);

    expect(received, 'the hook made no post, so the failure stays invisible').toHaveLength(1);
    expect(agent.status).toBe('error');
    // The text itself, not only the status: the task-start watch and the
    // delivery check can also put an agent in error, with sentences of their
    // own, and a status alone would let either of them pass for this.
    expect(agent.error).toBe(CLI_MESSAGE);
    // What turns it into the desktop notification, whose body is agent.error.
    expect(ctx.handleStatusChangeNotificationCallback).toHaveBeenCalledWith(agent, 'error');
  });

  it('carries a message with quotes and line breaks through unchanged', async () => {
    const agent = putAgent();
    const message = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}\nTry again in a moment';

    await failTurn({ ...MEASURED_STOP_FAILURE, error: 'server_error', last_assistant_message: message });

    expect(agent.status).toBe('error');
    expect(agent.error).toBe(message);
  });

  it('names the failure when the CLI gives it no message', async () => {
    const agent = putAgent();
    const withoutMessage: Record<string, unknown> = { ...MEASURED_STOP_FAILURE, error: 'rate_limit' };
    delete withoutMessage.last_assistant_message;

    await failTurn(withoutMessage);

    expect(agent.status).toBe('error');
    expect(agent.error).toContain('rate_limit');
  });

  it('changes nothing when it comes from a session that no longer owns the agent', async () => {
    // /api/hooks/* needs no token, so ownership is the only thing standing
    // between a killed session's hooks and the agent that replaced it.
    const agent = putAgent({ currentSessionId: sid('live-session') });

    await failTurn(MEASURED_STOP_FAILURE);

    expect(received).toHaveLength(1);
    expect(agent.status).toBe('running');
    expect(agent.error).toBeUndefined();
  });

  it('drops a delivery still pending, rather than typing it into a CLI that cannot run it', async () => {
    const agent = putAgent({
      pendingDelivery: { ptyId: 'pty-1', task: 'rebase onto main', dispatchedAt: new Date().toISOString() },
    });

    await failTurn(MEASURED_STOP_FAILURE);

    expect(agent.status).toBe('error');
    expect(agent.pendingDelivery).toBeUndefined();
  });

  it('leaves the failure behind once the next turn begins', async () => {
    const agent = putAgent();
    await failTurn(MEASURED_STOP_FAILURE);
    expect(agent.error).toBe(CLI_MESSAGE);

    // JeanBrasse runs /login in that terminal and sends the task again.
    post({ agent_id: 'a1', session_id: SESSION, status: 'running', event: 'UserPromptSubmit' });

    expect(agent.status).toBe('running');
    expect(agent.error).toBeUndefined();
  });
});

/**
 * An agent is left alone after its turn failed, which is the case the error is
 * for. Measured on 2.1.268: a minute after StopFailure the CLI raises its idle
 * prompt, and notification.sh posts that as `status: waiting`. The waiting
 * branch applied it over `error`, so the agent stopped showing why it had
 * stopped. Only a new turn may take it out of `error`.
 *
 * Both tests assert the status and not only the sentence, because each has a
 * neighbour that settles the sentence on its own. The waiting branch never
 * touches `agent.error`, so the sentence outlived the old defect; and
 * noteTurnStarted clears it on a new turn even for an agent left in `error`.
 * TeamRail shows the sentence only while the status is `error`.
 */
describe.skipIf(shHooksNotShipped())('a failed turn left alone', () => {
  it('still shows the failure when the idle prompt comes a minute later', async () => {
    const agent = putAgent();
    post({ agent_id: 'a1', session_id: SESSION, status: 'running', event: 'UserPromptSubmit' });
    await failTurn(MEASURED_STOP_FAILURE);
    expect(agent.status).toBe('error');

    const posts = await runHook(NOTIFICATION_HOOK, MEASURED_IDLE_PROMPT);
    // The waiting post is really made, and the route accepts it as the live
    // session's. Missing, or refused as stale, it would keep the agent in
    // error with no help from the guard, and this test would prove nothing.
    expect(posts.map(p => p.url)).toEqual(['/api/hooks/notification', '/api/hooks/status']);
    expect(posts[1].body).toMatchObject({ session_id: SESSION, status: 'waiting', waiting_reason: 'idle' });
    const answers = posts.map(p => send(p.url, p.body));
    expect(answers[1]).toMatchObject({ success: true });
    expect(answers[1]).not.toHaveProperty('stale');

    expect(agent.status).toBe('error');
    expect(agent.error).toBe(CLI_MESSAGE);
    expect(agent.waitingReason).toBeUndefined();
    // One status notification, for the failure, and none saying it waits.
    expect(ctx.handleStatusChangeNotificationCallback).toHaveBeenCalledTimes(1);
    expect(ctx.handleStatusChangeNotificationCallback).toHaveBeenCalledWith(agent, 'error');
  });

  it('leaves the error when a new turn begins, and waits normally after it', async () => {
    const agent = putAgent();
    await failTurn(MEASURED_STOP_FAILURE);
    for (const p of await runHook(NOTIFICATION_HOOK, MEASURED_IDLE_PROMPT)) send(p.url, p.body);
    // Still in error when the turn begins, or this would test another transition.
    expect(agent.status).toBe('error');

    // JeanBrasse runs /login in that terminal and types the task again.
    const posts = await runHook(PROMPT_HOOK, MEASURED_NEXT_PROMPT);
    expect(posts.map(p => p.url)).toEqual(['/api/hooks/status']);
    send(posts[0].url, posts[0].body);

    expect(agent.status).toBe('running');
    expect(agent.error).toBeUndefined();
    expect(ctx.handleStatusChangeNotificationCallback).toHaveBeenLastCalledWith(agent, 'running');

    // That turn ends as turns do, with the Stop hook's idle. The idle prompt
    // comes a minute after it: one straight after the turn began would be
    // about the rest before that turn, and is dropped for that reason.
    post({ agent_id: 'a1', session_id: SESSION, status: 'idle' });

    // The same idle prompt, now that the agent is out of error, is a wait
    // like any other: the guard holds the error, not every waiting post.
    for (const p of await runHook(NOTIFICATION_HOOK, MEASURED_IDLE_PROMPT)) send(p.url, p.body);
    expect(agent.status).toBe('waiting');
    expect(agent.waitingReason).toBe('idle');
  });
});

/**
 * The same idle prompt, on the other channel it reaches: the desktop
 * notification "X is waiting". The status guard above kept the card honest
 * while this still told JeanBrasse, a minute after the failure, that the agent was
 * waiting for his answer.
 *
 * The settings are the app's defaults on purpose. The suite's are empty, and
 * with notifyOnWaiting unset this channel never fires at all, so an absence
 * asserted there would be the setting's doing and not the guard's. The second
 * test is the proof that it is live in this harness.
 */
describe.skipIf(shHooksNotShipped())('the waiting notification after a failed turn', () => {
  function withTheAppDefaults(): void {
    Object.assign(ctx.getAppSettings(), { notificationsEnabled: true, notifyOnWaiting: true, notifyOnError: true });
  }

  const waitingAlerts = () => vi.mocked(ctx.sendNotificationCallback).mock.calls
    .filter(([title]) => String(title).endsWith(' is waiting'));

  it('is not raised for an agent that stopped on a failure', async () => {
    withTheAppDefaults();
    const agent = putAgent();
    post({ agent_id: 'a1', session_id: SESSION, status: 'running', event: 'UserPromptSubmit' });
    await failTurn(MEASURED_STOP_FAILURE);
    expect(agent.status).toBe('error');

    const posts = await runHook(NOTIFICATION_HOOK, MEASURED_IDLE_PROMPT);
    expect(posts.map(p => p.url)).toEqual(['/api/hooks/notification', '/api/hooks/status']);
    const answers = posts.map(p => send(p.url, p.body));
    // Accepted as the live session's: refused as stale, the notification would
    // be missing for a reason that has nothing to do with the failure.
    expect(answers[0]).toMatchObject({ success: true });
    expect(answers[0]).not.toHaveProperty('stale');

    expect(waitingAlerts()).toEqual([]);
    // What this must not take away: the failure's own notification, the one
    // that carries the CLI's sentence.
    expect(ctx.handleStatusChangeNotificationCallback).toHaveBeenCalledTimes(1);
    expect(ctx.handleStatusChangeNotificationCallback).toHaveBeenCalledWith(agent, 'error');
    expect(agent.status).toBe('error');
  });

  it('is raised as usual again once a new turn has begun', async () => {
    withTheAppDefaults();
    const agent = putAgent();
    await failTurn(MEASURED_STOP_FAILURE);
    for (const p of await runHook(NOTIFICATION_HOOK, MEASURED_IDLE_PROMPT)) send(p.url, p.body);
    expect(waitingAlerts()).toEqual([]);

    // JeanBrasse logs in again in that terminal and sends the task.
    for (const p of await runHook(PROMPT_HOOK, MEASURED_NEXT_PROMPT)) send(p.url, p.body);
    expect(agent.status).toBe('running');
    // The turn ends with its Stop, and the idle prompt comes a minute later.
    post({ agent_id: 'a1', session_id: SESSION, status: 'idle' });

    for (const p of await runHook(NOTIFICATION_HOOK, MEASURED_IDLE_PROMPT)) send(p.url, p.body);

    // The body as the hook builds it: `echo | jq -Rs` keeps the newline echo
    // adds. What this test is about is that the alert is raised, for this agent.
    expect(waitingAlerts()).toEqual([
      ['Tars-Backend is waiting', expect.stringContaining('Claude is waiting for your input'), 'a1', ctx.getAppSettings()],
    ]);
  });

  /**
   * The guard is for the idle prompt only, as hooks-routes.ts and OPERATIONS.md
   * both say, and nothing held it to that: holding back every notification of
   * an agent in error passed the whole file. A permission prompt comes from a
   * turn in progress and waits on JeanBrasse's answer, so if one ever meets an agent
   * still marked `error`, a turn whose start Tars missed, hiding it would leave
   * that turn blocked with nobody told.
   *
   * Not a measured payload: the idle prompt's, with the type and the message a
   * permission prompt carries, through the real hook.
   */
  it('still raises a permission prompt, which only a turn in progress can ask', async () => {
    withTheAppDefaults();
    const agent = putAgent();
    await failTurn(MEASURED_STOP_FAILURE);
    expect(agent.status).toBe('error');

    const posts = await runHook(NOTIFICATION_HOOK, {
      ...MEASURED_IDLE_PROMPT,
      message: 'Claude needs your permission to use Bash',
      notification_type: 'permission_prompt',
    });
    expect(posts.map(p => p.url)).toEqual(['/api/hooks/notification']);
    for (const p of posts) send(p.url, p.body);

    expect(vi.mocked(ctx.sendNotificationCallback).mock.calls).toEqual([
      ['Tars-Backend needs permission', expect.stringContaining('Claude needs your permission to use Bash'), 'a1', ctx.getAppSettings()],
    ]);
  });
});

describe('the hook reaches every claude-family CLI', () => {
  it('is registered for StopFailure in the settings they all read', async () => {
    const home = fs.mkdtempSync(path.join(tmp, 'home-'));
    const restoreHome = moveTestHome(home);
    try {
      const provider = new ClaudeProvider();
      // This writes a settings file. Refuse to write the real one.
      expect(provider.configDir.startsWith(home), `would have written into ${provider.configDir}`).toBe(true);

      await provider.configureHooks(HOOKS_DIR);

      const settings = JSON.parse(fs.readFileSync(path.join(provider.configDir, 'settings.json'), 'utf-8'));
      // On win32 the CLI runs the Node runner for the same event (hook-command.ts).
      const expected = process.platform === 'win32'
        ? nodeHookCommand(path.join(HOOKS_DIR, 'tars-hook.mjs'), 'stop-failure')
        : HOOK;
      expect(settings.hooks.StopFailure?.[0]?.hooks?.[0]?.command).toBe(expected);
    } finally {
      restoreHome();
    }
  });

  it.skipIf(shHooksNotShipped())('is executable, since the CLI runs it by path', () => {
    expect(fs.statSync(HOOK).mode & 0o111).not.toBe(0);
  });
});
