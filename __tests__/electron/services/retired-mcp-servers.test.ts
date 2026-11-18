import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The MCP servers Tars, or Dorothy before it, no longer ships leave every CLI (2.0.7; an orchestrator's report
 * of 19/11: every session started with claude-mgr-telegram, dorothy-world and tasmania failing, CONNECTION_CLOSED).
 * Measured on the owner's Mac: the three sit in ~/.claude.json's user scope, which every claude session loads; the
 * first two name a Dorothy build's bundles that no longer exist, the third a scratchpad file of an agent's session.
 * dorothy-world is in ~/.codex/config.toml and ~/.gemini/settings.json too. 2.0.5's retirement of mcp-telegram asked
 * claude's provider whether it was registered, and that answers no for an entry of the user scope, by design (an
 * entry there is taken out by registering again, which Tars no longer does for mcp-telegram): it never went.
 *
 * How it can fail, written before the code:
 * R1. claude-mgr-telegram in ~/.claude.json's user scope, running a Tars or Dorothy mcp-telegram bundle, stays.
 * R2. dorothy-world, running a mcp-world bundle, stays in ~/.claude.json, ~/.codex/config.toml or
 *     ~/.gemini/settings.json.
 * R3. A server of the owner's under one of those names, running another program, is taken out.
 * R4. Another server of the owner's (tasmania, honcho), or another key of ~/.claude.json, is touched; its mode
 *     (0600, it holds the account) is not kept.
 * R5. A ~/.claude.json that is not JSON is written over, or throws; none at all throws.
 * R6. A bundle path written with Windows separators is not recognised.
 * R7. The claude CLI must run for the user scope to be cleaned: no claude on the PATH, nothing goes.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => path.join(os.homedir(), 'app'), isPackaged: false, getVersion: () => '2.0.7' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));
(process as { resourcesPath?: string }).resourcesPath = path.join(os.homedir(), 'Tars.app', 'Contents', 'Resources');

const DOROTHY = '/Users/someone/Dorothy-fix/release/mac-arm64/Dorothy.app/Contents/Resources';
const TASMANIA = { type: 'stdio', command: 'node', args: ['/private/tmp/claude-501/-Users-someone-Dorothy-fix/4ab31f00/scratchpad/x'], env: {} };
const HONCHO = { type: 'http', url: 'https://mcp.honcho.dev' };
const claudeFile = () => path.join(os.homedir(), '.claude.json');
const geminiFile = () => path.join(os.homedir(), '.gemini', 'settings.json');
const servers = (file: string) => Object.keys((JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: object }).mcpServers ?? {});

type Retired = typeof import('../../../electron/services/hermes-relay-switch');
let retired: Retired;

beforeEach(async () => {
  for (const f of [claudeFile(), path.join(os.homedir(), '.gemini'), path.join(os.homedir(), '.codex')]) fs.rmSync(f, { recursive: true, force: true });
  vi.resetModules();
  retired = await import('../../../electron/services/hermes-relay-switch');
});

function ownersClaudeJson(extra: Record<string, unknown> = {}) {
  fs.writeFileSync(claudeFile(), JSON.stringify({
    numStartups: 412,
    projects: { '/Users/someone/work': { hasTrustDialogAccepted: true } },
    mcpServers: {
      'claude-mgr-telegram': { type: 'stdio', command: 'node', args: [`${DOROTHY}/mcp-telegram/dist/bundle.js`], env: {} },
      'dorothy-world': { type: 'stdio', command: 'node', args: [`${DOROTHY}/mcp-world/dist/bundle.js`], env: {} },
      tasmania: TASMANIA,
      honcho: HONCHO,
      ...extra,
    },
  }, null, 2), { mode: 0o600 });
}

async function providers() {
  const { getProvider } = await import('../../../electron/providers');
  return [getProvider('claude'), getProvider('codex'), getProvider('gemini')];
}

