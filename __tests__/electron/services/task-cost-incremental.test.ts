import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readTaskCosts, clearTaskCostCache } from '../../../electron/services/task-cost';
import { resetCatalogCache } from '../../../electron/services/model-catalog';
import { DATA_DIR } from '../../../electron/constants';
import type { TaskRecord } from '../../../electron/services/task-ledger';
import { hasPosixModes } from '../../setup/platform-limits';

/**
 * The cost of each task (usage:tasks, #311) reads a transcript once, then only what it gained (2026-10-13).
 *
 * The Usage page asks for it at each new figure, every ten seconds while an agent works, and it read the WHOLE
 * transcript of each session again whenever it had changed, the sessions still being written always; its cache held
 * 32 files, fewer than the sessions of one day (72 files, 1.5 GB, measured by the Frontend: 15 to 19 s cold), so the
 * others were read whole again as well. Read the way transcript-usage.ts reads since #377: from where it stopped,
 * keyed by inode, size and date.
 *
 * How it fails, written before the code:
 * 1. A transcript that grew between two reads loses a reply, or counts one twice.
 * 2. A grown transcript is read whole again: what it held already is parsed again (shown here by bytes changed in
 *    place before the growth, which a read from where it stopped never sees).
 * 3. A reply whose line was half-written at the first read is lost, or counted twice once it is whole; a last line
 *    whole but without its newline yet is counted twice when the newline and the next line come.
 * 4. A transcript that shrank (rewritten shorter) keeps replies it no longer holds.
 * 5. A transcript rewritten to the same size keeps its old replies.
 * 6. A transcript replaced by another file (a compaction that writes a new one, then renames it) is read from the
 *    old one's offset, mixing the two.
 * 7. An unchanged transcript is read again.
 * 8. More sessions than the cache holds churn it: with 40 sessions asked each time, 8 were read whole again at every
 *    call.
 * The figures stay those of a whole read: no reply counted twice or lost, whatever happened between two reads.
 * 7 and 8 prove a file was not read by making it unreadable, which Windows has no mode for: they run on macOS and
 * Linux, and the rest on all three.
 */

const T0 = Date.UTC(2026, 9, 13, 8, 0, 0);
const MODEL = 'claude-opus-5';
let home: string;

function task(id: string, sessionId: string): TaskRecord {
  return {
    id, agentId: 'worker-1', projectPath: '/work/tars', worktreePath: null, provider: 'claude', model: null,
    accountId: null, source: 'tars', requesterAgentId: null, parentTaskId: null, text: 'build it',
    startedAt: T0, endedAt: null, lastAt: T0 + 60_000, outcome: null, turns: 1, sessionIds: [sessionId],
  } as TaskRecord;
}

/** One reply line, input tokens only: at $1 a million, the cost reads as tokens / 1e6. */
const reply = (id: string, input: number) => JSON.stringify({
  type: 'assistant', requestId: `req_${id}`, timestamp: new Date(T0 + 1_000).toISOString(),
  message: { id, model: MODEL, usage: { input_tokens: input, output_tokens: 0 } },
});

const fileOf = (sessionId: string) => path.join(home, '.claude', 'projects', '-work-tars', `${sessionId}.jsonl`);
const write = (sessionId: string, text: string) => {
  fs.mkdirSync(path.dirname(fileOf(sessionId)), { recursive: true });
  fs.writeFileSync(fileOf(sessionId), text);
};
const append = (sessionId: string, text: string) => fs.appendFileSync(fileOf(sessionId), text);
/** Bytes changed where they are: the same file, the same size, a later date. */
const overwriteAt = (sessionId: string, position: number, text: string) => {
  const fd = fs.openSync(fileOf(sessionId), 'r+');
  try { fs.writeSync(fd, text, position); } finally { fs.closeSync(fd); }
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(fileOf(sessionId), later, later);
};
const tokens = async (tasks: TaskRecord[], id = tasks[0].id) => (await readTaskCosts(tasks, { homeDir: home })).get(id)?.tokens?.input ?? null;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-task-cost-inc-'));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'model-catalog.json'), JSON.stringify({
    anthropic: { models: { [MODEL]: { id: MODEL, name: 'Claude Opus 5', cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } } } },
  }));
  resetCatalogCache();
  clearTaskCostCache();
});

