import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The rules an orchestrator is given, and whether they actually reach it.
 *
 * electron/resources/super-agent-instructions.md is what decides how an
 * orchestrator behaves: whether it answers a question itself or opens a half
 * hour task for it. It is read with fs.existsSync and silently skipped when it
 * is not there, and it is shipped through extraResources, so a rename or a
 * packaging change makes every orchestrator run with no rules at all and
 * nothing anywhere says so. It also has to reach orchestrators only: attaching
 * it to a worker would tell a worker to delegate instead of doing the work.
 *
 * So these drive a real dispatch and assert on the argv actually handed to the
 * shell, rather than on the contents of the file.
 */

const spawnCalls: { file: string; args: string[] }[] = [];
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string, args: string[]) => {
    spawnCalls.push({ file, args });
    return { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() };
  }),
}));

let uuidCounter = 0;
vi.mock('uuid', () => ({ v4: vi.fn(() => `pty-${++uuidCounter}`) }));

// getResourcePath builds on app.getAppPath(), so pointing it at the repo makes
// the lookup resolve against the real file that ships.
vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test', getAppPath: () => process.cwd() },
  // The routes tell every open window when an agent changes; here there are none.
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));

vi.mock('../../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  initAgentPty: vi.fn(),
  killStalePty: vi.fn(),
  ensureProjectTrusted: vi.fn(),
  appendAgentOutput: vi.fn(),
  // Exported by agent-manager and imported by agent-routes: a mock that
  // omits it makes the spawn path throw on an undefined call.
  armTaskStartWatch: vi.fn(),
}));

vi.mock('../../../../electron/core/pty-manager', () => ({
  launchPrompt: (_sender: unknown, data: string) => data,
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
}));

vi.mock('../../../../electron/utils/path-builder', () => ({
  buildFullPath: vi.fn(() => '/usr/bin'),
}));

vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));

import { performDispatch } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { getAgentInstructionsPath, getSuperAgentInstructionsPath } from '../../../../electron/utils';
import { RouteContext } from '../../../../electron/services/api-routes/types';
import { AgentStatus, AppSettings } from '../../../../electron/types';

// The launch these hold is darwin and linux's: a line typed into the shell, or
// `bash -l -c`. On a Windows host they read it as linux; the win32 launch (the
// CLI as the terminal's process) is held by launch-call-sites.test.ts and
// agent-terminal-win32.test.ts.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });


let ctx: RouteContext;

beforeEach(() => {
  agents.clear();
  ptyProcesses.clear();
  spawnCalls.length = 0;
  uuidCounter = 0;

  ctx = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
    appSettings: {} as AppSettings,
    getAppSettings: () => ({} as AppSettings),
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'new-pty-id'),
    agentStatusEmitter: new EventEmitter(),
  } as RouteContext;
});

function putAgent(over: Partial<AgentStatus> & { id: string }): AgentStatus {
  const agent: AgentStatus = {
    status: 'idle',
    // A directory that exists, since the spawn path checks before running.
    projectPath: process.cwd(),
    skills: [],
    output: [],
    lastActivity: new Date().toISOString(),
    ...over,
  } as AgentStatus;
  agents.set(agent.id, agent);
  return agent;
}

/** The command line the shell was actually given. */
async function dispatchAndReadCommand(agent: AgentStatus): Promise<string> {
  await performDispatch(agent, { message: 'have a look at the sidebar' }, ctx, vi.fn());
  expect(spawnCalls.length, 'no PTY was spawned').toBeGreaterThan(0);
  return spawnCalls[0].args.join(' ');
}

describe('the instructions file that ships with the app', () => {
  it('is where the app looks for it, and is not empty', () => {
    const file = getSuperAgentInstructionsPath();

    expect(fs.existsSync(file), `missing: ${file}`).toBe(true);
    expect(fs.readFileSync(file, 'utf-8').trim().length).toBeGreaterThan(0);
    // Under electron/resources, which is the glob extraResources ships.
    expect(file).toContain(path.join('electron', 'resources'));
  });
});

describe('who gets the orchestrator rules', () => {
  it('an orchestrator is started with them attached', async () => {
    const agent = putAgent({ id: 'orch', name: 'Orchestrator', role: 'orchestrator' });

    const command = await dispatchAndReadCommand(agent);

    expect(command).toContain('--append-system-prompt-file');
    expect(command).toContain('super-agent-instructions.md');
  });

  it('an ordinary agent is not', async () => {
    const agent = putAgent({ id: 'w', name: 'Frontend', role: 'worker' });

    const command = await dispatchAndReadCommand(agent);

    // A worker told to delegate rather than work is the failure this guards.
    expect(command).not.toContain('super-agent-instructions.md');
  });
});

