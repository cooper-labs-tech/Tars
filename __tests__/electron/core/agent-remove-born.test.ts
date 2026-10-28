import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';

/**
 * Deleting an agent ends what it started outside its terminal, as a stop does, and says it (2.0.5, the Audit's
 * Info 2 on #523).
 *
 * How it fails, written before the code (2026-10-28):
 * 1. The agent's terminal is killed, but what it started detached (nohup, setsid, reparented to init or launchd)
 *    runs on; and since the agent has left the fleet, the watch that reports what outlives a session never
 *    names it. That is how Tars's own e2e left 20 `my-cli` orphans.
 * 2. What was ended and kept is not said to whoever deleted the agent.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }) }));
vi.setConfig({ testTimeout: 20_000 });

import { removeAgent } from '../../../electron/core/agent-remove';
import { agents } from '../../../electron/core/agent-manager';
import { tarsAddress } from '../../../electron/core/born-processes';
import type { AgentStatus } from '../../../electron/types';

const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
});
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim().startsWith('Z'); } catch { return false; }
};

describe.skipIf(process.platform === 'win32')('deleting an agent', () => {
  it('1, 2. ends what it started detached, and says what it ended', async () => {
    const id = 'agent-remove-born-1';
    agents.set(id, { id, name: 'Gone', status: 'idle', provider: 'claude', projectPath: '/p', skills: [], output: [], lastActivity: '2026-10-28T00:00:00.000Z' } as AgentStatus);
    const tag = { ...process.env, CLAUDE_AGENT_ID: id, CLAUDE_MGR_API_URL: tarsAddress() };
    // node, not sleep: macOS shows no environment of a platform binary, so no tag.
    const server = Number(execFileSync('/bin/sh', ['-c', `nohup "$0" -e 'setInterval(() => {}, 1 << 30)' remove-1 >/dev/null 2>&1 & echo $!`, process.execPath], { env: tag }).toString().trim());
    leftovers.push(server);
    await new Promise(r => setTimeout(r, 300));

    const removed = await removeAgent(id);

    expect(await new Promise(r => setTimeout(() => r(alive(server)), 200))).toBe(false);
    expect(removed.processes?.ended).toHaveLength(1);
    expect(removed.processes?.ended[0]).toMatch(new RegExp(`^pid ${server}: .* remove-1$`));
    expect(agents.has(id)).toBe(false);
  });
});
