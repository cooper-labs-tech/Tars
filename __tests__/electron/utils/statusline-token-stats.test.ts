import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { enableStatusLine } from '../../../electron/utils/statusline';
import { shHooksNotShipped } from '../../setup/platform-limits';

/**
 * ~/.dorothy/token-stats.json is written by the status line script and by
 * nothing else, on every render of every Claude session.
 *
 * Found on JeanBrasse's machine on 2026-09-22: 0 bytes, rewritten at every tick,
 * and unable to recover. The script piped the file into jq. An empty file gave
 * jq no input at all, jq printed nothing and exited 0, and that nothing was
 * moved back over the file. So the Usage page's "extra usage" figure, which
 * reads this file, had nothing to read, for good. A file that did not parse
 * was never replaced either: jq failed, and the temp file was thrown away.
 *
 * These run the script Tars installs, through bash and jq, in a temp HOME.
 */

let script: string;
let home: string;

beforeAll(() => {
  if (shHooksNotShipped()) return;
  // The status line runs on jq. A machine without it has no token stats at
  // all, and a case that skipped itself there would pass without running.
  const jq = spawnSync('jq', ['--version'], { encoding: 'utf-8' });
  if (jq.status !== 0) throw new Error('jq is not on PATH: the status line needs it, and so do these cases');

  // Installed into the suite's throwaway HOME, exactly as the app installs it.
  enableStatusLine();
  script = path.join(os.homedir(), '.dorothy', 'statusline.sh');
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-token-stats-'));
  fs.mkdirSync(path.join(home, '.dorothy'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const statsFile = () => path.join(home, '.dorothy', 'token-stats.json');

/** One render, with the JSON Claude Code pipes into its status line. */
function render(sessionId: string) {
  const input = JSON.stringify({
    session_id: sessionId,
    model: { model_id: 'claude-opus-5', display_name: 'Opus 5' },
    context_window: { total_input_tokens: 1200, total_output_tokens: 340, used_percentage: 12, context_window_size: 200_000 },
    cost: { total_cost_usd: 0.42, total_duration_ms: 61_000, total_lines_added: 3, total_lines_removed: 1 },
    rate_limits: { five_hour: { used_percentage: 20, resets_at: 0 }, seven_day: { used_percentage: 30, resets_at: 0 } },
  });
  return spawnSync('bash', [script], {
    input, cwd: home, encoding: 'utf-8', env: { PATH: process.env.PATH, HOME: home },
  });
}

/** What the file holds after a render, with the script's stderr to explain a miss. */
function afterRender(sessionId: string): { text: string; why: string } {
  const run = render(sessionId);
  const text = fs.existsSync(statsFile()) ? fs.readFileSync(statsFile(), 'utf-8') : '(no file)';
  return { text, why: `status ${run.status}, stderr: ${run.stderr}` };
}

const NEW_SESSION = {
  in: 1200, out: 340, cost: 0.42, model: 'claude-opus-5', extra: false,
  date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), provider: 'claude',
  // The account the session ran on (statusline-account.test.ts); none here.
  account: '',
};

// Each case runs the script through bash and jq, and the one that rewrites a
// file holding something that is not an object runs it five times: it took
// 7.5 s in the full suite at a load average of about 40 (QA's gate of #311,
// 2026-10-05), past vitest's 5 s, and 6.8 s alone. 30 s, as the status line's
// git cache cases have (statusline-gnu-stat.test.ts).
describe.skipIf(shHooksNotShipped())('the status line writing token-stats.json', { timeout: 30_000 }, () => {
  it('starts again from an empty object when the file is empty', () => {
    fs.writeFileSync(statsFile(), '');

    const { text, why } = afterRender('s-new');

    expect(text, why).not.toBe('');
    expect(JSON.parse(text)).toEqual({ 's-new': NEW_SESSION });
  });

  it('starts again from an empty object when the file does not parse', () => {
    fs.writeFileSync(statsFile(), '{"s-old":{"in":');

    const { text, why } = afterRender('s-new');

    expect(() => JSON.parse(text), why).not.toThrow();
    expect(JSON.parse(text)).toEqual({ 's-new': NEW_SESSION });
  });

  it('starts again from an empty object when the file parses to something that is not one', () => {
    // jq cannot set a key on an array, a number, a string or a boolean: it
    // fails, the temp file is thrown away, and the file stays as it was at
    // every render after, which is the empty file's story again.
    for (const content of ['[]', '[{"s-old":{}}]', '42', '"s-old"', 'true']) {
      fs.writeFileSync(statsFile(), content);

      const { text, why } = afterRender('s-new');

      expect(text, `${content}: ${why}`).not.toBe(content);
      expect(JSON.parse(text), `${content}: ${why}`).toEqual({ 's-new': NEW_SESSION });
    }
  });

  it('keeps every session a readable file already holds', () => {
    const old = { in: 5, out: 6, cost: 0.01, model: 'claude-sonnet-5', extra: true, date: '2026-09-01', provider: 'claude' };
    fs.writeFileSync(statsFile(), JSON.stringify({ 's-old': old }));

    const { text, why } = afterRender('s-new');

    expect(JSON.parse(text), why).toEqual({ 's-old': old, 's-new': NEW_SESSION });
  });

  it('creates the file when there is none', () => {
    const { text, why } = afterRender('s-new');

    expect(JSON.parse(text === '(no file)' ? 'null' : text), why).toEqual({ 's-new': NEW_SESSION });
  });
});
