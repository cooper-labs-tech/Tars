import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The four launches the Telegram and Slack bots make, an agent by name and
 * the super agent from a message on each, run on the agent's model and
 * effort, medium included.
 *
 * These four always passed the agent's own model. Medium was the level they
 * dropped, like every launch on the claude binary, and without it Claude Code
 * starts at the effort it last saved for that model from any terminal: an
 * agent set to medium ran at whatever somebody had last chosen elsewhere.
 *
 * The bots, the provider builders, initAgentPty, spawnAgentPty and the writer
 * are the real ones; node-pty and the window are fakes.
 * (Telegram's launches went with Tars's own Telegram bot in 2.0.5: the cases
 * that only drove its /start_agent or its message to the super agent are gone,
 * and the few that used it as the way in, about the shared launch path, now go
 * in through Slack.)
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-bots-launch-${process.pid}-${Date.now()}`),
}));

type FakePty = { pid: number; process: string; write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; onData: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn>; say: (data: string) => void };
const spawned = vi.hoisted(() => [] as FakePty[]);
/** When a fake shell prints its first output (its prompt) after it is spawned, as bash -l does. */
const shell = vi.hoisted(() => ({ speaksAfterMs: 20 }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string): FakePty => {
    const listeners: Array<(data: string) => void> = [];
    const terminal: FakePty = {
      pid: 7000 + spawned.length, process: file, write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onExit: vi.fn(),
      onData: vi.fn((listener: (data: string) => void) => { listeners.push(listener); return { dispose() {} }; }),
      say: (data: string) => { for (const listener of listeners) listener(data); },
    };
    spawned.push(terminal);
    setTimeout(() => terminal.say('bash-3.2$ '), shell.speaksAfterMs);
    return terminal;
  }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.7.9' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));
vi.mock('@slack/bolt', () => ({ App: class {}, LogLevel: { INFO: 'info' } }));
import { agents, wireDialogProbe } from '../../../electron/core/agent-manager';
import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { resetLaunches, launchBegins, sessionStarting, setSlotGate } from '../../../electron/core/agent-launch';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { handleSlackCommand, sendToSuperAgentFromSlack } from '../../../electron/services/slack-bot';
import { getSuperAgentInstructionsPath } from '../../../electron/utils';
import type { AgentStatus, AppSettings } from '../../../electron/types';

// The launch these hold is darwin and linux's: a line typed into the shell, or
// `bash -l -c`. On a Windows host they read it as linux; the win32 launch (the
// CLI as the terminal's process) is held by launch-call-sites.test.ts and
// agent-terminal-win32.test.ts.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });


const project = path.join(tmpHome, 'project');
const settings = {} as AppSettings;

function agent(fields: Partial<AgentStatus>): AgentStatus {
  const record = {
    id: 'agent-w', name: 'Worker', status: 'idle', provider: 'claude', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(), permissionMode: 'bypass',
    model: 'claude-opus-5-5', effort: 'medium',
    ...fields,
  } as AgentStatus;
  agents.set(record.id, record);
  return record;
}

/** What was typed into the terminal the launch opened. */
async function typedAfter(launch: () => Promise<unknown>): Promise<string> {
  const before = spawned.length;
  await launch();
  // The command goes in as a paste and its Enter 300 ms later.
  await new Promise(resolve => setTimeout(resolve, 450));
  const terminal = spawned[before];
  expect(terminal, 'the launch opened no terminal').toBeDefined();
  return terminal.write.mock.calls.map(call => String(call[0])).join('');
}

beforeEach(() => {
  // As main.ts wires it at startup.
  wireDialogProbe();
  shell.speaksAfterMs = 20;
  // A cold start of one test is not a launch still on its way in the next.
  resetLaunches();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(project, { recursive: true });
  agents.clear();
  ptyProcesses.clear();
  spawned.length = 0;
});

describe('the role, on the launches the bots make', () => {
  // The toggle is the role (core/agent-role.ts). These two launches decided it
  // by the role alone already, and never attached the instructions: an
  // orchestrator started from a phone did the work itself.
  const INSTRUCTIONS = () => `--append-system-prompt-file '${getSuperAgentInstructionsPath()}'`;
  const TOOL_BLOCK = '--disallowed-tools "Edit" "Write" "NotebookEdit" "Task"';

  it('Slack `start` launches an orchestrator with its instructions, and a worker called orchestrator as a worker', async () => {
    agent({ id: 'agent-o', name: 'Lead', role: 'orchestrator' });
    agent({ id: 'agent-w', name: 'Tars-Orchestrator', role: 'worker' });

    const lead = await typedAfter(() => handleSlackCommand('start lead Plan the release', 'C1', async () => undefined, settings));
    const named = await typedAfter(() => handleSlackCommand('start tars-orchestrator Fix the build', 'C1', async () => undefined, settings));

    expect(lead).toContain(INSTRUCTIONS());
    expect(lead).toContain(TOOL_BLOCK);
    expect(named).not.toContain('--append-system-prompt-file');
    expect(named).not.toContain('--disallowed-tools');
  });

  // A chat's runner is a worker with the orchestrator's powers
  // (ORCHESTRATOR-PER-CHAT.md 4.2, PR D). Written before the code (2026-10-12):
  // started from a bot, it was launched as a worker, without the instructions
  // and with its editing tools.
  it("Slack `start` launches a chat's runner with the orchestrator's instructions", async () => {
    agent({ id: 'agent-o', name: 'Lead', role: 'orchestrator' });
    agent({ id: 'agent-r', name: 'Lead · Release 1.9.4', role: 'worker', kind: 'chat', chatId: 'c-2', teamOrchestratorId: 'agent-o' });
    // By its id: a part of a name finds the orchestrator, never one of its chats (bot-core's findAgent).
    const runner = await typedAfter(() => handleSlackCommand('start agent-r Ship it', 'C1', async () => undefined, settings));

    expect(runner).toContain(INSTRUCTIONS());
    expect(runner).toContain(TOOL_BLOCK);
  });

  // The Audit's L2 on #379, written before the fix (2026-10-13): a bot started
  // a chat's runner by its exact id through initAgentPty, past the slot gate,
  // over the RAM's limit.
  it("Slack `start` takes the runner's slot: refused, it opens nothing and says why", async () => {
    agent({ id: 'agent-o', name: 'Lead', role: 'orchestrator' });
    agent({ id: 'agent-r', name: 'Lead · Release 1.9.4', role: 'worker', kind: 'chat', chatId: 'c-2', teamOrchestratorId: 'agent-o' });
    setSlotGate(async () => ({ ok: false, error: '2 chats are already working, the most this Mac runs at once.' }));
    try {
      const said: string[] = [];
      await handleSlackCommand('start agent-r Ship it', 'C1', async (t) => { said.push(t); }, settings);
      await new Promise(resolve => setTimeout(resolve, 450));
      expect(spawned, 'a terminal opened for a start the gate refused').toHaveLength(0);
      expect(said.join('\n')).toContain('2 chats are already working');
    } finally {
      setSlotGate(undefined);
    }
  });

  it('a message goes to the agent whose role is orchestrator, not to one named like it', async () => {
    agent({ id: 'agent-w', name: 'Super Agent', role: 'worker' });
    agent({ id: 'agent-o', name: 'Lead', role: 'orchestrator' });

    await typedAfter(() => sendToSuperAgentFromSlack('C1', 'what is everyone doing', async () => undefined, settings));

    expect(agents.get('agent-o')!.status).toBe('running');
    expect(agents.get('agent-w')!.status).toBe('idle');
  });
});

describe("the super agent's cold start, from a message", () => {
  // Added at the QA gate of #123. The two launches of the orchestrator that a
  // message makes when it is not running: the role picks it, and nothing read
  // the flags it was started with. A Telegram message starts it in bypass,
  // since nobody is there to answer a permission question; a Slack message
  // starts it on its own mode (SPECS §4, The orchestrator role). Both with the
  // instructions and without the editing tools.
  const TOOL_BLOCK = '--disallowed-tools "Edit" "Write" "NotebookEdit" "Task"';
  const promptFile = (typed: string) => /--append-system-prompt-file '([^']+)'/.exec(typed)?.[1];

  it('from Slack: the instructions, no editing tools, and its own permission mode', async () => {
    agent({ id: 'agent-s', name: 'Lead', role: 'orchestrator', permissionMode: 'auto' });

    const typed = await typedAfter(() => sendToSuperAgentFromSlack('C1', 'what is everyone doing', async () => undefined, settings));

    expect(typed).toContain(TOOL_BLOCK);
    expect(typed).toContain(' --permission-mode auto');
    expect(typed).not.toContain('--dangerously-skip-permissions');
    expect(promptFile(typed)).toBe(getSuperAgentInstructionsPath());
  });
});

describe('an agent whose CLI is already up', () => {
  // Every turn ends on `idle`, so a start from a phone reached agents at their
  // prompt, and typed `cd '...' && claude ...` into the CLI's own field.
  const live = (fields: Partial<AgentStatus> = {}) => {
    const terminal = spawnAgentPty({
      binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: project, cols: 120, rows: 30,
      env: { CLAUDE_AGENT_ID: fields.id ?? 'agent-w' },
    }) as unknown as FakePty;
    terminal.process = '2.1.280';
    ptyProcesses.set('pty-live', terminal as never);
    agent({ status: 'idle', ptyId: 'pty-live', ptyCwd: project, ...fields });
    return terminal;
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 450));
  const typed = (terminal: FakePty) => terminal.write.mock.calls.map(call => String(call[0])).join('');

  it('gets a Slack `start` task typed in as a message, not a launch command', async () => {
    const terminal = live();

    await handleSlackCommand('start worker Rebase onto main', 'C1', async () => undefined, settings);
    await settle();

    expect(typed(terminal)).toContain('Rebase onto main');
    expect(typed(terminal)).toContain('Message from Slack: Rebase onto main');
    expect(typed(terminal)).not.toContain("&& '");
    expect(spawned).toHaveLength(1);
  });

  it('gets a Slack message to the super agent typed into its open session', async () => {
    const terminal = live({ id: 'agent-s', name: 'Super Agent (Orchestrator)', role: 'orchestrator' });

    await sendToSuperAgentFromSlack('C1', 'what is everyone doing', async () => undefined, settings);
    await settle();

    expect(typed(terminal)).toContain('[FROM SLACK');
    expect(typed(terminal)).not.toContain("&& '");
  });
});

describe('a super agent whose status still says it works, over a bare shell', () => {
  // A claude that dies without its SessionEnd leaves `running` or `waiting`
  // behind. The bots took that status for a session and typed the message
  // into the shell, which ran it as a command.
  const bare = (status: AgentStatus['status']) => {
    const terminal = spawnAgentPty({
      binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: project, cols: 120, rows: 30,
      env: { CLAUDE_AGENT_ID: 'agent-s' },
    }) as unknown as FakePty;
    terminal.process = 'bash';
    ptyProcesses.set('pty-bare', terminal as never);
    agent({ id: 'agent-s', name: 'Super Agent (Orchestrator)', role: 'orchestrator', status, ptyId: 'pty-bare', ptyCwd: project });
    return terminal;
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 450));
  const typed = (terminal: FakePty) => terminal.write.mock.calls.map(call => String(call[0])).join('');
  /** The message went in as the task of a launch, never as a line of its own. */
  const onlyAsTheTaskOfALaunch = (text: string, marker: string) => {
    expect(text).toContain(`cd '${project}' && '`);
    expect(text.indexOf(`cd '${project}'`), 'the message was typed before any launch').toBeLessThan(text.indexOf(marker));
  };

  it.each(['running', 'waiting'] as const)('gets a session started by a Slack message (%s)', async (status) => {
    const terminal = bare(status);

    await sendToSuperAgentFromSlack('C1', 'echo MARK-SHELL-$((6*7))', async () => undefined, settings);
    await settle();

    onlyAsTheTaskOfALaunch(typed(terminal), '[FROM SLACK');
  });
});