afterEach(() => {
  for (const dir of [path.join(home, '.claude', 'projects', '-work-tars')]) {
    try { for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o644); } catch { /* none */ }
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the cost of each task, read from what a transcript gained', () => {
  it('1. a transcript that grew: every reply once', async () => {
    const t = [task('a', 's1')];
    write('s1', `${reply('m1', 100)}\n${reply('m2', 200)}\n`);
    expect(await tokens(t)).toBe(300);
    append('s1', `${reply('m3', 400)}\n${reply('m2', 200)}\n`);
    expect(await tokens(t)).toBe(700);
  });

  it('2. a grown transcript is read from where it stopped, not whole again', async () => {
    const t = [task('a', 's1')];
    const first = reply('m1', 100);
    write('s1', `${first}\n`);
    expect(await tokens(t)).toBe(100);
    // The first line's bytes, changed in place to a line with no usage: a whole read would lose its 100.
    overwriteAt('s1', 0, JSON.stringify({ type: 'note' }).padEnd(first.length, ' '));
    append('s1', `${reply('m2', 50)}\n`);
    expect(await tokens(t)).toBe(150);
  });

  it('3. a line half-written, then whole; a last line without its newline, then the next', async () => {
    const t = [task('a', 's1')];
    const whole = reply('m2', 30);
    write('s1', `${reply('m1', 100)}\n${whole.slice(0, 40)}`);
    expect(await tokens(t)).toBe(100);
    append('s1', whole.slice(40));
    expect(await tokens(t)).toBe(130);
    append('s1', `\n${reply('m3', 5)}`);
    expect(await tokens(t)).toBe(135);
  });

  it('4. a transcript that shrank keeps none of what it lost', async () => {
    const t = [task('a', 's1')];
    write('s1', `${reply('m1', 100)}\n${reply('m2', 200)}\n`);
    expect(await tokens(t)).toBe(300);
    write('s1', `${reply('m3', 7)}\n`);
    expect(await tokens(t)).toBe(7);
  });

  it('5. a transcript rewritten to the same size keeps none of its old replies', async () => {
    const t = [task('a', 's1')];
    write('s1', `${reply('m1', 100)}\n`);
    expect(await tokens(t)).toBe(100);
    write('s1', `${reply('m9', 300)}\n`);
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(fileOf('s1'), later, later);
    expect(await tokens(t)).toBe(300);
  });

  it('6. a transcript replaced by another, longer file is read whole', async () => {
    const t = [task('a', 's1')];
    write('s1', `${reply('m1', 100)}\n`);
    expect(await tokens(t)).toBe(100);
    const next = `${fileOf('s1')}.next`;
    fs.writeFileSync(next, `${reply('m7', 1)}\n${reply('m8', 2)}\n`);
    fs.renameSync(next, fileOf('s1'));
    expect(await tokens(t)).toBe(3);
  });

  it.skipIf(!hasPosixModes())('7. an unchanged transcript is not read again', async () => {
    const t = [task('a', 's1')];
    write('s1', `${reply('m1', 100)}\n`);
    expect(await tokens(t)).toBe(100);
    // Unreadable now, unchanged: only a read would notice.
    fs.chmodSync(fileOf('s1'), 0o000);
    expect(await tokens(t)).toBe(100);
  });

  it.skipIf(!hasPosixModes())('8. forty sessions asked each time are each read once', async () => {
    const t = Array.from({ length: 40 }, (_, i) => task(`t${i}`, `s${i}`));
    for (let i = 0; i < 40; i += 1) write(`s${i}`, `${reply(`m${i}`, i + 1)}\n`);
    const first = await readTaskCosts(t, { homeDir: home });
    expect(t.map((x) => first.get(x.id)?.tokens?.input)).toEqual(t.map((_, i) => i + 1));
    for (let i = 0; i < 40; i += 1) fs.chmodSync(fileOf(`s${i}`), 0o000);
    const second = await readTaskCosts(t, { homeDir: home });
    expect(t.map((x) => second.get(x.id)?.tokens?.input)).toEqual(t.map((_, i) => i + 1));
  });
});
