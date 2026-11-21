/**
 * The 5 h and weekly counters of each account, as the status line leaves them
 * in ~/.tars/rate-limits.d/<account>.json
 * (electron/services/claude-accounts/counters.ts).
 *
 * What goes wrong if it is wrong, first:
 * - a counter filed under another account: the file name is the account, and
 *   only `default` and `acct-` plus six hex digits are read;
 * - a file an agent planted (~/.tars is every agent's) read as anything but
 *   two percentages and two reset times: anything else is no counter;
 * - a counter shown after its window reset (the page would say 98 % on a fresh
 *   window): a window whose reset has passed shows as nothing;
 * - seconds read as milliseconds or the other way round.
 */
import '../../setup/home-guard';
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readAccountUsage, usageForView, countersDir } from '../../../electron/services/claude-accounts/counters';

const NOW = Date.UTC(2026, 8, 28, 20, 0, 0);
const S = (ms: number) => Math.floor(ms / 1000);

function write(name: string, body: unknown): void {
  fs.mkdirSync(countersDir(), { recursive: true });
  fs.writeFileSync(path.join(countersDir(), name), typeof body === 'string' ? body : JSON.stringify(body));
}

beforeEach(() => {
  if (fs.existsSync(countersDir())) fs.rmSync(countersDir(), { recursive: true });
});

describe('reading the counters', () => {
  it('lives in ~/.tars/rate-limits.d, and none there reads as none', () => {
    expect(countersDir()).toBe(path.join(os.homedir(), '.tars', 'rate-limits.d'));
    expect(readAccountUsage()).toEqual({});
  });

  it('reads each account file the status line wrote, times in seconds, updatedAt in ms', () => {
    write('acct-1a2b3c.json', { updatedAt: S(NOW), rate_limits: { five_hour: { used_percentage: 42, resets_at: S(NOW) + 3600 }, seven_day: { used_percentage: 10, resets_at: S(NOW) + 86400 } } });
    write('default.json', { updatedAt: S(NOW) - 60, rate_limits: { five_hour: { used_percentage: 7, resets_at: S(NOW) + 60 } } });
    expect(readAccountUsage()).toEqual({
      'acct-1a2b3c': { fiveHour: { usedPercentage: 42, resetsAt: S(NOW) + 3600 }, sevenDay: { usedPercentage: 10, resetsAt: S(NOW) + 86400 }, updatedAt: S(NOW) * 1000 },
      default: { fiveHour: { usedPercentage: 7, resetsAt: S(NOW) + 60 }, sevenDay: null, updatedAt: (S(NOW) - 60) * 1000 },
    });
  });

  it('ignores files that are not an account, and values that are not numbers', () => {
    write('../../evil.json', { updatedAt: 1 });
    write('acct-XYZ.json', { updatedAt: S(NOW), rate_limits: { five_hour: { used_percentage: 1, resets_at: 1 } } });
    write('acct-000000.json.tmp.123', { updatedAt: S(NOW) });
    write('acct-000001.json', '{ not json');
    write('acct-000002.json', { updatedAt: 'soon', rate_limits: { five_hour: { used_percentage: '12', resets_at: 1 }, seven_day: { used_percentage: 5, resets_at: 'x' } } });
    const read = readAccountUsage();
    expect(Object.keys(read).sort()).toEqual(['acct-000002']);
    expect(read['acct-000002']).toEqual({ fiveHour: null, sevenDay: null, updatedAt: null });
  });
});

describe('what the page shows', () => {
  it('drops a window whose reset has passed, and keeps the others', () => {
    const shown = usageForView({ fiveHour: { usedPercentage: 98, resetsAt: S(NOW) - 1 }, sevenDay: { usedPercentage: 30, resetsAt: S(NOW) + 10 }, updatedAt: NOW - 1000 }, NOW);
    expect(shown).toEqual({ fiveHour: null, sevenDay: { usedPercentage: 30, resetsAt: S(NOW) + 10 }, updatedAt: NOW - 1000 });
    expect(usageForView(undefined, NOW)).toEqual({ fiveHour: null, sevenDay: null, updatedAt: null });
  });
});
