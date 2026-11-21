import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';

/**
 * Plan at launch. kimi-code has no plan mode (its --plan runs commands after dialogs nobody answers, measured), so a
 * kimi agent saved in plan is refused at its launch, with the reason create and update give. The Audit's L3 on #601:
 * the first form of that refusal refused every provider without plan mode at launch, so an agent saved in plan on
 * codex, gemini or an API-key provider before 13/10 was refused at every start, wake, restart and boot recovery, and
 * a restart had killed its terminal first.
 *
 * How it fails, written before the code (19/11):
 * 1. A provider other than kimi-code, saved in plan, is refused at launch: it must launch as it did before (main moves
 *    plan to normal nowhere on load; each CLI's own builder decides what plan is for it, as today).
 * 2. kimi-code in plan is let through, and kimi starts in a mode it cannot keep.
 * 3. kimi-code in any other mode is refused.
 * 4. A restart of a kimi agent saved in plan kills its terminal before it is refused, and leaves it with none.
 */

const h = vi.hoisted(() => ({ launches: [] as Array<{ agentId: string }>, kills: 0 }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, BrowserWindow: vi.fn(), Notification: vi.fn() }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/core/agent-pty', () => ({ cliRunningIn: () => true }));
vi.mock('../../../electron/core/pty-kill', () => ({ killPty: () => { h.kills++; } }));
vi.mock('../../../electron/core/agent-launch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CLI_BOOT_MS: 0,
  dialogOpen: () => false,
  noteCliLaunched: () => {},
  cliLaunchedAt: () => undefined,
  launchAgent: async (agentId: string) => { h.launches.push({ agentId }); return { success: true }; },
}));

import { launchPlanRefusal } from '../../../electron/providers/plan-mode';
import { restartAgent, resetAgentRestarts } from '../../../electron/core/agent-restart';
import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import type { AgentStatus } from '../../../electron/types';

beforeEach(() => {
  resetAgentRestarts();
  h.launches.length = 0;
  h.kills = 0;
});

describe('plan at launch', () => {
  it('1: codex, gemini and an API-key provider saved in plan launch as before', () => {
    for (const provider of ['codex', 'gemini', 'openrouter', 'pi']) expect(launchPlanRefusal(provider, 'plan'), provider).toBeNull();
  });

  it('2 and 3: kimi-code in plan is refused with the reason create and update give; in any other mode it is not', () => {
    expect(launchPlanRefusal('kimi-code', 'plan')).toBe('Kimi Code has no plan mode here: plan would run as manual. Ask for normal, auto or bypass.');
    for (const mode of ['normal', 'auto', 'bypass', undefined]) expect(launchPlanRefusal('kimi-code', mode), String(mode)).toBeNull();
  });

  it('4: a restart of a kimi agent saved in plan is refused before its terminal is touched', async () => {
    const agent = {
      id: 'k-plan', name: 'Kimi', status: 'idle', provider: 'kimi-code', permissionMode: 'plan', projectPath: '/p',
      skills: [], output: [], lastActivity: '', ptyId: 'pty-k-plan',
    } as unknown as AgentStatus;
    ptyProcesses.set(agent.ptyId!, { kill: () => {}, write: () => {}, pid: 1 } as never);
    agents.set(agent.id, agent);
    const result = await restartAgent(agent.id);
    expect(result).toEqual({ success: false, error: 'Kimi Code has no plan mode here: plan would run as manual. Ask for normal, auto or bypass.' });
    expect(h.kills).toBe(0);
    expect(ptyProcesses.has('pty-k-plan')).toBe(true);
    expect(agents.get('k-plan')?.ptyId).toBe('pty-k-plan');
    expect(h.launches).toEqual([]);
  });
});
