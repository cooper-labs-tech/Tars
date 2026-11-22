import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Where a Cline agent's own folder is, and that it goes with the agent (the Audit's M1 on #620).
 *
 * Each Cline agent runs on a folder of its own: its `--config` (Tars's hooks), its `--data-dir` (a copy of the user's
 * provider file, their key in it; its MCP settings; its sessions), named to its hooks as CLINE_DATA_DIR. It was
 * `~/.tars-private/cline/<id>`, while four places say nothing under `~/.tars-private` is ever passed to a CLI:
 * CLAUDE.md, constants/index.ts, utils/handed-folder.ts and SECURITY.md. With `--auto-approve true` Cline's tools read
 * whatever is there without asking. It is now in Tars's own userData, `<userData>/cline/<id>`, as the state mod's copy
 * that CLAUDE_CODE_PLUGIN_DIRS names: neither `~/.tars` (every agent is handed it) nor `~/.tars-private` (no CLI is).
 *
 * How it fails, written before the code:
 * 1. The folder, on the command line (`--config`, `--data-dir`) or in the terminal's environment (CLINE_DATA_DIR),
 *    is under `~/.tars-private`, or under `~/.tars`, which every agent is handed.
 * 2. It is a folder the handed-folder guard refuses (handedFolderProblem): inside `~/.tars-private`, or holding it.
 * 3. A removed agent's folder stays, with its copy of the user's provider key and its sessions.
 * 4. A removal takes more than that agent's folder: another agent's, the folder of them all, or anything outside it
 *    for an id that is no agent id.
 * 5. A folder that cannot be removed (its rights, a file held open on Windows) stops the agent's removal: it is said,
 *    and the agent goes all the same.
 */

const h = vi.hoisted(() => ({ userData: '' }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? h.userData : os.tmpdir()) },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.setConfig({ testTimeout: 20_000 });

import { ClineProvider } from '../../../electron/providers/cline-provider';
import { clineAgentDir } from '../../../electron/providers/cline-cli';
import { removeAgent } from '../../../electron/core/agent-remove';
import { agents } from '../../../electron/core/agent-manager';
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';
import { handedFolderProblem } from '../../../electron/utils/handed-folder';
import type { AgentStatus } from '../../../electron/types';

const ID = 'a1b2c3d4-0000-4000-8000-0000000000c1';
const OTHER = 'a1b2c3d4-0000-4000-8000-0000000000c2';

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const words = (command: string) => [...command.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]);
const flag = (command: string, name: string) => {
  const w = words(command);
  return w[w.indexOf(name) + 1];
};

function usersProvider(): void {
  const settings = path.join(os.homedir(), '.cline', 'data', 'settings');
  fs.mkdirSync(settings, { recursive: true });
  fs.writeFileSync(path.join(settings, 'providers.json'), JSON.stringify({ version: 1, providers: { anthropic: { settings: { apiKey: 'sk-users-own' } } } }));
}

function launch(agentId: string): string {
  return new ClineProvider().buildInteractiveCommand({ binaryPath: 'cline', agentId, permissionMode: 'normal' } as Parameters<ClineProvider['buildInteractiveCommand']>[0]);
}

function member(id: string): AgentStatus {
  const agent = { id, name: `Cline ${id.slice(-2)}`, status: 'idle', provider: 'cline', projectPath: os.tmpdir(), skills: [], output: [], lastActivity: '2026-11-21T00:00:00.000Z' } as unknown as AgentStatus;
  agents.set(id, agent);
  return agent;
}

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-userdata-'));
  usersProvider();
  agents.clear();
});
afterEach(() => {
  agents.clear();
  vi.restoreAllMocks();
});

describe("a Cline agent's own folder", () => {
  it('1, 2. is in Tars\'s userData, on the command line and in the environment: never under ~/.tars-private or ~/.tars', () => {
    const command = launch(ID);
    const env = new ClineProvider().getPtyEnvVars(ID, os.tmpdir(), []);
    const named = { config: flag(command, '--config'), data: flag(command, '--data-dir'), env: env.CLINE_DATA_DIR };
    for (const [what, dir] of Object.entries(named)) {
      expect(inside(dir, path.join(h.userData, 'cline', ID)), `${what}: ${dir}`).toBe(true);
      expect(inside(dir, PRIVATE_DIR), `${what} is under ~/.tars-private, which no CLI is handed`).toBe(false);
      expect(inside(dir, DATA_DIR), `${what} is under ~/.tars, which every agent is handed`).toBe(false);
      expect(handedFolderProblem(dir), what).toBeNull();
    }
    expect(fs.existsSync(path.join(named.data, 'settings', 'providers.json'))).toBe(true);
    expect(fs.existsSync(path.join(PRIVATE_DIR, 'cline'))).toBe(false);
  });

  it('3, 4. goes when its agent is removed, and nothing else does', async () => {
    launch(ID);
    launch(OTHER);
    member(ID);
    const sibling = path.join(h.userData, 'kept.txt');
    fs.writeFileSync(sibling, 'not a Cline folder');

    expect((await removeAgent(ID)).success).toBe(true);

    expect(fs.existsSync(clineAgentDir(ID)), 'the removed agent\'s folder, with its copy of the user\'s key, stayed').toBe(false);
    expect(fs.existsSync(path.join(clineAgentDir(OTHER), 'data', 'settings', 'providers.json')), 'another agent\'s folder went').toBe(true);
    expect(fs.existsSync(sibling)).toBe(true);
  });

  it('4. an id that is no agent id makes no folder and removes nothing', async () => {
    launch(OTHER);
    expect(() => clineAgentDir('../x')).toThrow();
    expect(() => clineAgentDir('..')).toThrow();
    member('..');
    expect((await removeAgent('..')).success).toBe(true);
    expect(fs.existsSync(path.join(h.userData, 'cline', OTHER))).toBe(true);
    expect(fs.existsSync(h.userData)).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('5. one that cannot be removed is said, and the agent goes all the same', async () => {
    launch(ID);
    member(ID);
    const root = path.join(h.userData, 'cline');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.chmodSync(root, 0o500);
    try {
      expect((await removeAgent(ID)).success).toBe(true);
    } finally {
      fs.chmodSync(root, 0o700);
    }
    expect(agents.has(ID)).toBe(false);
    expect(warn.mock.calls.map((c) => c.map(String).join(' ')).some((line) => line.includes(ID) && /Cline/.test(line))).toBe(true);
  });
});