describe('the rules an orchestrator is actually handed', () => {
  /** Read per test, not at collection: a missing file should fail an
   *  assertion with a path in it, not stop the file being loaded at all. */
  const read = () => fs.readFileSync(getSuperAgentInstructionsPath(), 'utf-8');

  /**
   * The one thing worth asserting about the prose (2.0.7, the owner's rule of
   * 10/11, which replaces the "smallest response" triage of 2026-09): the
   * orchestrator only orchestrates. Under the triage, a fresh orchestrator
   * asked why something was broken read the code itself and delegated nothing
   * (reports/orchestrator-role-runs, claude 2.1.321). The rule has to come
   * before any tool is reached for.
   */
  it('tells the orchestrator it never does the work itself, before it reaches for a tool', () => {
    const text = read();
    const rule = text.indexOf('You never do the work yourself');
    const tools = text.indexOf('## Available MCP Tools');

    expect(rule, 'no rule in the instructions').toBeGreaterThan(-1);
    expect(tools).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(tools);
  });

  it('no longer offers answering from the code without an agent', () => {
    const text = read();
    expect(text).not.toMatch(/\*\*No agent\.\*\*/);
    expect(text).not.toContain('reading the code to check a fact');
    // A project with no agent yet is not a reason to do the work: it creates one.
    expect(text).toContain('create_agent');
  });

  it('does not tell the orchestrator it may only manage', () => {
    // "agent manager only" is what forbade it to answer at all, which is the
    // instruction this whole change exists to replace.
    expect(read()).not.toContain('agent manager only');
  });

  it('carries the gate loop before the tools, in its order (W1 of the fresh-install report)', () => {
    const text = read();
    const steps = ['own feature branch', 'delivers a pull request', 'QA gates it', 'The Audit gates it', 'gh pr checks', 'Only then is the PR merged', 'Report'];
    const at = steps.map(s => text.indexOf(s));
    for (const [i, s] of steps.entries()) expect(at[i], s).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(at[at.length - 1]).toBeLessThan(text.indexOf('## Available MCP Tools'));
    expect(text).toContain('Never merge over a red gate');
  });

  it('hands parallel work with a short timeoutSeconds, never as waiting calls in one message (the Audit\'s L5 on #579)', () => {
    // Measured with claude 2.1.321: the tool calls of one message run one after another
    // (reports/workflow-runs/parallel): two waiting delegations took 40 s of work in series.
    const text = read();
    expect(text).not.toContain('all in one message');
    expect(text).toContain('timeoutSeconds: 1');
  });

  it('every agent\'s instructions give the loop with its exceptions: the user\'s say, no git, no remote (the Audit\'s L5 on #585)', () => {
    const text = fs.readFileSync(getAgentInstructionsPath(), 'utf-8');
    const delivery = text.slice(text.indexOf('## Delivery'), text.indexOf('## Core Principles'));
    expect(delivery).toContain('unless the user asks otherwise');
    expect(delivery).toMatch(/not a git repository/);
    expect(delivery).toMatch(/no remote/);
  });

  it('every agent\'s instructions tell an orchestrator it writes no files, and keep its memory with memory_write (QA\'s L1 on #579)', () => {
    // Write and Edit are denied to it (providers/cli-provider.ts orchestratorToolFlags): "write files with the Write
    // tool, never through the shell" left it no way, and its memory none.
    const text = fs.readFileSync(getAgentInstructionsPath(), 'utf-8');
    expect(text).toMatch(/An orchestrator writes no files/);
    expect(text).toContain('memory_write');
    expect(text).toMatch(/An orchestrator writes no file at all/);
  });

  it('follows parallel work with the reading tools, which run together (QA\'s gate of #579)', () => {
    // Claude Code 2.1.321 runs an MCP call beside the others of a message only when its tool is read-only:
    // wait_for_agent and task_status are (mcp-orchestrator, readOnly); delegate_task, which hands work, is not.
    const text = read();
    expect(text).toMatch(/`wait_for_agent` on each, then `task_status`.*Both only read/);
    expect(text).toContain('timeoutSeconds: 1');
  });

  it('hands work with delegate_task, never the deprecated start_agent (the Audit\'s I3 on #579)', () => {
    expect(read()).toContain('delegate_task');
    expect(read()).not.toContain('start_agent');
  });

  /**
   * Every agent's instructions, published as ~/.tars/CLAUDE.md and loaded by
   * every claude session, an orchestrator's too (the Audit's M1 on #579): their
   * "When given a bug report, just fix it: point at logs, errors, failing tests"
   * told an orchestrator to diagnose itself, with Read and Bash left to it.
   */
  it('every agent\'s instructions tell a worker, never an orchestrator, to fix a bug report itself', () => {
    const text = fs.readFileSync(getAgentInstructionsPath(), 'utf-8');
    expect(text).not.toContain('When given a bug report, just fix it');
    expect(text).toMatch(/A worker given a bug report just fixes it/);
    expect(text).toMatch(/An orchestrator never does: it hands the bug report to one of its agents/);
  });
});
