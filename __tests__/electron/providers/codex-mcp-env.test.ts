import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Tars's MCP servers inside codex know which agent they run for (2.0.4).
 *
 * codex hands an MCP server a few variables of its own (HOME, PATH, TERM) and the ones its config names, nothing
 * else: measured on codex-cli 0.163.0, a probe server got the two variables listed in `env_vars` with their values
 * from codex's environment, and not a third one that was set but not listed. So the agent's token, which Tars puts in
 * the codex process's environment, never reached the Tars server, and send_message answered "Driving an agent takes
 * an identity of your own... it presents the shared token". `codex mcp add --env KEY=VALUE` would write the value
 * itself into config.toml, and into the arguments of the command that adds it.
 *
 * The ways it fails:
 * 1. Tars's servers registered without `env_vars`, or without one of the names they read: the agent's token, id or
 *    project never reaches them.
 * 2. A value written into config.toml (the token, an agent's id): names only, the values stay in each agent's own
 *    environment, so one config serves every codex agent, and the user's own codex sessions get nothing.
 * 3. A registration made before 2.0.4 taken as current: it has no `env_vars`, and would stay so for good.
 * 4. A section codex cannot read back (codex refuses to start on a config.toml it cannot parse).
 */

let home: string;

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => home };
});

import { TARS_MCP_ENV } from '../../../electron/services/mcp-orchestrator-env';

async function codex() {
  const { CodexProvider } = await import('../../../electron/providers/codex-provider');
  return new CodexProvider();
}
const configFile = () => path.join(home, '.codex', 'config.toml');
// The installed codex, run on purpose to read the config with codex's own parser: only when TARS_TEST_REAL_CLIS names
// codex, as __tests__/setup/no-real-cli.ts lets it through then and refuses a real codex otherwise (the Audit's I-4
// on #616: a unit test runs no real CLI by default). Its home is this file's own folder.
const codexOnPath = (() => {
  if (!(process.env.TARS_TEST_REAL_CLIS ?? '').split(/[\s,]+/).some(n => n.toLowerCase() === 'codex')) return '';
  try { return execFileSync('which', ['codex'], { encoding: 'utf8' }).trim(); } catch { return ''; }
})();

let saved: string | undefined;
beforeEach(() => {
  vi.resetModules();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-env-'));
  saved = process.env.CLAUDE_MGR_API_TOKEN;
  // As in Tars's own process: a value that must never be written down.
  process.env.CLAUDE_MGR_API_TOKEN = 'secret-token-of-a-terminal-0123456789';
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_MGR_API_TOKEN;
  else process.env.CLAUDE_MGR_API_TOKEN = saved;
});

describe("Tars's servers in codex's config", () => {
  it('name every variable they read, as env_vars, and hold no value', async () => {
    const p = await codex();
    await p.registerMcpServer('claude-mgr-orchestrator', 'node', ['/app/mcp-orchestrator/dist/bundle.js'], TARS_MCP_ENV);
    const text = fs.readFileSync(configFile(), 'utf8');

    expect(TARS_MCP_ENV).toEqual(expect.arrayContaining([
      'CLAUDE_AGENT_ID', 'CLAUDE_AGENT_NAME', 'CLAUDE_PROJECT_PATH', 'CLAUDE_MGR_API_URL', 'CLAUDE_MGR_API_TOKEN', 'TARS_INSTANCE_ID', 'TARS_CHATS_READ',
    ]));
    expect(text).toContain('[mcp_servers.claude-mgr-orchestrator]');
    expect(text).toContain(`env_vars = [${TARS_MCP_ENV.map(n => JSON.stringify(n)).join(', ')}]`);
    expect(text, 'a value was written into config.toml').not.toContain('secret-token-of-a-terminal');
    expect(text).not.toMatch(/^env\s*=/m);
  });

  it('a registration without them is not current, and is made again', async () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), 'model = "gpt-6-luna"\n\n[mcp_servers.claude-mgr-orchestrator]\ncommand = "node"\nargs = ["/app/b.js"]\n');
    const p = await codex();
    expect(p.isMcpServerRegistered('claude-mgr-orchestrator', '/app/b.js', TARS_MCP_ENV), 'a pre-2.0.4 registration read as current').toBe(false);

    await p.registerMcpServer('claude-mgr-orchestrator', 'node', ['/app/b.js'], TARS_MCP_ENV);
    expect(p.isMcpServerRegistered('claude-mgr-orchestrator', '/app/b.js', TARS_MCP_ENV)).toBe(true);
    const text = fs.readFileSync(configFile(), 'utf8');
    expect(text).toContain('model = "gpt-6-luna"');
    expect(text.match(/\[mcp_servers\.claude-mgr-orchestrator\]/g)).toHaveLength(1);
  });

  it.skipIf(!codexOnPath)("reads back through codex's own parser, the names in env_vars", async () => {
    const p = await codex();
    await p.registerMcpServer('claude-mgr-orchestrator', 'node', ['/app/b.js'], TARS_MCP_ENV);
    await p.registerMcpServer('tars-memory', 'node', ['/app/m.js'], TARS_MCP_ENV);
    const listed = JSON.parse(execFileSync(codexOnPath, ['mcp', 'list', '--json'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: path.join(home, '.codex') }, stdio: ['ignore', 'pipe', 'pipe'],
    })) as Array<{ name: string; transport: { command: string; args: string[]; env: unknown; env_vars: string[] } }>;
    for (const name of ['claude-mgr-orchestrator', 'tars-memory']) {
      const server = listed.find(s => s.name === name);
      expect(server, name).toBeTruthy();
      expect(server!.transport.env_vars).toEqual([...TARS_MCP_ENV]);
      expect(server!.transport.env).toBeNull();
    }
  });
});
