import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * An agent asleep, and how it wakes: the contract #315's frames are drawn on
 * ("Agent asleep · and how it wakes"). The state and since when, a waking
 * state with who woke it, a wake call, and the pane's last screen kept while
 * the CLI is gone. JeanBrasse's choices 5 and 6 of 2026-10-05.
 *
 * How it fails, written before the code:
 * 8. Asleep, the agent keeps its terminal, its task or its wait, or its killed
 *    session is not a tombstone: that session's hooks, which outlive it, bring
 *    the agent back.
 * 9. Asleep, the pane has nothing to show: its last screen is not kept, or it
 *    is still given once the agent woke, was stopped or was put to sleep again
 *    with no screen.
 * 10. Woken, it starts a new conversation: the resume is spent once per run of
 *    Tars, so an agent started earlier in the run would lose its conversation.
 * 11. Waking, nothing says it, or who woke it and how; or `waking` outlives the
 *    launch (its session up, or the launch given up).
 * 12. An ordinary start (an agent that was not asleep) reads as waking.
 * 13. Woken on the session it slept in (`--resume` keeps the id), its hooks are
 *    dropped as the tombstone of that same session, and it never comes up.
 * 14. Asleep is lost at a restart of Tars (read back `idle`), or `waking`,
 *    which belongs to a launch, is read back.
 * 15. The wake call starts a CLI for an agent that is not asleep (a running
 *    one, a stopped one), or a second CLI over a wake already on its way.
 */

const { tmp, AGENTS_FILE } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-asleep-'));
  return { tmp, AGENTS_FILE: path.join(tmp, 'agents.json') };
});

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE };
});
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => tmp, getVersion: () => '1.9.3' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import type { AgentStatus } from '../../../electron/types';
import { fallAsleep, wakeFromSleep, noteWaker, publishedWaking, screenWhileAsleep, wakeAgent } from '../../../electron/core/agent-asleep';
import { consumeResumeSessionId, resetResumeTracking } from '../../../electron/utils/resume-session';
import { launchBegins, registerAgentLauncher, resetLaunches } from '../../../electron/core/agent-launch';

const SID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const project = path.join(tmp, 'project');

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'w1', name: 'Build Worker', status: 'idle', projectPath: project, skills: [], output: [],
    lastActivity: '2026-10-05T11:00:00.000Z', provider: 'claude', ptyId: 'pty-1',
    currentSessionId: SID, resumableSessionId: SID, currentTask: 'build', ...over,
  } as AgentStatus;
}

beforeEach(() => {
  resetResumeTracking();
  resetLaunches();
  fs.mkdirSync(project, { recursive: true });
  const transcripts = path.join(tmp, '.claude', 'projects', project.replace(/[/.]/g, '-'));
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(transcripts, `${SID}.jsonl`), '{}\n');
});
afterEach(() => vi.restoreAllMocks());

describe('asleep', () => {
  it('8. ends the terminal, the task and the wait, and tombstones the session', () => {
    const a = agent({ status: 'waiting', waitingReason: 'idle' });
    fallAsleep(a, 'SCREEN', Date.parse('2026-10-05T12:00:00.000Z'));
    expect(a.status).toBe('asleep');
    expect(a.asleepSince).toBe('2026-10-05T12:00:00.000Z');
    expect(a.ptyId).toBeUndefined();
    expect(a.currentTask).toBeUndefined();
    expect(a.waitingReason).toBeUndefined();
    expect(a.currentSessionId).toBeUndefined();
    expect(a.lastKilledSessionId).toBe(SID);
    // The conversation it wakes on.
    expect(a.resumableSessionId).toBe(SID);
  });

  it('9. keeps the last screen while asleep, and only then', () => {
    const a = agent();
    fallAsleep(a, '\x1bcSCREEN OF W1', Date.now());
    expect(screenWhileAsleep(a)).toBe('\x1bcSCREEN OF W1');
    a.status = 'stopped';
    expect(screenWhileAsleep(a)).toBeUndefined();
    // Asleep again with no screen to keep (no mirror): nothing from before.
    a.status = 'idle';
    fallAsleep(a, undefined, Date.now());
    expect(screenWhileAsleep(a)).toBeUndefined();
    fallAsleep(a, 'SECOND', Date.now());
    wakeFromSleep(a);
    expect(screenWhileAsleep(a)).toBeUndefined();
  });

  it('10. wakes on its own conversation, even after the start of this run spent the resume', () => {
    const a = agent();
    expect(consumeResumeSessionId(a, tmp)).toBe(SID);
    expect(consumeResumeSessionId(a, tmp)).toBeNull();
    fallAsleep(a, undefined, Date.now());
    wakeFromSleep(a);
    expect(consumeResumeSessionId(a, tmp)).toBe(SID);
    // Once: a start after that one is a start as any other.
    expect(consumeResumeSessionId(a, tmp)).toBeNull();
  });

  it('13. lifts the tombstone of the session it wakes on, and only that one', () => {
    const a = agent();
    fallAsleep(a, undefined, Date.now());
    expect(a.lastKilledSessionId).toBe(SID);
    wakeFromSleep(a);
    expect(a.lastKilledSessionId).toBeUndefined();
    // A tombstone of another session, set since, stands.
    const b = agent({ id: 'w2' });
    fallAsleep(b, undefined, Date.now());
    b.lastKilledSessionId = 'another-session';
    wakeFromSleep(b);
    expect(b.lastKilledSessionId).toBe('another-session');
  });

  it('11. says it is waking, who woke it and how, for as long as its launch is on its way', () => {
    const a = agent();
    fallAsleep(a, undefined, Date.now());
    noteWaker(a.id, 'Orchestrator', 'message');
    wakeFromSleep(a);
    expect(a.status).toBe('idle');
    expect(a.asleepSince).toBeUndefined();
    expect(a.waking).toMatchObject({ by: 'Orchestrator', via: 'message' });
    expect(Number.isFinite(Date.parse(a.waking!.since))).toBe(true);
    expect(publishedWaking(a, true)).toMatchObject({ by: 'Orchestrator', via: 'message' });
    // Up, or given up: no longer waking, and not again.
    expect(publishedWaking(a, false)).toBeUndefined();
    expect(a.waking).toBeUndefined();
    expect(publishedWaking(a, true)).toBeUndefined();
  });

  it('11. names Tars when nothing said who woke it, and forgets a waker once used', () => {
    const a = agent();
    fallAsleep(a, undefined, Date.now());
    wakeFromSleep(a);
    expect(a.waking).toMatchObject({ by: 'Tars', via: 'start' });
    noteWaker(a.id, 'you', 'wake');
    fallAsleep(a, undefined, Date.now());
    wakeFromSleep(a);
    fallAsleep(a, undefined, Date.now());
    wakeFromSleep(a);
    expect(a.waking).toMatchObject({ by: 'Tars', via: 'start' });
  });

  it('12. an agent that was not asleep starts without waking', () => {
    for (const status of ['stopped', 'idle', 'error', 'completed'] as const) {
      noteWaker('w1', 'you', 'wake');
      const a = agent({ status });
      wakeFromSleep(a);
      expect(a.waking, status).toBeUndefined();
      expect(a.status, status).toBe(status);
    }
  });
});

