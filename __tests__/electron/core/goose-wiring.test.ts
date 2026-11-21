import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

/**
 * A Goose terminal, spawned the way every agent terminal is (spawnAgentPty, initAgentPty), reaches Goose's session
 * watch with what its line says and the terminal itself, and runs in the permission mode the agent was given.
 *
 * How it fails, written before the wiring (t-7c3b02f7, Goose, 20/11):
 * 1. A Goose launch never noted, or noted without the session its line forks: a restart's fork is never bound and its
 *    turns never read. Or its terminal's exit never forgets it: read every second for the rest of the run.
 * 2. What Tars types into a Goose terminal never reaches its watch: a task delivered without an identity line binds
 *    nothing, and its answer never comes back.
 * 3. A Goose agent's terminal without the mode it was given: Goose reads it from GOOSE_MODE only (1.60.1 has no flag),
 *    so a normal agent would run in the user's own mode, or an auto one stop on dialogs nobody answers. In the
 *    terminal's environment for Windows, where the line's first word is the binary and nothing else is read; the line
 *    carries it on macOS and Linux (goose-adapter.test.ts).
 * 4. (The Audit's L3 on #618) A launch that starts a Goose agent's conversation over, because the servers its session
 *    saved are not this launch's, says nothing: the window shows a fresh conversation with no reason. It is said where
 *    a person reads the agent's kept output (Logs), in the window's words, for each cause: its role changed, Tars's
 *    servers moved, or a server was added or taken away (the Audit's I-4: an update that adds a server starts one
 *    fresh session per Goose agent). A launch that continues its session says nothing.
 */

const ptys: Array<{ onExit: ReturnType<typeof vi.fn>; env: Record<string, string>; write: ReturnType<typeof vi.fn> }> = [];
vi.mock('node-pty', () => ({
  spawn: vi.fn((_shell: string, _args: string[], opts: { env: Record<string, string> }) => {
    const pty = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn(), pid: 1, resize: vi.fn(), env: opts.env };
    ptys.push(pty);
    return pty;
  }),
}));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'test-uuid') }));
vi.mock('../../../electron/services/tasmania-client', () => ({ getTasmaniaStatus: vi.fn(async () => ({ status: 'stopped' })) }));
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, BrowserWindow: vi.fn(), Notification: vi.fn() }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/utils/agents-tick', () => ({ scheduleTick: vi.fn() }));
vi.mock('../../../electron/services/agent-events', () => ({ emitAgentStatus: vi.fn() }));
vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { initAgentPty, agents } from '../../../electron/core/agent-manager';
import { writeProgrammaticInput } from '../../../electron/core/pty-manager';
import type { AgentStatus } from '../../../electron/types';
import { moveTestHome } from '../../setup/test-home';
import { gooseSessionWatch, type HookPost } from '../../../electron/services/goose-sessions';
import { gooseDbPath, gooseUuidOf } from '../../../electron/providers/goose-cli';
import { GooseProvider } from '../../../electron/providers/goose-provider';
import { getProvider } from '../../../electron/providers';

const AGENT = 'a1b2c3d4-0000-4000-8000-00000000000c';
const S = '20261120_1';
const FORK = '20261120_2';
let root: string;
let project: string;
let posts: Array<{ agentId: string; post: HookPost }>;

