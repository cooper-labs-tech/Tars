import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A task delegated over ACP calls back the Tars that started it.
 *
 * Every agent terminal is told which one that is: spawnAgentPty sets
 * CLAUDE_MGR_API_URL after the caller's environment, precisely so no spawn
 * site has to remember. This path is not a terminal and did not set it, so the
 * run's hooks and its MCP servers fell back to the compiled default of 31415.
 * The QA measured it on 2026-09-20 while running on 31493: three posts from
 * its ACP child reached the live app and were refused as `Agent not found`.
 * Nothing was written, but the port is the boundary between a sandbox and
 * JeanBrasse's own app, and on this path it was not one.
 *
 * The port is fixed before the imports below, because `constants.ts` reads
 * DOROTHY_API_PORT once at module load. The fake agent process reports what it
 * and its MCP servers were actually handed.
 */

// Hoisted above the imports, because constants.ts reads DOROTHY_API_PORT once
// at module load and `env-isolation` has already cleared it by then.
vi.hoisted(() => { process.env.DOROTHY_API_PORT = '31493'; });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-port-'));
const serverBundle = path.join(tmp, 'bundle.js');
fs.writeFileSync(serverBundle, '');

/** Reports the address it was given, and the one each MCP server was given. */
const FAKE_AGENT = `
let buf = '';
let servers = [];
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
  if (msg.method === 'session/new') {
    servers = msg.params.mcpServers || [];
    return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  }
  if (msg.method === 'session/prompt') {
    const report = {
      process: process.env.CLAUDE_MGR_API_URL || null,
      servers: servers.map(s => ({
        name: s.name,
        url: (s.env.find(e => e.name === 'CLAUDE_MGR_API_URL') || {}).value || null,
      })),
    };
    send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(report) } } } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
}
`;

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
  getProvider: () => ({ getPtyEnvVars: () => ({}) }),
}));
vi.mock('../../../electron/services/usage-ledger', () => ({ recordUsage: vi.fn() }));

import { delegateOverAcp } from '../../../electron/services/acp/delegate';
import { API_PORT } from '../../../electron/constants';
import type { AgentStatus } from '../../../electron/types';

const AGENT = {
  id: 'agent-delegated', name: 'Delegated', status: 'idle', projectPath: tmp,
  provider: 'claude', skills: [], output: [], lastActivity: new Date().toISOString(),
} as AgentStatus;

interface Report {
  process: string | null;
  servers: { name: string; url: string | null }[];
}

async function delegate(): Promise<Report> {
  const script = path.join(tmp, 'agent.mjs');
  fs.writeFileSync(script, FAKE_AGENT);
  launch = { command: process.execPath, args: [script] };

  let report: Report | undefined;
  const result = await delegateOverAcp({
    agent: AGENT, task: 'report your address', appSettings: {} as never, timeoutMs: 20_000,
    onEvent: ({ type, payload }) => {
      if (type === 'text') report = JSON.parse(payload as string) as Report;
    },
  });
  if (!report) throw new Error(`the fake agent never reported: ${JSON.stringify(result)}`);
  return report;
}

beforeEach(() => {
  launch = { command: process.execPath, args: [] };
});

describe('a task delegated over ACP', () => {
  it('runs on the port this Tars is on, not on the compiled default', async () => {
    // The witness for everything below: without it a suite that happened to
    // run on 31415 would agree with a hardcoded 31415 and prove nothing.
    expect(API_PORT, 'the port under test is the default one').toBe(31493);

    const report = await delegate();

    expect(report.process, 'the CLI was started with no address, so its hooks post to 31415')
      .toBe('http://127.0.0.1:31493');
  });

  it('gives the same address to every MCP server it hands over', async () => {
    const report = await delegate();

    expect(report.servers.map(s => s.name).sort()).toEqual(['claude-mgr-orchestrator', 'tars-memory']);
    for (const server of report.servers) {
      expect(server.url, `${server.name} would fall back to 31415 and drive another Tars`)
        .toBe('http://127.0.0.1:31493');
    }
  });
});
