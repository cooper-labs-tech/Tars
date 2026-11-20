import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A key set or cleared reaches a terminal whose shell is reused (the Audit's
 * L1 on #459). A start runs in the agent's existing shell when its CLI exited
 * on its own, and that shell's environment is the one it was spawned with.
 *
 * Every way it can fail, written before the code (2026-10-18):
 *  S1. A codex key set after the shell was spawned: the start builds codex's
 *      `-c model_provider=tars-key`, but CODEX_API_KEY is not in that shell,
 *      and codex refuses to start where it would have used its login.
 *  S2. A key cleared, or changed, stays in that shell's environment.
 *  S3. A shell whose keys still match is killed anyway, and every start of
 *      a CLI without a key of Tars's (claude) loses its terminal.
 */

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getAppPath: () => process.cwd() }, BrowserWindow: { getAllWindows: () => [] } }));
const killed = vi.hoisted(() => [] as unknown[]);
vi.mock('../../../electron/core/pty-kill', async (original) => ({
  ...(await original<typeof import('../../../electron/core/pty-kill')>()),
  killPty: (p: unknown) => { killed.push(p); },
}));

import { agents, killStalePty, notePtyKeys } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { withCliKey } from '../../../electron/services/cli-keys';
import { DATA_DIR } from '../../../electron/constants';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const settingsFile = path.join(DATA_DIR, 'app-settings.json');
const saveSettings = (s: Partial<AppSettings>) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(s)); };
const withKey = (s: Partial<AppSettings>, cli: 'codex' | 'gemini', key: string | null) => {
  const r = withCliKey(s as AppSettings, cli, { key });
  if (!r.ok) throw new Error(r.error);
  return r.settings;
};

function agentWithShell(id: string, provider: string, spawnedWith: Partial<AppSettings>): AgentStatus {
  const pty = { pid: 1, kill: vi.fn() };
  ptyProcesses.set(`pty-${id}`, pty as never);
  const agent = { id, provider, projectPath: '/p', ptyId: `pty-${id}`, ptyCwd: '/p', status: 'idle', skills: [], output: [] } as unknown as AgentStatus;
  agents.set(id, agent);
  notePtyKeys(pty as never, agent, spawnedWith as AppSettings);
  return agent;
}

beforeEach(() => {
  killed.length = 0;
  agents.clear();
  ptyProcesses.clear();
  saveSettings({});
});

describe('a reused shell and the keys it was spawned with', () => {
  it('S1. a key set since the shell was spawned: the shell goes, and the start opens one with it', () => {
    const agent = agentWithShell('cx', 'codex', {});
    saveSettings(withKey({}, 'codex', 'k-new'));
    expect(killStalePty(agent)).toBe(true);
    expect(agent.ptyId).toBeUndefined();
    expect(killed).toHaveLength(1);
  });

  it('S2. a key cleared or changed since: the shell goes', () => {
    const spawned = withKey({}, 'codex', 'k-old');
    const cleared = agentWithShell('cx', 'codex', spawned);
    saveSettings({});
    expect(killStalePty(cleared)).toBe(true);
    const changed = agentWithShell('gm', 'gemini', withKey({}, 'gemini', 'g-old'));
    saveSettings(withKey({}, 'gemini', 'g-new'));
    expect(killStalePty(changed)).toBe(true);
  });

  it('S3. a shell whose keys match stays, and so does a claude agent\'s, whatever the keys of the other CLIs', () => {
    const same = withKey({}, 'codex', 'k-1');
    const cx = agentWithShell('cx', 'codex', same);
    saveSettings(same);
    expect(killStalePty(cx)).toBe(false);
    const cl = agentWithShell('cl', 'claude', {});
    saveSettings(withKey(same, 'gemini', 'g-1'));
    expect(killStalePty(cl)).toBe(false);
    // A gemini key changing leaves codex's shell alone too.
    expect(killStalePty(cx)).toBe(false);
    expect(killed).toHaveLength(0);
  });
});
