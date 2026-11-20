/**
 * Each Claude account's 5 h and weekly windows read from Claude Code itself,
 * with `get_usage`, instead of the status line's files
 * (electron/services/claude-accounts/usage-probe.ts; PLAN-1.9.3.md, taken
 * from T3 Code).
 *
 * Measured on 2026-10-04 with claude 2.1.289 (usage-sdk-study/ in the review
 * folder): `claude -p --input-format stream-json --output-format stream-json`
 * answers a `get_usage` control request with the plan's windows, as
 * percentages 0 to 100 and ISO reset times, plus per-model weeklies
 * (`model_scoped`); a folder with no login answers `rate_limits_available:
 * false`; with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC set the windows are
 * null. Claude Code reads its own credential: Tars never sees one.
 *
 * How it fails, written before the code (2026-10-04):
 * 1. A percentage is read as a fraction, or the other way round.
 * 2. A reset time is read in the wrong unit: an ISO string must become epoch
 *    seconds, and one that does not parse is no window.
 * 3. An answer that is no reading (an error, `rate_limits_available: false`,
 *    null windows) reads as 0 %: an account nobody measured looks empty.
 * 4. A value that is not a number, out of 0..100, or a model name with
 *    control characters or no end, reaches the chooser or the page.
 * 5. The per-model weeklies are lost, or an absent list reads as an empty one.
 * 6. A CLI that never answers keeps the probe, and what it started, running;
 *    one that exits without answering is waited for.
 * 7. The probe runs with the traffic switch (no windows), with another
 *    account's folder, or with a folder set for account 1.
 * 8. A probe starts during the quit.
 * 9. Merged with the status line: an older probe hides a newer status line,
 *    or a newer probe loses to an older file.
 *
 * And from the Audit's gate (2026-10-05): a probe was a whole `claude -p` for
 * the account, which ran its SessionStart hooks (Tars's session-start.sh then
 * asked /api/memory/context, which asks Hermes) and started every MCP server
 * the account has, ten for account 1, only to kill them a second later.
 * 10. A probe loads the account's settings (its hooks) or its MCP servers.
 *     `--setting-sources ""` and `--strict-mcp-config` keep both out, and the
 *     Audit measured the reading intact with them: no hook, no transcript.
 *
 * And from QA's gate (2026-10-05): the probe killed claude with SIGKILL the
 * moment it answered, so claude never removed what it registers on start:
 * ~/.claude/sessions/<pid>.json, its key, and /tmp/cc-socks/<pid>.sock, 144 a
 * day per account, in the real ~/.claude for account 1. Closing its input
 * lets it exit by itself, in 0.57 s, and remove all three (QA's measure).
 * 11. A claude that answered is killed rather than let to exit and clean up.
 * 12. A claude that answered and does not exit when its input closes is left
 *     running, or the quit no longer ends it while it is closing.
 *
 * And of the tests themselves (06/10): the stand-ins of the two tests 12 ignore
 * their input closing, so only the code under test ends them. Run against a
 * mutant, red first, or failing before the grace, they outlived the run: two
 * from #303's bench were still running 43 h on, and QA ended one at 17 h.
 * 13. A test leaves a stand-in, or what it started, running after it ends.
 */
import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { parseUsageAnswer, probeUsage, usageProbeEnv, recordProbe, resetProbes } from '../../../electron/services/claude-accounts/usage-probe';
import { readAccountUsage, countersDir } from '../../../electron/services/claude-accounts/counters';
import { claudeAccountsNotPorted } from '../../setup/platform-limits';

const NOW = Date.UTC(2026, 9, 4, 19, 37, 0);
const S = (ms: number) => Math.floor(ms / 1000);
const iso = (ms: number) => new Date(ms).toISOString();

/** The `response` of a control_response to get_usage, as claude 2.1.289 sent it (trimmed). */
function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 32, resets_at: iso(NOW + 3 * 3600_000), limit_dollars: null },
      seven_day: { utilization: 9, resets_at: iso(NOW + 6 * 86400_000) },
      seven_day_opus: null,
      model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: iso(NOW + 6 * 86400_000) }],
    },
    ...over,
  };
}

