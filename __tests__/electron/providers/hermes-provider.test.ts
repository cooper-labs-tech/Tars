import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Hermes Agent as an agent's CLI, on an inference endpoint only (measured on 0.23.4, 26 and 27/11): `hermes chat`
 * in the agent's terminal, its home the agent's profile in Tars's own Hermes home (services/hermes-home.ts).
 *
 * How it fails, written before the code (27/11):
 * 1. Hermes starts in another home than the agent's profile: the user's `~/.hermes` (their own gateway, memory and
 *    messaging platforms), or one an rc file of the agent's shell exports. On macOS and Linux the home is on the line,
 *    which no rc file runs after; on Windows, where nothing is sourced, in the terminal's environment.
 * 2. A user's OPENAI_API_KEY or OPENAI_BASE_URL, from the environment or an rc file, reaches Hermes and is used
 *    instead of the profile's (the proxy token): the user's key sent to the proxy, or the turn sent elsewhere.
 * 3. A token is on the line (`--api-key`), where `ps` shows it to every process of the user.
 * 4. An agent with no endpoint starts a Hermes that asks for a provider in its terminal, where nobody answers.
 * 5. The task reaches Hermes as more than one argument, or is run by the shell (quotes, `$(...)`, line breaks).
 * 6. bypass does not reach Hermes (`--yolo`), or normal and auto get it.
 * 7. The sessions are not tagged `tool` (Hermes refuses `--source tars`), so they show in the user's own lists.
 * 8. A resumed session id that is not one of Hermes's reaches the line.
 * 9. Its MCP servers are written into a config of the user's, or registered with a token's value.
 */

const AGENT = 'agent-hermes-1';
const PROXY = 'http://127.0.0.1:31417/v1';
const launch = vi.hoisted(() => ({ value: null as null | { args: string[]; env: Record<string, string>; tokenVars: string[]; profile?: { baseUrl: string; model: string } } }));
vi.mock('../../../electron/services/traces-runtime', () => ({ endpointLaunchForAgent: () => launch.value }));

import { getProvider } from '../../../electron/providers';
import { DATA_DIR } from '../../../electron/constants';
import { hermesProfileDir, hermesRoot } from '../../../electron/services/hermes-home';

const hermes = () => getProvider('hermes' as never);
const ONE = { args: [], env: {}, tokenVars: [], profile: { baseUrl: PROXY, model: 'open-coder-1' } };