describe('Slack', () => {
  it("`start <agent> <task>` runs on the agent's model and effort", async () => {
    agent({});

    const typed = await typedAfter(() => handleSlackCommand('start worker Rebase onto main', 'C1', async () => undefined, settings));

    expect(typed).toContain(" --model 'claude-opus-5-5'");
    expect(typed).toContain(' --effort medium ');
  });

  it("a message to the super agent starts it on its model and effort", async () => {
    agent({ id: 'agent-s', name: 'Super Agent (Orchestrator)', role: 'orchestrator' });

    const typed = await typedAfter(() => sendToSuperAgentFromSlack('C1', 'what is everyone doing', async () => undefined, settings));

    expect(typed).toContain(" --model 'claude-opus-5-5'");
    expect(typed).toContain(' --effort medium ');
  });
});

describe('a launch on its way, and the bots (#134)', () => {
  // Every bot entry point that can start a CLI: a launch already on its way
  // (a restart, a start from a window) is waited for, and the bot's own
  // launch is marked for every sender after it.
  const entryPoints: Array<[string, boolean, () => Promise<unknown>]> = [
    ['Slack `start`', false, () => handleSlackCommand('start worker Rebase onto main', 'C1', async () => undefined, settings)],
    ['Slack message to the super agent', true, () => sendToSuperAgentFromSlack('C1', 'Rebase onto main', async () => undefined, settings)],
  ];
  const record = (superAgent: boolean, fields: Partial<AgentStatus> = {}) => agent(superAgent
    ? { id: 'agent-s', name: 'Super Agent (Orchestrator)', role: 'orchestrator', ...fields }
    : { ...fields });
  const typed = (terminal: FakePty) => terminal.write.mock.calls.map(call => String(call[0])).join('');

  it.each(entryPoints)('%s waits for a launch on its way, then types into the session it brought up', async (_name, superAgent, send) => {
    const terminal = spawnAgentPty({
      binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: project, cols: 120, rows: 30,
      env: { CLAUDE_AGENT_ID: superAgent ? 'agent-s' : 'agent-w' },
    }) as unknown as FakePty;
    terminal.process = 'bash';
    ptyProcesses.set('pty-launching', terminal as never);
    const target = record(superAgent, { ptyId: 'pty-launching', ptyCwd: project });
    // A launch was typed there a moment ago; the shell has not handed over.
    launchBegins(target.id);
    const before = spawned.length;

    const sent = send();
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(typed(terminal), 'typed over the launch before its CLI came up').toBe('');

    terminal.process = '2.1.280';
    target.sessionRegisteredAt = new Date().toISOString();
    await sent;
    await new Promise(resolve => setTimeout(resolve, 450));

    expect(typed(terminal)).toContain('Rebase onto main');
    expect(typed(terminal), 'launched a second CLI over the first').not.toContain("&& '");
    expect(spawned.length).toBe(before);
  });

  it.each(entryPoints)('%s marks its own launch for the senders after it', async (_name, superAgent, send) => {
    const target = record(superAgent);

    await send();

    expect(sessionStarting(target), 'a sender right after would take the new shell for an idle agent').toBe(true);
  });
});