beforeEach(() => {
  ptys.length = 0;
  posts = [];
  root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-goose-wiring-')));
  project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
  gooseSessionWatch.setDeps({ post: async (agentId, post) => { posts.push({ agentId, post }); } });
});
afterEach(() => {
  for (const pty of ptys) for (const [listener] of pty.onExit.mock.calls as Array<[(e: { exitCode?: number }) => void]>) listener({ exitCode: 0 });
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const utc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
/** Goose's database with the sessions given, each with its messages, as Goose 1.60.1 writes them. */
function gooseDb(sessions: Array<{ id: string; at: number; messages: Array<{ at: number; role: string; text: string }> }>): void {
  const file = gooseDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, working_dir TEXT NOT NULL, created_at TIMESTAMP, parent_session_id TEXT);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL, metadata_json TEXT);
    CREATE TABLE IF NOT EXISTS usage_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_timestamp INTEGER NOT NULL, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER);`);
  for (const s of sessions) {
    db.prepare('INSERT INTO sessions (id, working_dir, created_at) VALUES (?, ?, ?)').run(s.id, project, utc(s.at));
    for (const m of s.messages) {
      db.prepare('INSERT INTO messages (session_id, role, content_json, created_timestamp, metadata_json) VALUES (?, ?, ?, ?, ?)')
        .run(s.id, m.role, JSON.stringify([{ type: 'text', text: m.text }]), Math.floor(m.at / 1000), '{"userVisible":true,"agentVisible":true}');
    }
  }
  db.close();
}
const exitLast = () => {
  for (const [listener] of ptys[ptys.length - 1].onExit.mock.calls as Array<[(e: { exitCode?: number }) => void]>) listener({ exitCode: 0 });
};

describe("a Goose terminal and Goose's watch (1, 2)", () => {
  it("1: notes a restart's fork, binds the fork, and forgets it at the terminal's exit", async () => {
    const line = new GooseProvider().buildInteractiveCommand({ binaryPath: '/opt/goose', prompt: '', resumeSessionId: S, forkSession: true });
    const now = Date.now();
    spawnAgentPty({ binaryName: 'goose', shell: '/bin/bash', args: ['-l', '-c', `cd '${project}' && exec ${line}`], cwd: project, cols: 80, rows: 24, env: { CLAUDE_AGENT_ID: AGENT } });
    expect(gooseSessionWatch.watching).toBe(true);
    const first = 'a first prompt long ago, with no identity line in it';
    gooseDb([
      { id: S, at: now - 60_000, messages: [{ at: now - 59_000, role: 'user', text: first }] },
      { id: FORK, at: now + 1_000, messages: [{ at: now - 59_000, role: 'user', text: first }, { at: now + 2_000, role: 'user', text: 'go on' }, { at: now + 3_000, role: 'assistant', text: 'the answer' }] },
    ]);
    await gooseSessionWatch.tick();
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((p) => p.agentId === AGENT && p.post.body.session_id === gooseUuidOf(FORK))).toBe(true);
    expect(posts.filter((p) => p.post.path === '/api/hooks/output').map((p) => p.post.body.output)).toEqual(['the answer']);
    exitLast();
    expect(gooseSessionWatch.watching).toBe(false);
  });

  it('2: a task Tars types into the terminal binds the session whose first prompt holds it', async () => {
    const line = new GooseProvider().buildInteractiveCommand({ binaryPath: '/opt/goose', prompt: '' });
    const now = Date.now();
    spawnAgentPty({ binaryName: 'goose', shell: '/bin/bash', args: ['-l', '-c', `cd '${project}' && exec ${line}`], cwd: project, cols: 80, rows: 24, env: { CLAUDE_AGENT_ID: AGENT } });
    const task = 'Message from agent "Lead": run the probe and say what it printed';
    writeProgrammaticInput(ptys[ptys.length - 1] as never, task, true, { agentId: AGENT } as never);
    gooseDb([{ id: S, at: now + 1_000, messages: [{ at: now + 2_000, role: 'user', text: task }, { at: now + 3_000, role: 'assistant', text: 'printed it' }] }]);
    await gooseSessionWatch.tick();
    expect(posts.filter((p) => p.post.path === '/api/hooks/output').map((p) => [p.agentId, p.post.body.output])).toEqual([[AGENT, 'printed it']]);
  });
});

describe("a Goose agent's permission mode, at its terminal's spawn (3)", () => {
  it('normal asks (approve), auto and bypass never do (auto)', async () => {
    const restoreHome = moveTestHome(path.join(root, 'home'));
    try {
      const envOf = async (permissionMode: AgentStatus['permissionMode']) => {
        agents.clear();
        const agent = {
          id: `goose-${permissionMode}`, name: 'g', status: 'idle', provider: 'goose', role: 'worker', projectPath: project, permissionMode,
          skills: [], output: [], lastActivity: new Date().toISOString(),
        } as AgentStatus;
        await initAgentPty(agent, null, vi.fn(), vi.fn());
        return ptys[ptys.length - 1].env;
      };
      expect((await envOf('normal')).GOOSE_MODE).toBe('approve');
      expect((await envOf('auto')).GOOSE_MODE).toBe('auto');
      expect((await envOf('bypass')).GOOSE_MODE).toBe('auto');
    } finally {
      restoreHome();
    }
  });
});

describe('a fresh session said where a person reads it (4, the Audit\'s L3 on #618)', () => {
  const ORCH = { name: 'claude-mgr-orchestrator', cmd: '/opt/node', args: ['/res/mcp-orchestrator/dist/bundle.js'] };
  const X = { name: 'dorothy-x', cmd: '/opt/node', args: ['/res/mcp-x/dist/bundle.js'] };
  const MEMORY = { name: 'tars-memory', cmd: '/opt/node', args: ['/res/mcp-memory/dist/bundle.js'] };
  const goose = getProvider('goose');
  afterEach(async () => {
    for (const name of [ORCH.name, X.name, MEMORY.name]) await goose.removeMcpServer(name);
    agents.clear();
  });
  function savedWith(servers: Array<{ name: string; cmd: string; args: string[] }>): void {
    const file = gooseDbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, working_dir TEXT NOT NULL, created_at TIMESTAMP, extension_data TEXT)');
    const extensions = servers.map((x) => ({ type: 'stdio', name: x.name, cmd: x.cmd, args: x.args, envs: {} }));
    db.prepare("INSERT OR REPLACE INTO sessions (id, working_dir, created_at, extension_data) VALUES (?, ?, '2026-11-20 16:31:10', ?)")
      .run(S, project, JSON.stringify({ 'enabled_extensions.v0': { extensions } }));
    db.close();
  }
  async function launch(registered: Array<typeof ORCH>, orchestratorMode: boolean): Promise<string> {
    for (const x of registered) await goose.registerMcpServer(x.name, x.cmd, x.args);
    const agent = { id: AGENT, name: 'g', status: 'idle', provider: 'goose', role: orchestratorMode ? 'orchestrator' : 'worker', projectPath: project, skills: [], output: [], lastActivity: new Date().toISOString() } as AgentStatus;
    agents.set(AGENT, agent);
    const line = goose.buildInteractiveCommand({ agentId: AGENT, binaryPath: '/opt/goose', prompt: '', resumeSessionId: S, orchestratorMode });
    expect(line, 'a fresh session').not.toContain('--resume');
    return agent.output.join('');
  }

  it('its role changed', async () => {
    savedWith([ORCH, X]);
    expect(await launch([ORCH, X], false)).toContain('[Tars] Its conversation starts over: its servers changed with its role');
  });

  it("Tars's servers moved", async () => {
    savedWith([ORCH]);
    expect(await launch([{ ...ORCH, args: ['/new/res/mcp-orchestrator/dist/bundle.js'] }], false)).toContain("[Tars] Its conversation starts over: Tars's servers moved since its session began");
  });

  it('a server was added (I-4) or taken away', async () => {
    savedWith([ORCH]);
    expect(await launch([ORCH, MEMORY], false)).toContain("[Tars] Its conversation starts over: Tars's servers changed since its session began");
    agents.clear();
    savedWith([ORCH, MEMORY]);
    await goose.removeMcpServer(MEMORY.name);
    expect(await launch([ORCH], false)).toContain("[Tars] Its conversation starts over: Tars's servers changed since its session began");
  });

  it('a launch that continues its session says nothing', async () => {
    savedWith([ORCH]);
    for (const x of [ORCH, X]) await goose.registerMcpServer(x.name, x.cmd, x.args);
    const agent = { id: AGENT, name: 'g', status: 'idle', provider: 'goose', role: 'worker', projectPath: project, skills: [], output: [], lastActivity: new Date().toISOString() } as AgentStatus;
    agents.set(AGENT, agent);
    expect(goose.buildInteractiveCommand({ agentId: AGENT, binaryPath: '/opt/goose', prompt: '', resumeSessionId: S, orchestratorMode: false })).toContain('--resume');
    expect(agent.output.join('')).not.toContain('[Tars]');
  });
});
