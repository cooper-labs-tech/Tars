/**
 * A move to another Claude account restarts the agent's CLI through the same
 * wait as a changed setting (agent-restart.ts), though no setting changed:
 * the account a move goes to is chosen by the launch, not saved on the record.
 *
 * What goes wrong if it is wrong, first:
 * - decide() compares what the CLI was launched with to the record, finds them
 *   equal, and never restarts it: the move is asked for and never made;
 * - `always` taken for "at once": a move must still wait for a turn, a
 *   dialog, a draft, a note, like any restart;
 * - `always` kept after the restart it asked for, so a later unchanged
 *   setting restarts the CLI for nothing.
 */
import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';

const h = vi.hoisted(() => ({ launches: [] as { agentId: string; options: unknown }[] }));

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, BrowserWindow: vi.fn(), Notification: vi.fn() }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/core/agent-pty', () => ({ cliRunningIn: () => true }));
vi.mock('../../../electron/core/agent-launch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CLI_BOOT_MS: 0,
  dialogOpen: () => false,
  noteCliLaunched: () => {},
  cliLaunchedAt: () => undefined,
  launchAgent: async (agentId: string, _prompt: string, options: unknown) => {
    h.launches.push({ agentId, options });
    return { success: true };
  },
}));

import { restartForSettings, noteLaunch, launchSettings, resetAgentRestarts } from '../../../electron/core/agent-restart';
import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import type { AgentStatus } from '../../../electron/types';

function agentWithCli(status: AgentStatus['status']): AgentStatus {
  const agent = {
    id: `a-${Math.random().toString(16).slice(2, 8)}`, name: 'Worker', status, provider: 'claude', projectPath: '/p',
    skills: [], output: [], lastActivity: '', ptyId: `pty-${Math.random()}`, resumableSessionId: '11111111-2222-3333-4444-555555555555',
  } as unknown as AgentStatus;
  const pty = { kill: () => {}, write: () => {}, pid: 1 };
  ptyProcesses.set(agent.ptyId!, pty as never);
  agents.set(agent.id, agent);
  noteLaunch(pty, launchSettings(agent));
  return agent;
}

beforeEach(() => {
  resetAgentRestarts();
  h.launches.length = 0;
});

describe('a restart for a move', () => {
  it('is not made when nothing the CLI reads changed, unless asked always', async () => {
    const a = agentWithCli('idle');
    expect(restartForSettings(a.id, ['claudeAccount'])).toMatchObject({ action: 'next-launch' });
    expect(restartForSettings(a.id, ['claudeAccount'], { always: true })).toEqual({ action: 'restarted' });
    await vi.waitFor(() => expect(h.launches).toHaveLength(1));
    expect(h.launches[0]).toEqual({ agentId: a.id, options: { resumeSessionId: '11111111-2222-3333-4444-555555555555' } });
  });

  it('still waits for the turn to end', () => {
    const a = agentWithCli('running');
    expect(restartForSettings(a.id, ['claudeAccount'], { always: true })).toEqual({ action: 'waiting', for: 'turn' });
    expect(h.launches).toEqual([]);
  });

  it('is forgotten once made: the next unchanged setting restarts nothing', async () => {
    const a = agentWithCli('idle');
    restartForSettings(a.id, ['claudeAccount'], { always: true });
    await vi.waitFor(() => expect(h.launches).toHaveLength(1));
    const pty = { kill: () => {}, write: () => {}, pid: 2 };
    a.ptyId = 'pty-after';
    ptyProcesses.set(a.ptyId, pty as never);
    noteLaunch(pty, launchSettings(a));
    expect(restartForSettings(a.id, ['claudeAccount'])).toMatchObject({ action: 'next-launch' });
  });
});