describe('QA #158: a launch slower than the API senders wait, and the bots', () => {
  // Written by the QA at the gate of #158. The bots have no caller timing out
  // on them, so they hold a task for as long as a launch whose CLI runs is
  // starting (CLI_UP_MS), where /dispatch and /message give up at 20 s. What
  // this guards: a bot let go with the API senders, at 20 s, types into a
  // claude that is not taking keys yet, and the task is lost.
  const entryPoints: Array<[string, boolean, () => Promise<unknown>]> = [
    ['Slack `start`', false, () => handleSlackCommand('start worker Rebase onto main', 'C1', async () => undefined, settings)],
    ['Slack message to the super agent', true, () => sendToSuperAgentFromSlack('C1', 'Rebase onto main', async () => undefined, settings)],
  ];
  const typed = (terminal: FakePty) => terminal.write.mock.calls.map(call => String(call[0])).join('');

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(entryPoints)('%s holds its task while the CLI boots past 20 s, then types it into the session', async (_name, superAgent, send) => {
    const terminal = spawnAgentPty({
      binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: project, cols: 120, rows: 30,
      env: { CLAUDE_AGENT_ID: superAgent ? 'agent-s' : 'agent-w' },
    }) as unknown as FakePty;
    // The claude runs, slowly, and has not registered its session.
    terminal.process = '2.1.280';
    ptyProcesses.set('pty-launching', terminal as never);
    const target = agent(superAgent
      ? { id: 'agent-s', name: 'Super Agent (Orchestrator)', role: 'orchestrator', ptyId: 'pty-launching', ptyCwd: project }
      : { ptyId: 'pty-launching', ptyCwd: project });
    launchBegins(target.id);

    const sent = send();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(typed(terminal), 'typed into a claude not yet taking keys').toBe('');

    target.sessionRegisteredAt = new Date().toISOString();
    await vi.advanceTimersByTimeAsync(1_000);
    await sent;
    await vi.advanceTimersByTimeAsync(500);

    expect(typed(terminal)).toContain('Rebase onto main');
  });
});

