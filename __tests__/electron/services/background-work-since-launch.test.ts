import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodeProjectDirName } from '../../../electron/utils/resume-session';

/**
 * From when the background work an agent left running is counted (QA, gate of
 * #189). `pendingBackgroundWork` says it itself: `sinceMs` is when the CLI now
 * running was launched. A task started by a process that is gone is not
 * running, and one started by the process still there is.
 *
 * How it fails, written before any fix:
 * 1. Counted from the session's registration: every SessionStart moves it,
 *    and claude sends one on a compaction too (`source: compact`, the hook is
 *    installed with matcher `*`), in the same process, with the same session
 *    and the job still running. The rest after that compaction reads "has
 *    finished its turn", the link is spent, and when the job reports and the
 *    agent really finishes, the orchestrator is told nothing.
 * 2. Counted from the hand-over only (main): a CLI launched again in the same
 *    terminal resumes the conversation, copies its old background starts with
 *    their old timestamps, and every later rest says the work is still
 *    running, though it died with the CLI that started it.
 *
 * Driven through the real hooks route, the real agent-watch and the real
 * transcript reader, in the order the app sees them.
 */

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() } }));
// Made before the imports, with the mock that reads it: a module imported above loads the constants on its way in
// (providers/cline-cli.ts, through utils/resume-session.ts), which runs that mock before a plain const would be set.
const tmp = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  return mkdtempSync(join(tmpdir(), 'tars-bg-since-'));
});
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json'), dataPath: (f: string) => path.join(tmp, f) };
});

type AgentStatus = import('../../../electron/types').AgentStatus;
type RouteApp = import('../../../electron/services/api-routes/types').RouteApp;
type RouteContext = import('../../../electron/services/api-routes/types').RouteContext;
type RouteRequest = import('../../../electron/services/api-routes/types').RouteRequest;
let watch: typeof import('../../../electron/services/agent-watch');
let manager: typeof import('../../../electron/core/agent-manager');
let pty: typeof import('../../../electron/core/pty-manager');
let truth: typeof import('../../../electron/services/agent-truth');
let restart: typeof import('../../../electron/core/agent-restart');
let hooks: typeof import('../../../electron/services/api-routes/hooks-routes');

const PROJECT = '/tars';
const FIRST = '5b0c6a1e-7d7f-4c1e-9b1a-2f3c4d5e6f70';
const RESUMED = '6c1d7b2f-8e80-4d2f-8c2b-3a4d5e6f7081';
const settle = (ms: number) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();

function transcript(session: string, lines: unknown[]) {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectDirName(PROJECT));
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${session}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}
/** A Bash call run in the background, as claude 2.1.280 records it, stamped `at`. */
const backgroundStart = (at: string, id: string) => [
  { type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: `t-${id}`, name: 'Bash', input: { run_in_background: true } }] } },
  { type: 'user', timestamp: at, toolUseResult: { backgroundTaskId: id }, message: { content: [{ type: 'tool_result', tool_use_id: `t-${id}`, content: 'running' }] } },
];

function terminal(id: string): string[] {
  const written: string[] = [];
  pty.ptyProcesses.set(`pty-${id}`, { write: (d: string) => { written.push(d); }, kill: () => {} } as never);
  return written;
}
function putAgent(over: Partial<AgentStatus> & { id: string }): AgentStatus {
  const a = { name: over.id.toUpperCase(), status: 'idle', projectPath: PROJECT, skills: [], output: [], ptyId: `pty-${over.id}`, lastActivity: now(), ...over } as AgentStatus;
  manager.agents.set(a.id, a);
  return a;
}
const told = (w: string[]) => w.join('').replace(/\x1b\[20[01]~/g, '');

let routes: RouteApp;
function mountHooks(): RouteApp {
  const ctx = {
    mainWindow: null,
    appSettings: {},
    getAppSettings: () => ({}),
    getTelegramBot: () => null,
    getSlackApp: () => null,
    handleStatusChangeNotificationCallback: () => {},
    sendNotificationCallback: () => {},
    initAgentPtyCallback: async () => 'unused',
  } as unknown as RouteContext;
  const app = {
    routes: [] as Array<{ method: string; pattern: string; handler: (req: RouteRequest, send: unknown) => unknown }>,
    add(method: string, pattern: string, handler: never) { this.routes.push({ method, pattern, handler }); },
    get(pattern: string, handler: never) { this.add('GET', pattern, handler); },
    post(pattern: string, handler: never) { this.add('POST', pattern, handler); },
    put(pattern: string, handler: never) { this.add('PUT', pattern, handler); },
    delete(pattern: string, handler: never) { this.add('DELETE', pattern, handler); },
  } as unknown as RouteApp;
  hooks.registerHooksRoutes(app, ctx);
  return app;
}
/** What the hook scripts post, as they post it. */
async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const route = (routes as unknown as { routes: Array<{ pattern: string; handler: (req: RouteRequest, send: unknown) => unknown }> })
    .routes.find(r => r.pattern === '/api/hooks/status')!;
  let answer: Record<string, unknown> = {};
  await route.handler({ body, params: {} } as unknown as RouteRequest, ((payload: Record<string, unknown>) => { answer = payload; }) as never);
  return answer;
}

