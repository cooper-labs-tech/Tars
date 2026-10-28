import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The desktop notifications and the reply sent back to Telegram, for the
 * chats' runners (ORCHESTRATOR-PER-CHAT.md v2.2, 4.2, PR D), as
 * handleStatusChangeNotification decides them.
 *
 * A runner converses with the user in its chat as the project's orchestrator
 * does in its own: its turns are read where they happen, and the
 * orchestrator's never raised a desktop notification. The reply sent back to
 * Telegram is another matter: the bots write to the project's orchestrator,
 * and its answer is the one that goes back.
 *
 * How it fails, written before the code (2026-10-12):
 * 1. Each turn a runner ends raises a desktop notification ("needs your
 *    attention", "completed", an error) where the orchestrator's never did.
 * 2. A worker's notifications go with them.
 * 3. A runner's turn ending while Telegram waits on the orchestrator sends the
 *    runner's screen to Telegram as the orchestrator's answer, and the
 *    orchestrator's own answer then never goes.
 * (Item 3 went with Tars's own Telegram bot in 2.0.5.)
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.0' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));

import { agents, handleStatusChangeNotification } from '../../../electron/core/agent-manager';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const settings = { notificationsEnabled: true, notifyOnWaiting: true, notifyOnComplete: true, notifyOnError: true } as AppSettings;
const notify = vi.fn();

function put(id: string, fields: Partial<AgentStatus>): AgentStatus {
  const agent = {
    id, name: id, status: 'running', projectPath: '/projects/atlas', skills: [], output: [], lastActivity: '2026-10-12T09:00:00.000Z', ...fields,
  } as AgentStatus;
  agents.set(id, agent);
  return agent;
}

const lead = () => put('lead', { name: 'Atlas-Lead', role: 'orchestrator', orchestratorMode: true });
const runner = () => put('runner', { name: 'Atlas-Lead · Release 1.9.4', role: 'worker', kind: 'chat', chatId: 'c-2', teamOrchestratorId: 'lead' });
const worker = () => put('backend', { name: 'Backend', role: 'worker' });

/** The agent leaves a turn for `status`, and the five seconds a notification waits go by. */
async function ends(agent: AgentStatus, status: 'waiting' | 'completed' | 'error'): Promise<void> {
  handleStatusChangeNotification(agent, 'running', settings, notify);
  agent.status = status;
  handleStatusChangeNotification(agent, status, settings, notify);
  await vi.advanceTimersByTimeAsync(5_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  agents.clear();
  notify.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a chat's runner, as the notifications see it", () => {
  it.each(['waiting', 'completed', 'error'] as const)('1, 2. raises no desktop notification when %s, as the orchestrator does not, and a worker still does', async status => {
    await ends(lead(), status);
    await ends(runner(), status);
    expect(notify, 'the orchestrator or a runner raised a desktop notification').not.toHaveBeenCalled();

    await ends(worker(), status);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][2]).toBe('backend');
  });
});