/**
 * The launch command, as the bytes a bot types into a cold terminal.
 *
 * Every agent terminal is /bin/bash (initAgentPty), which on macOS is Apple's
 * 3.2, and bash 3.2 has no bracketed paste. The Telegram bot typed its launch
 * command as a paste: bash ran `00~cd ...` and answered "command not found",
 * so neither /start_agent nor a message to the super agent ever started a cold
 * agent (the re-gate of #134, seen in a sandbox with real claude; main did the
 * same). The Slack bot types the same command plainly, and starts it.
 *
 * How this can fail, written before the fix:
 * 1. a bot types its launch command into the shell as a bracketed paste;
 * 2. the command goes in without its Enter, or in pieces, and sits at the prompt;
 * 3. the fix reaches the other writes: a message into a claude that is already up loses its paste, which its field relies on;
 * 4. the Slack launches, which already work, change.
 */
describe('the launch command a bot types into a cold terminal', () => {
  const PASTE_START = '\x1b[200~';
  const PASTE_END = '\x1b[201~';

  /** The terminal a launch opened, and every write into it, in order. */
  async function launchIn(launch: () => Promise<unknown>): Promise<{ terminal: FakePty; writes: string[] }> {
    const before = spawned.length;
    await launch();
    // Long enough for a paste's Enter, which follows it by 300 ms.
    await new Promise(resolve => setTimeout(resolve, 450));
    const terminal = spawned[before];
    expect(terminal, 'the launch opened no terminal').toBeDefined();
    return { terminal, writes: terminal.write.mock.calls.map(call => String(call[0])) };
  }

  const launches: Array<[string, () => Promise<unknown>]> = [
    ['Slack start', async () => {
      agent({});
      await handleSlackCommand('start worker Rebase onto main', 'C1', async () => undefined, settings);
    }],
    ['Slack, a message to the super agent', async () => {
      agent({ id: 'agent-s', name: 'Chief', role: 'orchestrator' });
      await sendToSuperAgentFromSlack('C1', 'what is everyone doing', async () => undefined, settings);
    }],
  ];

  it.each(launches)('%s: typed plainly, whole and submitted', async (_name, launch) => {
    const { writes } = await launchIn(launch);

    expect(writes, 'the launch command went in as more than one write').toHaveLength(1);
    const [command] = writes;
    expect(command, 'a bracketed paste, which the bash 3.2 of the terminal runs as "00~cd"').not.toContain(PASTE_START);
    expect(command).not.toContain(PASTE_END);
    expect(command.startsWith(`cd '${project}' && `), command.slice(0, 120)).toBe(true);
    expect(command.endsWith('\r'), 'typed and never submitted').toBe(true);
  });

  it('keeps the paste for a message into a claude that is already up', async () => {
    agent({ id: 'agent-s', name: 'Chief', role: 'orchestrator' });
    const { terminal } = await launchIn(() => sendToSuperAgentFromSlack('C1', 'start on this', async () => undefined, settings));
    // Its claude is up and its launch is over.
    terminal.process = '2.1.280';
    resetLaunches();
    terminal.write.mockClear();

    // Past the 200 characters where the writer pastes rather than types.
    const long = `and now this, for $HOME: ${'the whole plan '.repeat(20)}`;
    await sendToSuperAgentFromSlack('C1', long, async () => undefined, settings);
    await new Promise(resolve => setTimeout(resolve, 450));

    const writes = terminal.write.mock.calls.map(call => String(call[0]));
    expect(writes.join(''), 'the message went into claude without its paste').toContain(PASTE_START);
    expect(writes.join('')).toContain(long.trim());
    expect(writes.at(-1), 'the Enter did not follow the paste on its own').toBe('\r');
    expect(spawned.at(-1), 'a second terminal was opened for a claude that was up').toBe(terminal);
  });
});

