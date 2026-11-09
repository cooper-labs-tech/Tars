import { describe, it, expect } from 'vitest';
import { createAgentWithRole } from '../../src/lib/agent-role';

/**
 * An agent made from the window keeps its role (QA's fresh-install report, B2; Tars-Backend's
 * fix/role-not-overwritten-by-launch): once main stops writing `savedPrompt` on agent:start, a role the window only
 * passed as a launch prompt is lost. A template's role, and a team member's, is saved on the agent through agent:update
 * as soon as it exists; a launch prompt stays a first task. Checked against a stand-in of main's agent store.
 *
 * How it can fail, written before the code:
 * 1. a role given is not saved on the agent once made;
 * 2. a blank role (empty, spaces, none) writes an empty savedPrompt over nothing, or calls main for nothing;
 * 3. the role is saved before the agent exists, on an id main does not know;
 * 4. a creation main refuses saves a role somewhere, or does not throw its reason;
 * 5. what main answered for the agent is not handed back to the caller (its id is what starts it);
 * 6. a role main refuses to save, once the agent is made, reads as a creation that failed: the caller loses the
 *    agent's id, a team says the member could not be created, and a template's retry makes a second agent (the Audit's
 *    L2 on #581). The agent is handed back with why its role was not saved.
 */

type Stored = { id: string; name: string; savedPrompt?: string };

function main(refuseSave?: string, refuseHow: 'throw' | 'answer' = 'throw') {
  const agents = new Map<string, Stored>();
  let n = 0;
  return {
    agents,
    createAgent: async (params: { name: string; refuse?: string }) => {
      if (params.refuse) throw new Error(params.refuse);
      const agent: Stored = { id: `a${++n}`, name: params.name };
      agents.set(agent.id, agent);
      return { ...agent };
    },
    updateAgent: async (params: { id: string; savedPrompt?: string | null }) => {
      // useElectronAgents' updateAgent answers main's refusal as `{ success: false, error }`; IPC itself may throw.
      if (refuseSave && refuseHow === 'answer') return { success: false, error: refuseSave };
      if (refuseSave) throw new Error(refuseSave);
      const agent = agents.get(params.id);
      if (!agent) throw new Error(`Agent ${params.id} not found`);
      if (params.savedPrompt !== undefined) agent.savedPrompt = params.savedPrompt ?? undefined;
      return { success: true };
    },
  };
}

describe('an agent made with a role', () => {
  it('keeps its role (1, 3)', async () => {
    const m = main();
    const { agent, roleNotSaved } = await createAgentWithRole(m, { name: 'Reviewer' }, 'You review every PR before it merges.');
    expect(m.agents.get(agent.id)?.savedPrompt).toBe('You review every PR before it merges.');
    expect(roleNotSaved).toBeNull();
  });

  it('a blank role saves nothing (2)', async () => {
    const m = main();
    for (const role of ['', '   ', undefined, null]) {
      const { agent } = await createAgentWithRole(m, { name: 'Worker' }, role);
      expect(m.agents.get(agent.id)).toEqual({ id: agent.id, name: 'Worker' });
    }
  });

  it('a role main refuses to save still hands back the agent made, with why (6)', async () => {
    const m = main('The agent could not be saved: disk full');
    const { agent, roleNotSaved } = await createAgentWithRole(m, { name: 'Tester' }, 'You test.');
    expect(agent).toMatchObject({ id: 'a1', name: 'Tester' });
    expect(m.agents.size).toBe(1);
    expect(roleNotSaved).toBe('The agent could not be saved: disk full');
  });

  it('a refusal main answers rather than throws is a role not saved too (6, the Audit\'s L3 on #581)', async () => {
    const m = main('Refused: the agent is being removed', 'answer');
    const { agent, roleNotSaved } = await createAgentWithRole(m, { name: 'Tester' }, 'You test.');
    expect(m.agents.get(agent.id)?.savedPrompt).toBeUndefined();
    expect(roleNotSaved).toBe('Refused: the agent is being removed');
  });

  it('a refused creation saves nothing and says why (4)', async () => {
    const m = main();
    await expect(createAgentWithRole(m, { name: 'Builder', refuse: 'not a git repository' }, 'You build.')).rejects.toThrow('not a git repository');
    expect(m.agents.size).toBe(0);
  });

  it('hands back the agent main made (5)', async () => {
    const m = main();
    const { agent } = await createAgentWithRole(m, { name: 'Planner' }, 'You plan.');
    expect(agent).toMatchObject({ id: 'a1', name: 'Planner' });
  });
});
