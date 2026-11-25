import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Nothing is announced about an agent once the quit has begun.
 *
 * The quit ends every terminal (killAllPty), and on Windows it now waits for
 * them to report their exit (pty-kill.ts, holdExitUntilTerminalsExit), up to
 * 5 s when one never does. Each exit sets its agent to `error` and calls
 * handleStatusChangeNotification, whose announcement is debounced by 5 s: a
 * timer that comes due inside the hold sends a desktop notification, or for
 * the super agent a Telegram message, while the user is quitting (found in
 * review, 2026-09-27). stopStatusNotifications() is the quit's step for it, before
 * killAllPty.
 *
 * How it fails, written before the code:
 * 1. A status change made after the quit began schedules an announcement.
 * 2. An announcement pending when the quit begins still goes out.
 * 3. Before the quit, a change is no longer announced: the guard is on too
 *    early, or always (the witness that 1 and 2 are not vacuous).
 * 4. darwin/linux, whose quit holds nothing: the step changes what they
 *    announce. They keep today's announcements.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-quit-status-'));
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json') };
});
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => tmp, getVersion: () => '1.8.0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
  Notification: vi.fn(),
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: () => undefined }));

type AgentStatus = import('../../../electron/types').AgentStatus;
type AppSettings = import('../../../electron/types').AppSettings;
let manager: typeof import('../../../electron/core/agent-manager');

const settings = { notifyOnError: true, notifyOnComplete: true, notifyOnWaiting: true } as AppSettings;

function agent(id: string, status: AgentStatus['status']): AgentStatus {
  const a = { id, name: `Agent ${id}`, status, projectPath: tmp, skills: [], output: [], lastActivity: '' } as unknown as AgentStatus;
  manager.agents.set(id, a);
  return a;
}

/** Moves an agent to `status` as a terminal's exit does, and hands the change to the notifier. */
function change(a: AgentStatus, status: AgentStatus['status'], sent: string[]) {
  a.status = status;
  manager.handleStatusChangeNotification(a, status, settings, (title) => { sent.push(title); }, (text) => { sent.push(text); });
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  manager = await import('../../../electron/core/agent-manager');
  manager.agents.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('status notifications at quit', () => {
  it('3. are announced 5 s after a change, before the quit', () => {
    const sent: string[] = [];
    const a = agent('a1', 'running');
    change(a, 'running', sent);
    change(a, 'error', sent);
    vi.advanceTimersByTime(5_100);
    expect(sent).toEqual(['Agent a1 encountered an error']);
  });

  it('1. are not scheduled for a change made once the quit has begun', () => {
    const sent: string[] = [];
    const a = agent('a1', 'running');
    change(a, 'running', sent);
    manager.stopStatusNotifications('win32');
    change(a, 'error', sent);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
  });

  it('2. pending when the quit begins, are cancelled', () => {
    const sent: string[] = [];
    const a = agent('a1', 'running');
    const b = agent('a2', 'running');
    change(a, 'running', sent);
    change(b, 'running', sent);
    change(a, 'error', sent);
    change(b, 'completed', sent);
    vi.advanceTimersByTime(2_000);
    manager.stopStatusNotifications('win32');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
  });

  it.each(['darwin', 'linux'] as const)('4. on %s, are announced as before, pending or new', (platform) => {
    const sent: string[] = [];
    const a = agent('a1', 'running');
    const b = agent('a2', 'running');
    change(a, 'running', sent);
    change(b, 'running', sent);
    change(a, 'error', sent);
    vi.advanceTimersByTime(2_000);
    manager.stopStatusNotifications(platform);
    change(b, 'completed', sent);
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual(['Agent a1 encountered an error', 'Agent a2 completed']);
  });
});
