import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A folder an agent was saved with, and Tars no longer hands, is said in the agent's own terminal before its CLI
 * starts (27/11, the Audit's M1 on #666).
 *
 * A secondary folder or a template folder saved before the rule (~/.claude/skills, ~/.config, ~/.docker...) is left
 * off the launch line by handedSecondaryFolder. It was said only in the main process's log: the agent modal does not
 * send these folders on save, the agent dialog still shows the folder as the agent's, and the CLI simply no longer
 * had it.
 *
 * How it fails, written before the code:
 *  1. A saved secondary folder Tars no longer hands is left out with no line in the agent's terminal, only the log.
 *  2. The same for a template folder (made from a template before the rule).
 *  3. A CLI whose line hands such a folder gets no line: claude, codex, gemini, Qwen Code (Kimi Code's provider comes
 *     with the harness adapters, under its id); or a CLI that never hands one (opencode, pi, amp, grok, the thirteen
 *     API-key providers for the secondary folder) is told about a folder it was never going to get.
 *  4. The line does not say which folder, why, or where to change it; it is more than one line; it lists what the
 *     folder holds.
 *  5. The line comes after the CLI's line is typed, where the CLI's own screen hides it.
 *  6. Over-notice: a folder that is handed, no folder, or a template folder that does not exist (left out for that,
 *     not refused) prints a line.
 *
 * The negative witness is #666 at 8e8b81c8c, which only logs.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '0.0.0', on: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
const broadcasts = vi.hoisted(() => [] as Array<{ channel: string; payload: Record<string, unknown> }>);
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: Record<string, unknown>) => { broadcasts.push({ channel, payload }); },
}));

import { foldersLeftOut } from '../../../electron/core/folders-left-out';
import { agents, initAgentPty, launchIntoTerminal } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { toLaunch } from '../../../electron/platform/launch';
import type { AgentStatus } from '../../../electron/types';

const home = () => os.homedir();
let project: string;
let ssh: string;
let docker: string;
let fine: string;

beforeEach(() => {
  broadcasts.length = 0;
  project = fs.mkdtempSync(path.join(home(), 'project-'));
  ssh = path.join(home(), '.ssh');
  docker = path.join(home(), '.docker');
  fine = fs.mkdtempSync(path.join(home(), 'notes-'));
  for (const d of [ssh, docker]) fs.mkdirSync(d, { recursive: true });
});

const agent = (over: Partial<AgentStatus> = {}) => ({
  id: `ag-${Math.random().toString(16).slice(2, 8)}`, status: 'idle', projectPath: project, skills: [], output: [], lastActivity: '', provider: 'claude', ...over,
}) as AgentStatus;

describe('the folders an agent was saved with that its line leaves out', () => {
  it('1 and 4. a secondary folder: one line, the folder, why, and where to change it', () => {
    const lines = foldersLeftOut(agent({ secondaryProjectPath: ssh }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/\n/);
    expect(lines[0]).toContain(ssh);
    expect(lines[0]).toMatch(/credentials/);
    expect(lines[0]).toMatch(/secondary folder in its settings/);
    expect(lines[0]).not.toMatch(/id_rsa|known_hosts|key file/i);
  });

  it('2. a template folder, with where to change it', () => {
    const lines = foldersLeftOut(agent({ obsidianVaultPaths: [fine, docker] }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(docker);
    expect(lines[0]).toMatch(/template/);
  });

  it.each(['claude', 'codex', 'gemini', 'qwen-code', 'kimi-code'])('3. %s, whose line hands such folders, is told', (provider) => {
    expect(foldersLeftOut(agent({ provider: provider as AgentStatus['provider'], secondaryProjectPath: ssh }))).toHaveLength(1);
  });

  it.each(['opencode', 'pi', 'amp', 'grok', 'deepseek', 'openrouter'])('3. %s, whose line never hands one, is told nothing', (provider) => {
    expect(foldersLeftOut(agent({ provider: provider as AgentStatus['provider'], secondaryProjectPath: ssh, obsidianVaultPaths: [docker] }))).toEqual([]);
  });

  it('6. a folder that is handed, no folder, or a template folder that does not exist: nothing', () => {
    expect(foldersLeftOut(agent({ secondaryProjectPath: fine, obsidianVaultPaths: [fine] }))).toEqual([]);
    expect(foldersLeftOut(agent())).toEqual([]);
    expect(foldersLeftOut(agent({ obsidianVaultPaths: [path.join(home(), 'no-such-vault')] }))).toEqual([]);
  });
});

describe('5. said in the agent\'s terminal before its line is typed', () => {
  it('the line reaches the terminal\'s output and the window, before the CLI\'s line', async () => {
    const a = agent({ secondaryProjectPath: ssh });
    agents.set(a.id, a);
    a.ptyId = 'pty-left-out';
    let outputWhenTyped = '';
    const terminal = {
      pid: 4343, process: 'bash',
      write: vi.fn(() => { if (!outputWhenTyped) outputWhenTyped = a.output.join(''); }),
      kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn(),
    };
    const launch = toLaunch(`'/opt/cli/bin/claude' --add-dir '${fine}'`, project, process.env);
    // Windows types no line into a shell: its CLI replaces the shell, and says the line when it is spawned.
    if (launch.platform === 'win32') return;
    await launchIntoTerminal(a, terminal as never, launch, { ptyProcesses, initAgentPty });
    expect(outputWhenTyped).toContain(ssh);
    expect(outputWhenTyped).toMatch(/\[Tars\]/);
    const told = broadcasts.filter(b => b.channel === 'agent:output' && b.payload.agentId === a.id).map(b => String(b.payload.data)).join('');
    expect(told).toContain(ssh);
    agents.delete(a.id);
  });
});