describe('the wake call', () => {
  it('15. launches the CLI of an asleep agent with no prompt, once, and nothing for one awake or stopped', async () => {
    const launches: Array<{ id: string; prompt: string }> = [];
    registerAgentLauncher(async (id, prompt) => {
      launchBegins(id);
      launches.push({ id, prompt });
      return { success: true };
    });
    const a = agent();
    fallAsleep(a, undefined, Date.now());
    expect(await wakeAgent(a, 'you', 'wake')).toEqual({ success: true });
    // The launcher's own initAgentPty is what turns it awake; here it is not
    // called, so the agent still reads asleep: a second wake waits on the first.
    expect(await wakeAgent(a, 'you', 'key')).toEqual({ success: true, alreadyWaking: true });
    expect(launches).toEqual([{ id: 'w1', prompt: '' }]);

    for (const status of ['idle', 'running', 'stopped'] as const) {
      const other = agent({ id: `x-${status}`, status });
      const answer = await wakeAgent(other, 'you', 'wake');
      expect(answer.success, status).toBe(false);
    }
    expect(launches).toHaveLength(1);
  });

  it('15. says why when the launch fails, and the agent stays asleep', async () => {
    registerAgentLauncher(async () => ({ success: false, error: 'its folder is gone' }));
    const a = agent();
    fallAsleep(a, undefined, Date.now());
    expect(await wakeAgent(a, 'you', 'wake')).toEqual({ success: false, error: 'its folder is gone' });
    expect(a.status).toBe('asleep');
  });
});

describe('across a restart of Tars', () => {
  it('14. stays asleep, with since when, and is not read back waking', async () => {
    vi.resetModules();
    const manager = await import('../../../electron/core/agent-manager');
    manager.loadAgents();
    const a = agent({ id: 'a1', ptyId: undefined, status: 'asleep', asleepSince: '2026-10-05T11:30:00.000Z' } as Partial<AgentStatus>);
    const b = agent({ id: 'b1', ptyId: undefined, waking: { by: 'you', via: 'wake', since: '2026-10-05T11:31:00.000Z' } } as Partial<AgentStatus>);
    manager.agents.set('a1', a);
    manager.agents.set('b1', b);
    manager.saveAgents();
    // Not written: agents.json carries no launch.
    const written = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8')).agents as AgentStatus[];
    expect(written.find((x) => x.id === 'b1')?.waking).toBeUndefined();
    manager.agents.clear();
    manager.loadAgents();
    expect(manager.agents.get('a1')?.status).toBe('asleep');
    expect(manager.agents.get('a1')?.asleepSince).toBe('2026-10-05T11:30:00.000Z');
    expect(manager.agents.get('b1')?.waking).toBeUndefined();
    // Nor read back from a file that has one (an older build, a hand edit).
    manager.stopAgentAutosave();
    fs.writeFileSync(AGENTS_FILE, JSON.stringify({ version: 3, agents: written.map((x) => (x.id === 'b1' ? { ...x, waking: { by: 'you', via: 'wake', since: '2026-10-05T11:31:00.000Z' } } : x)) }));
    vi.resetModules();
    const again = await import('../../../electron/core/agent-manager');
    again.loadAgents();
    expect(again.agents.get('b1')?.waking).toBeUndefined();
    again.stopAgentAutosave();
  });
});
