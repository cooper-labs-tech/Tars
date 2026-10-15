import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeTranscriptUsage, clearTranscriptUsageCache } from '../../../electron/services/transcript-usage';
import { usageByProvider, ledgerPath } from '../../../electron/services/usage-ledger';

/**
 * Usage fine enough for a rolling "last 24 hours", and filed under the session that spent it.
 *
 * The Usage page cannot show the last 24 hours (JeanBrasse, 01/10): the transcripts are added up by local day, and so are
 * the ledger's rows, so at 09:00 "the last 24 hours" can only be read as today since midnight, or as today and the
 * whole of yesterday. And the Audit (AUDIT-USAGE-COMPTES.md, 01/10) measured how usage is lost or misfiled: the
 * transcripts under a user's own CLAUDE_CONFIG_DIR are never read; a model served through OpenRouter or Ollama is
 * filed under Claude at $0, because the provider is guessed from the model's name while the status line has written
 * each session's provider all along; and no figure says which account spent it.
 *
 * How this can fail, written before the code:
 * 1. the transcripts give no figure finer than a day, so the last 24 hours cannot be cut;
 * 2. a turn lands in another hour than the one it was made in, a turn older than 48 hours is listed by the hour, or
 *    a recent one is left out;
 * 3. the hours do not add up to what their turns cost: a reply written on two lines counted twice, or one of its
 *    lines counted as another reply;
 * 4. the ledger's turns (ACP, every CLI but Claude) give no figure finer than a day either;
 * 5. the transcripts under $CLAUDE_CONFIG_DIR/projects are never read;
 * 6. a model's provider is still guessed from its name when a session says which provider ran it, or is invented
 *    for a model no session speaks for;
 * 7. no figure says which account spent it;
 * 8. a provider or an account the status line writes after a first pass is never picked up.
 * And what must not change: the days, their costs, and one reply counted once across transcripts.
 */

const HOUR = 3_600_000;
let home: string;
let savedConfigDir: string | undefined;
const now = Date.now();
const hourOf = (ms: number) => Math.floor(ms / HOUR) * HOUR;
const ago = (ms: number) => new Date(now - ms).toISOString();

const projects = (base: string) => path.join(base, '.claude', 'projects');

function transcript(root: string, session: string, lines: unknown[]) {
  const dir = path.join(root, 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

/** One reply, made `msAgo` ago: 1000 tokens in, 100 out, nothing cached, so every turn costs the same. */
function turn(id: string, msAgo: number, model = 'claude-opus-5', output = 100) {
  return {
    type: 'assistant',
    requestId: `req-${id}`,
    timestamp: ago(msAgo),
    message: { id: `msg-${id}`, model, usage: { input_tokens: 1000, output_tokens: output } },
  };
}

/** What the status line writes, per session. */
function tokenStats(sessions: Record<string, { provider: string; account?: string }>) {
  fs.mkdirSync(path.join(home, '.dorothy'), { recursive: true });
  const entries = Object.fromEntries(Object.entries(sessions).map(([sid, s]) => [sid, {
    in: 1000, out: 100, cost: 0.01, model: 'x', extra: false, date: ago(0).slice(0, 10), ...s,
  }]));
  fs.writeFileSync(path.join(home, '.dorothy', 'token-stats.json'), JSON.stringify(entries));
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-usage-24h-')));
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  clearTranscriptUsageCache();
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ledgerPath(), { force: true });
  clearTranscriptUsageCache();
});

type Hour = { hour: number; costUSD: number; costByModel: Record<string, number>; messagesByModel: Record<string, number>; costByAccount?: Record<string, number> };
const hoursOf = (usage: unknown) => ((usage as { hourlyModelTokens?: Hour[] }).hourlyModelTokens ?? []);

describe('the transcripts, by the hour', () => {
  it('1, 2. the turns of the last 48 hours are listed by the hour they were made in, and older ones are not', async () => {
    transcript(projects(home), 'session-a', [turn('a', 30 * 60_000), turn('b', 5 * HOUR), turn('c', 30 * HOUR), turn('d', 72 * HOUR)]);

    const hours = hoursOf(await computeTranscriptUsage(home));

    expect(hours.map((h) => h.hour)).toEqual([30 * HOUR, 5 * HOUR, 30 * 60_000].map((msAgo) => hourOf(now - msAgo)));
  });

  it('3. the hours add up to what their turns cost, a reply on two lines once, and the last 24 hours to the turns made in them', async () => {
    // A reply is written as several lines sharing its id; the last carries the whole count.
    transcript(projects(home), 'session-a', [turn('a', 30 * 60_000, 'claude-opus-5', 40), turn('a', 30 * 60_000), turn('b', 5 * HOUR), turn('c', 30 * HOUR), turn('d', 72 * HOUR)]);
    // A resumed session replays an earlier reply into its own transcript.
    transcript(projects(home), 'session-b', [turn('b', 5 * HOUR)]);

    const usage = await computeTranscriptUsage(home);
    const perTurn = usage.modelUsage['claude-opus-5'].costUSD / 4;
    const hours = hoursOf(usage);
    const lastDay = hours.filter((h) => h.hour >= now - 24 * HOUR);

    expect(hours.reduce((n, h) => n + h.costUSD, 0)).toBeCloseTo(3 * perTurn, 9);
    expect(lastDay.reduce((n, h) => n + h.costUSD, 0)).toBeCloseTo(2 * perTurn, 9);
    expect(hours.find((h) => h.hour === hourOf(now - 30 * 60_000))?.messagesByModel).toEqual({ 'claude-opus-5': 1 });
  });

  it('what must not change: the days add up to every dated turn, and a reply in two transcripts counts once', async () => {
    transcript(projects(home), 'session-a', [turn('a', HOUR), turn('b', 30 * HOUR)]);
    // A resumed session replays the earlier reply into its own transcript.
    transcript(projects(home), 'session-b', [turn('a', HOUR), turn('e', 2 * HOUR)]);

    const usage = await computeTranscriptUsage(home);
    const total = usage.modelUsage['claude-opus-5'];

    expect(total.inputTokens).toBe(3000);
    expect(usage.dailyModelTokens.reduce((n, d) => n + d.costUSD, 0)).toBeCloseTo(total.costUSD, 9);
  });
});

