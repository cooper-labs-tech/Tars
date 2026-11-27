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
 *  8. A folder edited by hand into agents.json or templates.json holds control characters (ESC, BEL, CR, LF, a C1 CSI,
 *     DEL): every save path refuses it, a direct edit does not. Printed as they are, they clear the screen, move the
 *     cursor over an earlier line, set the title, or start a forged [Tars] line, in the agent's terminal, its kept
 *     output and what get_agent_output hands an orchestrator (the Audit's L1 at e70cae532). The same in the template's
 *     log line, its name too.
 *
 * The negative witness is #666 at 8e8b81c8c, which only logs; for 8, #666 at e70cae532, which prints the folder raw.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '0.0.0', on: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<Record<string, unknown>>) => { handlers.set(channel, handler); } },
}));
const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => Promise<Record<string, unknown>>>());
const broadcasts = vi.hoisted(() => [] as Array<{ channel: string; payload: Record<string, unknown> }>);
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: Record<string, unknown>) => { broadcasts.push({ channel, payload }); },
}));

import { foldersLeftOut, sayFoldersLeftOut } from '../../../electron/core/folders-left-out';
import { replayText } from '../../../electron/core/terminal-mirror';
import { agents, initAgentPty, launchIntoTerminal } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { toLaunch } from '../../../electron/platform/launch';
import { registerTemplateHandlers } from '../../../electron/handlers/template-handlers';
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

/**
 * 7. A template saved before the rule, with a folder Tars no longer hands: an agent made from it gets the line at each
 *    start (2); the template itself, as it is loaded, says nothing anywhere. Until the window has a place for it, the
 *    same sentence goes to the log as the template is loaded, once per folder, not at every listing.
 */
describe('7. a template loaded with such a folder', () => {
  it('says the same sentence as it is loaded, once', async () => {
    fs.mkdirSync(path.join(home(), '.tars'), { recursive: true });
    fs.writeFileSync(path.join(home(), '.tars', 'templates.json'), JSON.stringify({
      user: [{ id: 'tpl-keys', displayName: 'Keys', provider: 'claude', obsidianVaultPaths: [docker], createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }],
      overrides: {},
    }));
    handlers.clear();
    registerTemplateHandlers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handlers.get('template:list')!({});
    await handlers.get('template:list')!({});
    const said = warn.mock.calls.map(c => c.join(' ')).filter(l => l.includes(docker));
    warn.mockRestore();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/Keys/);
    expect(said[0]).toMatch(/credentials/);
  });
});

/**
 * 8. The Audit's path: under ~/.ssh, holding a title (OSC 0), a cleared screen, a line end and a forged line, a C1 CSI
 *    moving the cursor up, and DEL. Measured on the headless xterm Tars mirrors with: each acts as it would in a panel.
 */
const FORGED = 'x\u{1b}]0;forged\u{7}\u{1b}[2J\r\n[Tars] Forged line\u{9b}1A\u{7f}';
const controls = (s: string) => Array.from(s).filter((ch) => {
  const c = ch.codePointAt(0)!;
  return c < 0x20 || (c >= 0x7f && c <= 0x9f);
});
const windows = process.platform === 'win32';

describe('8. a saved folder holding control characters', () => {
  it('is said as one line with none of them, each written out as [U+XXXX]', () => {
    const lines = foldersLeftOut(agent({ secondaryProjectPath: path.join(ssh, FORGED) }));
    expect(lines).toHaveLength(1);
    expect(controls(lines[0])).toEqual([]);
    expect(lines[0]).toContain('x[U+001B]]0;forged[U+0007][U+001B][2J[U+000A][Tars] Forged line[U+009B]1A[U+007F]');
    expect(lines[0]).toMatch(/credentials/);
  });

  it('leaves the terminal as it was: the earlier output stays, and the forged line stays inside the one [Tars] line', () => {
    const a = agent({ secondaryProjectPath: path.join(ssh, FORGED), output: ['earlier line\r\n'] });
    sayFoldersLeftOut(a, { onData: vi.fn(), onExit: vi.fn() } as never, 'pty-forged');
    const told = broadcasts.filter(b => b.channel === 'agent:output' && b.payload.agentId === a.id).map(b => String(b.payload.data));
    expect(told).toHaveLength(1);
    // What a panel opened later replays (the kept output), and what an open panel was sent.
    for (const chunks of [a.output, ['earlier line\r\n', ...told]]) {
      const rows = replayText(chunks, { cols: 400, rows: 20 })!;
      expect(rows).toContain('earlier line');
      expect(rows.filter(r => r.startsWith('[Tars]'))).toHaveLength(1);
      expect(rows.join('\n')).toContain('[U+000A][Tars] Forged line');
    }
  });

  // A template folder is said only when it exists, and NTFS refuses these characters in a name: none on Windows.
  it.skipIf(windows)('a template folder the same', () => {
    const vault = path.join(docker, FORGED);
    fs.mkdirSync(vault, { recursive: true });
    const lines = foldersLeftOut(agent({ obsidianVaultPaths: [vault] }));
    expect(lines).toHaveLength(1);
    expect(controls(lines[0])).toEqual([]);
    expect(lines[0]).toContain('[U+009B]1A[U+007F]');
  });

  it.skipIf(windows)('the template\'s log line the same, its name too', async () => {
    const vault = path.join(docker, `t${FORGED}`);
    fs.mkdirSync(vault, { recursive: true });
    fs.mkdirSync(path.join(home(), '.tars'), { recursive: true });
    fs.writeFileSync(path.join(home(), '.tars', 'templates.json'), JSON.stringify({
      user: [{ id: 'tpl-forged', displayName: 'K\u{1b}[2Jeys', provider: 'claude', obsidianVaultPaths: [vault], createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }],
      overrides: {},
    }));
    handlers.clear();
    registerTemplateHandlers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handlers.get('template:list')!({});
    const said = warn.mock.calls.map(c => c.join(' ')).filter(l => l.includes('Forged line'));
    warn.mockRestore();
    expect(said).toHaveLength(1);
    expect(controls(said[0])).toEqual([]);
    expect(said[0]).toContain('K[U+001B][2Jeys');
    expect(said[0]).toContain('[U+009B]1A[U+007F]');
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
