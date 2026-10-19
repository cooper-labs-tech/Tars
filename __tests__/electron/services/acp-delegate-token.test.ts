import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A task delegated over ACP runs as its agent, not as nobody.
 *
 * delegate_task tries /run-task first, and that starts the CLI through
 * delegateOverAcp rather than spawnAgentPty, which is where a terminal gets its
 * token. Without one of its own, the run's MCP servers fall back to the shared
 * token, on which a call has no agent behind it: refused on the bus, refused by
 * the cross-project guard, so a delegated agent could neither speak in its room
 * nor delegate in turn.
 *
 * The session here is the real AcpSession, speaking to a fake agent process
 * that reports, mid-turn, the token it was started with and the ones its MCP
 * servers were handed. What matters is checked while the run is still going,
 * and again once it is over.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-token-'));
const serverBundle = path.join(tmp, 'bundle.js');
fs.writeFileSync(serverBundle, '');

const PRELUDE = `
import * as fs from 'node:fs';
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
`;

/**
 * Reports its tokens in a message chunk, then ends the turn as told. A server's token is the one it would present:
 * since 2.0.4 the list hands it the path of a file that holds the token (acp-delegate-token-file.test.ts).
 */
function fakeAgentScript(ending: 'end_turn' | 'error'): string {
  return `${PRELUDE}
let servers = [];
const tokenOf = s => {
  const file = s.env.find(e => e.name === 'CLAUDE_MGR_API_TOKEN_FILE');
  if (!file) return (s.env.find(e => e.name === 'CLAUDE_MGR_API_TOKEN') || {}).value || null;
  try { return fs.readFileSync(file.value, 'utf8').trim(); } catch { return null; }
};
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') {
    servers = msg.params.mcpServers || [];
    return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  }
  if (msg.method === 'session/prompt') {
    const report = {
      process: process.env.CLAUDE_MGR_API_TOKEN || null,
      instance: process.env.TARS_INSTANCE_ID || null,
      servers: servers.map(s => ({ name: s.name, token: tokenOf(s), instance: (s.env.find(e => e.name === 'TARS_INSTANCE_ID') || {}).value || null })),
    };
    send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(report) } } } });
    return send(${ending === 'end_turn'}
      ? { jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }
      : { jsonrpc: '2.0', id: msg.id, error: { message: 'the turn failed' } });
  }
}
`;
}

let launch: { command: string; args: string[] };

vi.mock('../../../electron/services/acp/registry', () => ({
  acpLaunchFor: () => launch,
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
import { agentForToken, mintAgentToken, tarsInstanceId } from '../../../electron/core/agent-tokens';
import type { AgentStatus } from '../../../electron/types';

const AGENT = {
  id: 'agent-delegated',
  name: 'Delegated',
  status: 'idle',
  projectPath: tmp,
  provider: 'claude',
  skills: [],
  output: [],
  lastActivity: new Date().toISOString(),
} as AgentStatus;

interface Report {
  process: string | null;
  instance: string | null;
  servers: { name: string; token: string | null; instance: string | null }[];
}

/** Runs one delegation, reading the fake agent's report while the turn is still open. */
async function delegate(ending: 'end_turn' | 'error') {
  const script = path.join(tmp, `agent-${ending}.mjs`);
  fs.writeFileSync(script, fakeAgentScript(ending));
  launch = { command: process.execPath, args: [script] };

  let report: Report | undefined;
  const namedDuringTheRun: Array<string | undefined> = [];
  const result = await delegateOverAcp({
    agent: AGENT,
    task: 'report your tokens',
    appSettings: {} as never,
    timeoutMs: 20_000,
    onEvent: ({ type, payload }) => {
      if (type !== 'text') return;
      report = JSON.parse(payload as string) as Report;
      for (const token of [report.process, ...report.servers.map(s => s.token)]) {
        namedDuringTheRun.push(token ? agentForToken(token) : undefined);
      }
    },
  });
  if (!report) throw new Error(`the fake agent never reported: ${JSON.stringify(result)}`);
  return { result, report, namedDuringTheRun };
}

beforeEach(() => {
  launch = { command: process.execPath, args: [] };
});

describe('a task delegated over ACP', () => {
  it('runs with a token that names its agent, in the CLI and in every MCP server it is handed', async () => {
    const { result, report, namedDuringTheRun } = await delegate('end_turn');

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(report.process, 'the CLI was started with no token').toMatch(/^[0-9a-f]{64}$/);
    // And the id its hooks check the port with before they send that token (#11).
    expect(report.instance).toBe(tarsInstanceId());
    expect(report.servers.map(s => s.name).sort()).toEqual(['claude-mgr-orchestrator', 'tars-memory']);
    for (const server of report.servers) {
      expect(server.token, `${server.name} was handed no token, and would call as nobody`).toBe(report.process);
      // And the id it proves the port with before it sends that token (#376): a CLI
      // such as codex hands a server only its explicit env, so without it here every
      // Tars tool of the run went without a token, a 401 (QA's H1 on #376).
      expect(server.instance, `${server.name} was handed no instance id, and would send no token`).toBe(tarsInstanceId());
    }
    expect(namedDuringTheRun).toEqual([AGENT.id, AGENT.id, AGENT.id]);
  });

  it('stops naming the agent once the run is over', async () => {
    const { report } = await delegate('end_turn');

    expect(agentForToken(report.process!), 'the run left its pass behind').toBeUndefined();
  });

  it('stops naming the agent when the run fails too', async () => {
    const { result, report, namedDuringTheRun } = await delegate('error');

    expect(result.ok).toBe(false);
    expect(namedDuringTheRun[0]).toBe(AGENT.id);
    expect(agentForToken(report.process!), 'a failed run left its pass behind').toBeUndefined();
  });

  it("does not cut off the agent's terminal, before or after", async () => {
    const terminal = mintAgentToken(AGENT.id);

    const { report, namedDuringTheRun } = await delegate('end_turn');

    expect(report.process).not.toBe(terminal);
    expect(namedDuringTheRun[0]).toBe(AGENT.id);
    expect(agentForToken(terminal), 'the run invalidated the terminal of the agent it ran as').toBe(AGENT.id);
  });
});