let tmp: string;
let printer: string;
beforeEach(() => {
  launch.value = ONE;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-provider-'));
  // Stands in for the binary: prints its arguments, then what it got of the variables at stake, as JSON.
  printer = path.join(tmp, 'hermes');
  fs.writeFileSync(printer, `#!${process.execPath}\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), home: process.env.HERMES_HOME ?? null, key: process.env.OPENAI_API_KEY ?? null, base: process.env.OPENAI_BASE_URL ?? null }));\n`, { mode: 0o755 });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const line = (over: Record<string, unknown> = {}) => hermes().buildInteractiveCommand({ agentId: AGENT, binaryPath: printer, prompt: '', ...over } as never);

/** Runs the line as a login shell of the user would, with an rc file that exports its own values first. */
function reached(command: string): { argv: string[]; home: string | null; key: string | null; base: string | null } {
  const rc = path.join(tmp, 'rc.sh');
  fs.writeFileSync(rc, 'export HERMES_HOME="$HOME/.hermes"\nexport OPENAI_API_KEY=sk-user-own\nexport OPENAI_BASE_URL=https://api.openai.com/v1\n');
  const out = execFileSync('/bin/bash', ['-c', `. '${rc}'; ${command}`], { encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: 'sk-env' } });
  return JSON.parse(out.trim().split('\n').pop()!);
}

describe.skipIf(process.platform === 'win32')('the line on macOS and Linux', () => {
  it('1 and 2: the home is the agent\'s profile and the user\'s OpenAI variables are taken out, whatever an rc file says', () => {
    const r = reached(line());
    expect(r.home).toBe(hermesProfileDir(hermesRoot(), AGENT));
    expect(r.home!.startsWith(path.join(DATA_DIR, 'hermes'))).toBe(true);
    expect(r.key).toBeNull();
    expect(r.base).toBeNull();
  });

  it('5 and 7: chat, tagged tool, the model, and the task as one argument the shell does not run', () => {
    const task = `it's "x" $(touch ${tmp}/ran) \`id\`\nsecond line`;
    const r = reached(line({ prompt: task }));
    expect(r.argv).toEqual(['chat', '--source', 'tool', '-m', 'open-coder-1', '-q', task]);
    expect(fs.existsSync(path.join(tmp, 'ran'))).toBe(false);
  });

  it('6: bypass is --yolo, normal and auto are not', () => {
    expect(reached(line({ permissionMode: 'bypass' })).argv).toContain('--yolo');
    for (const mode of ['normal', 'auto', undefined]) expect(reached(line({ permissionMode: mode })).argv).not.toContain('--yolo');
  });

  it('8: only a session id of Hermes\'s form is resumed', () => {
    const id = `local-${'ab12'.repeat(16)}`;
    expect(reached(line({ resumeSessionId: id })).argv).toEqual(['chat', '--source', 'tool', '-m', 'open-coder-1', '--resume', id]);
    for (const bad of ['latest', 'local-x; rm -rf /', '--yolo', '']) {
      expect(reached(line({ resumeSessionId: bad })).argv, bad).not.toContain('--resume');
    }
  });
});

describe('on every platform', () => {
  it('3: no token, and no key, on the line', () => {
    const l = line({ prompt: 'do it', permissionMode: 'bypass' });
    expect(l).not.toMatch(/api-key|tep_|OPENAI_API_KEY=/);
  });

  it('4: refuses to start without an endpoint, or without its agent', () => {
    launch.value = null;
    expect(() => line()).toThrow(/inference endpoint/);
    launch.value = ONE;
    expect(() => hermes().buildInteractiveCommand({ binaryPath: printer, prompt: '' } as never)).toThrow();
  });

  it('1 and 2 on Windows: the home in the terminal\'s environment, the OpenAI variables removed', () => {
    const env = hermes().getPtyEnvVars(AGENT, '/p', [], undefined as never);
    expect(env.HERMES_HOME).toBe(hermesProfileDir(hermesRoot(), AGENT));
    expect(env.CLAUDE_AGENT_ID).toBe(AGENT);
    expect(hermes().getEnvVarsToDelete()).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_MGR_API_TOKEN', 'TARS_ENDPOINT_TOKEN']));
  });

  it('9: Tars\'s MCP servers go into a list of Tars\'s in its own Hermes home, by variable name only', async () => {
    const p = hermes();
    expect(p.getMcpConfigStrategy()).toBe('config-file');
    await p.registerMcpServer('claude-mgr-orchestrator', '/n/node', ['/r/mcp-orchestrator/dist/bundle.js'], ['CLAUDE_AGENT_ID', 'CLAUDE_MGR_API_TOKEN']);
    expect(p.isMcpServerRegistered('claude-mgr-orchestrator', '/r/mcp-orchestrator/dist/bundle.js', ['CLAUDE_AGENT_ID', 'CLAUDE_MGR_API_TOKEN'])).toBe(true);
    expect(p.isMcpServerRegistered('claude-mgr-orchestrator', '/elsewhere/bundle.js', ['CLAUDE_AGENT_ID', 'CLAUDE_MGR_API_TOKEN'])).toBe(false);
    const file = path.join(hermesRoot(), 'tars-mcp-servers.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      'claude-mgr-orchestrator': { command: '/n/node', args: ['/r/mcp-orchestrator/dist/bundle.js'], env: ['CLAUDE_AGENT_ID', 'CLAUDE_MGR_API_TOKEN'] },
    });
    expect(fs.existsSync(path.join(os.homedir(), '.hermes'))).toBe(false);
    await p.removeMcpServer('claude-mgr-orchestrator');
    expect(p.isMcpServerRegistered('claude-mgr-orchestrator', '/r/mcp-orchestrator/dist/bundle.js')).toBe(false);
  });
});
