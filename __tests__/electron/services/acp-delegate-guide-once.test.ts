import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * How Tars works (services/agent-guide.ts), in the prompt of a delegated run.
 *
 * The Audit's L3 on #448: delegateOverAcp put the section before every task,
 * on the belief that a run has no bootstrap. A claude run has one: the adapter
 * loads the user's settings (`settingSources: ["user","project","local"]`), so
 * Tars's SessionStart hook runs and fetches /bootstrap, which ends with the
 * same section. Measured on 2026-10-18 with the adapter Tars pins (0.70.0):
 * a SessionStart hook in the CLAUDE_CONFIG_DIR's settings.json fires at
 * session/new, before any prompt.
 *
 * Every way this can fail, written before the fix:
 *  G1. A claude run gets the section in its prompt too: twice in its context.
 *  G2. A run of a CLI without Claude's hook (opencode, codex...) loses it.
 *  G3. The section is there more than once, or the task is not there.
 *
 * The fake agent below answers each prompt with the text it was sent.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-guide-once-'));
afterAll(() => fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

const FAKE_AGENT = `
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
    const text = (msg.params.prompt || []).map(p => p.text || '').join('');
    send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
}
`;

const script = path.join(tmp, 'agent.mjs');
fs.writeFileSync(script, FAKE_AGENT);

vi.mock('../../../electron/services/acp/registry', () => ({
  acpLaunchFor: () => ({ command: process.execPath, args: [script] }),
  loadAcpRegistry: async () => undefined,
}));
vi.mock('../../../electron/services/mcp-orchestrator', () => ({
  getMcpOrchestratorPath: () => path.join(tmp, 'absent.js'),
  getMcpMemoryPath: () => path.join(tmp, 'absent.js'),
}));
// Each provider's config folder, as the real ones have it: claude's is the one
// whose settings carry Tars's hooks.
vi.mock('../../../electron/providers', () => ({
  getProvider: (id: string) => ({
    getPtyEnvVars: () => ({}),
    configDir: id === 'claude' ? path.join(os.homedir(), '.claude') : path.join(os.homedir(), `.${id}`),
  }),
}));
vi.mock('../../../electron/services/usage-ledger', () => ({ recordUsage: () => undefined }));

import { delegateOverAcp } from '../../../electron/services/acp/delegate';
import type { AgentStatus } from '../../../electron/types';

const SECTION = '## How Tars works';

/** The prompt a run of this provider was sent. */
async function promptOf(provider: string): Promise<string> {
  let sent = '';
  const result = await delegateOverAcp({
    agent: {
      id: `agent-${provider}`, name: 'Delegated', status: 'idle', projectPath: tmp, provider,
      skills: [], output: [], lastActivity: new Date().toISOString(),
    } as AgentStatus,
    task: 'TASK>> report', appSettings: {} as never, timeoutMs: 20_000,
    onEvent: ({ type, payload }) => { if (type === 'text') sent += String(payload); },
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return sent;
}

describe('the section in a delegated run\'s prompt', () => {
  it('(G1) a claude run: not in the prompt, its bootstrap carries it', async () => {
    const prompt = await promptOf('claude');
    expect(prompt).not.toContain(SECTION);
    expect(prompt).toBe('TASK>> report');
  });

  it('(G2, G3) an opencode run: once, before the task', async () => {
    const prompt = await promptOf('opencode');
    expect(prompt.split(SECTION).length - 1).toBe(1);
    expect(prompt.indexOf(SECTION)).toBeLessThan(prompt.indexOf('TASK>> report'));
  });
});
