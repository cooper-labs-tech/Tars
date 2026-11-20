import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentDialogSuperAgentSidebar } from '../../src/components/AgentWorld/AgentDialogSuperAgentSidebar';
import type { AgentStatus } from '../../src/types/electron';

/**
 * The orchestrator window's rail (#161's Low, from the Audit's gate): its head
 * counts every agent but the window's own, and its lists covered running,
 * idle or completed, and error only, so a waiting agent was counted and shown
 * nowhere. Orchestrators wait most of the time, so it showed. Frame:
 * `Agent window · orchestrator rail` in design/tars-redesign.pen. How it fails:
 * 1. an agent the head counts has no row, whatever its status;
 * 2. a waiting agent is filed under another group and reads as what it is not;
 * 3. an agent gets two rows, or the window's own agent gets one.
 */

const agent = (id: string, status: AgentStatus['status'], name = `Agent ${id}`): AgentStatus => ({
  id, name, status, projectPath: `/work/${id}`, skills: [], output: [], lastActivity: new Date(0).toISOString(),
} as unknown as AgentStatus);

const EVERY: AgentStatus[] = [
  agent('me', 'waiting', 'The window'),
  agent('r', 'running', 'Runner'),
  agent('w', 'waiting', 'Waiter'),
  agent('e', 'error', 'Failer'),
  agent('i', 'idle', 'Rester'),
  agent('c', 'completed', 'Finisher'),
  agent('s', 'stopped', 'Halted'),
];

const rail = (agents: AgentStatus[]) => renderToStaticMarkup(<AgentDialogSuperAgentSidebar agentId="me" agents={agents} projects={[]} />);
const count = (markup: string, text: string) => markup.split(`>${text}<`).length - 1;

describe('the orchestrator rail', () => {
  it('gives every agent the head counts one row, whatever its status, and none to its own (1, 3)', () => {
    const markup = rail(EVERY);
    for (const name of ['Runner', 'Waiter', 'Failer', 'Rester', 'Finisher', 'Halted']) expect(count(markup, name), name).toBe(1);
    expect(count(markup, 'The window')).toBe(0);
    expect(markup).not.toContain('No agents created yet');
  });

  it('lists a waiting agent under Waiting, after Running, in the waiting colour (2)', () => {
    const markup = rail(EVERY);
    const at = (text: string) => markup.indexOf(text);
    expect(at('Waiting (1)')).toBeGreaterThan(at('Running (1)'));
    expect(at('Waiter')).toBeGreaterThan(at('Waiting (1)'));
    expect(at('Waiter')).toBeLessThan(at('Error (1)'));
    expect(markup).toMatch(/text-status-waiting[^"]*"[^>]*>\s*<svg|class="[^"]*text-status-waiting[^"]*"[^>]*>Waiting \(1\)/);
    expect(markup).toMatch(/class="[^"]*text-status-waiting[^"]*">waiting</);
  });

  it('keeps the idle group to idle and completed agents (2)', () => {
    const markup = rail(EVERY);
    const idle = markup.slice(markup.indexOf('Idle (2)'));
    expect(idle).toContain('Rester');
    expect(idle).toContain('Finisher');
    expect(idle).not.toContain('Waiter');
  });

  it('lists a lone waiting agent rather than an empty rail (1)', () => {
    const markup = rail([agent('me', 'running', 'The window'), agent('w', 'waiting', 'Waiter')]);
    expect(count(markup, 'Waiter')).toBe(1);
    expect(markup).toContain('Waiting (1)');
  });
});
