import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

/**
 * A Kilo terminal, spawned the way every agent terminal is (spawnAgentPty), reaches Kilo's own session watch as an
 * opencode terminal reaches opencode's: with what its line says (the session it forks, the prompt it starts on) and
 * the terminal itself, which forgets the launch at its exit (the Audit's re-read of #613, for #614's rebase).
 *
 * How it fails, written for the rebase of #614 onto #613's fixes:
 * 1. A Kilo launch noted by the session its line resumes only: a restart's `--session S --fork` noted with nothing, so
 *    the fork it makes is never bound and its turns never read (M1, back for Kilo).
 * 2. A Kilo terminal's exit forgetting only opencode's watch: Kilo's launch read every second for the rest of the run
 *    (I-a, back for Kilo).
 * 3. A Kilo launch noted in opencode's watch, or an opencode one in Kilo's: a turn read from the wrong database.
 * 4. (The #614 Audit's Info 5) A Kilo worker's terminal spawned without the role reaching its provider: it keeps X and
 *    Telegram (kilo-adapter.test.ts, case 12, for what the provider does with it).
 */

const ptys: Array<{ onExit: ReturnType<typeof vi.fn>; env: Record<string, string> }> = [];
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
import type { AgentStatus } from '../../../electron/types';
import { moveTestHome } from '../../setup/test-home';
import { opencodeWatchFor, type HookPost } from '../../../electron/services/opencode-sessions';
import { opencodeDbPath, opencodeUuidOf } from '../../../electron/providers/opencode-cli';
import { KiloProvider } from '../../../electron/providers/kilo-provider';

const AGENT = 'a1b2c3d4-0000-4000-8000-00000000000b';
const S = 'ses_e085d0587ffeOy1kXK0heSjjPE';
const FORK = 'ses_e085c632dffeRCzXYzfxOcfqmU';
let root: string;
let project: string;

beforeEach(() => {
  ptys.length = 0;
  root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-builds-wiring-')));
  project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Kilo's database with S, a turn before the launch, and the fork a restart makes, as opencode's builds write one. */
function kiloForked(after: number): void {
  const file = opencodeDbPath(process.env, os.homedir(), 'kilo');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, time_created integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);`);
  const msg = (sid: string, id: string, at: number, data: Record<string, unknown>, text: string) => {
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(id, sid, at, at, JSON.stringify(data));
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(`prt_${id}`, id, sid, at, at, JSON.stringify({ type: 'text', text }));
  };
  for (const [sid, at] of [[S, 500], [FORK, after]] as const) {
    db.prepare('INSERT INTO session (id, directory, time_created) VALUES (?, ?, ?)').run(sid, project, at);
    msg(sid, `msg_${sid}_1`, 501, { role: 'user', time: { created: 501 } }, 'a first prompt long ago, with no identity line in it');
  }
  msg(FORK, 'msg_new_1', after + 1, { role: 'user', time: { created: after + 1 } }, 'go on');
  msg(FORK, 'msg_new_2', after + 2, { role: 'assistant', modelID: 'm', finish: 'stop', time: { created: after + 2, completed: after + 3 } }, 'the answer');
  db.close();
}

describe("a Kilo terminal and Kilo's watch", () => {
  it("notes a restart's fork in Kilo's watch only, binds the fork in kilo.db, and forgets it at the terminal's exit", async () => {
    const kiloWatch = opencodeWatchFor('kilo')!;
    const opencodeWatch = opencodeWatchFor('opencode')!;
    const posts: Array<{ agentId: string; post: HookPost }> = [];
    kiloWatch.setDeps({ post: async (agentId, post) => { posts.push({ agentId, post }); } });
    const line = new KiloProvider().buildInteractiveCommand({ binaryPath: '/opt/kilo', prompt: '', resumeSessionId: S, forkSession: true });
    spawnAgentPty({ binaryName: 'kilo', shell: '/bin/bash', args: ['-l', '-c', `cd '${project}' && exec ${line}`], cwd: project, cols: 80, rows: 24, env: { CLAUDE_AGENT_ID: AGENT } });
    expect(kiloWatch.watching).toBe(true);
    expect(opencodeWatch.watching).toBe(false);

    kiloForked(Date.now() + 1_000);
    await kiloWatch.tick();
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((p) => p.agentId === AGENT && p.post.body.session_id === opencodeUuidOf(FORK))).toBe(true);
    expect(posts.filter((p) => p.post.path === '/api/hooks/output').map((p) => p.post.body.output)).toEqual(['the answer']);

    // The terminal exits: every listener it was given hears it, as node-pty's would.
    for (const [listener] of ptys[ptys.length - 1].onExit.mock.calls as Array<[(e: { exitCode?: number }) => void]>) listener({ exitCode: 0 });
    expect(kiloWatch.watching).toBe(false);
  });
});

describe("a Kilo agent's role, at its terminal's spawn (4)", () => {
  it("a worker's terminal carries Kilo's switch for X and Telegram, an orchestrator's does not", async () => {
    const restoreHome = moveTestHome(path.join(root, 'home'));
    try {
      const envOf = async (role: 'worker' | 'orchestrator') => {
        agents.clear();
        const agent = {
          id: `kilo-${role}`, name: role, status: 'idle', provider: 'kilo', role, projectPath: project,
          skills: [], output: [], lastActivity: new Date().toISOString(),
        } as AgentStatus;
        await initAgentPty(agent, null, vi.fn(), vi.fn());
        return ptys[ptys.length - 1].env;
      };
      const worker = await envOf('worker');
      expect(JSON.parse(worker.KILO_CONFIG_CONTENT ?? '{}').mcp).toEqual({ 'claude-mgr-telegram': { enabled: false }, 'dorothy-x': { enabled: false } });
      const lead = await envOf('orchestrator');
      expect(lead.KILO_CONFIG_CONTENT).toBeUndefined();
    } finally {
      restoreHome();
    }
  });
});
