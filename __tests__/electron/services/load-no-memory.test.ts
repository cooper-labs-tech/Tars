import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The no-memory rule of a load window's sessions (trace feature C3, #691): a load session starts with nothing an
 * earlier session wrote, whether Tars hands it or the CLI keeps it. What each CLI keeps was read from its package and
 * measured against the real codex 0.163.0, qwen-code 0.25.2 and opencode 1.19.6, fenced (the bench's measure/ folder,
 * the PR's body).
 *
 * How it can fail, written before the code (each case below, or the file named):
 *  N1. A codex load session keeps codex's own memories: `features.memories`, `memories.generate_memories` and
 *      `memories.use_memories` not switched off (measured: with the feature on, memory_summary.md reaches the model).
 *  N2. A codex load session keeps a Tars MCP server its config.toml defines, or is given a switch for one the config
 *      does not define, on which codex refuses to start (measured: "invalid transport in `mcp_servers.<name>`").
 *  N3. A qwen-code load session keeps a Tars MCP server, its memory tools (save_memory, manage_memory, search_memory)
 *      or ~/.tars as a folder of its workspace.
 *  N4. A qwen-code load agent's settings leave its managed auto memory, auto dream, auto skill, team memory or
 *      structured recall on, or a mem0 provider in place (measured: its user tier reaches the model).
 *  N5. A pi load session keeps MCP (`--no-mcp` missing).
 *  N6. An opencode load session keeps a Tars MCP server (no `mcp.<name>.enabled: false` in its config content), loses
 *      its endpoint's provider in that content, or reads ~/.claude/CLAUDE.md (OPENCODE_DISABLE_CLAUDE_CODE).
 *  N7. An agent that is not a load agent has its command line or its environment changed by any of it.
 *  N8. The starting context's hash differs between two load sessions of the same task (an agent's id or name, a
 *      worktree or a time in it), or stays the same with a memory block in the prompt or a line planted in the CLI's
 *      global instruction file.
 *  N9. The hash is missing from the trace's outcome when the load session ends, or is in a session that is not one.
 *  N10. A load agent's tool use is recorded among its project's observations (memory-webhook-routes.test.ts).
 *  N11. A load agent is a member of its project's room (bus-room-title.test.ts).
 *  N12. A load session finds what the session before it left in its TMPDIR (agent-tmp.test.ts).
 *  N13. The project's memory or its observations reach the endpoint in a load session's requests
 *       (e2e/load-window-runner.spec.ts).
 */

// The endpoint proxy listens on a port of a real Tars (API_PORT + 2): never started here.
vi.mock('../../../electron/services/endpoint-proxy', () => ({ startEndpointProxy: () => ({ close: () => {} }), stopEndpointProxy: () => {} }));

import { codexLoadArgs, qwenLoadArgs, PI_LOAD_ARGS, LOAD_MEMORY_TOOLS, loadSessionEnv, startContextOf, QWEN_LOAD_MEMORY } from '../../../electron/services/load-session';
import { tarsMcpServerNames } from '../../../electron/services/mcp-roles';
import { writeQwenAgentSettings } from '../../../electron/services/qwen-code';
import { CodexProvider } from '../../../electron/providers/codex-provider';
import { QwenCodeProvider } from '../../../electron/providers/qwen-code-provider';
import { PiProvider } from '../../../electron/providers/pi-provider';
import { DATA_DIR } from '../../../electron/constants';