describe('a launch typed into a terminal the bot has just opened (gate of #155)', () => {
  // Written by Backend after QA's gate of #155, before the fix. The four bots
  // typed the launch a few milliseconds after /bin/bash -l was spawned, before
  // the shell was at its prompt. Until then the line goes through the
  // terminal's canonical mode, which on macOS holds about 1 KB: a launch
  // carrying a long Telegram message was cut, and nothing started (QA: 995
  // bytes typed at once run, 1095 do not; after the shell has spoken, 1495 do).
  // So nothing is typed before the shell's first output, then 150 ms of quiet.
  const entryPoints: Array<[string, boolean, () => Promise<unknown>]> = [
    ['Slack `start`', false, () => handleSlackCommand('start worker Rebase onto main', 'C1', async () => undefined, settings)],
    ['Slack message to the super agent', true, () => sendToSuperAgentFromSlack('C1', 'Rebase onto main', async () => undefined, settings)],
  ];

  afterEach(() => { vi.useRealTimers(); });

  it.each(entryPoints)('%s types nothing before the shell has spoken and gone quiet', async (_name, superAgent) => {
    vi.useFakeTimers();
    shell.speaksAfterMs = 800;
    agent(superAgent ? { id: 'agent-s', name: 'Super Agent (Orchestrator)', role: 'orchestrator' } : {});
    const send = entryPoints.find(e => e[1] === superAgent && e[0] === _name)![2];
    const before = spawned.length;

    const sent = send();
    await vi.advanceTimersByTimeAsync(700);
    const terminal = spawned[before];
    expect(terminal, 'the launch opened no terminal').toBeDefined();
    const typed = () => terminal.write.mock.calls.map(call => String(call[0])).join('');
    expect(typed(), 'typed before the shell had printed anything').toBe('');

    // The prompt comes at 800 ms; 100 ms later the shell is not yet quiet long enough.
    await vi.advanceTimersByTimeAsync(200);
    expect(typed(), 'typed less than 150 ms after the shell spoke').toBe('');

    await vi.advanceTimersByTimeAsync(200);
    await sent;
    await vi.advanceTimersByTimeAsync(500);
    expect(typed()).toContain(`cd '${project}' && `);
  });

  it('does not wait for ever on a shell that never speaks', async () => {
    vi.useFakeTimers();
    shell.speaksAfterMs = 60_000;
    agent({});
    const before = spawned.length;

    const sent = entryPoints[0][2]();
    await vi.advanceTimersByTimeAsync(6_000);
    await sent;

    const typed = spawned[before].write.mock.calls.map(call => String(call[0])).join('');
    expect(typed).toContain(`cd '${project}' && `);
  }, 20_000);
});

