import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenCodeProvider } from '../../../electron/providers/opencode-provider';
import { PiProvider } from '../../../electron/providers/pi-provider';

/**
 * Tars's MCP servers, written where opencode and pi read them (the QA's CLI
 * matrix of 18/10, its Backend row: "Tars writes its server into
 * ~/.opencode/config.json and ~/.pi/config.json, where neither reads").
 *
 * Read from the CLIs' own published code, 19/10:
 * - opencode 1.19.3 (opencode-darwin-arm64, the compiled bundle): the global
 *   config is `config.json`, `opencode.json` and `opencode.jsonc` merged, in
 *   `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`; `opencode mcp add`
 *   writes `opencode.json` there. A server is `mcp.<name>`, `{ type: "local",
 *   command: [binary, ...args], environment?, enabled? }`, started with
 *   `{ ...process.env, ...environment }` (MCP.connectLocal).
 * - pi (`@earendil-works/pi-coding-agent` 1.3.0; `@mariozechner/pi-coding-agent`
 *   0.73.1, its former name, has no MCP at all): `<agent-dir>/mcp.json`,
 *   `mcpServers.<name>` = `{ command, args, env?, cwd? }`, the agent dir
 *   `$PI_CODING_AGENT_DIR`, else `~/.pi/agent` (docs/mcp.md, docs/configuration.md);
 *   started with `{ ...process.env, ...env }` (pi-mcp 1.3.0, transports/stdio.js).
 * Both hand a server their whole environment, so the agent's token reaches it
 * with no `env` of Tars's.
 *
 * Every way it can fail, written before the code:
 *  W1. opencode's server goes anywhere but `opencode.json` in its config
 *      folder, or in another shape than `mcp.<name>` local with the command
 *      and its arguments as one array.
 *  W2. `XDG_CONFIG_HOME`, or pi's `PI_CODING_AGENT_DIR`, is ignored.
 *  W3. pi's server goes anywhere but `<agent-dir>/mcp.json` under `mcpServers`.
 *  W4. The user's own settings and servers in those files are lost, or a file
 *      Tars cannot read (opencode takes JSONC, with comments) is replaced.
 *  W5. Registered, Tars does not see it registered (and writes it again at
 *      every start), or removes it from another file than the one it wrote.
 *  W6. What Tars wrote in the old places, where nothing reads, stays there
 *      for ever under Tars's names.
 *  W7. pi (1.5.2, measured 19/11) declares a server's tools to the model only with `"exposure": "direct"`: its
 *      default, `codemode`, leaves them callable from its code tool alone, so an agent on pi never sees
 *      send_message or delegate_task as tools. A server an older Tars wrote without it is written again.
 */

const SERVER = '/Applications/Tars.app/Contents/Resources/mcp-orchestrator/dist/bundle.js';
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.PI_CODING_AGENT_DIR;
  for (const dir of ['.config', '.opencode', '.pi']) fs.rmSync(path.join(os.homedir(), dir), { recursive: true, force: true });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('opencode', () => {
  const file = () => path.join(os.homedir(), '.config', 'opencode', 'opencode.json');

  it('W1. writes mcp.<name> into ~/.config/opencode/opencode.json, a local server with its command as one array', async () => {
    await new OpenCodeProvider().registerMcpServer('claude-mgr-orchestrator', '/usr/local/bin/node', [SERVER]);
    expect(read(file()).mcp['claude-mgr-orchestrator']).toEqual({ type: 'local', command: ['/usr/local/bin/node', SERVER], enabled: true });
    expect(fs.existsSync(path.join(os.homedir(), '.opencode', 'config.json'))).toBe(false);
  });

  it('W2. follows XDG_CONFIG_HOME', async () => {
    process.env.XDG_CONFIG_HOME = path.join(os.homedir(), 'xdg');
    await new OpenCodeProvider().registerMcpServer('tars-memory', 'node', [SERVER]);
    expect(read(path.join(os.homedir(), 'xdg', 'opencode', 'opencode.json')).mcp['tars-memory'].command).toEqual(['node', SERVER]);
  });

  it('W4. keeps the user\'s settings and servers, and leaves a file it cannot read as it is', async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'anthropic/x', mcp: { mine: { type: 'remote', url: 'https://example.com/mcp' } } }));
    await new OpenCodeProvider().registerMcpServer('tars-memory', 'node', [SERVER]);
    const after = read(file());
    expect(after.model).toBe('anthropic/x');
    expect(after.mcp.mine).toEqual({ type: 'remote', url: 'https://example.com/mcp' });
    expect(after.mcp['tars-memory'].type).toBe('local');

    const jsonc = '{\n  // mine\n  "model": "anthropic/x"\n}\n';
    fs.writeFileSync(file(), jsonc);
    await new OpenCodeProvider().registerMcpServer('tars-memory', 'node', [SERVER]);
    expect(fs.readFileSync(file(), 'utf8')).toBe(jsonc);
  });

  it('W5. sees it registered there, with the server\'s path, and removes it from there', async () => {
    const p = new OpenCodeProvider();
    expect(p.isMcpServerRegistered('tars-memory', SERVER)).toBe(false);
    await p.registerMcpServer('tars-memory', 'node', [SERVER]);
    expect(p.isMcpServerRegistered('tars-memory', SERVER)).toBe(true);
    expect(p.isMcpServerRegistered('tars-memory', '/elsewhere/bundle.js')).toBe(false);
    await p.removeMcpServer('tars-memory');
    expect(read(file()).mcp['tars-memory']).toBeUndefined();
    expect(p.isMcpServerRegistered('tars-memory', SERVER)).toBe(false);
  });

  it('W6. takes its server out of ~/.opencode/config.json, where an older Tars put it, and leaves the rest', async () => {
    const legacy = path.join(os.homedir(), '.opencode', 'config.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ theme: 'dark', mcpServers: { 'tars-memory': { command: 'node', args: [SERVER] }, other: { command: 'x' } } }));
    await new OpenCodeProvider().registerMcpServer('tars-memory', 'node', [SERVER]);
    expect(read(legacy)).toEqual({ theme: 'dark', mcpServers: { other: { command: 'x' } } });
  });
});

