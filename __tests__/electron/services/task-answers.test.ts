import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readTurnAnswer, windowStart } from '../../../electron/services/terminal-answer';
import { answerOfTask, answerPending, noteOutputPosted, postedOutputSince, forgetAnswers } from '../../../electron/services/task-answers';
import { transcriptPath } from '../../../electron/utils/resume-session';
import { qwenTranscriptPath } from '../../../electron/services/qwen-code';

/**
 * Every task's answer, read once its turn has ended, whatever CLI ran it (2.0.7; an orchestrator's reports of 19/11:
 * task_status gave a worker's task two lines of narration as its result). Measured on the owner's ledger: 27 of 496 delegated claude tasks of three weeks kept a shorter answer
 * than their transcript holds now, read 31 to 634 ms after the turn's end; in the reported task the report is stamped .590, its Stop
 * reached Tars at .647, its transcript was read at .788, and the report was not on disk yet. Claude Code's Stop hook
 * and the state mod post the turn's last message (`last_assistant_message`) before the idle that ends the task: the
 * read waits until the transcript holds it (services/terminal-answer.ts readTurnAnswer), and services/task-answers.ts
 * reads each ended task once, for its end and for the delegation that follows it.
 *
 * How it can fail, written before the code:
 * A1. The final message is not on disk yet when the turn's end is heard: the narration before it is kept as the
 *     answer (the reported task).
 * A2. The CLI's last message is known but compared byte for byte: spacing, or the hook's cut copy (4000 bytes), keep
 *     them from ever matching, and every read waits out the whole delay.
 * A3. Without the hook's copy, a transcript whose last record says the turn goes on (stop_reason tool_use) is read at
 *     once.
 * A4. A transcript that never shows the end (a CLI that writes no stop reason, a message that never comes) holds the
 *     read for ever: it must give up after `settleMs` and take what is there.
 * A5. A turn already whole on disk waits anyway.
 * A6. A task that ended stopped or in error waits for an end that will never be written.
 * A7. codex, pi and gemini (no transcript Tars reads): the output posted before this task began (an earlier turn's)
 *     is taken as its answer; or the one posted during it is not; or another agent's is.
 * A8. Read twice (the end's own read, and the delegation that follows the task): the two get different answers, or
 *     the transcript, megabytes, is read again.
 * A9. Qwen Code's transcript (Gemini's `parts`, no stop reason) waits for a stop reason it never writes.
 * A10. A read in flight is not said: a caller that asks for the task meanwhile reads it ended with no answer.
 * A11. (measured once the reads ran at every turn's end) A turn's read streams the session's whole history: the reported
 *      session's 36 MB transcript took 3 s per read at a load of 114, once per turn of every agent now, and again at
 *      each re-read while the end settles. The read starts at a line no later than the task's first record, found from
 *      the file's end (`windowStart`); and still finds that record when the lines near the end carry no timestamp,
 *      when the window begins at the file's first line, or when a line is longer than a probe.
 */

const T0 = Date.parse('2026-11-18T19:37:10.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const ROOT = '/Users/someone/shop';
const NARRATION_1 = 'Je lis le schéma des commandes, puis j\'écris la migration et ses deux index.';
const NARRATION_2 = 'Maintenant la migration.';
const REPORT = `La migration est écrite et réversible, et les deux requêtes ont leur index. ${'Détail. '.repeat(80)}`;

const assistant = (ms: number, id: string, text: string, stop: string | null) => JSON.stringify({
  type: 'assistant', timestamp: at(ms), isSidechain: false, message: { id, role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] },
});
const toolCall = (ms: number, id: string) => JSON.stringify({
  type: 'assistant', timestamp: at(ms), message: { id, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Edit', input: {} }] },
});

let home: string;
let file: string;
let sid: string;
const task = (over: Record<string, unknown> = {}) => ({
  id: `task-${sid}`, agentId: 'arch', sessionIds: [sid], projectPath: ROOT, worktreePath: null,
  startedAt: T0, endedAt: T0 + 234_581, outcome: 'completed' as const, provider: null as string | null, ...over,
});
const write = (lines: string[]) => fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(''));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'task-answers-'));
  sid = `s${Math.random().toString(16).slice(2, 10)}`;
  file = transcriptPath(ROOT, sid, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  forgetAnswers();
});

/** The reported turn as its transcript held it at .788: two lines of narration between tool calls, no report yet. */
const narrationOnly = () => write([
  assistant(103_973, 'm1', NARRATION_1, 'tool_use'), toolCall(104_653, 'm1'),
  assistant(106_855, 'm2', NARRATION_2, 'tool_use'), toolCall(112_122, 'm2'),
]);
const report = () => write([assistant(234_524, 'm3', REPORT, 'end_turn'), JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: at(234_709) })]);