describe('the ledger, by the hour', () => {
  it('4. lists its turns of the last 48 hours by the hour they were made in', () => {
    const line = (msAgo: number) => JSON.stringify({ ts: ago(msAgo), agentId: 'a1', provider: 'codex', model: 'gpt-5', inputTokens: 1000, outputTokens: 100, costUSD: 0.5, transport: 'acp' });
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.writeFileSync(ledgerPath(), [line(72 * HOUR), line(30 * HOUR), line(2 * HOUR), line(2 * HOUR)].join('\n') + '\n');

    const { hourly } = usageByProvider() as { hourly?: Array<{ hour: number; provider: string; model: string | null; costUSD: number; turns: number }> };

    expect(hourly).toEqual([
      expect.objectContaining({ hour: hourOf(now - 30 * HOUR), provider: 'codex', model: 'gpt-5', costUSD: 0.5, turns: 1 }),
      expect.objectContaining({ hour: hourOf(now - 2 * HOUR), provider: 'codex', model: 'gpt-5', costUSD: 1, turns: 2 }),
    ]);
  });
});

describe('where the transcripts are, and whose session they are', () => {
  it('5. reads $CLAUDE_CONFIG_DIR/projects as well as ~/.claude/projects', async () => {
    const own = path.join(home, 'own-config');
    transcript(path.join(own, 'projects'), 'session-own', [turn('own', HOUR)]);
    transcript(projects(home), 'session-home', [turn('home', HOUR)]);
    process.env.CLAUDE_CONFIG_DIR = own;

    expect((await computeTranscriptUsage(home)).modelUsage['claude-opus-5'].inputTokens).toBe(2000);
  });

  it('6. a model\'s provider is the one its sessions ran under, and none is invented for a model no session speaks for', async () => {
    transcript(projects(home), 'sess-openrouter', [turn('or', HOUR, 'anthropic/claude-sonnet-5')]);
    transcript(projects(home), 'sess-ollama', [turn('ol', HOUR, 'llama3.3:70b')]);
    transcript(projects(home), 'sess-unknown', [turn('un', HOUR, 'mystery-model')]);
    tokenStats({ 'sess-openrouter': { provider: 'openrouter' }, 'sess-ollama': { provider: 'ollama' } });

    const { providerByModel } = (await computeTranscriptUsage(home)) as { providerByModel?: Record<string, string> };

    expect(providerByModel).toEqual({ 'anthropic/claude-sonnet-5': 'openrouter', 'llama3.3:70b': 'ollama' });
  });

  it('7. every day and every hour say which account spent what', async () => {
    transcript(projects(home), 'sess-one', [turn('1a', HOUR)]);
    transcript(projects(home), 'sess-two', [turn('2a', HOUR), turn('2b', 2 * HOUR)]);
    transcript(projects(home), 'sess-none', [turn('na', HOUR)]);
    tokenStats({ 'sess-one': { provider: 'claude', account: '1' }, 'sess-two': { provider: 'claude', account: '2' } });

    const usage = await computeTranscriptUsage(home);
    const perTurn = usage.modelUsage['claude-opus-5'].costUSD / 4;
    const sum = (rows: Array<{ costByAccount?: Record<string, number> }>) => {
      const out: Record<string, number> = {};
      for (const row of rows) for (const [account, cost] of Object.entries(row.costByAccount ?? {})) out[account] = (out[account] ?? 0) + cost;
      return out;
    };

    for (const byAccount of [sum(usage.dailyModelTokens as never), sum(hoursOf(usage))]) {
      expect(Object.keys(byAccount).sort()).toEqual(['', '1', '2']);
      expect(byAccount['1']).toBeCloseTo(perTurn, 9);
      expect(byAccount['2']).toBeCloseTo(2 * perTurn, 9);
      expect(byAccount['']).toBeCloseTo(perTurn, 9);
    }
  });

  it('8. a provider the status line writes after a first pass is picked up by the next one', async () => {
    transcript(projects(home), 'sess-late', [turn('late', HOUR, 'llama3.3:70b')]);
    // The file is there already, as it is on a machine that has run Claude: it changes, it does not appear.
    tokenStats({ 'sess-other': { provider: 'claude' } });
    const first = (await computeTranscriptUsage(home)) as { providerByModel?: Record<string, string> };
    tokenStats({ 'sess-other': { provider: 'claude' }, 'sess-late': { provider: 'ollama', account: '2' } });

    // The 60 s memo expired, the transcripts as they were.
    const real = Date.now;
    const later = real() + 61_000;
    Date.now = () => later;
    let second: { providerByModel?: Record<string, string> };
    try {
      second = (await computeTranscriptUsage(home)) as { providerByModel?: Record<string, string> };
    } finally {
      Date.now = real;
    }

    expect(first.providerByModel?.['llama3.3:70b']).toBeUndefined();
    expect(second.providerByModel?.['llama3.3:70b']).toBe('ollama');
  });
});
