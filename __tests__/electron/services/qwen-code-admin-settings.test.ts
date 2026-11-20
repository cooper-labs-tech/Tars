import '../../setup/home-guard';
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Tars's settings file for a Qwen Code agent and the administrator's (the
 * Audit's M1 on #461). Tars points QWEN_CODE_SYSTEM_SETTINGS_PATH at a file of
 * its own for each agent (its hooks, its MCP servers, the agent's effort). That
 * variable names qwen's system settings slot, which qwen 0.25.2's own docs give
 * as /Library/Application Support/QwenCode/settings.json, /etc/qwen-code/
 * settings.json or C:\ProgramData\qwen-code\settings.json: the file through
 * which an administrator enforces controls (a tool denylist, disabled slash
 * commands, fixed MCP servers) over the user's and the project's settings.
 * Pointing the slot elsewhere dropped them without a word.
 *
 * Every way it can fail, written before the code (2026-10-18):
 *  A1. An administrator's file exists, and the agent's file of Tars's carries
 *      none of its controls.
 *  A2. Their keys are merged, but Tars's win: an administrator's value is
 *      replaced by Tars's (the updater, an MCP server of the same name).
 *  A3. The administrator's hooks replace Tars's, or Tars's theirs: both must
 *      run (a hook is a list, and both lists are kept).
 *  A4. The administrator's file is read once: a change to it misses the next
 *      launch.
 *  A5. An administrator's file that cannot be read (broken, a folder) is
 *      ignored and the agent starts without its controls; it must be refused,
 *      with why.
 *  A6. The administrator's file is looked for where qwen does not look: the
 *      platform's default, or QWEN_CODE_SYSTEM_SETTINGS_PATH when the user's
 *      environment sets it, unless that names one of Tars's own files.
 *  A7. Over-correction: without an administrator's file, the agent's file is
 *      not what it was.
 *  A8. (The Audit's re-check at 4804a90f, written before its code.) Joining
 *      lists widens an administrator's allowlist (tools.allowed, tools.core,
 *      mcp.allowed) the day Tars writes the same key: only hooks are joined,
 *      every other list is the administrator's alone.
 */

import { qwenSystemSettingsFile, writeQwenAgentSettings, saveQwenHooks, setQwenMcpServer, underAdministrator } from '../../../electron/services/qwen-code';

let dataDir: string;
let admin: string;
const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

const ADMIN = {
  permissions: { deny: ['run_shell_command(rm -rf *)'] },
  slashCommands: { disabled: ['mcp'] },
  tools: { disabled: ['web_fetch'] },
  mcpServers: { 'company-docs': { command: 'docs-server', args: ['--ro'] }, 'claude-mgr-orchestrator': { command: 'admin-pinned', args: [] } },
  general: { enableAutoUpdate: true },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'audit-log stop' }] }] },
};

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-admin-'));
  dataDir = path.join(root, 'qwen-code');
  admin = path.join(root, 'system', 'settings.json');
  saveQwenHooks('/opt/tars/hooks', 'darwin', dataDir);
  setQwenMcpServer('claude-mgr-orchestrator', { command: '/bin/node', args: ['/r/mcp-orchestrator/dist/bundle.js'] }, dataDir);
});