describe('QA #166: the quiet counts from the last thing the shell printed', () => {
  // Written by the QA at the gate of #166. A login shell can print more than
  // once before its prompt (a profile's own line, the zsh notice, the prompt):
  // counted from the first output, the 150 ms of quiet ran out while the shell
  // was still talking, and the launch went back into canonical mode. Measured
  // at the gate: with only the tests above, that mutant left them green.
  afterEach(() => { vi.useRealTimers(); });

  it('types 150 ms after the last output, not the first', async () => {
    vi.useFakeTimers();
    shell.speaksAfterMs = 800;
    agent({ id: 'agent-s', name: 'Super Agent (Orchestrator)', role: 'orchestrator' });
    const before = spawned.length;

    const sent = sendToSuperAgentFromSlack('C1', 'Rebase onto main', async () => undefined, settings);
    await vi.advanceTimersByTimeAsync(900);
    const terminal = spawned[before];
    const typed = () => terminal.write.mock.calls.map(call => String(call[0])).join('');
    expect(typed(), 'typed 100 ms after the first output').toBe('');
    // The shell spoke at 800 ms, and speaks again at 900 ms.
    terminal.say('bash-3.2$ ');

    await vi.advanceTimersByTimeAsync(100);
    expect(typed(), 'typed 200 ms after the first output but 100 ms after the last').toBe('');

    await vi.advanceTimersByTimeAsync(200);
    await sent;
    await vi.advanceTimersByTimeAsync(500);
    expect(typed()).toContain(`cd '${project}' && `);
  });
});