beforeEach(async () => {
  vi.resetModules();
  manager = await import('../../../electron/core/agent-manager');
  pty = await import('../../../electron/core/pty-manager');
  watch = await import('../../../electron/services/agent-watch');
  truth = await import('../../../electron/services/agent-truth');
  restart = await import('../../../electron/core/agent-restart');
  hooks = await import('../../../electron/services/api-routes/hooks-routes');
  manager.agents.clear();
  pty.ptyProcesses.clear();
  truth.clearAgentTruthCache();
  fs.rmSync(path.join(os.homedir(), '.claude', 'projects', encodeProjectDirName(PROJECT)), { recursive: true, force: true });
  watch.resetAgentWatch();
  watch.startAgentWatch();
  watch.watchInterruptedTurns();
  routes = mountHooks();
});

afterEach(() => { watch.stopAgentWatch(); watch.stopWatchingInterruptedTurns(); });

/** Orch, idle, and a worker whose CLI has just been launched in its terminal and registered. */
async function fleet(): Promise<{ orch: string[]; w: AgentStatus }> {
  const orch = terminal('orch');
  putAgent({ id: 'orch', name: 'Orchestrator', status: 'idle' });
  terminal('w');
  const w = putAgent({ id: 'w', name: 'Worker', status: 'idle' });
  restart.noteLaunch(pty.ptyProcesses.get('pty-w'), {} as never);
  await settle(15);
  expect((await post({ agent_id: 'w', session_id: FIRST, status: 'idle', source: 'startup' })).registered).toBe(true);
  await settle(15);
  // Orch hands it work, as the dispatch route records it.
  w.requestedBy = { agentId: 'orch', ptyId: 'pty-w' };
  w.workHandedAt = now();
  w.status = 'running';
  await settle(15);
  await post({ agent_id: 'w', session_id: FIRST, status: 'running', event: 'UserPromptSubmit' });
  await settle(15);
  return { orch, w };
}

describe('background work, counted from the launch of the CLI now running', { timeout: 20_000 }, () => {
  it('C. a compaction in the same CLI does not hide the job it left running', async () => {
    const { orch } = await fleet();
    transcript(FIRST, backgroundStart(now(), 'bgalive'));
    await settle(15);
    // Claude compacts, in the same process and the same session: SessionStart, source compact.
    expect((await post({ agent_id: 'w', session_id: FIRST, status: 'idle', source: 'compact' })).registered).toBe(true);
    await settle(15);
    // The turn ends with the job still running.
    await post({ agent_id: 'w', session_id: FIRST, status: 'idle' });
    await settle(800);

    expect(told(orch)).toContain('background work still running');
    expect(told(orch)).toContain('bgalive');
    expect(told(orch)).not.toContain('has finished its turn');
    expect(manager.agents.get('w')!.requestedBy?.agentId).toBe('orch');
  });

  it('R. a CLI launched again in the same terminal does not count the start it copied from the one before', async () => {
    const { orch, w } = await fleet();
    const started = now();
    transcript(FIRST, backgroundStart(started, 'bgdead'));
    await settle(15);
    // The CLI dies at its prompt and a new one is launched in the same shell, resuming.
    restart.noteLaunch(pty.ptyProcesses.get('pty-w'), {} as never);
    await settle(15);
    expect((await post({ agent_id: 'w', session_id: RESUMED, status: 'idle', source: 'resume' })).registered).toBe(true);
    transcript(RESUMED, backgroundStart(started, 'bgdead'));
    await settle(15);
    // A turn in the resumed conversation, and its end.
    await post({ agent_id: 'w', session_id: RESUMED, status: 'running', event: 'UserPromptSubmit' });
    await settle(15);
    await post({ agent_id: 'w', session_id: RESUMED, status: 'idle' });
    await settle(800);

    expect(w.currentSessionId).toBe(RESUMED);
    expect(told(orch)).toContain('has finished its turn');
    expect(told(orch)).not.toContain('background work still running');
    expect(manager.agents.get('w')!.requestedBy).toBeUndefined();
  });
});
