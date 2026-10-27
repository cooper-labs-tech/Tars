import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ORCHESTRATOR_ONLY_MCP, mcpConfigPathFor, geminiRoleArgs } from '../../../electron/services/mcp-roles';
import { ClaudeProvider } from '../../../electron/providers/claude-provider';
import { CodexProvider } from '../../../electron/providers/codex-provider';
import { QwenCodeProvider } from '../../../electron/providers/qwen-code-provider';

/**
 * The MCP servers each agent gets, by its role (2.0.5, the owner's lot 3 of 28/10, item G of
 * ressources-agents-proposition-2810.md): "un exécutant ne reçoit plus Telegram ni X". A worker keeps the
 * orchestrator, memory, kanban, vault and socialdata servers; an orchestrator (or a chat's runner, which has its
 * powers) keeps all seven. Measured on 28/10: each server is a process of its own per session, the orchestrator's
 * 19 MB and every other 9 MB (median RSS over 14 sessions), so a worker gives back two processes and about 24 MB.
 *
 * How it fails, written before the code:
 * 1. Claude Code and the providers that run its binary: a worker's --mcp-config holds telegram or x, or an
 *    orchestrator's lacks one of the seven; or the worker's file drops a server the user added to that file (only
 *    the two are taken out), or goes stale once that file changed; or, with no file at all, one is passed anyway.
 * 2. Claude Code loads its user scope (~/.claude.json) whatever --mcp-config says: a Tars server registered there
 *    reaches every session, the worker's included, so registering one there makes 1 moot. Registration writes
 *    Tars's file only, and takes a Tars server out of the user scope; it never touches the user's own servers
 *    there, and a server still in the user scope does not read as registered.
 * 3. codex: a worker's command does not switch the two off (`-c mcp_servers.<name>.enabled=false`, measured on
 *    0.163), or an orchestrator's does.
 * 4. Qwen Code: a worker's command does not switch the two off (`--disable-mcp-server`, 0.25.2), or an
 *    orchestrator's does.
 * 5. gemini: a worker's command does not limit it to its other servers (`--allowed-mcp-server-names`, every server
 *    of its settings but the two), or limits an orchestrator; or, settings it cannot read, it is limited to none.
 */

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-mcp-roles-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const SEVEN = ['claude-mgr-orchestrator', 'tars-memory', 'claude-mgr-telegram', 'claude-mgr-kanban', 'claude-mgr-vault', 'dorothy-socialdata', 'dorothy-x'];
const flag = { getMcpConfigStrategy: () => 'flag' as const };
const configFile = { getMcpConfigStrategy: () => 'config-file' as const };
function writeMcpJson(servers: string[]) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const mcpServers = Object.fromEntries(servers.map(name => [name, { command: 'node', args: [`/srv/${name}/bundle.js`] }]));
  fs.writeFileSync(path.join(home, '.claude', 'mcp.json'), JSON.stringify({ mcpServers }));
}
const serversIn = (file: string) => Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers).sort();

describe('the claude family: a file per role', () => {
  it('1. an orchestrator gets all seven, a worker all but telegram and x, and a server the user added', () => {
    expect([...ORCHESTRATOR_ONLY_MCP].sort()).toEqual(['claude-mgr-telegram', 'dorothy-x']);
    writeMcpJson([...SEVEN, 'my-own-server']);
    const lead = mcpConfigPathFor(flag, true, home)!;
    const worker = mcpConfigPathFor(flag, false, home)!;
    expect(serversIn(lead)).toEqual([...SEVEN, 'my-own-server'].sort());
    expect(serversIn(worker)).toEqual([...SEVEN.filter(n => n !== 'claude-mgr-telegram' && n !== 'dorothy-x'), 'my-own-server'].sort());
    expect(worker).not.toBe(lead);
  });

  it('1. the worker\'s file follows the orchestrator\'s, and nothing is passed without one or to a config-file CLI', () => {
    writeMcpJson(SEVEN);
    const worker = mcpConfigPathFor(flag, false, home)!;
    writeMcpJson([...SEVEN, 'added-later']);
    expect(serversIn(mcpConfigPathFor(flag, false, home)!)).toContain('added-later');
    expect(mcpConfigPathFor(flag, false, home)).toBe(worker);
    expect(mcpConfigPathFor(configFile, false, home)).toBeUndefined();
    fs.rmSync(path.join(home, '.claude', 'mcp.json'));
    expect(mcpConfigPathFor(flag, false, home)).toBeUndefined();
    expect(mcpConfigPathFor(flag, true, home)).toBeUndefined();
  });
});