describe('an agent whose CLI shows a dialog (the Audit\'s census, 2026-09-24)', () => {
  // Written by Backend before the fix. A permission dialog or an
  // AskUserQuestion is up (the PermissionRequest hook said so: waiting,
  // permission). The bots typed their message into it, and its Enter answered
  // the dialog: "Yes", or the first option of the question.
  const atDialog = (fields: Partial<AgentStatus> = {}) => {
    const terminal = spawnAgentPty({
      binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: project, cols: 120, rows: 30,
      env: { CLAUDE_AGENT_ID: fields.id ?? 'agent-w' },
    }) as unknown as FakePty;
    terminal.process = '2.1.280';
    ptyProcesses.set('pty-dialog', terminal as never);
    agent({ status: 'waiting', waitingReason: 'permission', ptyId: 'pty-dialog', ptyCwd: project, ...fields });
    return terminal;
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 1500));
  const typed = (terminal: FakePty) => terminal.write.mock.calls.map(call => String(call[0])).join('');
  const SUPER = { id: 'agent-s', name: 'Super Agent (Orchestrator)', role: 'orchestrator' } as const;

  it('Slack `start` types nothing into it', async () => {
    const terminal = atDialog();

    await handleSlackCommand('start worker Rebase onto main', 'C1', async () => undefined, settings);
    await settle();

    expect(typed(terminal)).not.toContain('Rebase onto main');
  });

  it('a Slack message to the super agent types nothing into it', async () => {
    const terminal = atDialog(SUPER);

    await sendToSuperAgentFromSlack('C1', 'what is everyone doing', async () => undefined, settings);
    await settle();

    expect(typed(terminal)).not.toContain('what is everyone doing');
  });
});

describe('how Tars works, on the launches the bots make (the Audit\'s M1 on #448)', () => {
  // How this fails, written before the code: the section (services/agent-guide.ts)
  // went only into the prompt spawnAgentSession builds, so a CLI without Claude's
  // SessionStart hook that a Telegram or Slack message started never learnt how
  // Tars works nor where its project folder is; or it gets the section twice; or
  // a claude agent, whose bootstrap carries it, gets it in its prompt as well.
  const SECTION = '## How Tars works';
  // A launch too long for one typed line is written to a script the shell
  // sources (`. '<file>'`): the command is in the file.
  const commandOf = (typed: string) => {
    const script = /\. '([^']+\.sh)'/.exec(typed)?.[1];
    return script && fs.existsSync(script) ? fs.readFileSync(script, 'utf8') : typed;
  };
  const count = (typed: string) => commandOf(typed).split(SECTION).length - 1;
  const launch = async (text: string) => commandOf(await typedAfter(() => handleSlackCommand(text, 'C1', async () => undefined, settings)));

  it('an opencode worker started from Slack gets it once, for a worker, with the task', async () => {
    agent({ id: 'agent-oc', name: 'Opencode', provider: 'opencode', model: undefined });
    const typed = await launch('start opencode Rebase onto main');
    expect(count(typed), typed).toBe(1);
    expect(typed).toContain('assign_task');
    expect(typed).not.toContain('delegate_task');
    expect(typed).toContain('Rebase onto main');
  });

  it('an opencode orchestrator a message starts gets the orchestrator\'s, once', async () => {
    agent({ id: 'agent-s', name: 'Lead', role: 'orchestrator', provider: 'opencode', model: undefined });
    const typed = commandOf(await typedAfter(() => sendToSuperAgentFromSlack('C1', 'what is everyone doing', async () => undefined, settings)));
    expect(count(typed), typed).toBe(1);
    expect(typed).toContain('delegate_task');
  });

  it('a claude agent gets it from its bootstrap, not in its prompt', async () => {
    agent({});
    expect(count(await launch('start worker Rebase onto main'))).toBe(0);
    agent({ id: 'agent-s', name: 'Lead', role: 'orchestrator' });
    expect(count(await typedAfter(() => sendToSuperAgentFromSlack('C1', 'what is everyone doing', async () => undefined, settings)))).toBe(0);
  });
});
