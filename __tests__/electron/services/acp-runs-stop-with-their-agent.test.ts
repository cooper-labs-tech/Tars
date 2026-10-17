import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A delegated run stops with its agent (the Audit's table on a3d7c125, #6).
 *
 * `AcpSession.cancel()` had no caller, and the runs delegateOverAcp starts were
 * tracked nowhere: stopping or deleting the agent ended its terminal and left
 * its ACP run working, for up to its hour, with the agent's run token. And
 * `stop()` killed the process Tars spawned (npx, the adapter) and nothing it
 * had started: the CLI underneath, and whatever command that CLI ran.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. Stopping an agent leaves its delegated run working.
 * 2. The run is killed without being asked to cancel first.
 * 3. The process Tars spawned dies, and what it spawned lives on.
 * 4. The caller of the run is told nothing it can tell from a crash.
 * 5. Stopping one agent reaches another agent's run.
 * 6. A run that ended is still held, and a stop later reaches a process id
 *    that may be someone else's by then.
 * 7. The stop route of the API (what an orchestrator calls) does not reach it.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-stop-'));
const serverBundle = path.join(tmp, 'bundle.js');
fs.writeFileSync(serverBundle, '');

/** An ACP agent that, asked for a turn, starts a long command of its own and never answers. */
function busyAgent(tag: string): { command: string; args: string[]; pidFile: string; cancelFile: string } {
  const pidFile = path.join(tmp, `${tag}.pid`);
  const cancelFile = path.join(tmp, `${tag}.cancel`);
  const file = path.join(tmp, `${tag}.mjs`);
  fs.writeFileSync(file, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/cancel') { writeFileSync(${JSON.stringify(cancelFile)}, 'cancel'); return; }
  if (msg.method === 'session/prompt') {
    const work = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(pidFile)}, String(work.pid) + ' ' + String(process.pid));
  }
}
`);
  return { command: process.execPath, args: [file], pidFile, cancelFile };
}

let launch: { command: string; args: string[] };
vi.mock('../../../electron/services/acp/registry', () => ({ acpLaunchFor: () => launch, loadAcpRegistry: async () => undefined }));
vi.mock('../../../electron/services/mcp-orchestrator', () => ({ getMcpOrchestratorPath: () => serverBundle, getMcpMemoryPath: () => serverBundle }));
vi.mock('../../../electron/providers', () => ({ getProvider: () => ({ getPtyEnvVars: () => ({}), configDir: '/not-claude' }) }));
vi.mock('../../../electron/services/usage-ledger', () => ({ recordUsage: vi.fn() }));

import { delegateOverAcp, stopAcpRuns } from '../../../electron/services/acp/delegate';
import type { AgentStatus, AppSettings } from '../../../electron/types';
import { Leftovers } from '../../setup/leftover-processes';

const agent = (id: string) => ({
  id, name: id, status: 'running', projectPath: tmp, provider: 'claude', skills: [], output: [], lastActivity: new Date().toISOString(),
} as AgentStatus);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (what: string, test: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 50)); }
};
const pids = (file: string) => fs.readFileSync(file, 'utf-8').split(' ').map(Number);

// Ended by id only while the id is still the process the test saw: see leftover-processes.ts.
const leftovers = new Leftovers();
afterEach(() => leftovers.end(), 60_000);

describe('a delegated run, when its agent is stopped or deleted', { timeout: 30_000 }, () => {
  it('1, 2, 3, 4. is asked to cancel, then its whole process tree goes, and its caller is told it was stopped', async () => {
    const a = busyAgent('one');
    launch = a;
    const running = delegateOverAcp({ agent: agent('agent-one'), task: 'work', appSettings: {} as AppSettings, timeoutMs: 60_000 });
    await until('the run began its work', () => fs.existsSync(a.pidFile));
    const [work, adapter] = pids(a.pidFile);
    leftovers.push(work, adapter);

    expect(await stopAcpRuns('agent-one', 'the agent was stopped')).toBe(1);
    const result = await running;

    expect(fs.existsSync(a.cancelFile), 'killed without being asked to cancel').toBe(true);
    await until('the command the run started is gone', () => !alive(work), 5_000);
    expect(alive(adapter)).toBe(false);
    expect(result).toMatchObject({ ok: false, started: true });
    expect(result.error).toMatch(/the agent was stopped/);
  });

  it('5. leaves another agent\'s run alone', async () => {
    const a = busyAgent('two');
    launch = a;
    const running = delegateOverAcp({ agent: agent('agent-two'), task: 'work', appSettings: {} as AppSettings, timeoutMs: 60_000 });
    await until('the run began its work', () => fs.existsSync(a.pidFile));
    const [work, adapter] = pids(a.pidFile);
    leftovers.push(work, adapter);

    expect(await stopAcpRuns('agent-someone-else', 'stopped')).toBe(0);
    await new Promise(r => setTimeout(r, 500));
    expect(alive(work)).toBe(true);

    await stopAcpRuns('agent-two', 'cleanup');
    await running;
  });

  it('6. holds nothing once a run has ended', async () => {
    const a = busyAgent('three');
    launch = a;
    const running = delegateOverAcp({ agent: agent('agent-three'), task: 'work', appSettings: {} as AppSettings, timeoutMs: 1_000 });
    await running;
    leftovers.push(...(fs.existsSync(a.pidFile) ? pids(a.pidFile) : []));

    expect(await stopAcpRuns('agent-three', 'late')).toBe(0);
  });
});
