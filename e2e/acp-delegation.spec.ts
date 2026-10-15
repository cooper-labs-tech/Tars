import { test, expect, _electron as electron } from '@playwright/test';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A task delegated over ACP comes back with its stop reason, and a stopped
 * run leaves no process behind.
 *
 * The whole chain is the real app's: POST /api/agents/:id/run-task, the
 * delegation, the registry's launch for a claude agent (`npx -y
 * @agentclientprotocol/claude-agent-acp@...`), the lookup of npx on the PATH
 * built from Settings > CLI Paths, the spawn, the protocol, and the stop. Only
 * what npx is differs: an npx in the folder Settings names, which runs a fake
 * ACP agent instead of fetching one. On Windows that is npm's npx.cmd shim,
 * which Tars has to read through to the node.exe and script it runs; on macOS
 * and Linux a shell script.
 *
 * The fake agent, asked for a turn, starts a command that starts another, as
 * a CLI's tools do, both holding on. It answers `work` with a stop reason and
 * `hang` with nothing, so that the second run can only end by being stopped.
 *
 * Before this lot, on Windows: every run failed at the spawn, `npx` was not
 * found (libuv does not read PATHEXT, and a .cmd cannot be spawned without a
 * shell), and a stopped run left everything under its root running.
 */

const onWindows = process.platform === 'win32';

const FAKE_AGENT = String.raw`
const { spawn } = require('child_process');
const fs = require('fs');
const marker = process.env.TARS_E2E_ACP_MARKER;
let buf = '';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
function startWork(tag) {
  // A command that starts another, both alive until something ends them.
  // Detached: on Windows libuv puts every other child in a job that dies with
  // its parent, so a tree of Node processes ends with its root whatever Tars
  // does. A CLI's tool shells (claude.exe is not libuv) are in no such job.
  const inner = "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', process.argv[1]], { stdio: 'ignore', detached: true }); setInterval(() => {}, 1000)";
  const child = spawn(process.execPath, ['-e', inner, marker], { stdio: 'ignore', detached: true });
  fs.writeFileSync(marker + '.' + tag + '.pid', process.pid + ' ' + child.pid);
}
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { agentInfo: { name: 'fake-acp' } } });
    if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
    if (msg.method === 'session/prompt') {
      const task = msg.params.prompt[0].text;
      startWork(task);
      if (task === 'work') {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done: ' + JSON.stringify(process.argv.slice(2)) } } } });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    }
  }
});
`;

/** npx in `dir`: npm's own npx.cmd shim on Windows (node.exe beside it), a shell script elsewhere. */
function fakeNpx(dir: string): string {
  const script = path.join(dir, 'node_modules', 'fake-acp', 'npx-cli.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, FAKE_AGENT);
  if (onWindows) {
    try { fs.linkSync(process.execPath, path.join(dir, 'node.exe')); } catch { fs.copyFileSync(process.execPath, path.join(dir, 'node.exe')); }
    fs.writeFileSync(path.join(dir, 'npx.cmd'), [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-acp\\npx-cli.js" %*', '',
    ].join('\r\n'));
  } else {
    fs.writeFileSync(path.join(dir, 'npx'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  return script;
}

const run = promisify(execFile);

/**
 * Every process whose command line names the marker: the fake agent's commands, whatever their parent now.
 *
 * Asynchronous: Get-CimInstance takes seconds on a loaded machine, and a
 * synchronous call held the test's event loop for all of them, inside until()'s
 * polls, while the hanging run-task request it had in flight waited to be read.
 *
 * In UTF-8, as cli-updater-windows.ts reads the same table: Windows PowerShell
 * writes in the console's code page otherwise, where a character it lacks (an
 * arrow in a CLI's prompt on its command line) becomes a raw 0x1A, which no
 * JSON string may hold, and the parse failed on whatever ran on the machine.
 */
async function processesNaming(marker: string): Promise<{ pid: number; cmd: string }[]> {
  if (onWindows) {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout: out } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const rows = JSON.parse(out) as { ProcessId: number; CommandLine: string }[];
    return rows.filter(r => r.CommandLine.includes(marker)).map(r => ({ pid: r.ProcessId, cmd: r.CommandLine }));
  }
  const { stdout: out } = await run('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  return out.split('\n').filter(l => l.includes(marker)).map(l => ({ pid: Number(l.trim().split(/\s+/)[0]), cmd: l.trim() }));
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(what: string, test: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

test('a delegated task returns its stop reason, and a stopped run leaves no process behind', async () => {
  test.setTimeout(120_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-acp-'));
  const project = path.join(home, 'projects', 'acp');
  const cliDir = path.join(home, 'cli');
  fs.mkdirSync(project, { recursive: true });
  const script = fakeNpx(cliDir);
  const marker = path.join(home, 'acp-marker');
  const dorothy = path.join(home, '.dorothy');
  fs.mkdirSync(dorothy, { recursive: true });
  fs.writeFileSync(path.join(dorothy, 'agents.json'), JSON.stringify([{
    id: 'acp1', name: 'Delegate', provider: 'claude', status: 'idle', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(),
  }], null, 2));
  fs.writeFileSync(path.join(dorothy, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false,
    // The folder Settings > CLI Paths names: its npx comes first on the PATH the run gets.
    cliPaths: { node: path.join(cliDir, onWindows ? 'node.exe' : 'node') },
  }, null, 2));

  const port = apiPort(31476);
  const app = await launchSandboxed(electron, home, {
    env: {
      NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1',
      TARS_E2E_ACP_MARKER: marker,
    },
  });
  const leftovers: number[] = [];
  try {
    const dist = path.resolve(process.cwd(), 'electron', 'dist');
    // Tars's own pass, as the super chat presents it: the stop and run routes want a caller with an identity.
    const token = await app.evaluate((_e, d) => process.mainModule!.require(`${d}/core/agent-tokens.js`).internalToken() as string, dist);
    const api = async (route: string, body: object) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/agents/acp1/${route}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, data: await res.json() as Record<string, unknown> };
    };
    for (let i = 0; i < 100; i++) {
      try { await fetch(`http://127.0.0.1:${port}/api/health`); break; } catch { await new Promise(r => setTimeout(r, 200)); }
    }

    // 1. A task that finishes: its stop reason comes back, and what its turn left running is ended with the run.
    const worked = await api('run-task', { task: 'work', timeoutSeconds: 60 });
    const [workRoot, workChild] = fs.readFileSync(`${marker}.work.pid`, 'utf8').split(' ').map(Number);
    leftovers.push(workRoot, workChild);
    expect(worked.status, JSON.stringify(worked.data)).toBe(200);
    expect(worked.data.ok).toBe(true);
    expect(worked.data.stopReason).toBe('end_turn');
    const args = JSON.parse(String(worked.data.text).replace(/^done: /, '')) as string[];
    expect(args[0]).toBe('-y');
    expect(args[1]).toMatch(/^@agentclientprotocol\/claude-agent-acp@/);
    await until('the finished run\'s processes are gone', async () => (await processesNaming(marker)).length === 0 && !alive(workRoot));

    // 2. A task that hangs, stopped with its agent: the caller is told, and nothing of the run is left.
    const hanging = api('run-task', { task: 'hang', timeoutSeconds: 60 });
    await until('the hanging run started its commands', () => fs.existsSync(`${marker}.hang.pid`));
    const [hangRoot, hangChild] = fs.readFileSync(`${marker}.hang.pid`, 'utf8').split(' ').map(Number);
    leftovers.push(hangRoot, hangChild);
    await until('the command and the one it started are up', async () => (await processesNaming(marker)).length >= 2);
    const running = (await processesNaming(marker)).length;
    const stopped = await api('stop', { reason: 'the delegation spec stops the hanging run' });
    expect(stopped.status, JSON.stringify(stopped.data)).toBe(200);
    const answer = await hanging;
    expect(answer.status, JSON.stringify(answer.data)).toBe(200);
    expect(answer.data.started).toBe(true);
    expect(answer.data.error).toBe('the run was stopped: the agent was stopped');
    await until('the stopped run\'s processes are gone', async () => (await processesNaming(marker)).length === 0 && !alive(hangRoot));

    recordValues({
      platform: process.platform,
      npxScript: script,
      finished: { status: worked.status, ok: worked.data.ok, stopReason: worked.data.stopReason, argv: args },
      stopped: { status: answer.status, started: answer.data.started, error: answer.data.error, processesBeforeStop: running },
      processesLeft: (await processesNaming(marker)).length,
      command: 'E2E_PORT_OFFSET=30 npx playwright test e2e/acp-delegation.spec.ts',
    });
  } finally {
    // Before the app closes, which a failed run may not live through: a red
    // run must not leave its commands behind either.
    for (const pid of [...leftovers, ...(await processesNaming(marker)).map(p => p.pid)]) { try { process.kill(pid); } catch { /* gone */ } }
    await app.close();
    await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
