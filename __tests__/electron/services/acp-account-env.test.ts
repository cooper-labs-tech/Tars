/**
 * A task delegated over ACP runs on the account its agent would launch on
 * (the Audit's N9).
 *
 * Measured on 2026-09-28 (DESIGN-COMPTES-CLAUDE.md): the adapter,
 * @agentclientprotocol/claude-agent-acp 0.70.0, runs the Agent SDK's own claude
 * (2.1.232), which honours CLAUDE_CONFIG_DIR with the same keychain naming as
 * 2.1.283 and answered as the account named. So the run gets what a terminal
 * gets, from the same resolver spawnAgentPty asks.
 *
 * What goes wrong if it is wrong, first:
 * - every delegated run billed to account 1 while its agent's terminal runs
 *   on another;
 * - account 1's run inheriting a CLAUDE_CONFIG_DIR from Tars's own environment:
 *   AcpSession merged the run's env over process.env and could remove nothing;
 * - with no resolver (option off), anything changed.
 *
 * The session is the real AcpSession, speaking to a fake agent that reports
 * the environment it was started with.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-account-'));
const serverBundle = path.join(tmp, 'bundle.js');
fs.writeFileSync(serverBundle, '');

const SCRIPT = `
let buf = '';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    const seen = {};
    for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'TARS_CLAUDE_ACCOUNT']) seen[k] = k in process.env ? process.env[k] : '<unset>';
    send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(seen) } } } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
}
`;
const script = path.join(tmp, 'agent.mjs');
fs.writeFileSync(script, SCRIPT);

vi.mock('../../../electron/services/acp/registry', () => ({
  acpLaunchFor: () => ({ command: process.execPath, args: [script] }),
  loadAcpRegistry: async () => undefined,
}));
vi.mock('../../../electron/services/mcp-orchestrator', () => ({
  getMcpOrchestratorPath: () => serverBundle,
  getMcpMemoryPath: () => serverBundle,
}));
vi.mock('../../../electron/providers', () => ({
  getProvider: () => ({ getPtyEnvVars: () => ({}), configDir: '/not-claude' }),
}));
vi.mock('../../../electron/services/usage-ledger', () => ({ recordUsage: vi.fn() }));

import { delegateOverAcp } from '../../../electron/services/acp/delegate';
import { setAccountEnvResolver } from '../../../electron/core/account-env';
import type { AgentStatus } from '../../../electron/types';

const AGENT = {
  id: 'agent-acp-account', name: 'Delegated', status: 'idle', projectPath: tmp, provider: 'claude',
  skills: [], output: [], lastActivity: new Date().toISOString(),
} as AgentStatus;

async function seen(): Promise<Record<string, string>> {
  let report: Record<string, string> | undefined;
  const result = await delegateOverAcp({
    agent: AGENT, task: 'say your environment', appSettings: {} as never, timeoutMs: 20_000,
    onEvent: ({ type, payload }) => { if (type === 'text') report = JSON.parse(payload as string); },
  });
  if (!report) throw new Error(`the fake agent never reported: ${JSON.stringify(result)}`);
  return report;
}

const inherited = { ...process.env };
beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = '/inherited/config';
  process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = '/inherited/storage';
});
afterEach(() => {
  setAccountEnvResolver(undefined);
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']) {
    if (inherited[k] === undefined) delete process.env[k]; else process.env[k] = inherited[k];
  }
});

describe('a delegated run and its account', () => {
  it('with no resolver, runs with the environment Tars has, as before', async () => {
    expect(await seen()).toMatchObject({ CLAUDE_CONFIG_DIR: '/inherited/config', TARS_CLAUDE_ACCOUNT: '<unset>' });
  });

  it("runs on the account the agent's terminal would, asked with the run's folder", async () => {
    const asked: string[] = [];
    setAccountEnvResolver((agentId, cwd) => {
      asked.push(`${agentId}@${cwd}`);
      return { accountId: 'acct-aaaaaa', set: { CLAUDE_CONFIG_DIR: '/h/.claude-accounts/acct-aaaaaa', TARS_CLAUDE_ACCOUNT: 'acct-aaaaaa' }, unset: ['CLAUDE_SECURESTORAGE_CONFIG_DIR'] };
    });
    expect(await seen()).toEqual({ CLAUDE_CONFIG_DIR: '/h/.claude-accounts/acct-aaaaaa', CLAUDE_SECURESTORAGE_CONFIG_DIR: '<unset>', TARS_CLAUDE_ACCOUNT: 'acct-aaaaaa' });
    expect(asked).toEqual([`${AGENT.id}@${tmp}`]);
  });

  it("on account 1, loses what Tars's own environment would have handed it", async () => {
    setAccountEnvResolver(() => ({ accountId: 'default', set: { TARS_CLAUDE_ACCOUNT: 'default' }, unset: ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'] }));
    expect(await seen()).toEqual({ CLAUDE_CONFIG_DIR: '<unset>', CLAUDE_SECURESTORAGE_CONFIG_DIR: '<unset>', TARS_CLAUDE_ACCOUNT: 'default' });
  });
});
