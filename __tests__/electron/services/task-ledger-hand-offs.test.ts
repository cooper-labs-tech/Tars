import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The launch these hold is darwin and linux's: a line typed into the shell,
// and a CLI read from what node-pty names in front. On a Windows host they read
// it as linux; the win32 launch (the CLI as the terminal's process) is held by
// launch-call-sites.test.ts and agent-terminal-win32.test.ts, and the hand-off
// is noted before it, whatever the platform (bot-core.ts, typeLaunch).
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });

/**
 * Where a chat hands work over, as the task ledger records it (the Audit's Low 1 on #305: the mutants that made a
 * bot's launch note no hand-off, or record a chat's whole prompt as the task, survived every test).
 *
 * How it can fail, written before the code:
 * 21. A chat's launch of an agent (Telegram, Slack, Discord) notes no hand-off: the turn it starts reads as typed in
 *     the window, from nobody.
 * 22. The orchestrator a chat message is forwarded to, started with it, records the whole prompt, the context Tars puts
 *     before the message included, as the task's text; or records it as from another channel.
 * 23. The same when the message is typed into a CLI already running.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.3' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import * as pty from 'node-pty';
import { forwardToOrchestrator, startWithTask, type BotFleet } from '../../../electron/services/bot-core';
import { createTaskLedger, setLiveTaskLedger, type TaskLedger } from '../../../electron/services/task-ledger';
import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { ptyProcesses, resetTerminalInput } from '../../../electron/core/pty-manager';
import { resetLaunches } from '../../../electron/core/agent-launch';
import type { AgentStatus, AppSettings } from '../../../electron/types';
import { withLaunchScripts } from '../../setup/launch-script';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-ledger-hand-offs-'));
const project = path.join(dir, 'project');
fs.mkdirSync(project, { recursive: true });
let ledger: TaskLedger;
let written: string[];
let terminal: Record<string, unknown>;
let agents: Map<string, AgentStatus>;

/** The agent's terminal: a shell (no CLI yet), or a claude up at its prompt. */
function open(id: string, withCli: boolean): void {
  written = [];
  terminal = {
    pid: 4242, process: withCli ? '2.1.289' : 'bash', write: (d: string) => { written.push(d); },
    kill: vi.fn(), resize: vi.fn(), onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
  };
  if (withCli) {
    vi.mocked(pty.spawn).mockReturnValueOnce(terminal as never);
    spawnAgentPty({ binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: project, cols: 80, rows: 24, env: {} });
  }
  ptyProcesses.set(`pty-${id}`, terminal as never);
}

function fleet(): BotFleet {
  return {
    agents, ptyProcesses: ptyProcesses as never, settings: () => ({}) as AppSettings, saveAgents: () => undefined,
    initAgentPty: async () => { throw new Error('the terminal is already open'); },
  };
}

beforeEach(() => {
  resetLaunches();
  ptyProcesses.clear();
  const ledgerDir = fs.mkdtempSync(path.join(dir, 'l-'));
  ledger = createTaskLedger({ file: path.join(ledgerDir, 'task-ledger.jsonl'), textFile: path.join(ledgerDir, 'private', 'task-texts.jsonl') });
  setLiveTaskLedger(ledger);
  agents = new Map();
  for (const [id, role] of [['orch', 'orchestrator'], ['worker', 'worker']] as const) {
    agents.set(id, {
      id, name: id, role, status: 'idle', provider: 'claude', projectPath: project, ptyId: `pty-${id}`, ptyCwd: project,
      skills: [], output: [], lastActivity: '', permissionMode: 'bypass',
    } as unknown as AgentStatus);
  }
});

afterEach(() => {
  setLiveTaskLedger(null);
  if (terminal) resetTerminalInput(terminal as never);
});

/** The task the agent's next turn opens, as the hook would open it. */
const taskOf = (id: string) => {
  ledger.turnStarted(agents.get(id)!, { sessionId: `sess-${id}`, text: 'what the hook saw' });
  return ledger.tasks().find((t) => t.agentId === id);
};

describe("a chat's hand-off", () => {
  it('21. a launch from Telegram notes the task, from Telegram', async () => {
    open('worker', false);

    await startWithTask(fleet(), agents.get('worker')!, 'fix the build', 'Telegram', { resume: false, reply: () => undefined });

    expect(withLaunchScripts(written.join(''))).toContain('fix the build');
    expect(taskOf('worker')).toMatchObject({ source: 'telegram', text: 'fix the build' });
  });

  it("22. an orchestrator started with a chat's message records the message, not the context before it", async () => {
    open('orch', false);

    await forwardToOrchestrator(fleet(), agents.get('orch')!, 'Slack', {
      message: 'where are we on #305?', context: '[From Slack, channel C042: answer there with send_slack]',
      permissionMode: 'bypass', resume: false, systemPromptFile: () => undefined, reply: () => undefined,
    });

    expect(withLaunchScripts(written.join(''))).toContain('From Slack, channel C042');
    expect(taskOf('orch')).toMatchObject({ source: 'slack', text: 'where are we on #305?' });
  });

  it('23. typed into a running CLI, the same', async () => {
    open('orch', true);

    await forwardToOrchestrator(fleet(), agents.get('orch')!, 'Discord', {
      message: 'where are we on #305?', context: '[From Discord: answer there]',
      permissionMode: 'bypass', resume: false, systemPromptFile: () => undefined, reply: () => undefined,
    });

    expect(written.join('')).toContain('where are we on #305?');
    expect(taskOf('orch')).toMatchObject({ source: 'discord', text: 'where are we on #305?' });
  });
});
