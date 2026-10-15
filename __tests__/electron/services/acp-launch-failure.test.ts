import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * An agent that cannot be launched fails the delegation. It does not reach the
 * top of the main process.
 *
 * JeanBrasse, 2026-09-18, in the installed app opened from the Dock: a window saying
 * "Uncaught Exception: Error: spawn npx ENOENT", with the stack of
 * child_process. Two defects made it:
 * - the ACP launch ran `npx` with the app's own PATH, and an app opened from
 *   the Dock has launchd's, `/usr/bin:/bin:/usr/sbin:/sbin` (read from the
 *   environment of JeanBrasse's running Tars that day), where no npx lives. Every
 *   other launch of the main process adds what buildFullPath knows: the
 *   folders set in Settings > CLI Paths, nvm, /usr/local/bin;
 * - the session emitted the child's 'error' again, on itself, where nothing
 *   listened. An EventEmitter throws an 'error' nobody hears, and in Electron's
 *   main process a throw nobody catches is that window. The `initialize` the
 *   session was waiting on then sat there for its 90 seconds.
 *
 * Writing to an agent that has stopped reading is the same class: its stdin
 * emits EPIPE, and nothing listened there either.
 *
 * Uncaught exceptions are recorded here rather than left to vitest: its worker
 * reports one only while it is the sole listener, so while the recorder is on,
 * it is what sees them, and every case asserts that it saw nothing.
 */

const DOCK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const onWindows = process.platform === 'win32';
/** A command no machine has. */
const MISSING = 'tars-acp-no-such-agent-cli';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-launch-'));

let launch: { command: string; args: string[] };
const runTokens: string[] = [];

vi.mock('../../../electron/services/acp/registry', () => ({
  acpLaunchFor: () => launch,
  loadAcpRegistry: async () => undefined,
}));
vi.mock('../../../electron/services/mcp-orchestrator', () => ({
  getMcpOrchestratorPath: () => path.join(tmp, 'no-such-bundle.js'),
  getMcpMemoryPath: () => path.join(tmp, 'no-such-bundle.js'),
}));
vi.mock('../../../electron/providers', () => ({
  getProvider: () => ({ getPtyEnvVars: () => ({}) }),
}));
vi.mock('../../../electron/services/usage-ledger', () => ({ recordUsage: vi.fn() }));
// The real tokens, with the run's own kept in sight, so a case can ask whether
// it still names the agent once the delegation has answered.
vi.mock('../../../electron/core/agent-tokens', async importOriginal => {
  const real = await importOriginal<typeof import('../../../electron/core/agent-tokens')>();
  return {
    ...real,
    mintRunToken: (agentId: string) => {
      const minted = real.mintRunToken(agentId);
      runTokens.push(minted.token);
      return minted;
    },
  };
});

import { AcpSession } from '../../../electron/services/acp/client';
import { delegateOverAcp } from '../../../electron/services/acp/delegate';
import { agentForToken } from '../../../electron/core/agent-tokens';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const PRELUDE = `
import * as fs from 'node:fs';
let buf = '';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
`;

/** Answers the handshake, then reports which npx it was started as, with what, and on which PATH. */
const REPORTING_AGENT = `${PRELUDE}
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    const report = { stub: process.env.TARS_NPX_STUB || process.argv[1], args: process.argv.slice(2), path: process.env.PATH };
    send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(report) } } } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
}
`;

function script(name: string, body: string): string {
  const file = path.join(tmp, `${name}.mjs`);
  fs.writeFileSync(file, body);
  return file;
}

/**
 * An executable called `npx` in `dir` that runs the reporting agent. A shell
 * script with the node of this run spelled out, so that it starts under any
 * PATH, and says through TARS_NPX_STUB that it is the one that ran: on a
 * machine with an npx of its own, finding that one instead would otherwise
 * look the same.
 */
function stubNpx(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const agent = script('reporting-agent', REPORTING_AGENT);
  if (onWindows) return stubNpxCmd(dir, agent);
  const stub = path.join(dir, 'npx');
  fs.writeFileSync(stub, `#!/bin/sh\nTARS_NPX_STUB="$0" exec "${process.execPath}" "${agent}" "$@"\n`, { mode: 0o755 });
  return stub;
}

/**
 * The same on Windows: npm's npx.cmd shim, which Tars reads through to the
 * node and script it runs (audit A20), with node.exe beside it as in Node's
 * own folder. What it runs is the reporting agent, copied into the stub's own
 * folder, so the script is what says which npx ran.
 */
function stubNpxCmd(dir: string, agent: string): string {
  const stub = path.join(dir, 'node_modules', 'npx-stub', 'npx-cli.mjs');
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.copyFileSync(agent, stub);
  try { fs.linkSync(process.execPath, path.join(dir, 'node.exe')); } catch { fs.copyFileSync(process.execPath, path.join(dir, 'node.exe')); }
  fs.writeFileSync(path.join(dir, 'npx.cmd'), [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\npx-stub\\npx-cli.mjs" %*', '',
  ].join('\r\n'));
  return stub;
}

