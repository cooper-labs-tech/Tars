import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A delegated run hands its MCP servers a file that holds its token, never the token (2.0.4).
 *
 * The list of servers a run hands its CLI over ACP is written, by the claude adapter, into the `--mcp-config` JSON
 * of the claude it starts: a value in that list is in that process's arguments, which any process on the machine
 * reads (`ps`; /proc/<pid>/cmdline on Linux). Measured on 17/10 with claude-agent-acp 0.93.0: the run's token was
 * there. The ways it fails:
 *
 * 1. The token is a value of a server's list, under its own name or any other.
 * 2. The file can be read by someone else: wider than 0600, or in a folder others may list (POSIX; on Windows the
 *    folder is in the user's own temporary folder).
 * 3. The file outlives its run, ended or failed.
 * 4. A server finds no token: no path in the list (codex hands a server that list and nothing of its own
 *    environment), or a path to a file that does not hold the run's token.
 * 5. Two runs of one agent share a file, and the end of one takes the other's token away.
 *
 * The session is the real AcpSession, speaking to a fake agent process that reports, mid-turn, what each server it
 * was handed would read, as acp-delegate-token.test.ts does.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-token-file-'));
const serverBundle = path.join(tmp, 'bundle.js');
fs.writeFileSync(serverBundle, '');

/** Reports what each server it was handed would read, then ends the turn as told. */
function fakeAgentScript(ending: 'end_turn' | 'error'): string {
  return `import * as fs from 'node:fs';
import * as path from 'node:path';
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
let servers = [];
const mode = p => { try { return fs.statSync(p).mode & 0o777; } catch { return null; } };
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') {
    servers = msg.params.mcpServers || [];
    return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  }
  if (msg.method === 'session/prompt') {
    const token = process.env.CLAUDE_MGR_API_TOKEN || null;
    const report = {
      token,
      servers: servers.map(s => {
        const file = (s.env.find(e => e.name === 'CLAUDE_MGR_API_TOKEN_FILE') || {}).value || null;
        let read = null;
        try { read = file ? fs.readFileSync(file, 'utf8').trim() : null; } catch (e) { read = 'unreadable: ' + e.code; }
        return {
          name: s.name,
          holdingTheToken: token ? s.env.filter(e => String(e.value).includes(token)).map(e => e.name) : [],
          file, read, fileMode: file ? mode(file) : null, folderMode: file ? mode(path.dirname(file)) : null,
        };
      }),
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
import type { AgentStatus } from '../../../electron/types';

const AGENT = {
  id: 'agent-delegated-file',
  name: 'Delegated',
  status: 'idle',
  projectPath: tmp,
  provider: 'claude',
  skills: [],
  output: [],
  lastActivity: new Date().toISOString(),
} as AgentStatus;

interface Report {
  token: string | null;
  servers: { name: string; holdingTheToken: string[]; file: string | null; read: string | null; fileMode: number | null; folderMode: number | null }[];
}

async function delegate(ending: 'end_turn' | 'error') {
  const script = path.join(tmp, `agent-${ending}.mjs`);
  fs.writeFileSync(script, fakeAgentScript(ending));
  launch = { command: process.execPath, args: [script] };
  let report: Report | undefined;
  const result = await delegateOverAcp({
    agent: AGENT,
    task: 'report what your servers would read',
    appSettings: {} as never,
    timeoutMs: 20_000,
    onEvent: ({ type, payload }) => {
      if (type === 'text') report = JSON.parse(payload as string) as Report;
    },
  });
  if (!report) throw new Error(`the fake agent never reported: ${JSON.stringify(result)}`);
  return { result, report };
}

beforeEach(() => {
  launch = { command: process.execPath, args: [] };
});

describe("a delegated run's MCP servers", () => {
  it('are handed a file that holds the run\'s token, and never the token itself', async () => {
    const { result, report } = await delegate('end_turn');

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(report.token, 'the run had no token of its own').toMatch(/^[0-9a-f]{64}$/);
    expect(report.servers.map(s => s.name).sort()).toEqual(['claude-mgr-orchestrator', 'tars-memory']);
    for (const server of report.servers) {
      expect(server.holdingTheToken, `${server.name}'s list holds the token, and the claude adapter puts that list in argv`).toEqual([]);
      expect(server.file, `${server.name} is handed no file, and would call with no token`).toBeTruthy();
      expect(server.read, `${server.name}'s file does not hold the run's token`).toBe(report.token);
      if (process.platform !== 'win32') {
        expect(server.fileMode, `${server.name}'s file can be read by others`).toBe(0o600);
        expect(server.folderMode, `${server.name}'s file sits in a folder others may list`).toBe(0o700);
      }
    }
  });

  it('lose the file when the run ends, and when it fails', async () => {
    for (const ending of ['end_turn', 'error'] as const) {
      const { report } = await delegate(ending);
      for (const server of report.servers) {
        expect(server.file, `the ${ending} run handed ${server.name} no file`).toBeTruthy();
        expect(fs.existsSync(server.file!), `the ${ending} run left its token file behind`).toBe(false);
        expect(fs.existsSync(path.dirname(server.file!)), `the ${ending} run left its folder behind`).toBe(false);
      }
    }
  });

  it('of two runs of one agent never share a file', async () => {
    const first = await delegate('end_turn');
    const second = await delegate('end_turn');
    expect(second.report.servers[0].file).not.toBe(first.report.servers[0].file);
    expect(second.report.servers[0].read).toBe(second.report.token);
  });
});
