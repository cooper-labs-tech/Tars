import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../electron/services/model-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/services/model-catalog')>();
  return { ...actual, priceFor: vi.fn(actual.priceFor) };
});

import { computeTranscriptUsage, clearTranscriptUsageCache } from '../../../electron/services/transcript-usage';
import { priceFor, resetCatalogCache } from '../../../electron/services/model-catalog';
import { DATA_DIR } from '../../../electron/constants';

/**
 * Prices, looked up once per model in each scan.
 *
 * costOf asked the catalogue at every turn. priceFor walks every model the
 * catalogue lists when a transcript's id is dated, and with no catalogue in
 * memory (a first launch, a machine offline) catalogSync tries to read the
 * missing cache file at every call. On JeanBrasse's 1826 transcripts, about 608
 * thousand turns, the adding up took 5 to 16 s that way, and 0.24 to 0.34 s
 * with the catalogue loaded (the Frontend's template, measured 2026-09-28).
 *
 * How it can fail, written before the code:
 * 1. the price is still looked up at every turn;
 * 2. a price looked up once outlives its scan, so a new catalogue never
 *    reaches the figures;
 * 3. a memo kept past the minute because no transcript moved keeps the old
 *    prices with it.
 */

let home: string;
const CATALOG = path.join(DATA_DIR, 'model-catalog.json');

function assistant(id: string, model: string) {
  return {
    type: 'assistant',
    requestId: `req_${id}`,
    timestamp: '2026-09-20T12:00:00.000Z',
    message: { id, model, usage: { input_tokens: 1_000_000, output_tokens: 0 } },
  };
}

function writeTranscript(lines: unknown[]) {
  const dir = path.join(home, '.claude', 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), lines.map(l => JSON.stringify(l)).join('\n'));
}

/** A catalogue on disk, as models.dev's is kept, with Opus at `input` dollars a million tokens. */
function catalogue(input: number) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CATALOG, JSON.stringify({
    anthropic: { models: { 'claude-opus-5': { id: 'claude-opus-5', name: 'Claude Opus 5', cost: { input, output: 25 } } } },
  }));
  resetCatalogCache();
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-usage-pricing-'));
  clearTranscriptUsageCache();
  resetCatalogCache();
  vi.mocked(priceFor).mockClear();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(CATALOG, { force: true });
  resetCatalogCache();
  clearTranscriptUsageCache();
});

describe('prices in a scan', () => {
  it('1. are looked up once for each model, not at every turn', async () => {
    const turns = Array.from({ length: 300 }, (_, i) => assistant(`msg_${i}`, i % 2 ? 'claude-opus-5-20260901' : 'claude-sonnet-5-20260901'));
    writeTranscript(turns);

    const { modelUsage } = await computeTranscriptUsage(home);

    expect(Object.keys(modelUsage).sort()).toEqual(['claude-opus-5-20260901', 'claude-sonnet-5-20260901']);
    expect(vi.mocked(priceFor).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('2, 3. follow a new catalogue at the next minute, though no transcript moved', async () => {
    catalogue(5);
    writeTranscript([assistant('msg_1', 'claude-opus-5')]);
    expect((await computeTranscriptUsage(home)).modelUsage['claude-opus-5'].costUSD).toBeCloseTo(5, 9);

    catalogue(50);
    const real = Date.now;
    const at = real();
    Date.now = () => at + 61_000;
    try {
      expect((await computeTranscriptUsage(home)).modelUsage['claude-opus-5'].costUSD).toBeCloseTo(50, 9);
    } finally {
      Date.now = real;
    }
  });
});