describe('pi', () => {
  const file = () => path.join(os.homedir(), '.pi', 'agent', 'mcp.json');

  it('W3. writes mcpServers.<name> into ~/.pi/agent/mcp.json', async () => {
    await new PiProvider().registerMcpServer('claude-mgr-orchestrator', '/usr/local/bin/node', [SERVER]);
    expect(read(file()).mcpServers['claude-mgr-orchestrator']).toEqual({ command: '/usr/local/bin/node', args: [SERVER], exposure: 'direct' });
  });

  it('W7. its tools declared to the model, and a server written without that written again', async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ mcpServers: { 'tars-memory': { command: 'node', args: [SERVER] } } }));
    const p = new PiProvider();
    expect(p.isMcpServerRegistered('tars-memory', SERVER)).toBe(false);
    await p.registerMcpServer('tars-memory', 'node', [SERVER]);
    expect(read(file()).mcpServers['tars-memory'].exposure).toBe('direct');
    expect(p.isMcpServerRegistered('tars-memory', SERVER)).toBe(true);
  });

  it('W2. follows PI_CODING_AGENT_DIR', async () => {
    process.env.PI_CODING_AGENT_DIR = path.join(os.homedir(), 'pi-agent');
    await new PiProvider().registerMcpServer('tars-memory', 'node', [SERVER]);
    expect(read(path.join(os.homedir(), 'pi-agent', 'mcp.json')).mcpServers['tars-memory'].args).toEqual([SERVER]);
  });

  it('W4. keeps the user\'s servers, and leaves a file it cannot read as it is', async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ mcpServers: { docs: { url: 'https://example.com/mcp' } } }));
    await new PiProvider().registerMcpServer('tars-memory', 'node', [SERVER]);
    expect(Object.keys(read(file()).mcpServers).sort()).toEqual(['docs', 'tars-memory']);

    fs.writeFileSync(file(), '{ not json');
    await new PiProvider().registerMcpServer('tars-memory', 'node', [SERVER]);
    expect(fs.readFileSync(file(), 'utf8')).toBe('{ not json');
  });

  it('W5. sees it registered there, and removes it from there', async () => {
    const p = new PiProvider();
    await p.registerMcpServer('tars-memory', 'node', [SERVER]);
    expect(p.isMcpServerRegistered('tars-memory', SERVER)).toBe(true);
    await p.removeMcpServer('tars-memory');
    expect(read(file()).mcpServers['tars-memory']).toBeUndefined();
    expect(p.isMcpServerRegistered('tars-memory', SERVER)).toBe(false);
  });

  it('W6. takes its server out of ~/.pi/config.json, where an older Tars put it', async () => {
    const legacy = path.join(os.homedir(), '.pi', 'config.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { 'tars-memory': { command: 'node', args: [SERVER] } } }));
    await new PiProvider().registerMcpServer('tars-memory', 'node', [SERVER]);
    expect(read(legacy)).toEqual({ mcpServers: {} });
  });
});
