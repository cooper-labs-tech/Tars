import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A terminal Tars replaces, for a new provider, a new CLI, another folder or other keys, or to start a CLI in it,
 * ends with everything its CLI started, before the next one opens: as a stop ends it (agent-stop.ts) and, since
 * #620, a restart (agent-restart.ts), with endTerminalTree.
 *
 * Found by Backend-5 in Cline's conformance (#620): the hangup alone ended Cline's node launcher, and left the .cline
 * it waits on orphaned and stopped, holding the agent's folder after Tars had quit. Every other place that replaced
 * an agent's terminal ended it with that hangup:
 * - a new provider or CLI path (core/agent-update.ts);
 * - a stale terminal, opened in another folder than the agent's or with other keys (killStalePty, agent-manager.ts):
 *   a project or a worktree moved (agent-update.ts), and every start, dispatch, message and bot launch before it
 *   opens one (ipc-handlers.ts agent:start, agent-routes.ts /dispatch and /message, bot-core.ts);
 * - the terminal a start opens again: the local provider's, for its own environment (ipc-handlers.ts), an API
 *   session's (spawnAgentSession, agent-routes.ts), and the shell a Windows start replaces with its CLI
 *   (startCliInTerminal, agent-manager.ts).
 *
 * How it fails, written before the code:
 * 1. A CLI deaf to the hangup, or one its launcher does not pass the hangup on to, and what it started, outlive the
 *    change or the start that replaced its terminal.
 * 2. The new terminal opens, or the update answers (and the start the window sends next opens one), while the old
 *    CLI still runs on the same folder.
 * 3. The agent still names the old terminal while it is being ended, which takes up to its grace: its exit is then
 *    taken for the agent's (an exit acts only for the terminal its agent names), or a message typed into it.
 * 4. A terminal that is not stale ended, or anything ended by an update that was refused (the Audit's MEDIUM on
 *    #403: a refused save changes nothing and kills no terminal).
 * 5. An end that fails (no ps to read) stops the update or the start, or goes unsaid: it is said, and they go on.
 * 6. A caller that does not wait for the end: killStalePty now ends a tree, which takes up to its grace, and a call
 *    left unawaited opens the new terminal beside the old one.
 * 7. A platform left out. Windows has neither process groups nor ps: there the tree goes by taskkill /T while the
 *    shell still runs, then the console is closed (endTerminalTree's own path, endTreeBeforeConsole in
 *    pty-manager.ts). So every site calls endTerminalTree on every system, and none keeps the hangup alone.
 * 8. Nothing tells the senders a replacement is under way (the Audit's L4 on #620, the same gap on these paths): for
 *    up to the grace the agent has no terminal and no launch, and a task delegated or a message sent then (the
 *    orchestrator's update_agent, then a task at once) launches the agent beside the tree being ended. Every sender
 *    asks sessionStarting before it launches or types (/dispatch and /run-task through performDispatch, /message,
 *    the bots, the chat runners, the writer): the replacement must read as a launch on its way until its tree is
 *    gone (endReplacedTerminal, core/agent-launch.ts), and stop reading so once it is, failed or not.
 *
 * The "terminal" is a real process group where node-pty's shell would be, as in restart-ends-tree.test.ts (#620),
 * in Cline's shape: a bash leader that relays the hangup to its job, as an interactive shell does; the job, a
 * launcher that dies of the hangup and waits on its child; the child, deaf to SIGHUP and SIGTERM, as .cline was.
 */

const h = vi.hoisted(() => ({ watch: [] as number[], opened: [] as boolean[], endFails: false }));

type ExitListener = (e: { exitCode: number; signal?: number }) => void;
// The terminals initAgentPty opens (startCliInTerminal's, 7): each notes whether the old tree was still there.
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string, args: string[] | string, opts: { name: string }) => {
    h.opened.push(h.watch.some((pid) => alive(pid)));
    const exits: ExitListener[] = [];
    return {
      file, args, opts, pid: 7000 + h.opened.length, process: opts.name,
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(() => ({ dispose() {} })),
      onExit: vi.fn((listener: ExitListener) => { exits.push(listener); return { dispose() {} }; }),
    };
  }),
}));
let uuid = 0;
vi.mock('uuid', () => ({ v4: vi.fn(() => `uuid-${++uuid}`) }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/utils/agents-tick', () => ({ scheduleTick: vi.fn() }));
vi.mock('../../../electron/services/agent-events', () => ({ emitAgentStatus: vi.fn() }));
vi.mock('../../../electron/services/tasmania-client', () => ({ getTasmaniaStatus: vi.fn(async () => ({ status: 'stopped' })) }));
vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));
// The end, failing when a case says so (5): a machine without ps, or one that refuses it.
vi.mock('../../../electron/core/pty-manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../electron/core/pty-manager')>();
  return {
    ...real,
    endTerminalTree: (...a: Parameters<typeof real.endTerminalTree>) =>
      (h.endFails ? Promise.reject(new Error('ps: command not found')) : real.endTerminalTree(...a)),
  };
});
vi.setConfig({ testTimeout: 20_000 });

