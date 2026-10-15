import { describe, it, expect } from 'vitest';
import { assignRole, hasOrchestratorPowers, requestedRole, rolesOnLoad, roleFromName } from '../../../electron/core/agent-role';
import type { AgentStatus } from '../../../electron/types';

/**
 * The Orchestrator toggle is the role, a project has one orchestrator, and the
 * name decides nothing: JeanBrasse's decision of 2026-09-22 after the audit showed
 * the toggle changed nothing for an orchestrator and the name was the switch.
 *
 * The orchestrator's powers (ORCHESTRATOR-PER-CHAT.md v2.2, 4.2, PR D): its
 * project's orchestrator has them, and so does a chat's runner, a worker with
 * `kind: 'chat'` that runs one chat's conversation. Where they are read is
 * role-sites.test.ts.
 * How hasOrchestratorPowers fails, written before the code (2026-10-12):
 * 1. A chat's runner is refused them: the role alone is read.
 * 2. The project's orchestrator loses them: the kind alone is read.
 * 3. A worker gets them from its name (a runner is called "<orchestrator> ·
 *    <chat title>", and any worker may be called "Orchestrator"), or from the
 *    toggle's old field left on its record.
 * 4. A worker gets them from a chat id or an orchestrator id on its record,
 *    without the kind.
 * 5. A record with a kind this Tars does not know (a newer one's), or a role
 *    or a kind spelled otherwise, gets them: any kind is read as a runner's.
 */

function agent(id: string, fields: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id, name: id, status: 'idle', projectPath: '/p/tars', skills: [], output: [],
    lastActivity: '2026-09-23T00:00:00.000Z', ...fields,
  } as AgentStatus;
}

describe('requestedRole', () => {
  it('reads role, then the toggle under its old name, then nothing', () => {
    expect(requestedRole({ role: 'orchestrator' })).toBe('orchestrator');
    expect(requestedRole({ role: 'worker', orchestratorMode: true })).toBe('worker');
    expect(requestedRole({ orchestratorMode: true })).toBe('orchestrator');
    expect(requestedRole({ orchestratorMode: false })).toBe('worker');
    expect(requestedRole({})).toBeUndefined();
    expect(requestedRole({ role: null, orchestratorMode: undefined })).toBeUndefined();
  });

  it('refuses a role that is neither, instead of saying it worked', () => {
    expect(() => requestedRole({ role: 'admin' })).toThrow('Invalid role: admin');
    expect(() => requestedRole({ role: true })).toThrow('Invalid role');
  });

  it('does not take a truthy value for the toggle', () => {
    expect(requestedRole({ orchestratorMode: 'yes' })).toBeUndefined();
  });
});

describe('assignRole', () => {
  it('writes the role and keeps the old toggle field equal to it', () => {
    const a = agent('a', { role: 'worker', orchestratorMode: false });

    assignRole(a, 'orchestrator', []);
    expect(a).toMatchObject({ role: 'orchestrator', orchestratorMode: true });

    assignRole(a, 'worker', []);
    expect(a).toMatchObject({ role: 'worker', orchestratorMode: false });
  });

  it("takes the role from its project's current orchestrator, and only that project's", () => {
    const current = agent('current', { role: 'orchestrator', orchestratorMode: true });
    const next = agent('next', { role: 'worker' });
    const elsewhere = agent('elsewhere', { role: 'orchestrator', orchestratorMode: true, projectPath: '/p/sak' });
    const fleet = [current, next, elsewhere];

    const demoted = assignRole(next, 'orchestrator', fleet);

    expect(demoted).toEqual([current]);
    expect(current).toMatchObject({ role: 'worker', orchestratorMode: false });
    expect(next).toMatchObject({ role: 'orchestrator', orchestratorMode: true });
    expect(elsewhere).toMatchObject({ role: 'orchestrator', orchestratorMode: true });
  });

  it('demotes nobody when it makes a worker', () => {
    const current = agent('current', { role: 'orchestrator' });
    const other = agent('other', { role: 'orchestrator' });

    expect(assignRole(other, 'worker', [current, other])).toEqual([]);
    expect(current.role).toBe('orchestrator');
  });

  it('restores the rule for an orchestrator that moved into a project with one', () => {
    const resident = agent('resident', { role: 'orchestrator' });
    const moved = agent('moved', { role: 'orchestrator', projectPath: '/p/tars' });

    expect(assignRole(moved, 'orchestrator', [resident, moved])).toEqual([resident]);
    expect(resident.role).toBe('worker');
  });

  it('ignores the name, whatever it says', () => {
    const named = agent('named', { name: 'Tars-Orchestrator', role: 'worker' });

    assignRole(named, 'worker', [named]);

    expect(named.role).toBe('worker');
  });
});

