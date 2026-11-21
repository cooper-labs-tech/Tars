import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Codex hands its MCP servers none of its own environment: TERM, SHELL,
 * TMPDIR, USER, PATH, HOME, LOGNAME and what the config names (measured on
 * codex 0.148, 2026-10-13). Tars's servers found no agent token there and
 * presented the shared ~/.dorothy/api-token instead; since 2.0.4 that file is
 * out of the agents' reach and no server reads it, so a codex agent's Tars
 * tools would answer 401. The registration names the variables codex is to
 * pass along (`env_vars`, which codex 0.163 reads: `codex mcp get` lists them).
 *
 * Every way it can fail, written before the code (2026-10-18):
 *  C1. A Tars server is registered for codex without the agent's token, its
 *      instance, its identity or the API's address among its env_vars, by
 *      `codex mcp add` or by the config.toml fallback.
 *  C2. A server registered before 2.0.4, without them, reads as registered and
 *      is never registered again.
 *  C3. A server that is not Tars's is handed the agent's token.
 *
 * Since #465 (main bc169117) the names come from the one list the orchestrator
 * keeps and hands each registration of a Tars server (TARS_MCP_ENV), and Tars
 * writes that section itself, `codex mcp add` having no way to say them: these
 * call the provider as the orchestrator does.
 */

const added = vi.hoisted(() => ({ fail: false }));
vi.mock('../../../electron/providers/cli-exec', async (original) => ({
  ...(await original<typeof import('../../../electron/providers/cli-exec')>()),
  execCliSync: (_cli: string, args: string[]) => {
    if (added.fail) throw new Error('codex not found');
    // What `codex mcp add <name> -- <command> <args>` writes.
    if (args[0] === 'mcp' && args[1] === 'add') {
      const [, , name, , command, ...rest] = args;
      const file = path.join(os.homedir(), '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `\n[mcp_servers.${name}]\ncommand = "${command}"\nargs = [${rest.map((a) => `"${a}"`).join(', ')}]\n`);
    }
    return '';
  },
}));

import { CodexProvider } from '../../../electron/providers/codex-provider';
import { TARS_MCP_ENV } from '../../../electron/services/mcp-orchestrator-env';

const config = () => fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf-8');
const section = (name: string) => config().split(/\n(?=\[)/).find((s) => s.startsWith(`[mcp_servers.${name}]`)) ?? '';
const NAMES = ['CLAUDE_MGR_API_TOKEN', 'TARS_INSTANCE_ID', 'CLAUDE_AGENT_ID', 'CLAUDE_PROJECT_PATH', 'CLAUDE_AGENT_NAME', 'CLAUDE_MGR_API_URL'];

beforeEach(() => {
  fs.rmSync(path.join(os.homedir(), '.codex'), { recursive: true, force: true });
  added.fail = false;
});

describe("codex and the variables of a Tars server", () => {
  it('C1. names them, whether codex mcp add works or not', async () => {
    const codex = new CodexProvider();
    await codex.registerMcpServer('claude-mgr-orchestrator', '/bin/node', ['/r/mcp-orchestrator/dist/bundle.js'], TARS_MCP_ENV);
    added.fail = true;
    await codex.registerMcpServer('claude-mgr-telegram', '/bin/node', ['/r/mcp-telegram/dist/bundle.js'], TARS_MCP_ENV);
    for (const name of ['claude-mgr-orchestrator', 'claude-mgr-telegram']) {
      for (const v of NAMES) expect(section(name), `${name} ${v}`).toContain(`"${v}"`);
      expect(section(name)).toMatch(/^env_vars = \[/m);
    }
  });

  it('C2. one registered without them is registered again', () => {
    fs.mkdirSync(path.join(os.homedir(), '.codex'), { recursive: true });
    fs.writeFileSync(path.join(os.homedir(), '.codex', 'config.toml'), '[mcp_servers.claude-mgr-vault]\ncommand = "/bin/node"\nargs = ["/r/mcp-vault/dist/bundle.js"]\n');
    expect(new CodexProvider().isMcpServerRegistered('claude-mgr-vault', '/r/mcp-vault/dist/bundle.js', TARS_MCP_ENV)).toBe(false);
  });

  it('C3. a server that is not Tars\'s gets none of them', async () => {
    await new CodexProvider().registerMcpServer('tasmania', '/bin/node', ['/opt/tasmania/server.js']);
    expect(section('tasmania')).not.toContain('CLAUDE_MGR_API_TOKEN');
    expect(new CodexProvider().isMcpServerRegistered('tasmania', '/opt/tasmania/server.js')).toBe(true);
  });
});