const posix = describe.skipIf(process.platform === 'win32');

posix('the claude family: no Tars server in the user scope', () => {
  let savedPath: string | undefined;
  let savedHome: string | undefined;
  beforeEach(() => {
    // A stand-in claude that does what `claude mcp remove -s user <name>` does to ~/.claude.json.
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs'), p = require('path').join(process.env.HOME, '.claude.json'); const a = process.argv.slice(2);
if (a[0] === 'mcp' && a[1] === 'remove' && a[2] === '-s' && a[3] === 'user') { const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!c.mcpServers || !c.mcpServers[a[4]]) { process.stderr.write('No user-scoped MCP server found'); process.exit(1); }
  delete c.mcpServers[a[4]]; fs.writeFileSync(p, JSON.stringify(c)); process.exit(0); }
process.stderr.write('not in this stand-in: ' + a.join(' ')); process.exit(2);
`, { mode: 0o755 });
    savedPath = process.env.PATH;
    savedHome = process.env.HOME;
    process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
    process.env.HOME = home;
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        'claude-mgr-telegram': { command: 'node', args: ['/srv/claude-mgr-telegram/bundle.js'] },
        pencil: { command: 'pencil-mcp', args: [] },
      },
      projects: { '/p': { hasTrustDialogAccepted: true } },
    }));
  });
  afterEach(() => { process.env.PATH = savedPath; process.env.HOME = savedHome; });

  it('2. registers into Tars\'s file, takes the server out of the user scope, and leaves the user\'s own there', async () => {
    const provider = new ClaudeProvider();
    expect(provider.isMcpServerRegistered('claude-mgr-telegram', '/srv/claude-mgr-telegram/bundle.js')).toBe(false);
    await provider.registerMcpServer('claude-mgr-telegram', 'node', ['/srv/claude-mgr-telegram/bundle.js']);
    const userScope = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(Object.keys(userScope.mcpServers)).toEqual(['pencil']);
    expect(userScope.projects['/p'].hasTrustDialogAccepted).toBe(true);
    expect(serversIn(path.join(home, '.claude', 'mcp.json'))).toEqual(['claude-mgr-telegram']);
    expect(provider.isMcpServerRegistered('claude-mgr-telegram', '/srv/claude-mgr-telegram/bundle.js')).toBe(true);
  });
});

describe('the CLIs that read their own config: a switch per run', () => {
  it('3. codex: a worker runs with the two switched off, an orchestrator with all', () => {
    const codex = new CodexProvider();
    const worker = codex.buildInteractiveCommand({ binaryPath: '/bin/codex', prompt: 'go', orchestratorMode: false, appSettings: {} as never });
    const lead = codex.buildInteractiveCommand({ binaryPath: '/bin/codex', prompt: 'go', orchestratorMode: true, appSettings: {} as never });
    for (const name of ORCHESTRATOR_ONLY_MCP) {
      expect(worker).toContain(`-c 'mcp_servers.${name}.enabled=false'`);
      expect(lead).not.toContain(`mcp_servers.${name}.enabled`);
    }
  });

  it('4. Qwen Code: a worker runs with the two disabled, an orchestrator with all', () => {
    const qwen = new QwenCodeProvider();
    const worker = qwen.buildInteractiveCommand({ binaryPath: '/bin/qwen', prompt: 'go', orchestratorMode: false });
    const lead = qwen.buildInteractiveCommand({ binaryPath: '/bin/qwen', prompt: 'go', orchestratorMode: true });
    for (const name of ORCHESTRATOR_ONLY_MCP) {
      expect(worker).toContain(`--disable-mcp-server '${name}'`);
      expect(lead).not.toContain(`--disable-mcp-server '${name}'`);
    }
  });

  it('5. gemini: a worker is limited to every server of its settings but the two; nothing when they cannot be read', () => {
    const settings = path.join(home, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ mcpServers: Object.fromEntries([...SEVEN, 'mine'].map(n => [n, {}])) }));
    const args = geminiRoleArgs(false, settings);
    expect(args[0]).toBe('--allowed-mcp-server-names');
    expect(args.slice(1).sort()).toEqual([...SEVEN.filter(n => !(ORCHESTRATOR_ONLY_MCP as readonly string[]).includes(n)), 'mine'].sort());
    expect(geminiRoleArgs(true, settings)).toEqual([]);
    expect(geminiRoleArgs(false, path.join(home, 'missing.json'))).toEqual([]);
    fs.writeFileSync(settings, '{ not json');
    expect(geminiRoleArgs(false, settings)).toEqual([]);
  });
});
