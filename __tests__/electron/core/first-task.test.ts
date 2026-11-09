/**
 * An agent's first task, kept for its next start (electron/core/first-task.ts, the window's agent.setFirstTask and
 * teams.deploy). From the orchestrator's task of 10/11 and Tars-Frontend's role-saved-on-create.md (M1): a team
 * deployed with "start on deploy" off lost its brief, since Tars had no way to keep a first task until an agent's first
 * start, and saving it as `savedPrompt` made it the agent's role, read at every start.
 *
 * How it fails, written before the code (10/11):
 * 1. The first task is typed at every start, or kept after it was typed: it is taken once, by the next fresh start.
 * 2. A launch that does not happen (refused, failed) loses it: it is cleared only once a launch succeeded.
 * 3. A chat's message, or a restart that continues a conversation, takes it: only a fresh start does.
 * 4. A start with its own prompt loses the first task, or loses its prompt: the first task, then the prompt.
 * 5. It is written as the agent's role (savedPrompt): never.
 * 6. setFirstTask takes an agent that does not exist, a task that is not text, or one past the cap: refused; empty or
 *    null clears it.
 */
import { describe, it, expect } from 'vitest';
import { FIRST_TASK_CAP, setFirstTask, withFirstTask } from '../../../electron/core/first-task';
import type { AgentStatus } from '../../../electron/types';

const agentWith = (firstTask?: string) => ({
  id: 'a1', name: 'Lead', savedPrompt: 'You are the orchestrator of my-app.',
  ...(firstTask ? { firstTask: { text: firstTask, setAt: '2026-11-10T00:00:00.000Z' } } : {}),
}) as unknown as AgentStatus;

describe("an agent's first task", () => {
  it('1, 4. a fresh start takes it as its prompt, before the start\'s own', () => {
    const a = agentWith('Build the login page.');
    expect(withFirstTask(a, '', undefined)).toEqual({ prompt: 'Build the login page.', took: true });
    expect(withFirstTask(a, '  ', {})).toEqual({ prompt: 'Build the login page.', took: true });
    expect(withFirstTask(a, 'Start with the form.', { model: 'x' })).toEqual({ prompt: 'Build the login page.\n\nStart with the form.', took: true });
  });

  it('3. a chat\'s message and a restart that continues a conversation leave it for a fresh start', () => {
    const a = agentWith('Build the login page.');
    expect(withFirstTask(a, 'hello', { message: true })).toEqual({ prompt: 'hello', took: false });
    expect(withFirstTask(a, '', { resumeSessionId: '11111111-1111-4111-8111-111111111111' })).toEqual({ prompt: '', took: false });
    expect(withFirstTask(a, '', { resumeSessionId: null })).toEqual({ prompt: 'Build the login page.', took: true });
  });

  it('1. nothing to take: the prompt as it was', () => {
    expect(withFirstTask(agentWith(), 'go', undefined)).toEqual({ prompt: 'go', took: false });
    expect(withFirstTask(undefined, 'go', undefined)).toEqual({ prompt: 'go', took: false });
  });

  it('5. setting it never touches the role', () => {
    const a = agentWith();
    expect(setFirstTask(a, 'Build the login page.')).toEqual({ success: true });
    expect(a.firstTask).toMatchObject({ text: 'Build the login page.' });
    expect(a.savedPrompt).toBe('You are the orchestrator of my-app.');
  });

  it('6. refuses no agent, a task that is not text, one past the cap; clears on empty or null', () => {
    expect(setFirstTask(undefined, 'x')).toMatchObject({ success: false, error: expect.stringMatching(/not found/) });
    const a = agentWith('old');
    for (const bad of [42, {}, ['x']]) expect(setFirstTask(a, bad), JSON.stringify(bad)).toMatchObject({ success: false });
    expect(setFirstTask(a, 'y'.repeat(FIRST_TASK_CAP + 1))).toMatchObject({ success: false, error: expect.stringMatching(/characters/) });
    expect(a.firstTask?.text).toBe('old');
    expect(setFirstTask(a, '   ')).toEqual({ success: true });
    expect(a.firstTask).toBeUndefined();
    setFirstTask(a, 'again');
    expect(setFirstTask(a, null)).toEqual({ success: true });
    expect(a.firstTask).toBeUndefined();
  });
});