describe('rolesOnLoad', () => {
  it('migrates a version 2 file: toggle on, or the stored role, or the name when there is none', () => {
    const list = [
      agent('stored', { name: 'Anything', role: 'orchestrator', projectPath: '/p/1' }),
      agent('toggle', { name: 'Reviewer', role: 'worker', orchestratorMode: true, projectPath: '/p/2' }),
      agent('named', { name: 'My Super Agent', projectPath: '/p/3' }),
      agent('plain', { name: 'Backend', projectPath: '/p/4' }),
    ];

    expect(rolesOnLoad(list, 2)).toEqual([]);

    expect(list.map(a => [a.id, a.role, a.orchestratorMode])).toEqual([
      ['stored', 'orchestrator', true],
      ['toggle', 'orchestrator', true],
      ['named', 'orchestrator', true],
      ['plain', 'worker', false],
    ]);
  });

  it('reads nothing but the role from a version 3 file', () => {
    const list = [
      agent('named', { name: 'Orchestrator' }),
      agent('stale-toggle', { role: 'worker', orchestratorMode: true, projectPath: '/p/2' }),
    ];

    rolesOnLoad(list, 3);

    expect(list.map(a => [a.id, a.role, a.orchestratorMode])).toEqual([
      ['named', 'worker', false],
      ['stale-toggle', 'worker', false],
    ]);
  });

  it('leaves one orchestrator per project, the first in the file, and says who lost it', () => {
    const first = agent('first', { role: 'orchestrator' });
    const second = agent('second', { role: 'orchestrator' });
    const other = agent('other', { role: 'orchestrator', projectPath: '/p/sak' });

    expect(rolesOnLoad([first, second, other], 3)).toEqual([second]);
    expect([first.role, second.role, other.role]).toEqual(['orchestrator', 'worker', 'orchestrator']);
  });
});

describe('roleFromName', () => {
  it('is the rule the name followed until now, and nothing more', () => {
    expect(roleFromName('Tars-Orchestrator')).toBe('orchestrator');
    expect(roleFromName('super agent')).toBe('orchestrator');
    expect(roleFromName('Tars-Lead')).toBe('worker');
    expect(roleFromName(undefined)).toBe('worker');
  });
});

describe('hasOrchestratorPowers', () => {
  const runner = (fields: Partial<AgentStatus> = {}) =>
    agent('runner', { name: 'Tars-Lead · Release 1.9.4', role: 'worker', kind: 'chat', chatId: 'c-2', teamOrchestratorId: 'lead', ...fields });

  it("1, 2. are its project's orchestrator's, and a chat's runner's", () => {
    expect(hasOrchestratorPowers(agent('lead', { role: 'orchestrator', orchestratorMode: true }))).toBe(true);
    expect(hasOrchestratorPowers(runner())).toBe(true);
    // A runner whose record says orchestrator too (never written by Tars) keeps them.
    expect(hasOrchestratorPowers(runner({ role: 'orchestrator' }))).toBe(true);
  });

  it("3. are no worker's, whatever its name or the old toggle field says", () => {
    expect(hasOrchestratorPowers(agent('w', { role: 'worker' }))).toBe(false);
    expect(hasOrchestratorPowers(agent('no-role'))).toBe(false);
    expect(hasOrchestratorPowers(agent('named', { name: 'Tars-Lead · Release 1.9.4', role: 'worker' }))).toBe(false);
    expect(hasOrchestratorPowers(agent('called', { name: 'Orchestrator', role: 'worker' }))).toBe(false);
    expect(hasOrchestratorPowers(agent('stale', { role: 'worker', orchestratorMode: true }))).toBe(false);
  });

  it('4. come from the kind, not from a chat id or an orchestrator id on a worker', () => {
    expect(hasOrchestratorPowers(agent('w', { role: 'worker', chatId: 'c-2' }))).toBe(false);
    expect(hasOrchestratorPowers(agent('w', { role: 'worker', teamOrchestratorId: 'lead' }))).toBe(false);
  });

  it('5. come from no other kind, and from no other spelling', () => {
    expect(hasOrchestratorPowers({ role: 'worker', kind: 'review' })).toBe(false);
    expect(hasOrchestratorPowers({ role: 'worker', kind: 'Chat' })).toBe(false);
    expect(hasOrchestratorPowers({ role: 'Orchestrator' })).toBe(false);
    expect(hasOrchestratorPowers({})).toBe(false);
  });
});
