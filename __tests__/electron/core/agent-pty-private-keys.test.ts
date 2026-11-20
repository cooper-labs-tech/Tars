import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * An agent's terminal gets its key from where the keys are since 2.0.4,
 * ~/.tars-private/settings-secrets.json (services/settings-secrets.ts).
 *
 * Every way it can fail, written before the code (2026-10-18, found by
 * secrets-private.spec.ts, red on the code before this):
 *  T1. initAgentPty builds the terminal's environment from app-settings.json
 *      alone, which holds no key since 2.0.4: a codex agent starts without
 *      CODEX_API_KEY, a key provider's agent without its key.
 *  T2. A key still in app-settings.json (an older Tars wrote it since) is not
 *      the one handed.
 */

const spawnCalls: Array<{ env: Record<string, string> }> = [];

vi.mock('node-pty', () => ({
  spawn: vi.fn((_shell: string, _args: string[], opts: { env: Record<string, string> }) => {
    spawnCalls.push({ env: opts.env });
    return { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn(), pid: 1, resize: vi.fn() };
  }),
}));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'test-uuid') }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: vi.fn(),
  Notification: vi.fn(),
}));
// Reached during a spawn; none of it is what these tests are about.
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/utils/agents-tick', () => ({ scheduleTick: vi.fn() }));
vi.mock('../../../electron/services/agent-events', () => ({ emitAgentStatus: vi.fn() }));
vi.mock('../../../electron/services/tasmania-client', () => ({
  getTasmaniaStatus: vi.fn(async () => ({ status: 'stopped' })),
}));
vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { initAgentPty, agents } from '../../../electron/core/agent-manager';
import { saveSettingsSplit } from '../../../electron/services/settings-secrets';
import { APP_SETTINGS_FILE } from '../../../electron/constants';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-private-keys-cwd-'));
const agent = (id: string, provider: string) => ({
  id, status: 'idle', provider, projectPath: cwd, skills: [], output: [], lastActivity: new Date().toISOString(),
} as unknown as AgentStatus);

beforeEach(() => {
  spawnCalls.length = 0;
  agents.clear();
});

describe('an agent\'s terminal and the keys in ~/.tars-private', () => {
  it('T1. a codex agent gets its CLI\'s key, a deepseek agent its provider\'s', async () => {
    saveSettingsSplit({ codexEnabled: true, deepSeekEnabled: true, deepSeekApiKey: 'ds-private-1', cliApiKeys: { codex: { key: 'cx-private-2' } } } as unknown as AppSettings);
    expect(fs.readFileSync(APP_SETTINGS_FILE, 'utf8')).not.toMatch(/private-[12]/);
    await initAgentPty(agent('cx', 'codex'), null, vi.fn(), vi.fn());
    await initAgentPty(agent('ds', 'deepseek'), null, vi.fn(), vi.fn());
    expect(spawnCalls[0].env.CODEX_API_KEY).toBe('cx-private-2');
    expect(Object.values(spawnCalls[1].env)).toContain('ds-private-1');
  });

  it('T2. a key an older Tars wrote into app-settings.json since is the one handed', async () => {
    saveSettingsSplit({ deepSeekEnabled: true, deepSeekApiKey: 'ds-private-1' } as unknown as AppSettings);
    const plain = JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf8'));
    fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify({ ...plain, deepSeekApiKey: 'ds-newer-3' }));
    await initAgentPty(agent('ds', 'deepseek'), null, vi.fn(), vi.fn());
    expect(Object.values(spawnCalls[0].env)).toContain('ds-newer-3');
  });
});
