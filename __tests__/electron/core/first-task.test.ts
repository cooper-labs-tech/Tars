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
 * And from the Audit's L3 on #584 (at 42c3e0a75), written before the code:
 * 7. A start is taken for fresh from its options alone: a wake or a recovery after a crash gives no resume option and
 *    continues the conversation all the same, and the old first task is typed into it. Fresh is read from the
 *    conversation the launch resolves (launchResumes, utils/resume-session.ts, as launchInTerminal resolves it).
 * 8. A start that does not take it leaves it for a later one: whichever start comes first takes it (fresh, not a
 *    chat's message) or spends it unused (continuing a conversation, a chat's message), so the caller clears it once
 *    that launch succeeded.
 * 9. launchResumes counts as the start it predicts, or reads another conversation than the launch: it continues
 *    nothing for a null option, the named session when its transcript is there, and with no option the last session
 *    once per run or after a sleep, as consumeResumeSessionId, without spending it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FIRST_TASK_CAP, setFirstTask, withFirstTask } from '../../../electron/core/first-task';
import { consumeResumeSessionId, encodeProjectDirName, launchResumes, resetResumeTracking, resumeOnNextStart } from '../../../electron/utils/resume-session';
import type { AgentStatus } from '../../../electron/types';

const agentWith = (firstTask?: string) => ({
  id: 'a1', name: 'Lead', savedPrompt: 'You are the orchestrator of my-app.',
  ...(firstTask ? { firstTask: { text: firstTask, setAt: '2026-11-10T00:00:00.000Z' } } : {}),
}) as unknown as AgentStatus;

describe("an agent's first task", () => {
  it('1, 4. a fresh start takes it as its prompt, before the start\'s own', () => {
    const a = agentWith('Build the login page.');
    expect(withFirstTask(a, '', { resumes: false })).toEqual({ prompt: 'Build the login page.', took: true, spent: true });
    expect(withFirstTask(a, '  ', { resumes: false })).toEqual({ prompt: 'Build the login page.', took: true, spent: true });
    expect(withFirstTask(a, 'Start with the form.', { resumes: false })).toEqual({ prompt: 'Build the login page.\n\nStart with the form.', took: true, spent: true });
  });

  it('3, 7, 8. a start that continues a conversation, or a chat\'s message, types nothing of it and spends it', () => {
    const a = agentWith('Build the login page.');
    expect(withFirstTask(a, 'hello', { message: true, resumes: false })).toEqual({ prompt: 'hello', took: false, spent: true });
    expect(withFirstTask(a, '', { resumes: true })).toEqual({ prompt: '', took: false, spent: true });
    expect(withFirstTask(a, 'go on', { resumes: true })).toEqual({ prompt: 'go on', took: false, spent: true });
  });

  it('1. nothing to take: the prompt as it was, nothing spent', () => {
    expect(withFirstTask(agentWith(), 'go', { resumes: false })).toEqual({ prompt: 'go', took: false, spent: false });
    expect(withFirstTask(undefined, 'go', { resumes: false })).toEqual({ prompt: 'go', took: false, spent: false });
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

describe('whether a launch continues a conversation, as the launch resolves it (launchResumes)', () => {
  const SID = '7b7b7b7b-2222-4222-8222-7b7b7b7b7b7b';
  const OTHER = '8c8c8c8c-3333-4333-8333-8c8c8c8c8c8c';
  let home: string;
  let project: string;
  const onDisk = (sid: string) => {
    const dir = path.join(home, '.claude', 'projects', encodeProjectDirName(project));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), '{}\n');
  };
  const agent = (over: Partial<AgentStatus> = {}) =>
    ({ id: 'a1', provider: 'claude', projectPath: project, resumableSessionId: SID, ...over }) as AgentStatus;

  beforeEach(() => {
    resetResumeTracking();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'first-task-resume-'));
    project = path.join(home, 'project');
    fs.mkdirSync(project, { recursive: true });
  });

  it('9. no option: the last session, the run\'s first start or after a sleep, without spending it', () => {
    onDisk(SID);
    const a = agent();
    expect(launchResumes(a, undefined, home)).toBe(true);
    expect(launchResumes(a, undefined, home), 'asking spends nothing').toBe(true);
    expect(consumeResumeSessionId(a, home)).toBe(SID);
    expect(launchResumes(a, undefined, home), 'a second start of the run is a new conversation').toBe(false);
    resumeOnNextStart(a.id);
    expect(launchResumes(a, undefined, home), 'woken after a sleep, it continues').toBe(true);
  });

  it('9. no transcript on disk: nothing to continue', () => {
    expect(launchResumes(agent(), undefined, home)).toBe(false);
    expect(launchResumes(agent({ resumableSessionId: undefined }), undefined, home)).toBe(false);
  });

  it('9. a null option continues nothing; a named session, when its transcript is there', () => {
    onDisk(SID);
    expect(launchResumes(agent(), null, home)).toBe(false);
    expect(launchResumes(agent(), SID, home)).toBe(true);
    expect(launchResumes(agent(), OTHER, home)).toBe(false);
    onDisk(OTHER);
    expect(launchResumes(agent({ resumableSessionId: undefined }), OTHER, home)).toBe(true);
  });
});
