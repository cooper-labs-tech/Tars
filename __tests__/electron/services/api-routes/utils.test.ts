import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
}));

import { findAgentByIdOrSession } from '../../../../electron/services/api-routes/utils';
import { agents } from '../../../../electron/core/agent-manager';
import { AgentStatus } from '../../../../electron/types';

function makeAgent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'agent-1',
    status: 'idle',
    projectPath: '/test',
    skills: [],
    output: [],
    lastActivity: new Date().toISOString(),
    ...overrides,
  };
}

describe('findAgentByIdOrSession', () => {
  beforeEach(() => {
    agents.clear();
  });

  it('finds agent by id', () => {
    const agent = makeAgent({ id: 'a1' });
    agents.set('a1', agent);
    expect(findAgentByIdOrSession('a1')).toBe(agent);
  });

  it('finds agent by session id when id lookup fails', () => {
    const agent = makeAgent({ id: 'a2', currentSessionId: 'sess-1' });
    agents.set('a2', agent);
    expect(findAgentByIdOrSession('unknown', 'sess-1')).toBe(agent);
  });

  it('returns undefined when nothing matches', () => {
    expect(findAgentByIdOrSession('nope', 'nope')).toBeUndefined();
  });

  it('returns undefined when no args provided', () => {
    expect(findAgentByIdOrSession()).toBeUndefined();
  });
});