describe('reading an answer', () => {
  it('1, 2, 5. keeps percentages as percentages, reset times as epoch seconds, and the per-model weeklies', () => {
    expect(parseUsageAnswer(answer())).toEqual({
      available: true,
      fiveHour: { usedPercentage: 32, resetsAt: S(NOW + 3 * 3600_000) },
      sevenDay: { usedPercentage: 9, resetsAt: S(NOW + 6 * 86400_000) },
      models: [{ name: 'Fable', usedPercentage: 0, resetsAt: S(NOW + 6 * 86400_000) }],
    });
  });

  it('2. a reset time that does not parse is no window', () => {
    const a = answer();
    (a.rate_limits as Record<string, unknown>).five_hour = { utilization: 32, resets_at: 'tomorrow' };
    expect(parseUsageAnswer(a).fiveHour).toBeNull();
  });

  it('3. no reading is no reading: not available, an error, or nothing at all', () => {
    const none = { available: false, fiveHour: null, sevenDay: null, models: [] };
    expect(parseUsageAnswer(answer({ rate_limits_available: false, rate_limits: null }))).toEqual(none);
    // Windows sent beside "not available" (an answer served from old data) are no reading either.
    expect(parseUsageAnswer(answer({ rate_limits_available: false }))).toEqual(none);
    expect(parseUsageAnswer(answer({ rate_limits: null }))).toEqual(none);
    expect(parseUsageAnswer(null)).toEqual(none);
    expect(parseUsageAnswer('x')).toEqual(none);
  });

  it('4. a value that is not a percentage is no window, and a model name is one short line', () => {
    const a = answer();
    const limits = a.rate_limits as Record<string, unknown>;
    limits.five_hour = { utilization: '32', resets_at: iso(NOW + 1000) };
    limits.seven_day = { utilization: 140, resets_at: iso(NOW + 1000) };
    limits.model_scoped = [
      { display_name: 'Fa\u001b[31mble\nnext line', utilization: 5, resets_at: iso(NOW + 1000) },
      { display_name: 'x'.repeat(500), utilization: 1, resets_at: iso(NOW + 1000) },
      { display_name: 'bad', utilization: Number.NaN, resets_at: iso(NOW + 1000) },
      'not an object',
    ];
    const read = parseUsageAnswer(a);
    expect(read.fiveHour).toBeNull();
    expect(read.sevenDay).toBeNull();
    expect(read.models).toHaveLength(2);
    expect(read.models[0].name).toBe('Fa[31mble next line');
    expect(read.models[1].name.length).toBeLessThanOrEqual(40);
  });

  it('5. no list is no list, and an empty one is empty', () => {
    const a = answer();
    delete (a.rate_limits as Record<string, unknown>).model_scoped;
    expect(parseUsageAnswer(a).models).toEqual([]);
  });
});

