/**
 * An agent's pinned Claude account is something its CLI reads once, at launch:
 * a pin that changes restarts it, through the same wait as a model or an
 * effort (agent-restart.ts), and a CLI already launched on it is left alone.
 *
 * What goes wrong if it is wrong, first:
 * - the pin missing from LaunchSettings: decide() compares what the CLI was
 *   launched with to the record, finds them equal, and never restarts it;
 * - an agent that never had a pin seen as changed: every agent would restart
 *   once the option exists.
 */
import '../../setup/home-guard';
import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, BrowserWindow: vi.fn(), Notification: vi.fn() }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { launchSettings, changedLaunchSettings } from '../../../electron/core/agent-restart';
import type { AgentStatus } from '../../../electron/types';

const base = { id: 'a1', status: 'idle', projectPath: '/p', skills: [], output: [], lastActivity: '' } as unknown as AgentStatus;

describe("the pinned account among an agent's launch settings", () => {
  it('is there, and a change to it is a change', () => {
    const before = launchSettings(base);
    const after = launchSettings({ ...base, claudeAccountPin: 'acct-aaaaaa' });
    expect(after.claudeAccount).toBe('acct-aaaaaa');
    expect(changedLaunchSettings(before, after)).toEqual(['claudeAccount']);
    expect(changedLaunchSettings(after, launchSettings({ ...base, claudeAccountPin: 'acct-bbbbbb' }))).toEqual(['claudeAccount']);
  });

  it('is absent for an agent that never had one, so nothing reads as changed', () => {
    expect(JSON.stringify(launchSettings(base))).not.toContain('claudeAccount');
    expect(changedLaunchSettings(launchSettings(base), launchSettings({ ...base }))).toEqual([]);
  });
});
