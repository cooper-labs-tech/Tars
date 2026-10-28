import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A project is named by its folder in what the bots say, whatever the
 * platform spells its path with (audit B/J-01).
 *
 * Each of these took `projectPath.split('/').pop()`: on Windows every
 * project was named by its whole path, `C:\Users\x\projects\atlas`, in
 * Telegram's and Slack's fleet lists and the /projects reply of all three
 * bots. The unit is platform/project-name.ts; this drives the exported sites
 * with a path the host spells natively.
 *
 * How it can fail, written before the fix:
 * 1. The projects report (Telegram, Slack, Discord /projects) names a project
 *    by its path.
 * 2. Telegram's agent status and Slack's agent status name its project by the
 *    path.
 * 3. win32: a path with a trailing separator is named 'Unknown' (or not at
 *    all) where its folder is meant.
 * 4. darwin/linux: any of it changes from `split('/').pop()`, a trailing `/`
 *    included, which still names nothing ('Unknown' in the report).
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => os.homedir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.8.0' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: Object.assign(vi.fn(), { isSupported: () => false }),
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { projectsReport } from '../../../electron/services/bot-core';
import { formatSlackAgentStatus } from '../../../electron/utils';
import { agents } from '../../../electron/core/agent-manager';
import type { AgentStatus } from '../../../electron/types';

// Spelled the host's way: `C:\...\atlas` on Windows, `/.../atlas` elsewhere.
const ATLAS = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-names-')), 'projects', 'atlas');
const ORION_TRAILING = path.join(path.dirname(ATLAS), 'orion') + path.sep;

function agent(id: string, projectPath: string): AgentStatus {
  return {
    id, name: id, status: 'idle', provider: 'claude', projectPath, skills: [], output: [],
    lastActivity: new Date().toISOString(), character: 'robot',
  } as AgentStatus;
}

beforeEach(() => {
  agents.clear();
});

const onWindows = process.platform === 'win32';

describe('a project is named by its folder', () => {
  it('1, 3, 4. in the projects report of the three bots', () => {
    const fleet = new Map([['a1', agent('a1', ATLAS)], ['a2', agent('a2', ORION_TRAILING)]]);
    const report = projectsReport(fleet, {
      title: 'Projects\n', folder: 'F', indent: '  ', people: 'P', face: () => '', dot: { running: 'r', waiting: 'w', error: 'e', idle: 'i' },
    })!;

    expect(report).toContain('F *atlas*\n');
    expect(report).toContain(onWindows ? 'F *orion*\n' : 'F *Unknown*\n');
  });

  it('2, 3, 4. in Slack\'s agent status (Telegram\'s went with its bot in 2.0.5)', () => {
    expect(formatSlackAgentStatus(agent('a1', ATLAS))).toContain(':file_folder: `atlas`');
    expect(formatSlackAgentStatus(agent('a2', ORION_TRAILING))).toContain(onWindows ? ':file_folder: `orion`' : ':file_folder: `Unknown`');
  });
});
