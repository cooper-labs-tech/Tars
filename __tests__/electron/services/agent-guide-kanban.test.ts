/**
 * The kanban lines of an agent's guide, with and without a Hermes gateway (electron/services/agent-guide.ts). From
 * QA's fresh-install report (fresh-install-turnkey.md, H3): the bootstrap told a new user's orchestrator "The kanban
 * is the project's Hermes board: file the work you split with create_task", while no gateway was set up, the Kanban
 * page read "Hermes is not configured" and every kanban tool went to a Hermes that was not there.
 *
 * How it fails, written before the code (10/11):
 * 1. Without a gateway an orchestrator is sent to file tasks on a board that is not there, and a worker to claim and
 *    finish tasks on it: neither is told to use the kanban tools, and both are told there is no board and where the
 *    split lives instead (the orchestrator's delegations and the reports).
 * 2. Without a gateway they are told to have the user sign in to Hermes when it refuses: nothing to sign in to.
 * 3. With a gateway, the board and its tools are lost: an orchestrator files with create_task, a worker claims with
 *    assign_task and finishes with mark_task_done, as before.
 * 4. The section an agent gets reads a Hermes that is not usable (a file with no address, a broken one) as set up:
 *    agentGuideSection asks usableHermesConnection, not the file's presence.
 * 5. Either way, more than 15 lines, or an em or en dash.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { usable } = vi.hoisted(() => ({ usable: { value: null as null | { mode: string } } }));
vi.mock('../../../electron/services/hermes-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/services/hermes-config')>();
  return { ...actual, usableHermesConnection: () => usable.value };
});

import { agentGuideSection, identitySection } from '../../../electron/services/agent-guide';
import type { AgentStatus } from '../../../electron/types';

const folder = '/Users/x/.tars/project-files/app-1234567890';

beforeEach(() => { usable.value = null; });

describe('the kanban lines of the guide', () => {
  it('1, 2. without a gateway: no board, no kanban tools, no Hermes to sign in to', () => {
    const lead = identitySection('orchestrator', folder, undefined, { hermes: false }).join('\n');
    const worker = identitySection('worker', folder, undefined, { hermes: false }).join('\n');
    for (const text of [lead, worker]) {
      expect(text).not.toMatch(/Hermes board|create_task|assign_task|mark_task_done|signs in to it/);
      expect(text).toMatch(/no kanban board/i);
    }
    expect(lead).toMatch(/delegat/);
    expect(worker).toMatch(/report/);
  });

  it('3. with a gateway: the board and its tools, as before', () => {
    const lead = identitySection('orchestrator', folder, undefined, { hermes: true }).join('\n');
    const worker = identitySection('worker', folder, undefined, { hermes: true }).join('\n');
    expect(lead).toContain('create_task');
    expect(lead).toContain("Hermes board");
    for (const word of ['assign_task', 'mark_task_done', 'create_task']) expect(worker).toContain(word);
    expect(lead).toMatch(/signs in to it in Tars/);
  });

  it('4. the section an agent gets follows whether Hermes is usable', () => {
    const agent = { id: 'a1', name: 'Lead', role: 'orchestrator', projectPath: '/tmp/no-such-project-for-guide', status: 'idle', skills: [], output: [] } as unknown as AgentStatus;
    expect(agentGuideSection(agent)).toMatch(/no kanban board/i);
    usable.value = { mode: 'local' };
    expect(agentGuideSection(agent)).toContain('create_task');
  });

  it('5. stays within 15 lines, with no em or en dash, either way', () => {
    for (const hermes of [true, false]) {
      for (const role of ['orchestrator', 'worker'] as const) {
        const lines = identitySection(role, folder, undefined, { hermes });
        expect(lines.length).toBeLessThanOrEqual(15);
        expect(lines.join('\n')).not.toMatch(/[–—]/);
      }
    }
  });
});
