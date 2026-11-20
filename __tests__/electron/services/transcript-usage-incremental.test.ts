import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The usage scan reads what a transcript gained, not the whole of it again
 * (the crash of 2026-10-13 00:26: Tars's main process died at its heap's limit).
 *
 * claude:getData is asked every 10 s while the Agents, Projects or Usage page
 * is open, and once its 60 s memo runs out it read again, whole, every
 * transcript whose size or date had changed: every live session's. On the
 * night of the crash the fleet's live transcripts were 830 MB together.
 *
 * How it fails, written before the code:
 * 1. A transcript that grew is read whole: the cost follows its size, not what
 *    was appended.
 * 2. Read from where it was, a line half written at the last read, or a
 *    character of several bytes cut at it, is lost, doubled or garbled: the
 *    totals differ from a whole read's.
 * 3. A transcript that shrank, or was replaced by another file, keeps the old
 *    file's turns, or is read from the old offset.
 * 4. A transcript that has not changed is read again.
 * 5. A last line with no newline after it (a file a writer ended so) is never
 *    counted, or counted twice once the next line comes.
 */

const counted = vi.hoisted(() => ({ on: false, bytes: 0 }));
const { home } = vi.hoisted(() => ({
  home: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-usage-incr-${process.pid}-${Date.now()}`),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home, default: { ...actual, homedir: () => home } };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const readSync = ((...args: Parameters<typeof actual.readSync>) => {
    const n = (actual.readSync as (...a: Parameters<typeof actual.readSync>) => number)(...args);
    if (counted.on) counted.bytes += n;
    return n;
  }) as typeof actual.readSync;
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const out = (actual.readFileSync as (...a: Parameters<typeof actual.readFileSync>) => string | Buffer)(...args);
    if (counted.on && String(args[0]).endsWith('.jsonl')) counted.bytes += typeof out === 'string' ? Buffer.byteLength(out) : out.length;
    return out;
  }) as typeof actual.readFileSync;
  return { ...actual, readSync, readFileSync, default: { ...actual, readSync, readFileSync } };
});

const PROJECTS = () => path.join(home, '.claude', 'projects', 'demo');
const FILE = () => path.join(PROJECTS(), 'a1b2c3d4-0000-4000-8000-000000000001.jsonl');
let n = 0;
const turn = (model = 'claude-opus-5', note = '') => JSON.stringify({
  type: 'assistant', requestId: `req_${++n}`, timestamp: '2026-10-12T12:00:00.000Z', note,
  message: { id: `msg_${n}`, model, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } },
}) + '\n';
const filler = (k: number) => Array.from({ length: k }, (_, i) => JSON.stringify({ type: 'user', message: { content: `${i} ${'z'.repeat(2000)}` } }) + '\n').join('');

async function load() {
  vi.resetModules();
  return import('../../../electron/services/transcript-usage');
}
/** One pass of the scan, its memo expired as 60 s would, the per-file knowledge kept. */
async function pass(mod: Awaited<ReturnType<typeof load>>) {
  mod.expireTranscriptUsageMemo();
  counted.bytes = 0;
  counted.on = true;
  try {
    const usage = await mod.computeTranscriptUsage(home);
    return { usage, bytes: counted.bytes };
  } finally {
    counted.on = false;
  }
}
const inputOf = (usage: { modelUsage: Record<string, { inputTokens: number }> }, model = 'claude-opus-5') => usage.modelUsage[model]?.inputTokens ?? 0;

beforeEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS(), { recursive: true });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('the usage scan, as a live transcript grows', () => {
  it('1. reads what a transcript gained, not its size again', async () => {
    fs.writeFileSync(FILE(), filler(5_000) + turn());
    const mod = await load();
    const first = await pass(mod);
    expect(inputOf(first.usage)).toBe(100);
    const added = turn() + turn();
    fs.appendFileSync(FILE(), added);
    const next = await pass(mod);
    expect(inputOf(next.usage)).toBe(300);
    expect(next.bytes, `read ${next.bytes} bytes for ${Buffer.byteLength(added)} appended`).toBeLessThanOrEqual(Buffer.byteLength(added) + 64);
  });

  it('2. counts a line written in two halves once, and keeps a character cut at the read', async () => {
    const model = 'claude-öpus-5-🎉';
    const line = turn(model, 'déjà');
    fs.writeFileSync(FILE(), turn() + line.slice(0, 40));
    const mod = await load();
    expect(inputOf((await pass(mod)).usage)).toBe(100);
    fs.appendFileSync(FILE(), line.slice(40));
    const { usage } = await pass(mod);
    expect(inputOf(usage)).toBe(100);
    expect(inputOf(usage, model)).toBe(100);
    mod.clearTranscriptUsageCache();
    const whole = await pass(mod);
    expect(whole.usage.modelUsage).toEqual(usage.modelUsage);
  });

  it('3. reads a transcript that shrank or was replaced from its start', async () => {
    fs.writeFileSync(FILE(), turn() + turn() + turn());
    const mod = await load();
    expect(inputOf((await pass(mod)).usage)).toBe(300);
    fs.writeFileSync(FILE(), turn());
    expect(inputOf((await pass(mod)).usage)).toBe(100);
    // Another file, of another model and of longer lines: read from the old
    // offset, it would start mid-line, miss a turn, and keep the old file's.
    const other = `${FILE()}.new`;
    const sonnet = 'claude-sonnet-5';
    fs.writeFileSync(other, turn(sonnet, 'a longer line '.repeat(20)) + turn(sonnet) + turn(sonnet) + turn(sonnet));
    fs.renameSync(other, FILE());
    const { usage } = await pass(mod);
    expect(inputOf(usage, sonnet)).toBe(400);
    expect(inputOf(usage)).toBe(0);
  });

  it('5. counts a last line with no newline after it once, when it parses whole', async () => {
    fs.writeFileSync(FILE(), turn().trimEnd());
    const mod = await load();
    expect(inputOf((await pass(mod)).usage)).toBe(100);
    fs.appendFileSync(FILE(), '\n' + turn());
    expect(inputOf((await pass(mod)).usage)).toBe(200);
  });

  it('4. reads nothing of a transcript that has not changed', async () => {
    fs.writeFileSync(FILE(), filler(100) + turn());
    const mod = await load();
    await pass(mod);
    expect((await pass(mod)).bytes).toBe(0);
  });
});