/** What `promise` came to within `ms`: its value, its error, or still nothing. */
async function within<T>(promise: Promise<T>, ms: number): Promise<{ value?: T; error?: Error; pending?: true }> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<{ pending: true }>(resolve => { timer = setTimeout(() => resolve({ pending: true }), ms); });
  try {
    return await Promise.race([
      promise.then(value => ({ value }), (error: Error) => ({ error })),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

/** Longer than any deadline below, so a case fails on what it waited for rather than on vitest's clock. */
const CASE_TIMEOUT = 30_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const uncaught: Error[] = [];
const record = (err: Error) => { uncaught.push(err); };
const sessions: AcpSession[] = [];
let savedPath: string | undefined;

beforeEach(() => {
  uncaught.length = 0;
  process.on('uncaughtException', record);
  savedPath = process.env.PATH;
});

afterEach(async () => {
  for (const s of sessions.splice(0)) s.stop();
  process.env.PATH = savedPath;
  // Whatever the case did, nothing it started may throw once it has returned.
  await settle();
  process.off('uncaughtException', record);
  expect(uncaught.map(e => String(e)), 'an error reached the top of the process').toEqual([]);
});

function track(session: AcpSession): AcpSession {
  sessions.push(session);
  return session;
}

describe('an ACP agent whose command cannot be found', { timeout: CASE_TIMEOUT }, () => {
  it('fails start() at once, says what is missing and where Tars looked, and throws nothing', async () => {
    const session = track(new AcpSession({ command: MISSING, args: [] }, { cwd: tmp, env: { PATH: DOCK_PATH } }));

    const outcome = await within(session.start(), 5_000);
    await settle();

    expect(uncaught.map(e => String(e)), 'the launch failure reached the top of the process').toEqual([]);
    expect(outcome.pending, 'start() was still waiting: the initialize it sent was never failed').toBeUndefined();
    expect(outcome.error?.message).toContain(`${MISSING} was not found`);
    expect(outcome.error?.message, 'the message does not say where Tars looked').toContain(DOCK_PATH);
    expect(outcome.error?.message, 'the message does not say what to do').toContain('Settings > CLI Paths');
    expect(session.isRunning).toBe(false);
  });

  it('names a working directory that is gone, rather than blaming the command', async () => {
    const gone = path.join(tmp, 'no-such-project');
    const session = track(new AcpSession({ command: process.execPath, args: [] }, { cwd: gone }));

    const outcome = await within(session.start(), 5_000);

    expect(outcome.pending).toBeUndefined();
    expect(outcome.error?.message).toContain(`working directory ${gone} does not exist`);
    expect(outcome.error?.message).not.toContain('was not found');
  });
});

describe('an ACP agent that stops reading its input', { timeout: CASE_TIMEOUT }, () => {
  // Measured on Windows 11 (2026-09-25): a child that destroys its stdin, or closes
  // fd 0 as well, leaves the pipe writable from this side, and the writes
  // succeed until the process is gone. No agent there can make this EPIPE, and
  // Windows has no /bin/sh to run this one.
  it.skipIf(onWindows)('fails the turn instead of throwing EPIPE, and stops the agent', async () => {
    const pidFile = path.join(tmp, 'deaf-agent.pid');
    // A shell, because a Node agent cannot close its own fd 0 under the handle
    // Node keeps on it: libuv aborts. The ids are the client's own, 1 to 3.
    // It stops reading, stays alive, and asks for an answer it can no longer read.
    const agent = path.join(tmp, 'deaf-agent.sh');
    fs.writeFileSync(agent, [
      `read -r line; echo '{"jsonrpc":"2.0","id":1,"result":{}}'`,
      `read -r line; echo '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}'`,
      'read -r line',
      'exec 0<&-',
      `echo $$ > ${JSON.stringify(pidFile)}`,
      'sleep 0.1',
      `echo '{"jsonrpc":"2.0","id":900,"method":"session/request_permission","params":{"toolCall":{"title":"Read","kind":"read"},"options":[{"optionId":"yes","kind":"allow_once"}]}}'`,
      'exec sleep 30',
      '',
    ].join('\n'));
    const session = track(new AcpSession({ command: '/bin/sh', args: [agent] }, { cwd: tmp }));
    await session.start();

    const outcome = await within(session.prompt('go', 20_000), 5_000);
    await settle();

    expect(uncaught.map(e => String(e)), 'writing to the agent threw at the top of the process').toEqual([]);
    expect(outcome.pending, 'the turn was still waiting on an agent that can no longer hear it').toBeUndefined();
    expect(outcome.error?.message).toMatch(/stopped reading/);
    const pid = Number(fs.readFileSync(pidFile, 'utf-8'));
    for (let i = 0; i < 20 && isAlive(pid); i++) await settle(100);
    expect(isAlive(pid), 'the agent was left running').toBe(false);
  });
});

describe('an ACP agent that exits before it answers', { timeout: CASE_TIMEOUT }, () => {
  it('says what the agent printed on its way out', async () => {
    // What claude-agent-acp prints under Node 18 through npm 9's npx, measured
    // on 2026-09-18 in the packaged app with /usr/local/bin first on the PATH:
    // the adapter needs Node 22. npm's update notice comes after, on the first
    // run of the week, and was all the message said until it was left out.
    const agent = script('dying-agent', `
process.stderr.write([
  'file:///x/.npm/_npx/523186a76b483a0d/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js:4',
  'import packageJson from "../package.json" with { type: "json" };',
  '                                          ^^^^',
  '',
  "SyntaxError: Unexpected token 'with'",
  '    at ESMLoader.moduleStrategy (node:internal/modules/esm/translators:119:18)',
  '    at ESMLoader.moduleProvider (node:internal/modules/esm/loader:468:14)',
  '    at async link (node:internal/modules/esm/module_job:68:21)',
  '',
  'Node.js v18.16.0',
  'npm notice ',
  'npm notice New major version of npm available! 9.5.1 -> 12.0.2',
  'npm notice Changelog: <https://github.com/npm/cli/releases/tag/v12.0.2>',
  'npm notice Run \`npm install -g npm@12.0.2\` to update!',
  'npm notice ',
  '',
].join('\\n'));
process.exit(1);
`);
    const session = track(new AcpSession({ command: process.execPath, args: [agent] }, { cwd: tmp }));

    const outcome = await within(session.start(), 5_000);

    expect(outcome.pending).toBeUndefined();
    expect(outcome.error?.message).toContain('exited (code 1)');
    expect(outcome.error?.message, 'the reason the agent gave is lost').toContain("SyntaxError: Unexpected token 'with'");
    expect(outcome.error?.message).toContain('Node.js v18.16.0');
    expect(outcome.error?.message, 'stack frames are noise here').not.toContain('ESMLoader');
    expect(outcome.error?.message, "npm's update notice is noise here").not.toContain('npm notice');
  });
});

describe('a delegation from an app opened from the Dock', { timeout: CASE_TIMEOUT }, () => {
  const AGENT = {
    id: 'agent-docked',
    name: 'Docked',
    status: 'idle',
    projectPath: tmp,
    provider: 'claude',
    skills: [],
    output: [],
    lastActivity: new Date().toISOString(),
  } as AgentStatus;

  // Arguments a real npx answers at once and offline, should the stub ever
  // lose to another npx: the case then fails on the stub check, and fetches
  // nothing.
  const ARGS = ['--version'];

  beforeEach(() => {
    process.env.PATH = DOCK_PATH;
    runTokens.length = 0;
  });

  async function delegate(appSettings: Partial<AppSettings>) {
    const outcome = await within(delegateOverAcp({
      agent: AGENT,
      task: 'report',
      appSettings: appSettings as AppSettings,
      timeoutMs: 20_000,
    }), 10_000);
    expect(outcome.pending, 'the delegation was still waiting').toBeUndefined();
    expect(outcome.error, 'delegateOverAcp itself threw').toBeUndefined();
    return outcome.value!;
  }

  it('finds npx in the folder set in Settings > CLI Paths', async () => {
    const dir = path.join(tmp, 'cli-paths-node');
    const stub = stubNpx(dir);
    launch = { command: 'npx', args: ARGS };

    const result = await delegate({ cliPaths: { node: path.join(dir, 'node') } as AppSettings['cliPaths'] });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const report = JSON.parse(result.text) as { stub: string; args: string[]; path: string };
    expect(report.stub, 'another npx ran').toBe(stub);
    expect(report.args).toEqual(ARGS);
    expect(report.path.split(path.delimiter)[0], 'the agent does not get the PATH it was found on').toBe(dir);
  });

  // buildFullPath's Windows rules have no ~/.nvm: nvm-windows puts the node it
  // selects on the PATH itself (electron/platform/path-env.ts).
  it.skipIf(onWindows)('finds npx under ~/.nvm, where buildFullPath looks for it', async () => {
    // HOME is the throwaway one of this run (see home-isolation.ts). The first
    // of buildFullPath's nvm folders, because it comes before /usr/local/bin,
    // where many machines, this one included, have an npx of their own.
    expect(process.env.HOME, 'HOME is not redirected').not.toBe(os.userInfo().homedir);
    const dir = path.join(process.env.HOME!, '.nvm/versions/node/v20.11.1/bin');
    const stub = stubNpx(dir);
    launch = { command: 'npx', args: ARGS };

    const result = await delegate({});

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((JSON.parse(result.text) as { stub: string }).stub, 'another npx ran').toBe(stub);
  });

  it('fails at once and readably when the command is nowhere, and lets go of its token', async () => {
    launch = { command: MISSING, args: [] };

    const started = Date.now();
    const result = await delegate({});

    expect(Date.now() - started, 'the failure waited for a timeout').toBeLessThan(5_000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`${MISSING} was not found`);
    expect(result.error).toContain('Settings > CLI Paths');
    expect(runTokens).toHaveLength(1);
    expect(agentForToken(runTokens[0]), 'the run left its pass behind').toBeUndefined();
  });
});
