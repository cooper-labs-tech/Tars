import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const reads = vi.hoisted(() => ({ files: [] as string[] }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  // Each read of the transcript opens it (agent-truth reads it in Buffers, from where it stopped, since 2.0.3).
  const openSync = ((p: unknown, ...rest: unknown[]) => {
    reads.files.push(String(p));
    return (actual.openSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof actual.openSync;
  return { ...actual, openSync, default: { ...actual, openSync } };
});

import { pendingBackgroundWork } from '../../../electron/services/agent-truth';

/**
 * The background work an agent left running, read from its transcript once per state of the file (the Audit's Low 3
 * on #305): at a rest, agent-watch asks for it to tell a requester, and task-watch asks to know whether the task
 * ended. Each read the whole transcript, synchronously, on the main thread: megabytes, twice, at every rest.
 *
 * How it can fail, written before the code:
 * 1. The second caller at the same rest reads the unchanged transcript again.
 * 2. A transcript written to since is not read again, and the answer is stale.
 * 3. One caller's start time decides the other's answer.
 */

let home: string;
const project = '/work/held';
const sessionId = '0941a7e6-7262-4068-ba83-68b7e0de1773';
const T0 = Date.UTC(2026, 9, 5, 2, 0, 0);
let file: string;

const at = (ms: number) => new Date(ms).toISOString();
const started = (id: string, ms: number) => JSON.stringify({ type: 'user', timestamp: at(ms), message: { content: [{ type: 'tool_result', tool_use_id: 'u' }] }, toolUseResult: { backgroundTaskId: id } });
const done = (id: string, ms: number) => JSON.stringify({ type: 'user', timestamp: at(ms), message: { content: `<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>` } });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-bg-once-'));
  const dir = path.join(home, '.claude', 'projects', project.replace(/[/.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, [started('b1', T0 + 1000), started('b2', T0 + 5000)].join('\n') + '\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const agent = { currentSessionId: sessionId, projectPath: project };
const readsOfTranscript = () => reads.files.filter((f) => f === file).length;

describe('the background work at a rest', () => {
  it('1. is read once for both callers when the transcript has not changed', () => {
    reads.files.length = 0;
    const forRequester = pendingBackgroundWork(agent, T0, home);
    const forTask = pendingBackgroundWork(agent, T0, home);

    expect(forRequester).toEqual(['b1', 'b2']);
    expect(forTask).toEqual(['b1', 'b2']);
    expect(readsOfTranscript()).toBe(1);
  });

  it('2. is read again once the transcript changed', () => {
    expect(pendingBackgroundWork(agent, T0, home)).toEqual(['b1', 'b2']);
    fs.appendFileSync(file, done('b1', T0 + 9000) + '\n');

    expect(pendingBackgroundWork(agent, T0, home)).toEqual(['b2']);
  });

  it("3. answers each caller from its own start time", () => {
    expect(pendingBackgroundWork(agent, T0, home)).toEqual(['b1', 'b2']);
    expect(pendingBackgroundWork(agent, T0 + 3000, home)).toEqual(['b2']);
  });
});
