import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * What a delegated run tells whoever delegated it about the work it could not
 * finish (sessions that died while they waited, 2026-09-23).
 *
 * A run is one turn, and Tars stops the agent when the turn ends. In the
 * Parallel project, Frontend ended its turn with builds, a Monitor and a
 * wakeup running: all stopped two seconds later, and its orchestrator read
 * "done". QA and Database were stopped at the one-hour limit mid-command, and
 * the run answered an empty text and "session/prompt timed out after 3600s".
 *
 * How this fails, written before the code:
 * 1. A run that ends its turn with background work does not say so: the
 *    result reads as finished work.
 * 2. A run stopped at its limit answers nothing it said or did before it.
 * 3. A run stopped at its limit is not told apart from one that failed to
 *    start, and delegate_task types the brief into the terminal again: the
 *    task runs twice.
 * 4. A run that never started (no ACP agent, a launch that fails) is
 *    reported as started, and delegate_task does not fall back when it should.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-left-'));
const serverBundle = path.join(tmp, 'bundle.js');
fs.writeFileSync(serverBundle, '');

const PRELUDE = `
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

function agentScript(updates: unknown[], answers: boolean): string {
  const file = path.join(tmp, `agent-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, `${PRELUDE}
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    for (const update of ${JSON.stringify(updates)}) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update } });
    ${answers ? "return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });" : ''}
  }
}
`);
  return file;
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
import type { AgentStatus, AppSettings } from '../../../electron/types';

const AGENT = {
  id: 'agent-delegated', name: 'Frontend', status: 'idle', projectPath: tmp, provider: 'claude',
  skills: [], output: [], lastActivity: new Date().toISOString(),
} as AgentStatus;
const run = (timeoutMs = 20_000) => delegateOverAcp({ agent: AGENT, task: 'upgrade Next', appSettings: {} as AppSettings, timeoutMs });

describe('a delegated run, about the work it could not finish', () => {
  it('says which background work was stopped when its turn ended', async () => {
    launch = { command: process.execPath, args: [agentScript([
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'pnpm build', kind: 'execute', rawInput: { command: 'pnpm build', run_in_background: true } },
      { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Monitor', kind: 'other', rawInput: {} },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Builds are running, I will pick up from their notifications.' } },
    ], true)] };

    const result = await run();

    expect(result).toMatchObject({ ok: true, started: true, stopReason: 'end_turn', backgroundStopped: ['pnpm build', 'Monitor'] });
  });

  it('keeps what a run said and did when it is stopped at its limit, and says it was', async () => {
    launch = { command: process.execPath, args: [agentScript([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Two of three repos compared.' } },
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'until grep -q DONE out; do sleep 10; done', kind: 'execute', rawInput: { command: 'until grep -q DONE out; do sleep 10; done' } },
    ], false)] };

    const result = await run(1_500);

    expect(result).toMatchObject({
      ok: false, started: true, stopReason: 'turn_limit', text: 'Two of three repos compared.',
      toolCalls: ['until grep -q DONE out; do sleep 10; done'],
    });
    expect(result.error).toMatch(/limit of 2 s/);
  });

  it('says a run whose agent died mid-turn had started: its task must not be sent again', async () => {
    const file = path.join(tmp, 'dies.mjs');
    fs.writeFileSync(file, `${PRELUDE}
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') process.exit(3);
}
`);
    launch = { command: process.execPath, args: [file] };

    const result = await run();

    expect(result).toMatchObject({ ok: false, started: true });
  });

  it('says a run that could not start did not start', async () => {
    launch = { command: path.join(tmp, 'no-such-agent'), args: [] };

    const result = await run();

    expect(result).toMatchObject({ ok: false, started: false });
  });
});
