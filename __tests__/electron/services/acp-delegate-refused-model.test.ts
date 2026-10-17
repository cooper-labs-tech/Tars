import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A model asked for one delegated run (delegate_task's `model`) that the
 * agent does not take.
 *
 * The Audit's M2 on f09ad4c9: delegateOverAcp set the asked model, and when
 * the agent refused it, set nothing else. The run went on the ACP adapter's
 * default model, the tool told its caller "ran on its own model", and the
 * turn's usage was filed under the agent's saved model.
 *
 * Every way this can fail, written before the fix:
 *  R1. The asked model is refused and the agent's own model is not set
 *      afterwards: the run is on the adapter's default.
 *  R2. The agent's own model is the one refused (the same value asked), and
 *      it is sent a second time.
 *  R3. The answer does not say what happened: which model was asked, that it
 *      was refused, which model the run is on, or claims the agent's own
 *      model when that was refused too.
 *  R4. The usage of the turn is filed under a model the run was not on: the
 *      asked one when it was refused, the agent's own when it was refused too.
 *  R5. An asked model the agent takes is followed by the agent's own,
 *      undoing it.
 *
 * The fake agent below offers `model`, refuses the values in FAKE_REFUSE,
 * records every value it took, and reports usage so the turn is filed.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-refused-model-'));
afterAll(() => fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

const FAKE_AGENT = `
let buf = '';
const refuse = JSON.parse(process.env.FAKE_REFUSE || '[]');
const sent = [];
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
    return send({ jsonrpc: '2.0', id: msg.id, result: {
      sessionId: 's1', configOptions: [{ id: 'model', name: 'model', type: 'select', currentValue: 'default', options: [] }],
    } });
  }
  if (msg.method === 'session/set_config_option') {
    sent.push(msg.params.value);
    if (refuse.includes(msg.params.value)) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown model' } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [] } });
  }
  if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(sent) } } } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } } });
  }
}
`;

let launch: { command: string; args: string[] };

vi.mock('../../../electron/services/acp/registry', () => ({
  acpLaunchFor: () => launch,
  loadAcpRegistry: async () => undefined,
}));
vi.mock('../../../electron/services/mcp-orchestrator', () => ({
  getMcpOrchestratorPath: () => path.join(tmp, 'absent.js'),
  getMcpMemoryPath: () => path.join(tmp, 'absent.js'),
}));
vi.mock('../../../electron/providers', () => ({
  getProvider: () => ({ getPtyEnvVars: () => ({}), configDir: '/not-claude' }),
}));
const filed: { model?: string }[] = [];
vi.mock('../../../electron/services/usage-ledger', () => ({ recordUsage: (entry: { model?: string }) => { filed.push(entry); } }));

import { delegateOverAcp } from '../../../electron/services/acp/delegate';
import type { AgentStatus } from '../../../electron/types';

/** One run asked on `asked`, for an agent saved on `own`: the values sent, what the run answered, what was filed. */
async function runAsking(asked: string, own: string | undefined, refuse: string[]) {
  const script = path.join(tmp, 'agent.mjs');
  fs.writeFileSync(script, FAKE_AGENT);
  launch = { command: process.execPath, args: [script] };
  process.env.FAKE_REFUSE = JSON.stringify(refuse);
  let sent: string[] | undefined;
  let atStart: unknown;
  const result = await delegateOverAcp({
    agent: {
      id: 'agent-acp', name: 'Delegated', status: 'idle', projectPath: tmp, provider: 'claude',
      skills: [], output: [], lastActivity: new Date().toISOString(),
      ...(own ? { model: own } : {}),
    } as AgentStatus,
    task: 'report', appSettings: {} as never, timeoutMs: 20_000, model: asked,
    onStarted: (run) => { atStart = run.model; },
    onEvent: ({ type, payload }) => { if (type === 'text') sent = JSON.parse(payload as string); },
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(filed).toHaveLength(1);
  return { sent: sent!, model: result.model, atStart, filedModel: filed[0].model };
}

beforeEach(() => {
  filed.length = 0;
  delete process.env.FAKE_REFUSE;
});

describe('a model asked for one delegated run, refused', () => {
  it('(R1, R3, R4) runs on the agent\'s own model, says so, and files the turn under it', async () => {
    const run = await runAsking('gpt-5', 'opus', ['gpt-5']);
    expect(run.sent).toEqual(['gpt-5', 'opus']);
    expect(run.model).toEqual({ asked: 'gpt-5', taken: false, own: 'opus', ranOn: 'opus' });
    expect(run.atStart).toEqual(run.model);
    expect(run.filedModel).toBe('opus');
  });

  it('(R3, R4) its own model refused too: names no model it ran on, and files the turn under none', async () => {
    const run = await runAsking('gpt-5', 'opus', ['gpt-5', 'opus']);
    expect(run.sent).toEqual(['gpt-5', 'opus']);
    expect(run.model).toEqual({ asked: 'gpt-5', taken: false, own: 'opus' });
    expect(run.filedModel).toBeUndefined();
  });

  it('(R3, R4) no model of its own: says so, and files the turn under none', async () => {
    const run = await runAsking('gpt-5', undefined, ['gpt-5']);
    expect(run.sent).toEqual(['gpt-5']);
    expect(run.model).toEqual({ asked: 'gpt-5', taken: false });
    expect(run.filedModel).toBeUndefined();
  });

  it('(R2) the asked model is the agent\'s own: not sent twice', async () => {
    const run = await runAsking('opus', 'opus', ['opus']);
    expect(run.sent).toEqual(['opus']);
    expect(run.model).toEqual({ asked: 'opus', taken: false, own: 'opus' });
    expect(run.filedModel).toBeUndefined();
  });
});

describe('a model asked for one delegated run, taken', () => {
  it('(R5) runs on it, the agent\'s own is not sent after it, and the turn is filed under it', async () => {
    const run = await runAsking('haiku', 'opus', []);
    expect(run.sent).toEqual(['haiku']);
    expect(run.model).toEqual({ asked: 'haiku', taken: true, own: 'opus', ranOn: 'haiku' });
    expect(run.filedModel).toBe('haiku');
  });
});
