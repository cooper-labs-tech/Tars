import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';

/**
 * Which orchestrator a chat message is for (point E of DESIGN-RELAIS-HERMES-V2.md).
 *
 * The bots handed a free message to `getSuperAgent(agents)` with no project: the first orchestrator found, all
 * projects considered (electron/main.ts:260). On JeanBrasse's machine that was Sak-Orchestrator, of a project at rest: his
 * messages never reached the orchestrator he was writing to. The relay's "@project" has the same question to answer.
 *
 * How this can fail, written before the code:
 * 1. A message with no "@project" goes to the first orchestrator when there are several, where the sender should get
 *    the list of projects; and with exactly one orchestrator in the fleet, it does not go to that one.
 * 2. "@project text" goes to another project's orchestrator, or keeps the "@project" in the text it types.
 * 3. A name no project has, a name two projects share, or a project with no orchestrator: the message goes somewhere
 *    anyway, where the sender should get the list (or be told).
 * 4. Upper or lower case in the name sends the message nowhere.
 * 5. The Slack and Discord bots still give a free message to the first orchestrator.
 * 6. A project whose folder name holds a space (or an @, a colon, a comma) cannot be written after "@" (the Audit's
 *    Low on #285): it must be offered, and taken back, under its name with a dash in each such place, as the relay
 *    already sends it; and the list of projects must say that name.
 *
 * The rule is a function of the fleet (orchestrator-routing.ts); the bots are their real handlers, typing through the
 * real writer into terminals whose node-pty process is a recorder per agent.
 */