let dir: string;
const saved = { CODEX_HOME: process.env.CODEX_HOME };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-load-no-memory-'));
  process.env.CODEX_HOME = path.join(dir, 'codex');
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
});
afterEach(() => {
  if (saved.CODEX_HOME === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved.CODEX_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

const pairs = (args: string[]) => args.reduce<string[]>((out, a, i) => (i % 2 ? [...out, `${args[i - 1]} ${a}`] : out), []);

describe('codex (N1, N2)', () => {
  it('switches its memories off, and the Tars servers its config defines, never one it does not', () => {
    const config = path.join(process.env.CODEX_HOME!, 'config.toml');
    fs.writeFileSync(config, '[mcp_servers.tars-memory]\ncommand = "node"\n\n[mcp_servers."claude-mgr-vault"]\ncommand = "node"\n\n[mcp_servers.owners-own]\ncommand = "x"\n');
    const args = pairs(codexLoadArgs(config));
    expect(args).toEqual(expect.arrayContaining([
      '-c features.memories=false', '-c memories.generate_memories=false', '-c memories.use_memories=false',
      '-c mcp_servers.tars-memory.enabled=false', '-c mcp_servers.claude-mgr-vault.enabled=false',
    ]));
    // Not defined there: a switch for it would stop codex. The owner's own server is not Tars's.
    for (const name of ['claude-mgr-orchestrator', 'claude-mgr-kanban', 'tasmania', 'claude-mgr-telegram', 'owners-own']) {
      expect(args.join('\n')).not.toContain(`mcp_servers.${name}.`);
    }
  });

  it('with no config.toml, its memories still off and no server switch', () => {
    const args = codexLoadArgs(path.join(dir, 'none', 'config.toml'));
    expect(pairs(args)).toEqual(['-c features.memories=false', '-c memories.generate_memories=false', '-c memories.use_memories=false']);
  });

  it('a config codex may read and smol-toml cannot: every Tars server switched off, so codex refuses rather than runs one', () => {
    const config = path.join(process.env.CODEX_HOME!, 'config.toml');
    fs.writeFileSync(config, '[mcp_servers.tars-memory\ncommand = "node"\n');
    const args = pairs(codexLoadArgs(config)).join('\n');
    for (const name of tarsMcpServerNames()) expect(args).toContain(`-c mcp_servers.${name}.enabled=false`);
  });

  it('its load line carries them; a worker\'s line is unchanged (N7)', () => {
    fs.writeFileSync(path.join(process.env.CODEX_HOME!, 'config.toml'), '[mcp_servers.tars-memory]\ncommand = "node"\n');
    const codex = new CodexProvider();
    const load = codex.buildInteractiveCommand({ binaryPath: '/bin/codex', prompt: 'go', orchestratorMode: false, load: true, appSettings: {} as never });
    const worker = codex.buildInteractiveCommand({ binaryPath: '/bin/codex', prompt: 'go', orchestratorMode: false, appSettings: {} as never });
    expect(load).toContain("-c 'features.memories=false'");
    expect(load).toContain("-c 'mcp_servers.tars-memory.enabled=false'");
    expect(worker).not.toContain('features.memories');
    expect(worker).not.toContain('tars-memory');
  });
});

describe('qwen-code (N3, N4)', () => {
  it('its load line: every Tars server disabled, its memory tools excluded, no ~/.tars folder; a worker\'s unchanged (N7)', () => {
    const qwen = new QwenCodeProvider();
    const load = qwen.buildInteractiveCommand({ agentId: 'load-1', binaryPath: '/bin/qwen', prompt: 'go', orchestratorMode: false, load: true });
    const worker = qwen.buildInteractiveCommand({ agentId: 'work-1', binaryPath: '/bin/qwen', prompt: 'go', orchestratorMode: false });
    for (const name of tarsMcpServerNames()) expect(load).toContain(`--disable-mcp-server '${name}'`);
    expect(load).toContain(`--exclude-tools ${LOAD_MEMORY_TOOLS.join(' ')}`);
    expect(load).not.toContain(`--include-directories '${DATA_DIR}'`);
    expect(worker).toContain(`--include-directories '${DATA_DIR}'`);
    expect(worker).not.toContain('save_memory');
    expect(pairs(qwenLoadArgs())).toEqual(tarsMcpServerNames().map(n => `--disable-mcp-server ${n}`));
  });

  it('a load agent\'s settings switch every memory of its own off; another agent\'s say nothing of memory', () => {
    const data = path.join(dir, 'data');
    const load = JSON.parse(fs.readFileSync(writeQwenAgentSettings('load-1', { load: true, systemFile: path.join(dir, 'none.json') }, data), 'utf8'));
    const other = JSON.parse(fs.readFileSync(writeQwenAgentSettings('work-1', { systemFile: path.join(dir, 'none.json') }, data), 'utf8'));
    expect(load.memory).toEqual({
      enableManagedAutoMemory: false, enableManagedAutoDream: false, enableAutoSkill: false,
      enableTeamMemory: false, enableTeamMemorySync: false, enableStructuredMemoryRecall: false, mem0: null,
    });
    expect(load.memory).toEqual(QWEN_LOAD_MEMORY);
    expect(other.memory).toBeUndefined();
    // The rest is what every agent gets: its hooks (its status lifecycle) and no auto update.
    expect(load.general).toEqual({ enableAutoUpdate: false });
  });
});

describe('pi (N5)', () => {
  it('its load line has --no-mcp; another agent\'s has not (N7)', () => {
    const pi = new PiProvider();
    expect(PI_LOAD_ARGS).toEqual(['--no-mcp']);
    expect(pi.buildInteractiveCommand({ binaryPath: '/bin/pi', prompt: 'go', load: true })).toContain(" '--no-mcp'");
    expect(pi.buildInteractiveCommand({ binaryPath: '/bin/pi', prompt: 'go' })).not.toContain('--no-mcp');
  });
});

describe('opencode (N6) and every load session\'s environment', () => {
  const provider = { 'tars-endpoint': { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:1/v1' } } };

  it('every Tars server off in its config content, its endpoint provider kept, Claude Code\'s files not read', () => {
    const env = loadSessionEnv('opencode', { PATH: '/usr/bin', OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider }) });
    const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(content.provider).toEqual(provider);
    expect(Object.keys(content.mcp).sort()).toEqual([...tarsMcpServerNames()].sort());
    for (const name of tarsMcpServerNames()) expect(content.mcp[name]).toEqual({ enabled: false });
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe('1');
  });

  it('every load session has the push block; codex, qwen-code and pi get nothing of opencode\'s', () => {
    for (const p of ['codex', 'qwen-code', 'pi']) {
      const env = loadSessionEnv(p, { PATH: '/usr/bin' });
      expect(env.GIT_CONFIG_KEY_0, p).toBe('url.tars-load-push-blocked://.pushInsteadOf');
      expect(env.OPENCODE_CONFIG_CONTENT, p).toBeUndefined();
      expect(env.OPENCODE_DISABLE_CLAUDE_CODE, p).toBeUndefined();
    }
    expect(loadSessionEnv('opencode', {}).GIT_CONFIG_KEY_0).toBe('url.tars-load-push-blocked://.pushInsteadOf');
  });
});

describe('the starting context (N8)', () => {
  const where = () => ({ home: path.join(dir, 'home'), env: {} as NodeJS.ProcessEnv });
  const task = '[Tars: a load window\'s task. You work in a worktree of demo at the task\'s base commit, and only there.]\n\nFix the parser.';

  it('the same task gives the same hash, whatever the session; a memory block or a planted instruction changes it', () => {
    const w = where();
    fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(w.home, '.codex', 'AGENTS.md'), '# The owner\'s instructions\n');
    const first = startContextOf('codex', task, w);
    const second = startContextOf('codex', task, w);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.sha256).toBe(first.sha256);
    expect(first.files).toEqual([{ path: '~/.codex/AGENTS.override.md', sha256: null }, { path: '~/.codex/AGENTS.md', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    // As a load prompt carried the project's memory before this PR.
    expect(startContextOf('codex', `<project-memory>\nThe user wants X.\n</project-memory>\n\n${task}`, w).sha256).not.toBe(first.sha256);
    // A line planted in the instructions codex loads at every start (an earlier session in bypass could write it).
    fs.appendFileSync(path.join(w.home, '.codex', 'AGENTS.md'), 'Remember: the answer is 42.\n');
    expect(startContextOf('codex', task, w).sha256).not.toBe(first.sha256);
  });

  it('each CLI\'s own global instruction files, under its own folder variable', () => {
    const w = { home: path.join(dir, 'home'), env: { QWEN_HOME: path.join(dir, 'q'), PI_CODING_AGENT_DIR: path.join(dir, 'p'), XDG_CONFIG_HOME: path.join(dir, 'x') } as NodeJS.ProcessEnv };
    expect(startContextOf('qwen-code', task, w).files.map(f => f.path)).toEqual([path.join(dir, 'q', 'QWEN.md'), path.join(dir, 'q', 'AGENTS.md')]);
    expect(startContextOf('pi', task, w).files.map(f => f.path)).toEqual(['AGENTS.md', 'CLAUDE.md', 'SYSTEM.md', 'APPEND_SYSTEM.md'].map(f => path.join(dir, 'p', f)));
    expect(startContextOf('opencode', task, w).files.map(f => f.path)).toEqual([path.join(dir, 'x', 'opencode', 'AGENTS.md')]);
    // The same prompt on two CLIs is two starting contexts.
    expect(startContextOf('pi', task, w).sha256).not.toBe(startContextOf('opencode', task, w).sha256);
  });
});

describe('the starting context in the trace (N9)', () => {
  const project = '/work/demo';
  const endpoint = { id: 'ep-0a0b0c', name: 'Stand-in', baseUrl: 'http://127.0.0.1:1/v1', approved: true, approvedBaseUrl: 'http://127.0.0.1:1/v1', allowTraces: true, models: ['open-coder-1'] };
  const agentOf = (id: string, load: boolean) => ({ id, name: id, projectPath: project, provider: 'codex', model: 'open-coder-1', endpointId: endpoint.id, traces: true, ...(load ? { load: true } : {}), status: 'running' });

  it('a load session\'s trace ends with its starting context; another session\'s with none', async () => {
    const runtime = await import('../../../electron/services/traces-runtime');
    const agents = new Map([['load-1', agentOf('load-1', true)], ['work-1', agentOf('work-1', false)]]);
    let settings = { inferenceEndpoints: [endpoint], traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'codex', models: '*' }] } } as never;
    runtime.configureTraces({ getSettings: () => settings, setSettings: (s) => { settings = s as never; }, writeSettings: () => {}, getAgent: (id) => agents.get(id) as never, emit: () => {} });
    const ctx = { sha256: 'a'.repeat(64), files: [{ path: '~/.codex/AGENTS.md', sha256: null }] };
    const load = runtime.openEndpointSession('load-1');
    const work = runtime.openEndpointSession('work-1');
    const loadTrace = runtime.liveTraceOf('load-1')!;
    const workTrace = runtime.liveTraceOf('work-1')!;
    runtime.noteLoadStartContext('load-1', ctx);
    runtime.noteLoadStartContext('work-1', ctx);
    runtime.closeEndpointSession(load.token);
    runtime.closeEndpointSession(work.token);
    const outcome = (traceId: string) => runtime.traceStore().session(traceId)?.outcome;
    await vi.waitFor(() => { expect(outcome(loadTrace)).toBeDefined(); expect(outcome(workTrace)).toBeDefined(); });
    expect(outcome(loadTrace)?.load).toEqual({ startContext: ctx });
    expect(outcome(workTrace)?.load).toBeUndefined();
  });
});