describe('an agent of Qwen Code, and the administrator\'s system settings', () => {
  it('A1, A2. keeps every control of the administrator\'s, their values winning', () => {
    write(admin, ADMIN);
    const s = read(writeQwenAgentSettings('a1', { effort: 'high', systemFile: admin }, dataDir));
    expect(s.permissions).toEqual(ADMIN.permissions);
    expect(s.slashCommands).toEqual(ADMIN.slashCommands);
    expect(s.tools).toEqual(ADMIN.tools);
    expect(s.mcpServers['company-docs']).toEqual(ADMIN.mcpServers['company-docs']);
    expect(s.mcpServers['claude-mgr-orchestrator'], 'a server of the administrator\'s name is theirs, whole').toEqual({ command: 'admin-pinned', args: [] });
    expect(s.general.enableAutoUpdate).toBe(true);
    expect(s.model).toEqual({ reasoningEffort: 'high' });
  });

  it('A3. runs the administrator\'s hooks and Tars\'s', () => {
    write(admin, ADMIN);
    const s = read(writeQwenAgentSettings('a1', { systemFile: admin }, dataDir));
    const stops = JSON.stringify(s.hooks.Stop);
    expect(stops).toContain('audit-log stop');
    expect(stops).toContain('/opt/tars/hooks');
    expect(Object.keys(s.hooks)).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'Stop']));
  });

  it('A4. reads the administrator\'s file again at each launch', () => {
    write(admin, ADMIN);
    writeQwenAgentSettings('a1', { systemFile: admin }, dataDir);
    write(admin, { ...ADMIN, permissions: { deny: ['web_fetch'] } });
    expect(read(writeQwenAgentSettings('a1', { systemFile: admin }, dataDir)).permissions).toEqual({ deny: ['web_fetch'] });
  });

  it('A5. refuses to start the agent on an administrator\'s file it cannot read, and says which and why', () => {
    write(admin, '{ broken');
    expect(() => writeQwenAgentSettings('a1', { systemFile: admin }, dataDir)).toThrow(new RegExp(`${admin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*administrator`));
    fs.rmSync(admin);
    fs.mkdirSync(admin);
    expect(() => writeQwenAgentSettings('a1', { systemFile: admin }, dataDir)).toThrow(/administrator/);
  });

  it('A6. looks where qwen looks: the platform\'s default, or the user\'s own QWEN_CODE_SYSTEM_SETTINGS_PATH', () => {
    expect(qwenSystemSettingsFile('darwin', {})).toBe('/Library/Application Support/QwenCode/settings.json');
    expect(qwenSystemSettingsFile('linux', {})).toBe('/etc/qwen-code/settings.json');
    expect(qwenSystemSettingsFile('win32', {})).toBe('C:\\ProgramData\\qwen-code\\settings.json');
    expect(qwenSystemSettingsFile('linux', { QWEN_CODE_SYSTEM_SETTINGS_PATH: '/srv/qwen/admin.json' })).toBe('/srv/qwen/admin.json');
    // Tars run from a Qwen Code agent's terminal inherits its own file's path: not an administrator's.
    const tars = writeQwenAgentSettings('a1', { systemFile: admin }, dataDir);
    expect(qwenSystemSettingsFile('linux', { QWEN_CODE_SYSTEM_SETTINGS_PATH: tars }, dataDir)).toBe('/etc/qwen-code/settings.json');
  });

  it('A7. without an administrator\'s file, the agent\'s file is Tars\'s alone', () => {
    const s = read(writeQwenAgentSettings('a1', { effort: 'low', systemFile: admin }, dataDir));
    expect(Object.keys(s).sort()).toEqual(['general', 'hooks', 'mcpServers', 'model']);
    expect(s.general).toEqual({ enableAutoUpdate: false });
    expect(Object.keys(s.mcpServers)).toEqual(['claude-mgr-orchestrator']);
  });

  it('A8. joins hooks and nothing else: an administrator\'s list is never widened by Tars\'s', () => {
    const tars = { hooks: { Stop: [{ hooks: [{ command: 'tars-stop' }] }] }, tools: { allowed: ['read_file', 'run_shell_command'], core: ['edit'] }, mcp: { allowed: ['claude-mgr-orchestrator'] } };
    const admin = { hooks: { Stop: [{ hooks: [{ command: 'audit-log stop' }] }] }, tools: { allowed: ['read_file'], core: ['read_file'] }, mcp: { allowed: ['company-docs'] } };
    const merged = underAdministrator(tars, admin) as typeof tars;
    expect(merged.tools.allowed).toEqual(['read_file']);
    expect(merged.tools.core).toEqual(['read_file']);
    expect(merged.mcp.allowed).toEqual(['company-docs']);
    expect(merged.hooks.Stop.map((e) => e.hooks[0].command)).toEqual(['audit-log stop', 'tars-stop']);
  });
});