describe('servers Tars no longer ships', () => {
  it('R1, R2, R4, R7: leave the user scope of ~/.claude.json, the owner\'s servers and keys stay, no claude CLI run', async () => {
    ownersClaudeJson();
    const before = JSON.parse(fs.readFileSync(claudeFile(), 'utf8'));
    // No claude on the PATH: the user scope is cleaned without it.
    const pathBefore = process.env.PATH;
    process.env.PATH = path.join(os.homedir(), 'empty-bin');
    try {
      await retired.retireOldMcpServers(await providers());
    } finally {
      process.env.PATH = pathBefore;
    }
    const after = JSON.parse(fs.readFileSync(claudeFile(), 'utf8'));
    expect(Object.keys(after.mcpServers)).toEqual(['tasmania', 'honcho']);
    expect(after.mcpServers.tasmania).toEqual(TASMANIA);
    expect(after.mcpServers.honcho).toEqual(HONCHO);
    expect(after.numStartups).toBe(before.numStartups);
    expect(after.projects).toEqual(before.projects);
    if (process.platform !== 'win32') expect(fs.statSync(claudeFile()).mode & 0o777).toBe(0o600);
    // The first test imports the providers and mcp-orchestrator cold: seconds on a loaded machine.
  }, 30_000);

  it('R2: dorothy-world leaves codex\'s and gemini\'s configs', async () => {
    const codexToml = path.join(os.homedir(), '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(codexToml), { recursive: true });
    fs.writeFileSync(codexToml, '[mcp_servers.dorothy-world]\ncommand = "node"\nargs = [ "/Applications/Dorothy.app/Contents/Resources/mcp-world/dist/bundle.js" ]\n\n[mcp_servers.mine]\ncommand = "node"\nargs = [ "/Users/someone/mine.js" ]\n');
    fs.mkdirSync(path.dirname(geminiFile()), { recursive: true });
    fs.writeFileSync(geminiFile(), JSON.stringify({ mcpServers: {
      'dorothy-world': { command: 'node', args: ['/Applications/Dorothy.app/Contents/Resources/mcp-world/dist/bundle.js'] },
      mine: { command: 'node', args: ['/Users/someone/mine.js'] },
    } }));
    await retired.retireOldMcpServers(await providers());
    expect(fs.readFileSync(codexToml, 'utf8')).not.toContain('dorothy-world');
    expect(fs.readFileSync(codexToml, 'utf8')).toContain('[mcp_servers.mine]');
    expect(servers(geminiFile())).toEqual(['mine']);
  });

  it('R3: an owner\'s server under those names, running another program, stays', async () => {
    fs.writeFileSync(claudeFile(), JSON.stringify({ mcpServers: {
      'claude-mgr-telegram': { command: 'node', args: ['/Users/someone/my-telegram/server.js'] },
      'dorothy-world': { command: 'python3', args: ['/Users/someone/world.py'] },
    } }));
    await retired.retireOldMcpServers(await providers());
    expect(servers(claudeFile())).toEqual(['claude-mgr-telegram', 'dorothy-world']);
  });

  it('R5: a ~/.claude.json that is not JSON is left as it is; none at all is no error', async () => {
    fs.writeFileSync(claudeFile(), '{ "mcpServers": ');
    await expect(retired.retireOldMcpServers(await providers())).resolves.toBeUndefined();
    expect(fs.readFileSync(claudeFile(), 'utf8')).toBe('{ "mcpServers": ');
    fs.rmSync(claudeFile());
    await expect(retired.retireOldMcpServers(await providers())).resolves.toBeUndefined();
    expect(fs.existsSync(claudeFile())).toBe(false);
  });

  it('R6: a bundle path written with Windows separators is recognised', async () => {
    fs.writeFileSync(claudeFile(), JSON.stringify({ mcpServers: {
      'claude-mgr-telegram': { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Users\\someone\\AppData\\Local\\Programs\\Dorothy\\resources\\mcp-telegram\\dist\\bundle.js'] },
      'dorothy-world': { command: 'node', args: ['C:\\Users\\someone\\AppData\\Local\\Programs\\Dorothy\\resources\\mcp-world\\dist\\bundle.js'] },
      honcho: HONCHO,
    } }));
    await retired.retireOldMcpServers(await providers());
    expect(servers(claudeFile())).toEqual(['honcho']);
  });
});
