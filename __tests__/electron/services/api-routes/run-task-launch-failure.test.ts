import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * The route an agent delegates through answers, whatever became of the launch.
 *
 * delegate_task calls POST /api/agents/:id/run-task first. With the agent's
 * CLI nowhere to be found, the route used to hang on the session's
 * `initialize` for its 90 seconds, while the launch error went up to the top
 * of the main process as the "Uncaught Exception" window JeanBrasse saw on
 * 2026-09-18. Here the whole chain is the real one, route, delegateOverAcp,
 * AcpSession and the spawn itself: only which command the registry names, and
 * where the MCP bundles would be, are decided by the test.
 */

const DOCK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const MISSING = 'tars-acp-no-such-agent-cli';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-run-task-launch-'));
let launch: { command: string; args: string[] };

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
  PROGRAMMATIC_SUBMIT_DELAY_MS: 300,
}));
vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));
vi.mock('../../../../electron/services/acp/registry', () => ({
  acpLaunchFor: () => launch,
  providerSupportsAcp: () => true,
  loadAcpRegistry: async () => undefined,
}));
vi.mock('../../../../electron/services/mcp-orchestrator', () => ({
  getMcpOrchestratorPath: () => path.join(tmp, 'no-such-bundle.js'),
  getMcpMemoryPath: () => path.join(tmp, 'no-such-bundle.js'),
}));
vi.mock('../../../../electron/services/usage-ledger', () => ({ recordUsage: vi.fn() }));

import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

let routes: RouteApp;
let settings: Partial<AppSettings>;
let savedPath: string | undefined;
const uncaught: Error[] = [];
const record = (err: Error) => { uncaught.push(err); };

beforeEach(() => {
  uncaught.length = 0;
  process.on('uncaughtException', record);
  savedPath = process.env.PATH;
  // Opened from the Dock, as JeanBrasse's was: launchd's PATH and nothing else.
  process.env.PATH = DOCK_PATH;
  agents.clear();
  settings = {};
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
    getAppSettings: () => settings as AppSettings,
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

afterEach(async () => {
  process.env.PATH = savedPath;
  await new Promise(resolve => setTimeout(resolve, 250));
  process.off('uncaughtException', record);
  expect(uncaught.map(e => String(e)), 'an error reached the top of the process').toEqual([]);
});

/** POST /api/agents/:id/run-task the way the server calls it, with a deadline on the answer. */
async function runTask(id: string, task: string, ms: number): Promise<{ data: Record<string, unknown>; status: number } | 'no answer'> {
  const pathname = `/api/agents/${id}/run-task`;
  const route = routes.routes.find(r => r.method === 'POST' && typeof r.pattern !== 'string' && r.pattern.test(pathname))!;
  let answered!: (a: { data: Record<string, unknown>; status: number }) => void;
  const answer = new Promise<{ data: Record<string, unknown>; status: number }>(resolve => { answered = resolve; });
  const req = {
    method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), body: { task },
    raw: { headers: {}, on: () => {} }, res: {}, params: { id },
    // An agent of the same project stands in for the orchestrator delegating.
    callerAgentId: id,
  } as unknown as RouteRequest;
  void route.handler(req, (data, status = 200) => answered({ data: data as Record<string, unknown>, status }), {} as RouteContext);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([answer, new Promise<'no answer'>(resolve => { timer = setTimeout(() => resolve('no answer'), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

function putAgent(id: string): AgentStatus {
  const agent = {
    id, name: id, status: 'idle', provider: 'claude', projectPath: tmp,
    skills: [], output: [], lastActivity: new Date().toISOString(),
  } as AgentStatus;
  agents.set(id, agent);
  return agent;
}

describe('POST /api/agents/:id/run-task from an app opened from the Dock', { timeout: 30_000 }, () => {
  it('answers at once with what was not found and where, and puts the agent back', async () => {
    const agent = putAgent('a-missing');
    launch = { command: MISSING, args: [] };

    const started = Date.now();
    const answer = await runTask('a-missing', 'review the diff', 5_000);

    expect(answer, 'the route never answered the agent that delegated').not.toBe('no answer');
    if (answer === 'no answer') return;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(answer.status).toBe(502);
    expect(answer.data.ok).toBe(false);
    expect(String(answer.data.error)).toContain(`${MISSING} was not found`);
    expect(String(answer.data.error)).toContain('Settings > CLI Paths');
    expect(agent.status, 'the agent was left marked running').toBe('idle');
  });

  it('runs npx from the folder Settings > CLI Paths names', async () => {
    putAgent('a-found');
    const dir = path.join(tmp, 'cli-paths-node');
    fs.mkdirSync(dir, { recursive: true });
    const agentScript = path.join(tmp, 'answering-agent.mjs');
    fs.writeFileSync(agentScript, `
let buf = '';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
    if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
    if (msg.method === 'session/prompt') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ran as ' + (process.env.TARS_NPX_STUB || process.argv[1]) } } } });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    }
  }
});
`);
    let stub = path.join(dir, 'npx');
    if (process.platform === 'win32') {
      // npm's shim, which Tars reads through to node and the script it runs
      // (platform/cli-binary.ts): the script, in the stub's folder, is what says which npx ran.
      stub = path.join(dir, 'node_modules', 'npx-stub', 'npx-cli.js');
      fs.mkdirSync(path.dirname(stub), { recursive: true });
      fs.copyFileSync(agentScript, stub);
      fs.writeFileSync(path.join(dir, 'npx.cmd'), [
        '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
        'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\npx-stub\\npx-cli.js" %*', '',
      ].join('\r\n'));
      // The node.exe beside the shim, which the shim prefers, as in Node's own folder.
      try { fs.linkSync(process.execPath, path.join(dir, 'node.exe')); } catch { fs.copyFileSync(process.execPath, path.join(dir, 'node.exe')); }
    } else {
      fs.writeFileSync(stub, `#!/bin/sh\nTARS_NPX_STUB="$0" exec "${process.execPath}" "${agentScript}" "$@"\n`, { mode: 0o755 });
    }
    settings = { cliPaths: { node: path.join(dir, 'node') } as AppSettings['cliPaths'] };
    // Answered at once and offline by a real npx, should the stub ever lose to one.
    launch = { command: 'npx', args: ['--version'] };

    const answer = await runTask('a-found', 'say where you ran from', 10_000);

    expect(answer).not.toBe('no answer');
    if (answer === 'no answer') return;
    expect(answer.status, JSON.stringify(answer.data)).toBe(200);
    expect(answer.data.text).toBe(`ran as ${stub}`);
  });
});