import { agents, killStalePty, initAgentPty, startCliInTerminal } from '../../../electron/core/agent-manager';
import { updateAgent } from '../../../electron/core/agent-update';
import { sessionStarting, sessionStarted } from '../../../electron/core/agent-launch';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { toLaunch, type DirectLaunch } from '../../../electron/platform/launch';
import type { FsProbe } from '../../../electron/platform/fs-probe';
import type { IPty } from 'node-pty';
import type { AgentStatus } from '../../../electron/types';
import { moveTestHome } from '../../setup/test-home';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-replaced-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-replaced-project-'));
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-replaced-elsewhere-'));
let restoreHome: () => void;
const started: ChildProcess[] = [];
const leftovers: number[] = [];

beforeEach(() => {
  h.watch.length = 0;
  h.opened.length = 0;
  h.endFails = false;
  agents.clear();
  ptyProcesses.clear();
  restoreHome = moveTestHome(home);
});
afterEach(() => {
  for (const pid of leftovers.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const c of started.splice(0)) { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ } }
  ptyProcesses.clear();
  agents.clear();
  restoreHome();
  vi.restoreAllMocks();
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim().startsWith('Z'); } catch { return false; }
}

/** A terminal whose CLI is a launcher with a child deaf to the hangup, the launcher not: Cline's node and .cline. */
async function launcherTerminal(): Promise<{ pty: IPty; launcher: number; child: number }> {
  const T = `${process.env.TMPDIR || '/tmp'}/tars-replaced-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const script = `
    set -m
    bash -c 'bash -c "$CHILD" & echo $! > "$0.child"; wait' "$T" &
    job=$!
    echo $job > "$T.job"
    trap 'kill -HUP -$job 2>/dev/null; exit 0' HUP
    wait
  `;
  const env = { ...process.env, T, CHILD: 'trap "" HUP TERM; exec sleep 300' };
  const leader = spawn('/bin/bash', ['-c', script], { detached: true, stdio: 'ignore', env });
  started.push(leader);
  const read = (f: string) => { try { return Number(fs.readFileSync(f, 'utf-8').trim()); } catch { return 0; } };
  for (let i = 0; i < 100 && !(read(`${T}.job`) && read(`${T}.child`)); i++) await new Promise((r) => setTimeout(r, 20));
  const exits: ExitListener[] = [];
  leader.on('exit', (code) => { for (const cb of [...exits]) cb({ exitCode: code ?? 1 }); });
  const pty = {
    pid: leader.pid!,
    kill: (signal = 'SIGHUP') => { process.kill(leader.pid!, signal as NodeJS.Signals); },
    onExit: (cb: ExitListener) => { exits.push(cb); return { dispose() {} }; },
    write: () => {},
  } as unknown as IPty;
  const launcher = read(`${T}.job`);
  const child = read(`${T}.child`);
  for (const f of [`${T}.job`, `${T}.child`]) fs.rmSync(f, { force: true });
  leftovers.push(launcher, child);
  expect(alive(launcher) && alive(child), 'the fixture did not start').toBe(true);
  h.watch.push(launcher, child);
  return { pty, launcher, child };
}

function agentIn(terminal: IPty, fields: Partial<AgentStatus> = {}): AgentStatus {
  ptyProcesses.set('pty-old', terminal);
  const agent = {
    id: 'a1', name: 'Worker', status: 'running', provider: 'gemini', permissionMode: 'bypass', projectPath: project,
    skills: [], output: [], lastActivity: '', ptyId: 'pty-old', ptyCwd: project, currentTask: 'reading the repo',
    ...fields,
  } as unknown as AgentStatus;
  agents.set(agent.id, agent);
  return agent;
}

const gone = (t: { launcher: number; child: number }) => ({ launcher: alive(t.launcher), child: alive(t.child) });
const GONE = { launcher: false, child: false };

// A bash process group read through ps: POSIX only, as agent-stop.test.ts's and restart-ends-tree.test.ts's.
const posixGroups = it.skipIf(process.platform === 'win32');

describe('an update that needs a new terminal', () => {
  posixGroups('a new provider: the launcher and the child it waits on are gone before the update answers, the agent naming no terminal from its first line on (1, 2, 3)', async () => {
    const t = await launcherTerminal();
    const agent = agentIn(t.pty);

    const answer = updateAgent({ id: 'a1', provider: 'codex' });
    expect(agent.ptyId, 'the agent still named the terminal being ended').toBeUndefined();
    expect(ptyProcesses.has('pty-old')).toBe(false);
    const result = await answer;

    expect(result.success).toBe(true);
    expect(gone(t), 'the old CLI, or what its launcher started, outlived the update').toEqual(GONE);
    expect(agent.provider).toBe('codex');
    expect(agent.status).toBe('idle');
  });

  posixGroups('a new CLI path: the same (1, 2, 3)', async () => {
    const t = await launcherTerminal();
    const agent = agentIn(t.pty);

    const answer = updateAgent({ id: 'a1', cliPath: '/opt/gemini/bin/gemini' });
    expect(agent.ptyId).toBeUndefined();
    expect((await answer).success).toBe(true);
    expect(gone(t)).toEqual(GONE);
  });

  posixGroups('another project: the terminal left in the old one goes with its tree before the answer (1, 2, 3, 6)', async () => {
    const t = await launcherTerminal();
    const agent = agentIn(t.pty);

    const answer = updateAgent({ id: 'a1', projectPath: elsewhere });
    expect(agent.ptyId).toBeUndefined();
    expect((await answer).success).toBe(true);
    expect(gone(t)).toEqual(GONE);
    expect(agent.projectPath).toBe(elsewhere);
  });

  posixGroups('refused, it ends nothing (4)', async () => {
    const t = await launcherTerminal();
    const agent = agentIn(t.pty);

    const result = await updateAgent({ id: 'a1', provider: 'codex', skills: ['../not a skill'] });
    expect(result.success).toBe(false);
    expect(agent.ptyId).toBe('pty-old');
    expect(agent.provider).toBe('gemini');
    await new Promise((r) => setTimeout(r, 300));
    expect(gone(t)).toEqual({ launcher: true, child: true });
  });
});

describe('a stale terminal (killStalePty)', () => {
  posixGroups('one in another folder is ended with its tree before the call resolves, and the agent names none from the call on (1, 2, 3, 6)', async () => {
    const t = await launcherTerminal();
    const agent = agentIn(t.pty, { ptyCwd: elsewhere });

    const ended = killStalePty(agent);
    expect(agent.ptyId).toBeUndefined();
    expect(ptyProcesses.has('pty-old')).toBe(false);
    expect(await ended).toBe(true);
    expect(gone(t)).toEqual(GONE);
  });

  posixGroups('one that is not stale is left as it is (4)', async () => {
    const t = await launcherTerminal();
    const agent = agentIn(t.pty);

    expect(await killStalePty(agent)).toBe(false);
    expect(agent.ptyId).toBe('pty-old');
    expect(ptyProcesses.get('pty-old')).toBe(t.pty);
    await new Promise((r) => setTimeout(r, 300));
    expect(gone(t)).toEqual({ launcher: true, child: true });
  });
});

describe('an end that fails (5)', () => {
  it('is said, and the update and the start go on, the agent naming no terminal', async () => {
    h.endFails = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const terminal = { pid: 4242, kill: vi.fn(), onExit: () => ({ dispose() {} }), write: vi.fn() } as unknown as IPty;

    const updated = agentIn(terminal);
    expect((await updateAgent({ id: 'a1', provider: 'codex' })).success).toBe(true);
    expect(updated.ptyId).toBeUndefined();

    const stale = agentIn(terminal, { id: 'a2', ptyCwd: elsewhere } as Partial<AgentStatus>);
    expect(await killStalePty(stale)).toBe(true);
    expect(stale.ptyId).toBeUndefined();

    const said = warn.mock.calls.map((c) => c.map(String).join(' '));
    expect(said.filter((line) => /ps: command not found/.test(line)), said.join('\n')).toHaveLength(2);
    expect(sessionStarting(updated) || sessionStarting(stale), 'a failed end held the senders for good (8)').toBe(false);
  });
});

describe('a task sent while the old tree ends (8)', () => {
  // What /dispatch, /run-task (performDispatch), /message, the bots and the chat runners do before they launch the
  // agent or type into it: wait while its session is starting.
  posixGroups('after a provider change: it waits for the old tree to be gone, then goes ahead', async () => {
    const t = await launcherTerminal();
    const agent = agentIn(t.pty);

    const answer = updateAgent({ id: 'a1', provider: 'codex' });
    expect(sessionStarting(agent), 'the task would launch the agent beside the tree being ended').toBe(true);
    expect(await sessionStarted(agent, 10_000), 'the task waited past the end').toBe(true);
    expect(gone(t), 'the task went ahead while the old tree still ran').toEqual(GONE);
    expect((await answer).success).toBe(true);
    expect(sessionStarting(agent)).toBe(false);
  });

  posixGroups('after a stale terminal is ended (killStalePty): the same', async () => {
    const t = await launcherTerminal();
    const agent = agentIn(t.pty, { ptyCwd: elsewhere });

    const ended = killStalePty(agent);
    expect(sessionStarting(agent)).toBe(true);
    expect(await sessionStarted(agent, 10_000)).toBe(true);
    expect(gone(t)).toEqual(GONE);
    expect(await ended).toBe(true);
    expect(sessionStarting(agent)).toBe(false);
  });
});

describe("the shell a Windows start replaces with its CLI (startCliInTerminal)", () => {
  // The start's launch is Windows's; the shell it replaces, a real tree here: what is asserted is the order, the
  // tree ended before the CLI's terminal opens. On Windows itself endTerminalTree takes it down with taskkill /T (7).
  const CLI_DIR = 'C:\\Users\\Sam Lee\\.local\\bin';
  const CLAUDE_EXE = `${CLI_DIR}\\claude.exe`;
  const winFs: FsProbe = {
    isFile: (p) => p.toLowerCase() === CLAUDE_EXE.toLowerCase(),
    readFile: (p) => { throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' }); },
  };

  posixGroups('ends it with what runs under it before the CLI\'s terminal opens (1, 2, 3, 7)', async () => {
    const t = await launcherTerminal();
    const agent = agentIn(t.pty, { provider: 'claude', status: 'idle', currentTask: undefined });
    const env = { Path: CLI_DIR, CLAUDE_AGENT_ID: agent.id, CLAUDE_PROJECT_PATH: project };
    const launch = toLaunch(`'claude' --permission-mode default`, project, env, 'win32', { fs: winFs }) as DirectLaunch;
    const open = (a: AgentStatus) => initAgentPty(a, null, vi.fn(), vi.fn());

    await startCliInTerminal(agent, launch, { ptyProcesses, initAgentPty: open });

    expect(h.opened, 'the CLI\'s terminal opened while the shell it replaced, or what ran under it, still ran').toEqual([false]);
    expect(gone(t)).toEqual(GONE);
    expect(agent.ptyId).toBe('uuid-1');
  });
});

describe('every place that replaces an agent terminal', () => {
  const electronDir = path.resolve(__dirname, '../../../electron');
  const source = (f: string) => fs.readFileSync(path.join(electronDir, f), 'utf8');
  const sources = (dir: string): string[] => fs.readdirSync(path.join(electronDir, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'dist' ? [] : sources(path.join(dir, e.name))) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);

  it('ends it with its tree (endTerminalTree), never with the hangup alone (1, 7)', () => {
    for (const f of ['core/agent-update.ts', 'core/agent-manager.ts', 'services/api-routes/agent-routes.ts', 'services/bot-core.ts']) {
      expect(source(f), `${f} ends an agent terminal with the hangup alone`).not.toMatch(/\bkillPty\(/);
    }
    // And through endReplacedTerminal, which the senders see (8): a bare endTerminalTree there is a replacement
    // nobody waits for.
    for (const f of ['core/agent-update.ts', 'core/agent-manager.ts', 'services/api-routes/agent-routes.ts', 'handlers/ipc-handlers.ts']) {
      expect(source(f), `${f} ends a replaced terminal out of the senders' sight`).not.toMatch(/\bendTerminalTree\(/);
    }
    // ipc-handlers.ts gives the hangup alone to the terminals that are no agent's, as a terminal app does: the
    // window's own shells (pty:create, the quick terminals) and an install it cancels. Its agent terminals end
    // with their tree.
    const ipc = source('handlers/ipc-handlers.ts');
    const handlerAt = (index: number) => [...ipc.slice(0, index).matchAll(/ipcMain\.handle\('([^']+)'/g)].pop()?.[1];
    const sites = [...ipc.matchAll(/\bkillPty\(/g)].map((m) => handlerAt(m.index!)).sort();
    expect(sites).toEqual(['plugin:install-kill', 'pty:kill', 'shell:killPty', 'skill:install-kill']);
  });

  it('waits for the end of a stale one before it goes on (6)', () => {
    const calls = sources('.').flatMap((f) => {
      const text = source(f);
      return [...text.matchAll(/^.*\bkillStalePty\(.*$/gm)]
        .filter((m) => !/function killStalePty\(/.test(m[0]))
        .map((m) => `${f}: ${m[0].trim()}`);
    });
    expect(calls.length, 'no caller found: the guard reads nothing').toBeGreaterThan(5);
    const unawaited = calls.filter((c) => !/(await killStalePty\(|terminalsEnding\.push\(killStalePty\()/.test(c));
    expect(unawaited, 'a stale terminal\'s end not waited for: the next one opens beside it').toEqual([]);
  });
});
