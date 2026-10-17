import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { STATUSLINE_SCRIPT } from '../../../electron/utils/statusline';
import { shHooksNotShipped } from '../../setup/platform-limits';

/**
 * Which account a Claude session ran on, written beside its provider in ~/.dorothy/token-stats.json.
 *
 * The Usage page cannot say which account spent what: the status line writes each session's provider, and no account
 * (the Audit's AUDIT-USAGE-COMPTES.md, 01/10, gap 8). A session started on one of several accounts carries the
 * account in TARS_CLAUDE_ACCOUNT (#267); the transcripts are then filed under it through this file.
 *
 * How this can fail, written before the code:
 * 1. the session's account is not written;
 * 2. a session with no account is given one;
 * 3. the rest of the entry changes: the provider, the counts, the cost.
 *
 * These run the script Tars installs, through bash and jq, in a temp HOME, as statusline-token-stats.test.ts does.
 */

let script: string;
let home: string;

beforeAll(() => {
  if (shHooksNotShipped()) return;
  const jq = spawnSync('jq', ['--version'], { encoding: 'utf-8' });
  if (jq.status !== 0) throw new Error('jq is not on PATH: the status line needs it, and so do these cases');
  // The bash status line, the reference hooks/statusline.mjs follows: Tars runs that one everywhere since 2.0.4.
  script = path.join(os.homedir(), '.dorothy', 'statusline.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, STATUSLINE_SCRIPT, { mode: 0o755 });
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-statusline-account-'));
  fs.mkdirSync(path.join(home, '.dorothy'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function render(sessionId: string, env: Record<string, string>) {
  const input = JSON.stringify({
    session_id: sessionId,
    model: { model_id: 'claude-opus-5', display_name: 'Opus 5' },
    context_window: { total_input_tokens: 1200, total_output_tokens: 340, used_percentage: 12, context_window_size: 200_000 },
    cost: { total_cost_usd: 0.42, total_duration_ms: 61_000, total_lines_added: 3, total_lines_removed: 1 },
    rate_limits: { five_hour: { used_percentage: 20, resets_at: 0 }, seven_day: { used_percentage: 30, resets_at: 0 } },
  });
  const run = spawnSync('bash', [script], { input, cwd: home, encoding: 'utf-8', env: { PATH: process.env.PATH, HOME: home, ...env } });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(fs.readFileSync(path.join(home, '.dorothy', 'token-stats.json'), 'utf-8'));
}

describe.skipIf(shHooksNotShipped())('the account of a session, in token-stats.json', () => {
  it('1, 3. a session on an account is written with it, beside its provider and its counts', () => {
    const stats = render('sess-two', { TARS_CLAUDE_ACCOUNT: '2', CLAUDE_PROVIDER: 'claude' });

    expect(stats['sess-two']).toMatchObject({ account: '2', provider: 'claude', in: 1200, out: 340, cost: 0.42, model: 'claude-opus-5' });
  });

  it('2. a session with no account is given none', () => {
    const stats = render('sess-none', {});

    expect(stats['sess-none'].account ?? '').toBe('');
    expect(stats['sess-none']).toMatchObject({ provider: 'claude', in: 1200, out: 340 });
  });
});
