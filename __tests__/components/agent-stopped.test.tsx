import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentManagementCard } from '../../src/components/AgentList/AgentManagementCard';
import TerminalPanelHeader from '../../src/components/TerminalsView/components/TerminalPanelHeader';
import { AgentDialogHeader } from '../../src/components/AgentWorld/AgentDialogHeader';
import { AgentDialogSuperAgentSidebar } from '../../src/components/AgentWorld/AgentDialogSuperAgentSidebar';
import type { AgentStatus } from '../../src/types/electron';

/**
 * A stopped agent where JeanBrasse looks at it: its card on the Agents page, its
 * pane's header on the Dashboard, its window's header, and the rail of an
 * orchestrator's window. Frame: `Agent stopped · who and why` in
 * design/tars-redesign.pen. Written before the code. How each can fail:
 * 1. it throws on `stopped`, a status its tables do not know (the Agents page
 *    did, "Cannot read properties of undefined (reading 'text')");
 * 2. it says idle, the word of an agent never started, or no word at all;
 * 3. the word takes a colour of its own instead of the idle ink;
 * 4. who stopped it, when and why is nowhere, or not whole in the title;
 * 5. the line shows for an agent working again, from fields a stop left;
 * 6. it offers stop on an agent with nothing left to stop: from the window a
 *    second stop is filed under you and replaces who and why;
 * 7. the rail counts it in its head and gives it no row, or files it as idle.
 */

const SENTENCE = 'Stopped by Project Lead at 14:02: frozen on a file read for 40 minutes';
const TASK = 'audit the session guard';

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'w1',
    name: 'Frontend Engineer',
    status: 'stopped',
    stoppedBy: 'Project Lead',
    stoppedAt: new Date(2026, 9, 1, 14, 2).toISOString(),
    stopReason: 'frozen on a file read for 40 minutes',
    projectPath: '/tmp/project',
    skills: [],
    output: [],
    lastActivity: new Date(0).toISOString(),
    currentTask: TASK,
    branchName: 'feat/frontend',
    provider: 'claude',
    model: 'opus-5',
    permissionMode: 'bypass',
    effort: 'high',
    cliRunning: false,
    ...over,
  } as AgentStatus;
}

const noop = () => {};

const card = (a: AgentStatus) => renderToStaticMarkup(
  <AgentManagementCard agent={a} onClick={noop} onEdit={noop} onStart={noop} onStop={noop} onDelete={noop} />,
);

const header = (a: AgentStatus) => renderToStaticMarkup(
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

const windowHeader = (a: AgentStatus) => renderToStaticMarkup(
  <AgentDialogHeader agent={a} isSuperAgentMode={false} onClose={noop} onStop={noop} onRestart={noop} onEdit={noop} onOpenInReview={noop} />,
);

const rail = (agents: AgentStatus[]) => renderToStaticMarkup(<AgentDialogSuperAgentSidebar agentId="me" agents={agents} projects={[]} />);

/** The element holding exactly this text, with its attributes. */
const elementWith = (html: string, text: string) => html.match(new RegExp(`<[a-z]+ [^>]*>${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</[a-z]+>`))?.[0] ?? '';

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1, 15, 0));
});
afterAll(() => {
  vi.useRealTimers();
});

describe('the Agents card of a stopped agent', () => {
  it('draws, says stopped in the idle ink, and who, when and why in place of the task (1, 2, 3, 4)', () => {
    const html = card(agent());
    const word = elementWith(html, 'stopped');
    expect(word).toContain('text-status-idle');
    expect(word).toContain(`title="${SENTENCE}"`);
    const line = elementWith(html, SENTENCE);
    expect(line).toContain(`title="${SENTENCE}"`);
    expect(html).not.toContain(TASK);
    expect(html).not.toContain('>idle<');
  });

  it('offers start, not stop (6)', () => {
    const html = card(agent());
    expect(html).toContain('>start</button>');
    expect(html).not.toContain('>stop</button>');
  });

  it('says a missing folder first, which is why it cannot start at all', () => {
    const html = card(agent({ pathMissing: true } as Partial<AgentStatus>));
    expect(html).toContain('Path not found');
    expect(elementWith(html, SENTENCE)).toBe('');
  });

  it('shows the task, and no stop, once the agent works again (5)', () => {
    const html = card(agent({ status: 'running', cliRunning: true }));
    expect(html).toContain(TASK);
    expect(html).not.toContain('Stopped by');
  });
});

describe('the Dashboard pane header of a stopped agent', () => {
  it('draws, says stopped in the idle ink, and puts who, when and why in the branch\'s place (1, 2, 3, 4)', () => {
    const html = header(agent());
    const word = elementWith(html, 'stopped');
    expect(word).toContain('text-status-idle');
    expect(word).toContain(`title="${SENTENCE}"`);
    expect(elementWith(html, SENTENCE)).toContain(`title="${SENTENCE}"`);
    expect(html).not.toContain('feat/frontend');
    expect(html).not.toContain('Bypass mode');
    expect(html).not.toContain('High effort');
  });

  it('offers start (6)', () => {
    expect(header(agent())).toMatch(/>start<\/button>/);
  });

  it('keeps the branch and says nothing of the stop once the agent works again (5)', () => {
    const html = header(agent({ status: 'running', cliRunning: true }));
    expect(html).toContain('feat/frontend');
    expect(html).not.toContain('Stopped by');
  });
});

describe('the window header of a stopped agent', () => {
  it('says stopped in the idle ink, the whole sentence in its title (1, 2, 3, 4)', () => {
    const html = windowHeader(agent());
    const word = elementWith(html, 'stopped');
    expect(word).toContain('text-status-idle');
    expect(word).toContain(`title="${SENTENCE}"`);
  });

  it('offers no second stop, which would file the stop under you and lose who and why (6)', () => {
    const stop = windowHeader(agent()).match(/<button[^>]*>stop<\/button>/)?.[0] ?? '';
    expect(stop).toMatch(/ disabled=""/);
    const live = windowHeader(agent({ status: 'running', cliRunning: true })).match(/<button[^>]*>stop<\/button>/)?.[0] ?? '';
    expect(live).not.toMatch(/ disabled=""/);
  });
});

describe('the rail of an orchestrator\'s window', () => {
  const at = (id: string, status: AgentStatus['status'], name: string, over: Partial<AgentStatus> = {}) => agent({ id, status, name, ...over });

  it('gives a stopped agent one row, in a stopped group after idle, with who, when and why (7, 4)', () => {
    const html = rail([
      at('me', 'running', 'The window', { role: 'orchestrator' }),
      at('i', 'idle', 'Rester'),
      at('w1', 'stopped', 'Frontend Engineer'),
      at('y1', 'stopped', 'Writer', { stoppedBy: 'you', stopReason: undefined }),
    ]);
    expect(html.split('>Frontend Engineer<').length - 1).toBe(1);
    expect(html.split('>Writer<').length - 1).toBe(1);
    expect(html.indexOf('Stopped (2)')).toBeGreaterThan(html.indexOf('Idle (1)'));
    expect(html.indexOf('Frontend Engineer')).toBeGreaterThan(html.indexOf('Stopped (2)'));
    expect(elementWith(html, SENTENCE)).toContain(`title="${SENTENCE}"`);
    expect(elementWith(html, 'Stopped by you at 14:02')).toContain('title="Stopped by you at 14:02"');
    const idle = html.slice(html.indexOf('Idle (1)'), html.indexOf('Stopped (2)'));
    expect(idle).not.toContain('Frontend Engineer');
  });
});