describe('a claude turn whose last message reaches the transcript after its end', () => {
  it('A1: the read waits for the message the CLI said it ended on, and gives the report', async () => {
    narrationOnly();
    setTimeout(report, 300);
    const answer = await readTurnAnswer(task(), { lastSaid: REPORT.slice(0, 4000), settleMs: 3_000, stepMs: 50, homeDir: home });
    expect(answer).toBe(REPORT);
  });

  it('A2: spacing and a cut copy of the last message still match, at once', async () => {
    narrationOnly();
    report();
    const started = Date.now();
    const said = `  ${REPORT.slice(0, 120).replace(/ /g, '  ')}\n`;
    expect(await readTurnAnswer(task(), { lastSaid: said, settleMs: 3_000, stepMs: 50, homeDir: home })).toBe(REPORT);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('A3: without the hook\'s copy, a last record that says the turn goes on is not the end', async () => {
    narrationOnly();
    setTimeout(report, 300);
    expect(await readTurnAnswer(task(), { settleMs: 3_000, stepMs: 50, homeDir: home })).toBe(REPORT);
  });

  it('A4: an end that never comes is waited for settleMs at most, and what is there is taken', async () => {
    narrationOnly();
    const started = Date.now();
    const answer = await readTurnAnswer(task(), { lastSaid: REPORT, settleMs: 600, stepMs: 50, homeDir: home });
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(answer).toBe(`${NARRATION_1}\n\n${NARRATION_2}`);
  });

  it('A5: a turn already whole on disk is read at once', async () => {
    narrationOnly();
    report();
    const started = Date.now();
    expect(await readTurnAnswer(task(), { settleMs: 3_000, stepMs: 50, homeDir: home })).toBe(REPORT);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('A4: a transcript that writes no stop reason at all is read at once, as before', async () => {
    write([JSON.stringify({ type: 'assistant', timestamp: at(1_000), message: { id: 'x', role: 'assistant', content: [{ type: 'text', text: 'done' }] } })]);
    const started = Date.now();
    expect(await readTurnAnswer(task(), { settleMs: 3_000, stepMs: 50, homeDir: home })).toBe('done');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('A6: a task that ended stopped or in error does not wait', async () => {
    narrationOnly();
    for (const outcome of ['stopped', 'error'] as const) {
      const started = Date.now();
      expect(await readTurnAnswer(task({ outcome }), { lastSaid: REPORT, settleMs: 3_000, stepMs: 50, homeDir: home })).toBe(`${NARRATION_1}\n\n${NARRATION_2}`);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  });

  it('A9: Qwen Code\'s transcript, which writes no stop reason, is read at once', async () => {
    const qwen = qwenTranscriptPath(ROOT, sid, home);
    fs.mkdirSync(path.dirname(qwen), { recursive: true });
    fs.writeFileSync(qwen, `${JSON.stringify({ type: 'assistant', timestamp: at(2_000), message: { role: 'model', parts: [{ text: 'qwen answer' }] } })}\n`);
    const started = Date.now();
    expect(await readTurnAnswer(task({ provider: 'qwen-code' }), { settleMs: 3_000, stepMs: 50, homeDir: home })).toBe('qwen answer');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('each ended task\'s answer, whatever its CLI', () => {
  it('A7: a CLI with no transcript Tars reads gets the output posted during its task, its own agent\'s', async () => {
    noteOutputPosted('codex-1', 'an earlier turn', T0 - 5_000);
    noteOutputPosted('pi-1', 'pi answer', T0 + 10_000);
    expect(postedOutputSince('codex-1', T0)).toBeUndefined();
    expect(await answerOfTask(task({ agentId: 'codex-1', id: 'c1', provider: 'codex' }), { transcript: false })).toBeNull();
    noteOutputPosted('codex-1', 'codex answer', T0 + 20_000);
    expect(await answerOfTask(task({ agentId: 'codex-1', id: 'c2', provider: 'codex' }), { transcript: false })).toBe('codex answer');
    expect(await answerOfTask(task({ agentId: 'pi-1', id: 'p1', provider: 'pi' }), { transcript: false })).toBe('pi answer');
    expect(await answerOfTask(task({ agentId: 'other', id: 'o1', provider: 'pi' }), { transcript: false })).toBeNull();
  });

  it('A8, A10: one read per task, said in flight, the same answer to both callers', async () => {
    narrationOnly();
    noteOutputPosted('arch', REPORT.slice(0, 4000), T0 + 234_500);
    const t = task();
    const first = answerOfTask(t, { transcript: true, homeDir: home, settleMs: 3_000, stepMs: 50 });
    expect(answerPending(t.id)).toBe(true);
    setTimeout(report, 300);
    const second = answerOfTask(t, { transcript: true, homeDir: home, settleMs: 3_000, stepMs: 50 });
    expect(await first).toBe(REPORT);
    expect(await second).toBe(REPORT);
    expect(answerPending(t.id)).toBe(false);
    // Read once: what the transcript says later is not read again for it.
    write([assistant(234_600, 'm4', `${REPORT} and a later word`, 'end_turn')]);
    expect(await answerOfTask(t, { transcript: true, homeDir: home })).toBe(REPORT);
  });
});

describe('a long session\'s transcript', () => {
  it('A11: the read starts near the task\'s first record, found from the end, and the answer is whole', async () => {
    // An old history of 4 MB (an hour before the task), then the task's turn.
    const old = Array.from({ length: 2_000 }, (_, i) => assistant(-3_600_000 + i, `old-${i}`, `old message ${i} ${'x'.repeat(2_000)}`, 'end_turn'));
    write(old);
    const before = fs.statSync(file).size;
    narrationOnly();
    report();
    const start = await windowStart(file, T0);
    expect(start).toBeGreaterThan(before * 0.9);
    expect(start).toBeLessThanOrEqual(before);
    expect(await readTurnAnswer(task(), { settleMs: 0, homeDir: home })).toBe(REPORT);
  });

  it('A11: lines with no timestamp near the end, a window from the first line, a line longer than a probe', async () => {
    write([assistant(1_000, 'first', `the first ${'y'.repeat(300_000)}`, 'end_turn')]);
    for (let i = 0; i < 50; i++) write([JSON.stringify({ type: 'api-request-blob', hash: `h${i}`, message: 'z'.repeat(10_000) })]);
    expect(await windowStart(file, T0)).toBe(0);
    expect(await readTurnAnswer(task(), { settleMs: 0, homeDir: home })).toBe(`the first ${'y'.repeat(300_000)}`);
  });
});
