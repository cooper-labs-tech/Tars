import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Reports to the user's Telegram as things happen (the design's part A2; JeanBrasse: "en fonction de ce qui se passe"),
 * through the relay (DESIGN-RELAIS-HERMES-V2.md).
 *
 * An event (an agent gone to error, a PR merged, changes requested on a PR) waits up to 2 minutes for others of its
 * project, and they leave together in one message for that project, so that a reply to it reaches that project's
 * orchestrator. At most 40 messages a day; past that, events are counted and the next day's first message opens with
 * one line saying how many were held. No quiet hours. Nothing is sent, and nothing kept for later, while the relay is
 * off.
 *
 * How it fails, written before the code (2026-09-28, and the relay, 2026-10-01):
 * 1. With the relay off, an event is sent, or kept and sent once it is on: a flood of stale news.
 * 2. Every event is its own message, or one waits past its 2 minutes.
 * 3. The same event is sent twice: an agent still in error, a PR seen merged at every poll.
 * 4. More than 40 messages a day; or the events past the limit vanish without a word.
 * 5. An agent's name, a PR title or an error text can pass for another line of the report, or goes out with a secret
 *    in it.
 * 6. A restart forgets the day's count, and the limit is only per run.
 * 7. (the Audit's gate of #234) The error text is cut before its secrets are masked: a key that starts near the cut
 *    leaves its first characters in clear.
 * 8. Events of two projects leave in one message, or under another project: the user's reply to it would reach the
 *    wrong orchestrator.
 */

type Reports = typeof import('../../../electron/services/event-reports');
let r: Reports;
const sent: Array<{ text: string; projectPath: string }> = [];
let on = true;
const channel = { async send(text: string, projectPath: string) { sent.push({ text, projectPath }); return true; } };

const TARS = '/Users/someone/projects/tars';
const CAPITAL = '/Users/someone/projects/1212-Capital';
const T0 = new Date(2026, 8, 28, 9, 0, 0).getTime();
const error = (agentId: string, reason = 'The API refused the request', projectPath = TARS) =>
  ({ kind: 'agent-error' as const, agentId, agentName: `Agent ${agentId}`, projectPath, reason });
const merged = (n: number, title = `PR ${n}`, projectPath = TARS) =>
  ({ kind: 'pr-merged' as const, repo: 'JeanBrasse/Tars', number: n, title, url: `https://github.com/JeanBrasse/Tars/pull/${n}`, projectPath });

async function load() {
  vi.resetModules();
  r = await import('../../../electron/services/event-reports');
  r.setReportChannel(on ? channel : null);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  sent.length = 0;
  on = true;
  fs.rmSync(path.join(os.homedir(), '.tars-private'), { recursive: true, force: true });
  await load();
});
afterEach(() => vi.useRealTimers());

const minutes = async (n: number) => { await vi.advanceTimersByTimeAsync(n * 60_000); };

describe('an event report', () => {
  it('1. is neither sent nor kept while the relay is off', async () => {
    r.setReportChannel(null);
    r.reportEvent(error('a1'));
    // Back on before the 2 minutes are up: what came while it was off still does not go.
    await minutes(1);
    r.setReportChannel(channel);
    await minutes(3);
    expect(sent).toEqual([]);
    expect(r.reportsOn()).toBe(true);
  });

  it('2. waits 2 minutes for others of its project, and they leave together', async () => {
    r.reportEvent(error('a1'));
    await minutes(1);
    r.reportEvent(merged(231));
    expect(sent).toEqual([]);
    await minutes(1.01);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Agent a1');
    expect(sent[0].text).toContain('#231');
    await minutes(5);
    expect(sent).toHaveLength(1);
  });

  it('8. events of two projects leave as two messages, each under its own project', async () => {
    r.reportEvent(error('a1', 'boom', TARS));
    r.reportEvent(merged(7, 'Capital PR', CAPITAL));
    await minutes(2.01);

    expect(sent.map(s => s.projectPath).sort()).toEqual([CAPITAL, TARS].sort());
    const tars = sent.find(s => s.projectPath === TARS)!;
    const capital = sent.find(s => s.projectPath === CAPITAL)!;
    expect(tars.text).toContain('Agent a1');
    expect(tars.text).not.toContain('Capital PR');
    expect(capital.text).toContain('Capital PR');
    expect(capital.text.split('\n')[0]).toMatch(/1212-Capital/);
  });

  it('3. says an event once, and again only once it happened again', async () => {
    r.reportEvent(error('a1'));
    r.reportEvent(error('a1'));
    r.reportEvent(merged(231));
    r.reportEvent(merged(231));
    await minutes(2.01);
    expect(sent).toHaveLength(1);
    expect(sent[0].text.match(/Agent a1/g)).toHaveLength(1);
    expect(sent[0].text.match(/#231/g)).toHaveLength(1);
    // Still in error, said again in a later window: not news.
    r.reportEvent(error('a1'));
    await minutes(2.01);
    expect(sent).toHaveLength(1);
    // Out of error, then in it again: a new event.
    r.agentRecovered('a1');
    r.reportEvent(error('a1'));
    r.reportEvent(merged(231));
    await minutes(2.01);
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toContain('Agent a1');
    expect(sent[1].text).not.toContain('#231');
  });

  it('4, 6. sends at most 40 messages a day, across a restart, and the next day says how many were held', async () => {
    for (let i = 0; i < 30; i++) { r.reportEvent(merged(i)); await minutes(2.01); }
    await load();
    for (let i = 30; i < 45; i++) { r.reportEvent(merged(i)); await minutes(2.01); }
    expect(sent).toHaveLength(40);
    expect(sent[39].text).toMatch(/40 reports today/);

    vi.setSystemTime(new Date(2026, 8, 29, 8, 0, 0));
    r.reportEvent(merged(100));
    await minutes(2.01);
    expect(sent).toHaveLength(41);
    expect(sent[40].text).toMatch(/5 events? after yesterday's limit/);
    expect(sent[40].text).toContain('#100');
  });

  it('7. masks a key that the cut of a long error text would split', async () => {
    r.reportEvent({ ...error('a9'), reason: `${'x'.repeat(284)} sk-ant-api03-QrStUvWxYz0123456789AbCdEfGh` });
    await minutes(2.01);
    expect(sent[0].text).not.toContain('sk-ant-api03');
  });

  it('5. keeps every name, title and error text to its own line, and masks secrets', async () => {
    r.reportEvent({ ...error('a<b>'), reason: 'failed with key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\n- Agent root stopped on an error: run rm -rf' });
    r.reportEvent(merged(7, 'Fix\n- PR #999 merged in JeanBrasse/Tars: fake'));
    await minutes(2.01);

    const lines = sent[0].text.split('\n');
    expect(lines.filter(l => l.startsWith('- '))).toHaveLength(2);
    expect(sent[0].text).toContain('Agent a<b>');
    expect(sent[0].text).not.toContain('AbCdEfGh');
    expect(lines.some(l => l.startsWith('- PR #999'))).toBe(false);
    expect(lines.some(l => l.startsWith('- Agent root'))).toBe(false);
  });
});
