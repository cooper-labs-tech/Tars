import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * An agent stored in plan on a CLI without a plan mode (the Audit's L1 on #640). The API's create took plan for any
 * provider until 1a92454f8 (13/10), so such an agent can be in agents.json today. Its CLI reads plan as normal: every
 * start that names no mode (the window's, a restart, a wake, the bots, /run-task, /message) runs it with every write
 * tool, with no word said, while a /dispatch that names plan for it is refused (2.0.7).
 *
 * How it fails, written before the code (24/11):
 * L1. Read back from agents.json, it is still in plan: the window shows plan chosen, which is not what runs.
 * L2. It is set right in memory and not written: the next load reads plan again, and so does any reader of the file.
 * L3. It is changed with no word in the log.
 * L4. A provider that has a plan mode (Claude Code, Qwen Code, and no provider, which is Claude Code) loses it, or
 *     another mode on a CLI without plan is changed.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-plan-on-load-'));
const AGENTS_FILE = path.join(tmp, 'agents.json');

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE };
});

vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => tmp, getVersion: () => '2.0.7' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

let manager: typeof import('../../../electron/core/agent-manager');

const agent = (id: string, provider: string | undefined, permissionMode: string) => ({
  id, name: `Agent ${id}`, status: 'idle', projectPath: tmp, output: [], skills: [],
  lastActivity: '2026-10-12T08:00:00.000Z', createdAt: '2026-10-12T08:00:00.000Z',
  ...(provider ? { provider } : {}), permissionMode,
});

const seed = (list: unknown[]) => fs.writeFileSync(AGENTS_FILE, JSON.stringify({ version: 4, savedAt: '2026-10-12T08:00:00.000Z', agents: list }, null, 2));
const onDisk = () => (JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8')) as { agents: Array<{ id: string; permissionMode?: string }> }).agents;

beforeEach(async () => {
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
  vi.resetModules();
  manager = await import('../../../electron/core/agent-manager');
});

afterEach(() => {
  manager.stopAgentAutosave();
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('an agent stored in plan on a CLI without a plan mode', () => {
  it('L1, L2, L3. is read back in normal, the mode it runs in, written so, and said once in the log', () => {
    seed([agent('cx', 'codex', 'plan'), agent('gm', 'opencode', 'plan')]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    manager.loadAgents();
    expect(manager.agents.get('cx')?.permissionMode).toBe('normal');
    expect(manager.agents.get('gm')?.permissionMode).toBe('normal');
    expect(onDisk().find(a => a.id === 'cx')?.permissionMode).toBe('normal');
    expect(onDisk().find(a => a.id === 'gm')?.permissionMode).toBe('normal');
    const said = warn.mock.calls.map(c => String(c[0])).filter(l => /plan/i.test(l));
    expect(said.filter(l => l.includes('Agent cx'))).toHaveLength(1);
    expect(said.filter(l => l.includes('Agent gm'))).toHaveLength(1);
    // The next load reads what was written: nothing more to change, nothing more said.
    warn.mockClear();
    manager.agents.clear();
    manager.loadAgents();
    expect(manager.agents.get('cx')?.permissionMode).toBe('normal');
    expect(warn.mock.calls.map(c => String(c[0])).filter(l => /plan/i.test(l))).toEqual([]);
  });

  it('L4. plan stays on a CLI that has one, and another mode stays on one that has none', () => {
    seed([agent('cl', 'claude', 'plan'), agent('qw', 'qwen-code', 'plan'), agent('none', undefined, 'plan'), agent('ca', 'codex', 'auto')]);
    manager.loadAgents();
    expect(manager.agents.get('cl')?.permissionMode).toBe('plan');
    expect(manager.agents.get('qw')?.permissionMode).toBe('plan');
    expect(manager.agents.get('none')?.permissionMode).toBe('plan');
    expect(manager.agents.get('ca')?.permissionMode).toBe('auto');
  });
});
