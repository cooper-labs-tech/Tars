import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { makeUnreadable } from '../../setup/file-access';

/**
 * What the slicing had to not break, and what a failed read must not look like.
 *
 * Pricing used to read each transcript whole and hold the main thread for 2775
 * ms over the 884 MB here. It reads four megabytes at a time now, and two of
 * the things that change with that are worth a test of their own.
 *
 * A UTF-8 character can straddle a chunk boundary. Cutting one in half
 * corrupts the line it sits in, and a corrupted line is a line that fails to
 * parse, which is to say tokens that quietly stop being billed. The decoder is
 * what prevents it, and the case below puts a four byte character exactly
 * across the boundary rather than trusting it.
 *
 * And a transcript that will not open used to come back as an empty list,
 * which is indistinguishable from one holding no usage. That turns a failure
 * into a smaller bill: the one kind of error that looks like good news, so
 * nobody reports it.
 */

const { home } = vi.hoisted(() => ({
  home: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-usage-chunk-${process.pid}-${Date.now()}`),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home, default: { ...actual, homedir: () => home } };
});

const PROJECTS = () => path.join(home, '.claude', 'projects', 'demo');

/** The chunk the reader uses, and a character that does not fit in one byte. */
const CHUNK = 4 * 1024 * 1024;
const FOUR_BYTE = '\u{1F600}';

function assistant(id: string, requestId: string, note = '', model = 'claude-opus-5'): Record<string, unknown> {
  return {
    type: 'assistant',
    requestId,
    timestamp: '2026-08-20T12:00:00.000Z',
    note,
    message: {
      id,
      model,
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 4000,
        cache_creation: { ephemeral_1h_input_tokens: 4000, ephemeral_5m_input_tokens: 0 },
      },
    },
  };
}

/**
 * The model id the straddling character sits in, so the damage is visible.
 *
 * The first version of this put the character in a text field and asserted on
 * the token totals, and it did not bite: decoding each chunk on its own turns
 * the halved character into replacement characters INSIDE a JSON string, which
 * is still valid JSON. The line parsed, the tokens were counted, and a broken
 * decoder passed. Put in the model id it becomes a key of the result, so a
 * character that did not survive the boundary is a key that does not match.
 */
const STRADDLING_MODEL = `claude-opus-5-${FOUR_BYTE}-preview`;

/**
 * One usage line whose four byte character starts two bytes before the chunk
 * boundary, so two of its bytes land in the first read and two in the second.
 *
 * Everything before it is ASCII, so a character index is a byte offset and the
 * padding can be solved for directly rather than guessed.
 */
function lineStraddlingTheBoundary(): string {
  const want = CHUNK - 2;
  let pad = want;
  for (let attempt = 0; attempt < 6; attempt++) {
    const line = JSON.stringify(assistant('msg_1', 'req_1', 'x'.repeat(pad), STRADDLING_MODEL));
    const at = line.indexOf(FOUR_BYTE);
    if (at === want) return line;
    pad += want - at;
    if (pad < 0) break;
  }
  throw new Error('could not place the character across the boundary');
}

function writeLines(name: string, lines: string[]): string {
  fs.mkdirSync(PROJECTS(), { recursive: true });
  const file = path.join(PROJECTS(), name);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

async function load() {
  vi.resetModules();
  return import('../../../electron/services/transcript-usage');
}

beforeEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a character that lands across a read boundary', () => {
  it('is still one character, so the line it sits in still parses', async () => {
    const straddling = lineStraddlingTheBoundary();
    // Proven to be the case it claims before it is used as one: two bytes on
    // each side of the boundary. A padding that drifted would make this test
    // pass while testing nothing.
    const before = Buffer.byteLength(straddling.slice(0, straddling.indexOf(FOUR_BYTE)), 'utf8');
    expect(before).toBe(CHUNK - 2);

    writeLines('boundary.jsonl', [straddling, JSON.stringify(assistant('msg_2', 'req_2'))]);

    const { computeTranscriptUsage } = await load();
    const { modelUsage } = await computeTranscriptUsage(home);

    // The model id came back whole, character and all. Decoded chunk by chunk
    // the halves become replacement characters and this key is a different
    // string: the turn is still counted, under a model nobody can price.
    expect(Object.keys(modelUsage)).toContain(STRADDLING_MODEL);
    expect(modelUsage[STRADDLING_MODEL].inputTokens).toBe(1000);
    expect(modelUsage['claude-opus-5'].inputTokens).toBe(1000);
  }, 60_000);

  it('does not lose the line that begins immediately after the boundary', async () => {
    // The other half of the same risk: the decoder holds the incomplete bytes
    // back, so what follows them has to come out in the right order.
    const straddling = lineStraddlingTheBoundary();
    writeLines('boundary.jsonl', [
      straddling,
      JSON.stringify(assistant('msg_2', 'req_2')),
      JSON.stringify(assistant('msg_3', 'req_3')),
    ]);

    const { computeTranscriptUsage } = await load();
    const { modelUsage } = await computeTranscriptUsage(home);

    expect(modelUsage['claude-opus-5'].inputTokens).toBe(2000);
    expect(modelUsage[STRADDLING_MODEL].inputTokens).toBe(1000);
  }, 60_000);
});

describe('a transcript that will not open', () => {
  /**
   * A file the process cannot read, which is what a failed read really is,
   * and what makes it readable again (mode 0600, where there are modes).
   */
  function unreadableFile(name: string): () => void {
    const file = writeLines(name, [JSON.stringify(assistant('msg_x', 'req_x'))]);
    return makeUnreadable(file, 0o600);
  }

  it('is counted rather than passed off as a transcript holding nothing', async () => {
    writeLines('good.jsonl', [JSON.stringify(assistant('msg_1', 'req_1'))]);
    const readable = unreadableFile('blocked.jsonl');

    const { computeTranscriptUsage } = await load();
    const usage = await computeTranscriptUsage(home);

    // The readable one is still priced, and the failure is on the record
    // beside it rather than folded into the total as an absence.
    expect(usage.modelUsage['claude-opus-5'].inputTokens).toBe(1000);
    expect(usage.unreadable).toBe(1);

    readable();
  });

  it('is not remembered as empty, so the next pass can still read it', async () => {
    writeLines('good.jsonl', [JSON.stringify(assistant('msg_1', 'req_1'))]);
    const readable = unreadableFile('blocked.jsonl');

    const { computeTranscriptUsage } = await load();
    await computeTranscriptUsage(home);

    // The clock is moved rather than the caches cleared, and that is the whole
    // point of this case: clearTranscriptUsageCache empties the per-file cache
    // too, so calling it here would erase the very thing under test. Written
    // that way first, and a version that cached failures passed it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 120_000);
    try {
      // Readable again, with nothing about the file itself changed: same
      // mtime, same size, so a remembered failure would still be served.
      readable();
      const second = await computeTranscriptUsage(home);

      expect(second.unreadable).toBe(0);
      expect(second.modelUsage['claude-opus-5'].inputTokens).toBe(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reaches the figure the page and both bots read', async () => {
    writeLines('good.jsonl', [JSON.stringify(assistant('msg_1', 'req_1'))]);
    const readable = unreadableFile('blocked.jsonl');

    vi.resetModules();
    const { getClaudeStats } = await import('../../../electron/services/claude-service');
    const stats = await getClaudeStats() as Record<string, unknown> | null;

    // One call site feeds all three: the Usage page and /stats on either bot
    // read whatever this returns. A number built from fewer transcripts than
    // exist can only say so if the count travels this far.
    expect(stats?.unreadable).toBe(1);

    readable();
  });
});
