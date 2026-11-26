import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * The Hermes agents' terminals (core/hermes-terminals.ts): each one's profile written at its spawn, its `.env` removed
 * at its exit, the gateway every Hermes agent shares stopped when none is left. Written after the module (27/11),
 * against what each failure would do on disk or to a process, never a mock's call count.
 *
 * How it fails:
 * 1. A restart: the new terminal is spawned before the old one's exit is heard, and that exit removes the new
 *    terminal's `.env`, so the new session gets no key and no Tars token.
 * 2. The gateway is stopped while another Hermes terminal still uses it, or left running once none is.
 * 3. A worker's profile lists the orchestrator's own MCP servers (Telegram, X), or an orchestrator's lacks them.
 * 4. A terminal with no endpoint writes a profile, or a `.env` with no token, instead of refusing.
 * 5. A value of the terminal's environment that is a secret reaches the config (only the agent's id, name, project,
 *    Tars's address and instance go there; the token by `${...}`).
 */

const endpoint = vi.hoisted(() => ({ on: true, agent: { id: 'a', role: 'worker', permissionMode: 'normal' } as Record<string, unknown> }));
vi.mock('../../../electron/services/traces-runtime', () => ({
  endpointLaunchForAgent: () => (endpoint.on ? { args: [], env: {}, tokenVars: [], profile: { baseUrl: 'http://127.0.0.1:31417/v1', model: 'open-coder-1' } } : null),
  endpointAgentOf: () => endpoint.agent,
}));

import { openHermesTerminal, closeHermesTerminal, endHermesOnQuit } from '../../../electron/core/hermes-terminals';
import { hermesProfileDir, hermesRoot } from '../../../electron/services/hermes-home';

const envFile = (id: string) => path.join(hermesProfileDir(hermesRoot(), id), '.env');
const config = (id: string) => fs.readFileSync(path.join(hermesProfileDir(hermesRoot(), id), 'config.yaml'), 'utf8');
const env = { CLAUDE_AGENT_ID: 'a', CLAUDE_PROJECT_PATH: '/p', CLAUDE_MGR_API_URL: 'http://127.0.0.1:31415', TARS_INSTANCE_ID: 'inst', CLAUDE_MGR_API_TOKEN: 'tok-in-env', OPENAI_API_KEY: 'sk-user' };

let gateway: ChildProcess | undefined;
beforeEach(() => {
  endpoint.on = true;
  endpoint.agent = { id: 'a', role: 'worker', permissionMode: 'normal' };
  fs.mkdirSync(hermesRoot(), { recursive: true });
  fs.writeFileSync(path.join(hermesRoot(), 'tars-mcp-servers.json'), JSON.stringify({
    'claude-mgr-orchestrator': { command: '/n/node', args: ['/r/o.js'], env: ['CLAUDE_AGENT_ID', 'CLAUDE_MGR_API_TOKEN'] },
    'claude-mgr-telegram': { command: '/n/node', args: ['/r/t.js'], env: ['CLAUDE_MGR_API_TOKEN'] },
    'dorothy-x': { command: '/n/node', args: ['/r/x.js'], env: [] },
  }));
});
afterEach(async () => {
  await endHermesOnQuit();
  if (gateway && gateway.exitCode === null) gateway.kill('SIGKILL');
  gateway = undefined;
  fs.rmSync(hermesRoot(), { recursive: true, force: true });
});

/** A process whose command line reads as a Hermes gateway's, recorded as this home's. */
async function startGateway(): Promise<ChildProcess> {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'hermes_cli.main', 'gateway', 'run', '--quiet'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 200));
  fs.writeFileSync(path.join(hermesRoot(), 'gateway.pid'), JSON.stringify({ pid: p.pid, hermes_home: hermesRoot(), kind: 'hermes-gateway' }));
  return p;
}
const ended = (p: ChildProcess) => new Promise<boolean>((resolve) => {
  if (p.exitCode !== null || p.signalCode !== null) return resolve(true);
  const t = setTimeout(() => resolve(false), 5000);
  p.once('exit', () => { clearTimeout(t); resolve(true); });
});

describe('a terminal\'s .env', () => {
  it('1: an older terminal\'s exit leaves the newer terminal\'s .env', () => {
    openHermesTerminal('a', { apiToken: 'tok-old', endpointToken: 'tep_old', env });
    openHermesTerminal('a', { apiToken: 'tok-new', endpointToken: 'tep_new', env });
    closeHermesTerminal('a', 'tep_old');
    expect(fs.readFileSync(envFile('a'), 'utf8')).toContain('OPENAI_API_KEY=tep_new');
    closeHermesTerminal('a', 'tep_new');
    expect(fs.existsSync(envFile('a'))).toBe(false);
  });

  it('4: no endpoint, or no token: refused, and nothing written', () => {
    endpoint.on = false;
    expect(() => openHermesTerminal('a', { apiToken: 't', endpointToken: 'tep_x', env })).toThrow(/inference endpoint/);
    endpoint.on = true;
    expect(() => openHermesTerminal('a', { apiToken: undefined, endpointToken: 'tep_x', env })).toThrow();
    expect(() => openHermesTerminal('a', { apiToken: 't', endpointToken: undefined, env })).toThrow();
    expect(fs.existsSync(hermesProfileDir(hermesRoot(), 'a'))).toBe(false);
  });

  it('5: the config takes the non-secret values, and the token by name only', () => {
    openHermesTerminal('a', { apiToken: 'tok-a', endpointToken: 'tep_a', env });
    const text = config('a');
    expect(text).toContain('CLAUDE_AGENT_ID: "a"');
    expect(text).toContain('CLAUDE_MGR_API_TOKEN: "${CLAUDE_MGR_API_TOKEN}"');
    for (const secret of ['tok-a', 'tep_a', 'tok-in-env', 'sk-user']) expect(text).not.toContain(secret);
    closeHermesTerminal('a', 'tep_a');
  });
});

describe('the servers of its role', () => {
  it('3: a worker goes without the orchestrator\'s own servers, an orchestrator has them', () => {
    openHermesTerminal('a', { apiToken: 't', endpointToken: 'tep_w', env });
    expect(config('a')).toContain('claude-mgr-orchestrator:');
    expect(config('a')).not.toMatch(/claude-mgr-telegram:|dorothy-x:/);
    closeHermesTerminal('a', 'tep_w');
    endpoint.agent = { id: 'a', role: 'orchestrator', permissionMode: 'auto' };
    openHermesTerminal('a', { apiToken: 't', endpointToken: 'tep_o', env });
    expect(config('a')).toMatch(/claude-mgr-telegram:[\s\S]*dorothy-x:/);
    expect(config('a')).toMatch(/^approvals:\n {2}mode: "smart"$/m);
    closeHermesTerminal('a', 'tep_o');
  });
});

describe.skipIf(process.platform === 'win32')('the gateway they share', () => {
  it('2: kept while one Hermes terminal is left, stopped once none is', async () => {
    gateway = await startGateway();
    openHermesTerminal('a', { apiToken: 't', endpointToken: 'tep_a', env });
    openHermesTerminal('b', { apiToken: 't', endpointToken: 'tep_b', env: { ...env, CLAUDE_AGENT_ID: 'b' } });
    closeHermesTerminal('a', 'tep_a');
    await new Promise(r => setTimeout(r, 500));
    expect(gateway.exitCode === null && gateway.signalCode === null).toBe(true);
    closeHermesTerminal('b', 'tep_b');
    expect(await ended(gateway)).toBe(true);
  });
});
