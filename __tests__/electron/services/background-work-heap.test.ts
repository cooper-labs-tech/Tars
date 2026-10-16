import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as v8 from 'v8';
import * as vm from 'vm';
import { pendingBackgroundWork } from '../../../electron/services/agent-truth';

/**
 * What the background-work reader keeps of a transcript in the main process (the V8 crashes of the main process on
 * 2026-10-13 and 2026-10-16: both died in a node fs read creating a string, the heap at its limit).
 *
 * At every rest of an agent whose transcript changed, pendingBackgroundWork read the whole transcript as one string,
 * split it into lines and kept the few that can name background work, for the 32 most recent transcripts. V8 makes a
 * line split out of a large flat string a sliced string pointing into it: 99 kept lines of 72 characters out of a
 * 102 MB file retained the 102 MB (measured with the repo's Electron as Node). The live transcripts run to 194 MB.
 *
 * How it fails, written before the code:
 * 1. The kept lines pin their transcripts: after rests of three agents on 30 MB transcripts, the heap retained after a
 *    collection is the transcripts' size, not the few lines'.
 * 2. Each rest reads the whole transcript again, though only lines were appended since: a transcript of 194 MB is read
 *    and turned into a string at every rest.
 * 3. Over-correction: a transcript replaced (a new file under the same name) or cut shorter is not read again from its
 *    start, and the answer goes on from what the old file said.
 * 4. Over-correction: a line still being written (no newline yet) is taken, then lost once it is whole.
 * 5. Over-correction: a line longer than what is read at once, or cut across two reads, is lost or taken in halves.
 * 6. Over-correction: text that is not ASCII in a kept line comes out mangled (a multi-byte character cut).
 */

const v8gc = (() => {
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
})();
const heapAfterGc = () => {
  v8gc();
  v8gc();
  return process.memoryUsage().heapUsed;
};

let home: string;
const T0 = Date.UTC(2026, 9, 17, 2, 0, 0);
const at = (ms: number) => new Date(ms).toISOString();
const started = (id: string, ms = T0 + 1000, note = '') => JSON.stringify({ type: 'user', timestamp: at(ms), message: { content: [{ type: 'tool_result', tool_use_id: 'u', text: note }] }, toolUseResult: { backgroundTaskId: id } });
const done = (id: string, ms = T0 + 2000) => JSON.stringify({ type: 'user', timestamp: at(ms), message: { content: `<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>` } });
const filler = (n = 3000) => JSON.stringify({ type: 'assistant', timestamp: at(T0 + 500), message: { content: [{ type: 'text', text: 'x'.repeat(n) }] } });

function agentWith(sessionId: string, project: string) {
  const dir = path.join(home, '.claude', 'projects', project.replace(/[/.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  return { agent: { currentSessionId: sessionId, projectPath: project }, file: path.join(dir, `${sessionId}.jsonl`) };
}

/** A transcript of about `mb` megabytes: filler, with a background task started every so often. */
function bigTranscript(file: string, mb: number, ids: string[]) {
  const fd = fs.openSync(file, 'w');
  const line = `${filler()}\n`;
  const per = Math.floor((mb * 1e6) / line.length / (ids.length + 1));
  for (const id of ids) {
    fs.writeSync(fd, line.repeat(per));
    fs.writeSync(fd, `${started(id)}\n`);
  }
  fs.writeSync(fd, line.repeat(per));
  fs.closeSync(fd);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-bg-heap-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('what the background-work reader keeps', () => {
  it('1. a few kept lines, not the transcripts they were read from', () => {
    const before = heapAfterGc();
    const agents = ['a', 'b', 'c'].map((n, i) => {
      const { agent, file } = agentWith(`0941a7e6-7262-4068-ba83-68b7e0de177${i}`, `/work/${n}`);
      bigTranscript(file, 30, [`${n}1`, `${n}2`, `${n}3`]);
      return agent;
    });
    for (const agent of agents) expect(pendingBackgroundWork(agent, T0, home).length).toBe(3);
    const retained = heapAfterGc() - before;
    expect(retained, `${(retained / 1e6).toFixed(1)} MB retained for 90 MB of transcripts`).toBeLessThan(10e6);
  });

  it('2. a later rest reads what was appended since, not the transcript again', () => {
    const { agent, file } = agentWith('0941a7e6-7262-4068-ba83-68b7e0de1773', '/work/append');
    const head = `${filler(200)}\n`;
    fs.writeFileSync(file, `${head}${started('t1')}\n`);
    expect(pendingBackgroundWork(agent, T0, home)).toEqual(['t1']);
    // In place, the same length: an earlier line that a whole re-read would now count. Transcripts only grow, so a
    // reader that reads only what was appended never sees it, which is the witness.
    const fd = fs.openSync(file, 'r+');
    const inPlace = started('zz', T0 + 1000, 'y'.repeat(Math.max(0, head.length - 1 - started('zz', T0 + 1000).length)));
    expect(inPlace.length).toBe(head.length - 1);
    fs.writeSync(fd, inPlace, 0);
    fs.closeSync(fd);
    fs.appendFileSync(file, `${done('t1')}\n${started('t2')}\n`);
    expect(pendingBackgroundWork(agent, T0, home)).toEqual(['t2']);
  });

  it('3. a transcript replaced or cut shorter is read again from its start', () => {
    const { agent, file } = agentWith('0941a7e6-7262-4068-ba83-68b7e0de1774', '/work/replaced');
    fs.writeFileSync(file, `${filler(200)}\n${started('old')}\n${filler(200)}\n`);
    expect(pendingBackgroundWork(agent, T0, home)).toEqual(['old']);
    // Replaced: a new file renamed over the old one.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${filler(500)}\n${filler(500)}\n${started('new')}\n`);
    fs.renameSync(tmp, file);
    expect(pendingBackgroundWork(agent, T0, home)).toEqual(['new']);
    // Cut shorter, in place.
    fs.writeFileSync(file, `${started('short')}\n`);
    expect(pendingBackgroundWork(agent, T0, home)).toEqual(['short']);
  });

  it('4. a line still being written counts once it is whole', () => {
    const { agent, file } = agentWith('0941a7e6-7262-4068-ba83-68b7e0de1775', '/work/partial');
    const line = started('p1');
    fs.writeFileSync(file, `${filler(100)}\n${line.slice(0, 40)}`);
    expect(pendingBackgroundWork(agent, T0, home)).toEqual([]);
    fs.appendFileSync(file, `${line.slice(40)}\n`);
    expect(pendingBackgroundWork(agent, T0, home)).toEqual(['p1']);
  });

  it('5. a line longer than one read is found whole', () => {
    const { agent, file } = agentWith('0941a7e6-7262-4068-ba83-68b7e0de1776', '/work/long');
    fs.writeFileSync(file, `${filler(100)}\n${started('long', T0 + 1000, 'z'.repeat(9e6))}\n${filler(100)}\n`);
    expect(pendingBackgroundWork(agent, T0, home)).toEqual(['long']);
  });

  it('6. text that is not ASCII comes out whole', () => {
    const { agent, file } = agentWith('0941a7e6-7262-4068-ba83-68b7e0de1777', '/work/accents');
    const id = 'tâche-é-🚀-终';
    fs.writeFileSync(file, `${filler(100)}\n${started(id, T0 + 1000, 'déjà vu, 你好 '.repeat(1000))}\n`);
    expect(pendingBackgroundWork(agent, T0, home)).toEqual([id]);
  });
});
