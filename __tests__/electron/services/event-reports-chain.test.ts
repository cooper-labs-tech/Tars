import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The chain of an event report, from an agent gone to error to the channel the relay hands the reports (the
 * DESIGN-RELAIS-HERMES-V2.md relay): the status change Tars already confirms (5 s, as its desktop notifications), and
 * the event reports.
 *
 * How it fails, written before the code (2026-09-28, and the relay, 2026-10-01):
 * 1. An agent gone to error is not reported, or is reported before the 5 s Tars waits to be sure of a status.
 * 2. It is reported under another project than the agent's: the user's reply would reach another orchestrator.
 * 3. Its name is changed on the way: the relay carries plain text, and an escape would show as "&lt;".
 * 4. Reports keep going once the relay is off.
 * 5. It depends on the desktop notification switch for errors: the two are different people's settings, the Mac's
 *    and the user's phone.
 * 6. (found in the app proof of #234) The first status change Tars sees for an agent is only recorded, never acted on:
 *    an agent whose first change after Tars starts is to error was neither notified nor reported.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.2' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));

import { agents, handleStatusChangeNotification } from '../../../electron/core/agent-manager';
import { setReportChannel } from '../../../electron/services/event-reports';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const settings = { notificationsEnabled: true, notifyOnError: false } as AppSettings;
const TARS = '/Users/someone/projects/tars';
const sent: Array<{ text: string; projectPath: string }> = [];
const channel = { async send(text: string, projectPath: string) { sent.push({ text, projectPath }); return true; } };

beforeEach(() => {
  vi.useFakeTimers();
  fs.rmSync(path.join(os.homedir(), '.tars-private'), { recursive: true, force: true });
  agents.clear();
  sent.length = 0;
  setReportChannel(channel);
});
afterEach(() => { setReportChannel(null); vi.useRealTimers(); });

function goesToError(id: string, name: string, reason: string) {
  const agent = { id, name, status: 'running', provider: 'claude', projectPath: TARS, skills: [], output: [], lastActivity: '' } as unknown as AgentStatus;
  agents.set(id, agent);
  handleStatusChangeNotification(agent, 'running', settings, vi.fn());
  agent.status = 'error';
  agent.error = reason;
  handleStatusChangeNotification(agent, 'error', settings, vi.fn());
}
const reports = () => sent.filter(m => /stopped on an error/.test(m.text));

describe('an agent gone to error', () => {
  it('1, 2, 3, 5. is reported under its own project, its name as it is, after Tars is sure of it, whatever the desktop switch', async () => {
    goesToError('a1', 'Tars-<Backend>', 'The API refused the request');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reports()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000 + 120_000 + 10);

    expect(reports().map(m => m.projectPath)).toEqual([TARS]);
    expect(reports()[0].text).toContain('Tars-<Backend>');
    expect(reports()[0].text).toContain('The API refused the request');
  });

  it('4. is not reported once the relay is off', async () => {
    setReportChannel(null);
    goesToError('a2', 'Other', 'boom');
    await vi.advanceTimersByTimeAsync(130_000);
    expect(reports()).toEqual([]);
  });
});

describe('the first status change Tars sees for an agent', () => {
  it('6. is reported when it is to error', async () => {
    const agent = { id: 'a3', name: 'First', status: 'error', error: 'API Error: 529 overloaded', provider: 'claude', projectPath: TARS, skills: [], output: [], lastActivity: '' } as unknown as AgentStatus;
    agents.set('a3', agent);
    handleStatusChangeNotification(agent, 'error', settings, vi.fn());
    await vi.advanceTimersByTimeAsync(130_000);
    expect(reports().map(m => m.text).join('')).toContain('529 overloaded');
  });
});