describe('the environment of a probe', () => {
  it('7. drops the traffic switch and names the account folder, none for account 1', () => {
    const base = { PATH: '/usr/bin', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CONFIG_DIR: '/elsewhere', TARS_CLAUDE_ACCOUNT: 'acct-000000' };
    const second = usageProbeEnv('/Users/x/.claude-accounts/acct-1a2b3c', base);
    expect(second.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
    expect(second.CLAUDE_CONFIG_DIR).toBe('/Users/x/.claude-accounts/acct-1a2b3c');
    expect(second.TARS_CLAUDE_ACCOUNT).toBeUndefined();
    const first = usageProbeEnv(null, base);
    expect(first.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(first.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
  });
});

/** The processes whose argv names `dir`: a test's stand-in and what it started. */
function startedIn(dir: string): number[] {
  const ps = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' });
  return ps.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m && m[2].includes(dir + path.sep) && Number(m[1]) !== process.pid ? [Number(m[1])] : [];
  });
}

// The probe runs only while the accounts are on, which a Windows build never
// is (D17): there it would start claude by its bare name, as the sign-in does.
// The stand-in is an extensionless script, and ps finds what it started.
describe.skipIf(claudeAccountsNotPorted())('a probe of the real protocol, against a stand-in claude', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-usage-probe-')); });
  afterEach(() => {
    // 13. Whatever the code under test did, each test ends what it started: every
    // process whose argv names this test's own folder (the stand-in, and what it
    // spawned), by PID, before the folder goes.
    for (const pid of startedIn(dir)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A claude that reads one control request on stdin and does what `script` says. */
  function standIn(script: string): string {
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, [
      `#!${process.execPath}`,
      "const fs = require('fs');",
      `fs.writeFileSync(__filename + '.argv', JSON.stringify({ argv: process.argv.slice(2), config: process.env.CLAUDE_CONFIG_DIR ?? null, traffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null }));`,
      "let buf = '';",
      "process.stdin.on('data', d => { buf += d; const nl = buf.indexOf('\\n'); if (nl < 0) return; const req = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1); onRequest(req); });",
      script,
      '',
    ].join('\n'), { mode: 0o755 });
    return bin;
  }

  it('asks get_usage over stream-json, skipping the transcript scan, and reads the answer', async () => {
    const bin = standIn(`function onRequest(req) {
      fs.writeFileSync(__filename + '.request', JSON.stringify(req));
      process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: ${JSON.stringify(answer())} } }) + '\\n');
    }`);
    const read = await probeUsage(bin, usageProbeEnv('/acct/dir', { PATH: process.env.PATH, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }));
    expect(read.fiveHour).toEqual({ usedPercentage: 32, resetsAt: S(NOW + 3 * 3600_000) });
    const request = JSON.parse(fs.readFileSync(`${bin}.request`, 'utf8'));
    expect(request).toMatchObject({ type: 'control_request', request: { subtype: 'get_usage', skip_behaviors: true } });
    const seen = JSON.parse(fs.readFileSync(`${bin}.argv`, 'utf8'));
    expect(seen.argv).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']));
    // 10. No settings (so no hook) and no MCP server of the account's.
    expect(seen.argv).toContain('--strict-mcp-config');
    expect(seen.argv[seen.argv.indexOf('--setting-sources') + 1]).toBe('');
    expect(seen).toMatchObject({ config: '/acct/dir', traffic: null });
  });

  it('3. an error answer is no reading', async () => {
    const bin = standIn(`function onRequest(req) {
      process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: req.request_id, error: 'nope' } }) + '\\n');
    }`);
    await expect(probeUsage(bin, process.env)).rejects.toThrow(/nope/);
  });

  it('6. a CLI that never answers is ended at the timeout, with what it started', async () => {
    // What the stand-in starts writes every 100 ms for as long as it lives, so
    // the test reads whether anything still writes after the answer, whenever
    // the stand-in got the request. With a 3 s timeout and a child that wrote
    // once, 5 s after it began, a stand-in slowed by load (~45) had not even
    // read the request when the probe gave up, and the test failed proving
    // nothing (the Audit's recheck of #303). 10 s leaves room for that.
    const bin = standIn(`function onRequest() {
      require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => require("fs").appendFileSync(process.argv[1], "."), 100)', __filename + '.child'], { stdio: 'ignore' });
      fs.writeFileSync(__filename + '.started', '');
    }`);
    const began = Date.now();
    await expect(probeUsage(bin, process.env, 10_000)).rejects.toThrow(/did not answer/);
    expect(Date.now() - began).toBeLessThan(13_000);
    expect(fs.existsSync(`${bin}.started`), 'the stand-in never got the request: this run proves nothing').toBe(true);
    const size = () => (fs.existsSync(`${bin}.child`) ? fs.statSync(`${bin}.child`).size : 0);
    await new Promise(r => setTimeout(r, 300));
    const after = size();
    await new Promise(r => setTimeout(r, 1000));
    expect(size(), 'what the probe started still writes after its answer').toBe(after);
  }, 30_000);

  const answers = `function onRequest(req) {
      process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: ${JSON.stringify(answer())} } }) + '\\n');
    }`;

  it('11. a claude that answered is let to exit by itself once its input closes', async () => {
    const bin = standIn(`${answers}
    process.stdin.on('end', () => { fs.writeFileSync(__filename + '.cleaned', ''); process.exit(0); });`);
    await expect(probeUsage(bin, process.env)).resolves.toMatchObject({ available: true });
    for (const until = Date.now() + 3000; Date.now() < until && !fs.existsSync(`${bin}.cleaned`);) await new Promise(r => setTimeout(r, 50));
    expect(fs.existsSync(`${bin}.cleaned`), 'killed before it could remove its session, key and socket').toBe(true);
  });

  it('12. one that answered and stays is ended after the grace, with what it started', async () => {
    const bin = standIn(`${answers}
    require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => require("fs").appendFileSync(process.argv[1], "."), 100)', __filename + '.child'], { stdio: 'ignore' });
    process.stdin.on('end', () => {});
    setInterval(() => {}, 1000);`);
    await expect(probeUsage(bin, process.env)).resolves.toMatchObject({ available: true });
    const size = () => (fs.existsSync(`${bin}.child`) ? fs.statSync(`${bin}.child`).size : 0);
    await new Promise(r => setTimeout(r, 4500));
    const after = size();
    await new Promise(r => setTimeout(r, 1000));
    expect(after, 'the child never ran').toBeGreaterThan(0);
    expect(size(), 'what the probe started still writes past the grace').toBe(after);
  }, 20_000);

  it('12. the quit ends one that answered and is still closing', async () => {
    vi.resetModules();
    const probe = await import('../../../electron/services/claude-accounts/usage-probe');
    const bin = standIn(`${answers}
    require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => require("fs").appendFileSync(process.argv[1], "."), 100)', __filename + '.child'], { stdio: 'ignore' });
    process.stdin.on('end', () => {});
    setInterval(() => {}, 1000);`);
    await expect(probe.probeUsage(bin, process.env)).resolves.toMatchObject({ available: true });
    probe.endUsageProbes();
    const size = () => (fs.existsSync(`${bin}.child`) ? fs.statSync(`${bin}.child`).size : 0);
    await new Promise(r => setTimeout(r, 300));
    const after = size();
    await new Promise(r => setTimeout(r, 1000));
    expect(size(), 'the quit left a closing probe running').toBe(after);
  }, 20_000);

  it('6. a CLI that exits without answering is not waited for', async () => {
    const bin = standIn('function onRequest() { process.exit(3); }');
    const began = Date.now();
    await expect(probeUsage(bin, process.env, 15_000)).rejects.toThrow(/exited/);
    expect(Date.now() - began).toBeLessThan(5000);
  });

  it('8. starts nothing during the quit', async () => {
    vi.resetModules();
    const quit = await import('../../../electron/core/quit-state');
    const probe = await import('../../../electron/services/claude-accounts/usage-probe');
    const bin = standIn("function onRequest() {}\nfs.writeFileSync(__filename + '.ran', '');");
    quit.beginQuit();
    await expect(probe.probeUsage(bin, process.env)).rejects.toThrow(/quitting/);
    await new Promise(r => setTimeout(r, 300));
    expect(fs.existsSync(`${bin}.ran`)).toBe(false);
  });
});

describe('merged with the status line', () => {
  function writeStatusLine(name: string, updatedAtMs: number, five: number): void {
    fs.mkdirSync(countersDir(), { recursive: true });
    fs.writeFileSync(path.join(countersDir(), name), JSON.stringify({
      updatedAt: S(updatedAtMs),
      rate_limits: { five_hour: { used_percentage: five, resets_at: S(NOW + 3600_000) }, seven_day: { used_percentage: 1, resets_at: S(NOW + 86400_000) } },
    }));
  }
  beforeEach(() => {
    resetProbes();
    if (fs.existsSync(countersDir())) fs.rmSync(countersDir(), { recursive: true });
  });

  it('9. a probe newer than the status line wins, with its per-model weeklies', () => {
    writeStatusLine('default.json', NOW - 60_000, 31);
    recordProbe('default', parseUsageAnswer(answer()), NOW);
    expect(readAccountUsage().default).toEqual({
      fiveHour: { usedPercentage: 32, resetsAt: S(NOW + 3 * 3600_000) },
      sevenDay: { usedPercentage: 9, resetsAt: S(NOW + 6 * 86400_000) },
      models: [{ name: 'Fable', usedPercentage: 0, resetsAt: S(NOW + 6 * 86400_000) }],
      updatedAt: NOW,
    });
  });

  it('9. a status line newer than the probe wins, and a probe with no reading never hides one', () => {
    writeStatusLine('default.json', NOW + 60_000, 40);
    recordProbe('default', parseUsageAnswer(answer()), NOW);
    expect(readAccountUsage().default.fiveHour?.usedPercentage).toBe(40);

    writeStatusLine('acct-1a2b3c.json', NOW - 60_000, 12);
    recordProbe('acct-1a2b3c', parseUsageAnswer(null), NOW);
    expect(readAccountUsage()['acct-1a2b3c'].fiveHour?.usedPercentage).toBe(12);
  });

  it('9. an account only a probe has read is read', () => {
    recordProbe('acct-1a2b3c', parseUsageAnswer(answer()), NOW);
    expect(readAccountUsage()['acct-1a2b3c']).toMatchObject({ fiveHour: { usedPercentage: 32 }, updatedAt: NOW });
  });
});