const typed = vi.hoisted(() => ({} as Record<string, string[]>));
vi.mock('node-pty', () => ({
  spawn: vi.fn((_file: string, _args: string[], opts: { env?: Record<string, string> }) => {
    const id = opts?.env?.CLAUDE_AGENT_ID ?? 'unknown';
    typed[id] = typed[id] ?? [];
    return {
      pid: 4242, process: '2.1.286',
      write: vi.fn((data: string) => { typed[id].push(data); }),
      kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn(),
    };
  }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.2' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import type { AgentStatus } from '../../../electron/types';

const TARS = '/Users/someone/projects/tars';
const CAPITAL = '/Users/someone/projects/1212-Capital';
const settle = () => new Promise((r) => setTimeout(r, 900));
const all = (id: string) => (typed[id] ?? []).join('');

function fleet(entries: Array<[string, string, string, ('orchestrator' | undefined)?]>): Map<string, AgentStatus> {
  return new Map(entries.map(([id, name, projectPath, role]) => [id, { id, name, projectPath, role, status: 'running', provider: 'claude' } as unknown as AgentStatus]));
}

describe('the rule', () => {
  let routing: typeof import('../../../electron/services/orchestrator-routing');
  beforeEach(async () => {
    routing = await import('../../../electron/services/orchestrator-routing');
  });

  const two = () => fleet([['orch-capital', 'Capital-Orchestrator', CAPITAL, 'orchestrator'], ['orch-tars', 'Tars-Orchestrator', TARS, 'orchestrator'], ['worker', 'Tars-Backend', TARS]]);

  it('1. no "@project" and several orchestrators: nobody, and the list of projects', () => {
    expect(routing.orchestratorForMessage(two(), 'hello')).toEqual({ kind: 'ambiguous', name: null, projects: ['1212-Capital', 'tars'] });
  });

  it('1. no "@project" and one orchestrator in the fleet: that one, the text as it is', () => {
    const one = fleet([['orch-tars', 'Tars-Orchestrator', TARS, 'orchestrator'], ['worker', 'Tars-Backend', TARS]]);

    expect(routing.orchestratorForMessage(one, 'hello')).toMatchObject({ kind: 'found', orchestrator: { id: 'orch-tars' }, text: 'hello', projectPath: TARS });
  });

  it('2, 4. "@project text": that project\'s orchestrator, the text without the prefix, whatever the case', () => {
    expect(routing.orchestratorForMessage(two(), '@tars fais le point')).toMatchObject({ kind: 'found', orchestrator: { id: 'orch-tars' }, text: 'fais le point' });
    expect(routing.orchestratorForMessage(two(), '@1212-capital: go')).toMatchObject({ kind: 'found', orchestrator: { id: 'orch-capital' }, text: 'go' });
  });

  it("6. a folder name with a space is offered, and reached, with a dash in its place", () => {
    const ONEIL = "/Users/someone/projects/o'neil project";
    const spaced = fleet([['orch-oneil', 'Oneil-Orchestrator', ONEIL, 'orchestrator'], ['orch-tars', 'Tars-Orchestrator', TARS, 'orchestrator']]);

    expect(routing.projectNames(spaced)).toEqual(["o'neil-project", 'tars']);
    expect(routing.orchestratorForMessage(spaced, "@O'Neil-Project ship it")).toMatchObject({ kind: 'found', orchestrator: { id: 'orch-oneil' }, text: 'ship it', projectPath: ONEIL });
    expect(routing.orchestratorForMessage(spaced, 'hello')).toEqual({ kind: 'ambiguous', name: null, projects: ["o'neil-project", 'tars'] });
    expect(routing.whereToWrite({ kind: 'unknown', name: 'nope', projects: routing.projectNames(spaced) })).toContain("@o'neil-project");
  });

  it('3. a name no project has, a name two share, a project with no orchestrator, no orchestrator at all', () => {
    const shared = fleet([['orch-tars', 'Tars-Orchestrator', TARS, 'orchestrator'], ['orch-other', 'Other', '/Users/someone/elsewhere/tars', 'orchestrator']]);
    const lonely = fleet([['orch-tars', 'Tars-Orchestrator', TARS, 'orchestrator'], ['w', 'Lonely-Worker', '/Users/someone/projects/lonely']]);

    expect(routing.orchestratorForMessage(two(), '@nope hi')).toEqual({ kind: 'unknown', name: 'nope', projects: ['1212-Capital', 'tars'] });
    expect(routing.orchestratorForMessage(shared, '@tars hi')).toEqual({ kind: 'ambiguous', name: 'tars', projects: ['tars', 'tars'] });
    expect(routing.orchestratorForMessage(lonely, '@lonely hi')).toEqual({ kind: 'no-orchestrator', projectPath: '/Users/someone/projects/lonely', text: 'hi' });
    expect(routing.orchestratorForMessage(fleet([['w', 'W', TARS]]), 'hi')).toEqual({ kind: 'none', projects: ['tars'] });
  });
});

describe('the bots', () => {
  let agents: Map<string, AgentStatus>;

  beforeEach(async () => {
    vi.resetModules();
    for (const key of Object.keys(typed)) delete typed[key];
    const manager = await import('../../../electron/core/agent-manager');
    ({ agents } = manager as never);
    manager.wireDialogProbe();
    const { ptyProcesses } = await import('../../../electron/core/pty-manager');
    const { spawnAgentPty } = await import('../../../electron/core/agent-pty');
    for (const [id, name, projectPath, role] of [['orch-capital', 'Capital-Orchestrator', CAPITAL, 'orchestrator'], ['orch-tars', 'Tars-Orchestrator', TARS, 'orchestrator']] as const) {
      const term = spawnAgentPty({ binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: os.tmpdir(), cols: 80, rows: 24, env: { CLAUDE_AGENT_ID: id } });
      ptyProcesses.set(`pty-${id}`, term as never);
      agents.set(id, { id, name, projectPath, role, status: 'running', provider: 'claude', ptyId: `pty-${id}`, ptyCwd: projectPath, skills: [], output: [], lastActivity: '' } as unknown as AgentStatus);
    }
  });

  it('5. Slack: a free message with two orchestrators is typed nowhere, and the sender gets the list', async () => {
    const { sendToSuperAgentFromSlack } = await import('../../../electron/services/slack-bot');
    const said: string[] = [];

    await sendToSuperAgentFromSlack('C1', 'hello', async (m: string) => { said.push(m); }, {} as never);
    await settle();

    expect(all('orch-tars') + all('orch-capital')).toBe('');
    expect(said.join('\n')).toMatch(/@1212-Capital[\s\S]*@tars|@tars[\s\S]*@1212-Capital/);
  });

  it('5. Slack: "@tars text" is typed into the tars orchestrator alone, without the prefix', async () => {
    const { sendToSuperAgentFromSlack } = await import('../../../electron/services/slack-bot');

    await sendToSuperAgentFromSlack('C1', '@tars fais le point', async () => {}, {} as never);
    await settle();

    expect(all('orch-tars')).toContain('fais le point');
    expect(all('orch-tars')).not.toContain('@tars');
    expect(all('orch-capital')).toBe('');
  });

  it('5. Discord: the same rule', async () => {
    const { sendToSuperAgentFromDiscord } = await import('../../../electron/services/discord-bot');
    const said: string[] = [];

    await sendToSuperAgentFromDiscord('D1', 'hello', async (m: string) => { said.push(m); }, {} as never);
    await sendToSuperAgentFromDiscord('D1', '@1212-Capital go', async () => {}, {} as never);
    await settle();

    expect(said.join('\n')).toMatch(/@tars/);
    expect(all('orch-capital')).toContain('go');
    expect(all('orch-tars')).toBe('');
  });
});
