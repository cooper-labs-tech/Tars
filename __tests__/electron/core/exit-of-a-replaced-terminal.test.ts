/**
 * A terminal that ends after its agent was given another one is not the
 * agent's news (the Frontend's finding of 05/10, electron/core/agent-manager.ts).
 *
 * initAgentPty's exit handler guarded the agent's status with "only if this
 * PTY is still the active one", but sent agent:complete whatever the answer.
 * A restart ends the old terminal after the new one has started, so the
 * window moved the agent's current task to done, with the new terminal's
 * screen as its summary.
 *
 * How it fails, written before the code (2026-10-05):
 * 1. A terminal that ends after it was replaced sends agent:complete.
 * 2. Over-correction: the agent's own terminal ending no longer does.
 * 3. A replaced terminal's exit changes the agent's status (the guard that
 *    already held).
 * And from the e2e of this fix (agent-stopped.spec.ts, red on its first
 * version): a stop clears the agent's terminal before it ends it, and the
 * window reads who stopped it and why only by fetching the fleet again,
 * which this agent:complete made it do (its status event is patched, not
 * fetched). So:
 * 4. The terminal a stop ended, the agent having no other, no longer sends
 *    agent:complete, and the window shows a stop without who or why. Pinned
 *    until the window fetches on the stop's own status event.
 * Which it does since #329 (the follow-ups of 06/10): the window fetches the
 * fleet on a `stopped` status event, and 4 turns round.
 * 4. The terminal a stop ended sends agent:complete: it is no longer the
 *    agent's, and the window takes it for the agent's task done.
 */
import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type Exit = (event: { exitCode: number }) => void;
/** Each terminal spawned, with every exit listener anyone gave it. */
const terminals: Exit[][] = [];
const exit = (n: number, exitCode: number) => { for (const fn of terminals[n]) fn({ exitCode }); };
let next = 0;

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const listeners: Exit[] = [];
    terminals.push(listeners);
    return { onData: vi.fn(), onExit: vi.fn((fn: Exit) => { listeners.push(fn); return { dispose() {} }; }), kill: vi.fn(), write: vi.fn(), pid: 1, resize: vi.fn() };
  }),
}));
vi.mock('uuid', () => ({ v4: vi.fn(() => `pty-${++next}`) }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: vi.fn(),
  Notification: vi.fn(),
}));
const { sent } = vi.hoisted(() => ({ sent: [] as Array<{ channel: string; payload: Record<string, unknown> }> }));
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: Record<string, unknown>) => { sent.push({ channel, payload }); },
}));
vi.mock('../../../electron/utils/agents-tick', () => ({ scheduleTick: vi.fn() }));
vi.mock('../../../electron/services/agent-events', () => ({ emitAgentStatus: vi.fn() }));
vi.mock('../../../electron/services/tasmania-client', () => ({ getTasmaniaStatus: vi.fn(async () => ({ status: 'stopped' })) }));
vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { initAgentPty, agents } from '../../../electron/core/agent-manager';
import type { AgentStatus } from '../../../electron/types';
import { moveTestHome } from '../../setup/test-home';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-exit-home-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-exit-cwd-'));
let restoreHome: () => void;

beforeEach(() => {
  terminals.length = 0;
  sent.length = 0;
  agents.clear();
  // HOME alone on macOS and Linux; on Windows os.homedir() reads USERPROFILE,
  // which moves with it (setup/test-home.ts).
  restoreHome = moveTestHome(home);
  expect(os.homedir()).toBe(home);
});
afterEach(() => { restoreHome(); });

function agent(): AgentStatus {
  const a = { id: 'a1', name: 'Backend', status: 'running', projectPath: cwd, skills: [], output: [], provider: 'claude', lastActivity: new Date().toISOString() } as unknown as AgentStatus;
  agents.set('a1', a);
  return a;
}
const completes = () => sent.filter(s => s.channel === 'agent:complete');

describe("a terminal's exit", () => {
  it('1, 3. after the agent got another terminal, says nothing and changes nothing', async () => {
    const a = agent();
    const status = vi.fn();
    const first = await initAgentPty(a, null, status, vi.fn());
    a.ptyId = first;
    // The restart: the new terminal is the agent's before the old one ends.
    a.ptyId = undefined;
    const second = await initAgentPty(a, null, status, vi.fn());
    a.ptyId = second;
    a.status = 'running';

    exit(0, 0);

    expect(completes()).toEqual([]);
    expect(a.status).toBe('running');
    expect(status).not.toHaveBeenCalled();
  });

  it('4. of the terminal a stop ended, with no other one, sends no agent:complete', async () => {
    const a = agent();
    await initAgentPty(a, null, vi.fn(), vi.fn());
    a.ptyId = undefined;
    a.status = 'stopped';

    exit(0, 0);

    expect(completes()).toEqual([]);
    expect(a.status).toBe('stopped');
  });

  it("2. of the agent's own terminal, is still its news", async () => {
    const a = agent();
    const ptyId = await initAgentPty(a, null, vi.fn(), vi.fn());
    a.ptyId = ptyId;

    exit(0, 0);

    expect(completes()).toHaveLength(1);
    expect(completes()[0].payload).toMatchObject({ agentId: 'a1', ptyId, exitCode: 0 });
    expect(a.status).toBe('completed');
  });
});
