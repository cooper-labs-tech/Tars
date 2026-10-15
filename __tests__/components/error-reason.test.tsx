import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { errorReason } from '../../src/app/agents/constants';
import { AgentManagementCard } from '../../src/components/AgentList/AgentManagementCard';
import TerminalPanelHeader from '../../src/components/TerminalsView/components/TerminalPanelHeader';
import { TeamSection } from '../../src/components/Chat/ChatSidebar';
import type { AgentStatus } from '../../src/types/electron';
import type { RoomAgent } from '../../src/hooks/useRoomAgents';

/**
 * Why an agent is in error, where JeanBrasse looks for it.
 *
 * Since 1.7.0 `agent.error` holds the CLI's own sentence when a turn fails, and
 * only the Chat rail printed it, and only for an agent with no task. It now
 * shows on the Agents card, in the Dashboard panel header, and before the task
 * in the rail. Asserted on the markup rather than left to the screenshots: the
 * seeded agent in error carries no sentence, and one red line is under the
 * 0.002 diff ratio the baselines run at.
 *
 * The field outlives the failure until the next turn clears it, so every
 * surface is also held to showing it only while the status still says error.
 */

const SENTENCE = 'Not logged in · Please run /login';
const TASK = 'Fourth try: audit the session guard';

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'a1',
    name: 'Tars-Backend',
    status: 'error',
    projectPath: '/tmp/project',
    skills: [],
    output: [],
    lastActivity: new Date(0).toISOString(),
    currentTask: TASK,
    error: SENTENCE,
    branchName: 'feat/guard',
    permissionMode: 'bypass',
    effort: 'high',
    ...over,
  } as AgentStatus;
}

const noop = () => {};

function card(a: AgentStatus): string {
  return renderToStaticMarkup(
    <AgentManagementCard agent={a} onClick={noop} onEdit={noop} onStart={noop} onStop={noop} onDelete={noop} />,
  );
}

function header(a: AgentStatus): string {
  return renderToStaticMarkup(
    <TerminalPanelHeader
      agent={a}
      view="live"
      onViewChange={noop}
      isFullscreen={false}
      isBroadcasting={false}
      tabType="project"
      onStart={noop}
      onStop={noop}
      onFullscreen={noop}
      onExitFullscreen={noop}
      onClear={noop}
      onRemove={noop}
      onContextMenu={noop}
    />,
  );
}

function rail(a: AgentStatus, hasEndOfTurn = true): string {
  const member: RoomAgent = { ...a, hasEndOfTurn, stopped: false };
  return renderToStaticMarkup(
    <TeamSection
      project="project"
      agents={[member]}
      pending={{}}
      lastSpoke={{}}
      candidates={[]}
      onAction={noop}
      onAdd={noop}
      onNewAgent={noop}
    />,
  );
}

describe('errorReason', () => {
  it('is the sentence while the status says error', () => {
    expect(errorReason({ status: 'error', error: `  ${SENTENCE}\n` })).toBe(SENTENCE);
  });

  it('is nothing for an error that carries no words', () => {
    expect(errorReason({ status: 'error', error: undefined })).toBeNull();
    expect(errorReason({ status: 'error', error: '   ' })).toBeNull();
  });

  it('is nothing once the agent has left error, whatever the field still holds', () => {
    for (const status of ['running', 'waiting', 'idle', 'completed'] as const) {
      expect(errorReason({ status, error: SENTENCE }), status).toBeNull();
    }
  });
});

describe('the Agents card', () => {
  it('shows the reason in place of the task, whole in the title', () => {
    const html = card(agent());
    expect(html).toContain(`title="${SENTENCE}"`);
    expect(html).toContain(`>${SENTENCE}</p>`);
    expect(html).toContain('text-status-error');
    expect(html).not.toContain(TASK);
  });

  it('shows the task, not a failure that is over, for an agent working again', () => {
    const html = card(agent({ status: 'running' }));
    expect(html).toContain(TASK);
    expect(html).not.toContain(SENTENCE);
  });

  it('still says a missing path first, which is why it cannot start at all', () => {
    const html = card(agent({ pathMissing: true } as Partial<AgentStatus>));
    expect(html).toContain('Path not found');
    expect(html).not.toContain(SENTENCE);
  });
});

describe('the Dashboard panel header', () => {
  it('puts the reason where the branch was, and steps the mode marks aside', () => {
    const html = header(agent());
    expect(html).toContain(`title="${SENTENCE}"`);
    expect(html).not.toContain('feat/guard');
    expect(html).not.toContain('Bypass mode');
    expect(html).not.toContain('High effort');
  });

  it('keeps the branch and the marks for an agent working again', () => {
    const html = header(agent({ status: 'running' }));
    expect(html).toContain('feat/guard');
    expect(html).toContain('Bypass mode');
    expect(html).not.toContain(SENTENCE);
  });
});

describe('the Chat team rows', () => {
  it('says why before what it was asked', () => {
    const html = rail(agent());
    expect(html).toContain(SENTENCE);
    expect(html).not.toContain(TASK);
  });

  it('falls back to the task, then to a plain sentence, when the error has no words', () => {
    expect(rail(agent({ error: undefined }))).toContain(TASK);
    expect(rail(agent({ error: undefined, currentTask: undefined }))).toContain('stopped on an error');
  });

  it('shows the task for an agent working again', () => {
    const html = rail(agent({ status: 'running' }));
    expect(html).toContain(TASK);
    expect(html).not.toContain(SENTENCE);
  });
});
