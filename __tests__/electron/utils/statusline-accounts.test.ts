/**
 * The status line files each render's rate limits under the account its CLI
 * runs on (DESIGN-COMPTES-CLAUDE.md B4), through the script Tars installs,
 * run for real with bash and jq in a temp HOME.
 *
 * What goes wrong if it is wrong, first:
 * - nothing changes when the option is off: with no TARS_CLAUDE_ACCOUNT the
 *   render is account 1's, and ~/.dorothy/rate-limits.json, which the Usage
 *   page reads, is written as it always was;
 * - a secondary account's usage written into rate-limits.json, where the Usage
 *   page would show it as account 1's;
 * - the account name used as a path: only `default` and `acct-` plus six hex
 *   digits are, anything else writes no counter at all;
 * - a render without rate limits (before the first answer) wiping a counter.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { STATUSLINE_SCRIPT } from '../../../electron/utils/statusline';
import { shHooksNotShipped } from '../../setup/platform-limits';

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
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-statusline-accounts-'));
  fs.mkdirSync(path.join(home, '.dorothy'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const LIMITS = { five_hour: { used_percentage: 42, resets_at: 1790625566 }, seven_day: { used_percentage: 10, resets_at: 1790960366 } };

function render(account: string | undefined, rateLimits: unknown = LIMITS) {
  const input = JSON.stringify({
    session_id: 's1',
    model: { model_id: 'claude-opus-5', display_name: 'Opus 5' },
    context_window: { total_input_tokens: 1, total_output_tokens: 1, used_percentage: 1, context_window_size: 200_000 },
    cost: { total_cost_usd: 0, total_duration_ms: 1, total_lines_added: 0, total_lines_removed: 0 },
    ...(rateLimits === undefined ? {} : { rate_limits: rateLimits }),
  });
  const env: Record<string, string> = { PATH: process.env.PATH as string, HOME: home };
  if (account !== undefined) env.TARS_CLAUDE_ACCOUNT = account;
  return spawnSync('bash', [script], { input, cwd: home, encoding: 'utf-8', env });
}

const dataFile = (...p: string[]) => path.join(home, '.dorothy', ...p);
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf-8'));

describe.skipIf(shHooksNotShipped())('the counters the status line leaves, per account', () => {
  it('with no account named, writes rate-limits.json as before, and default.json', () => {
    const r = render(undefined);
    expect(readJson(dataFile('rate-limits.json')), r.stderr).toEqual(LIMITS);
    const own = readJson(dataFile('rate-limits.d', 'default.json'));
    expect(own.rate_limits).toEqual(LIMITS);
    expect(Math.abs(own.updatedAt - Date.now() / 1000)).toBeLessThan(60);
  });

  it("files a secondary account's render under its name, and leaves rate-limits.json alone", () => {
    const r = render('acct-1a2b3c');
    expect(readJson(dataFile('rate-limits.d', 'acct-1a2b3c.json')).rate_limits, r.stderr).toEqual(LIMITS);
    expect(fs.existsSync(dataFile('rate-limits.json'))).toBe(false);
  });

  it.each(['../evil', 'acct-1A2B3C', 'acct-1a2b3c/../../x', '', 'default ', 'acct-1a2b3cd'])('writes no counter for the account name %j', (name) => {
    render(name);
    const dir = dataFile('rate-limits.d');
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    expect(fs.existsSync(dataFile('rate-limits.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'evil.json'))).toBe(false);
  });

  it('keeps the last counter through a render that has no rate limits yet', () => {
    render('acct-1a2b3c');
    render('acct-1a2b3c', undefined);
    render('acct-1a2b3c', null);
    expect(readJson(dataFile('rate-limits.d', 'acct-1a2b3c.json')).rate_limits).toEqual(LIMITS);
  });
});
