import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as childProcess from 'child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendSample, readSamples, cleanSample, HEALTH_KEEP_MS, HEALTH_MAX_BYTES, type HealthSample } from '../../../electron/services/health/samples';
import { APP_PAGES } from '../../../electron/services/health/pages';
import { closeSecretsToOtherAccounts } from '../../../electron/utils/secret-file';

// Real programs unless a case says otherwise: case 11 stands in for whoami and icacls on a stubbed win32.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return { ...real, execFileSync: vi.fn(real.execFileSync), execFile: vi.fn(real.execFile) };
});
import { hasPosixModes } from '../../setup/platform-limits';

/**
 * The health samples Tars keeps on this machine (2.0.3, the maintainer's go of 2026-10-15 on monitoring options 1 and 2): every
 * 5 minutes the main process's memory, its event loop delay, its slowest IPC handlers, how many agents there are and
 * run, and the page open. Kept 24 hours, in a bounded file, numbers with the names of Tars's own calls and pages; they leave only with the report of an abrupt
 * end, or when the user sends a diagnostic.
 *
 * How it fails, written before the code:
 * 1. A sample older than 24 hours is kept, or sent.
 * 2. The file grows without bound (samples written faster than planned, a clock that jumps): it must stay under its
 *    size, the oldest dropped first.
 * 3. A line that is not a sample (a broken write, a hand edit, an agent's write: the file is in ~/.dorothy) is read
 *    back and sent: a string field holding a path, a name or a conversation.
 * 4. A channel name that is not one (spaces, a slash, a path, too long) or a page that is not a bare path (a query, a
 *    home folder, too long) is kept.
 * 5. A number that is not one (NaN, negative, Infinity, a string) is kept.
 * 6. A sample dated in the future (a clock set back) stays for good.
 * 7. A file that cannot be read or parsed throws, at start or at a sample.
 * 8. The file is readable by other users (POSIX: 0600).
 * And from the Audit's Low 1 on #418: the file is in ~/.dorothy, which agents may write.
 * 9. A channel or a page that only looks like one (a word an agent chose, in the pattern) leaves with a diagnostic or
 *    an abrupt end: what leaves must hold only the channels this Tars registered and the app's own pages.
 * 10. The list of the app's pages drifts from the app: a page added in src/app is dropped from every sample, or a
 *    page removed stays allowed.
 * And from the Audit's gate of #421: the privacy page says the file is readable by the user's account only.
 * 11. On Windows it is not: Node ignores the mode there, and a plain write keeps the list ~/.dorothy hands down. Named
 *    at startup with the other owner-only files, each write must be born closed (in the closed staging directory,
 *    made the user's and SYSTEM's alone before the rename), and an icacls that fails must not lose the sample.
 */

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
let dir: string;
let file: string;

const sample = (at: number, over: Partial<HealthSample> = {}): HealthSample => ({
  at, heapUsedMb: 120, heapTotalMb: 180, rssMb: 400, loopP50Ms: 11, loopP95Ms: 30,
  slowest: [{ channel: 'usage:tasks', ms: 118 }, { channel: 'claude:getData', ms: 10 }],
  agents: 45, running: 3, page: '/usage', ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-health-'));
  file = path.join(dir, 'health-samples.jsonl');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('the health samples file', () => {
  it('1. keeps 24 hours, no more', () => {
    for (let h = 30; h >= 0; h -= 1) appendSample(file, sample(NOW - h * 3_600_000), NOW - h * 3_600_000);
    const kept = readSamples(file, NOW);
    expect(kept.length).toBe(25);
    expect(Math.min(...kept.map((s) => s.at))).toBeGreaterThanOrEqual(NOW - HEALTH_KEEP_MS);
  });

  it('2. stays under its size, the oldest dropped first', () => {
    // A file grown past its bound (samples written every second, by a runaway or a hand), then one more sample.
    fs.writeFileSync(file, Array.from({ length: 4_000 }, (_, i) => JSON.stringify(sample(NOW - (4_000 - i) * 1_000))).join('\n') + '\n');
    expect(fs.statSync(file).size).toBeGreaterThan(HEALTH_MAX_BYTES);
    appendSample(file, sample(NOW - 1_000), NOW);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(HEALTH_MAX_BYTES);
    const kept = readSamples(file, NOW);
    expect(kept.at(-1)!.at).toBe(NOW - 1_000);
    expect(kept.length).toBeGreaterThan(100);
  });

  it('3. a line that is not a sample is never read back', () => {
    appendSample(file, sample(NOW - 60_000), NOW - 60_000);
    fs.appendFileSync(file, 'not json\n');
    fs.appendFileSync(file, `${JSON.stringify({ ...sample(NOW - 30_000), note: '/Users/someone/secret plans' })}\n`);
    fs.appendFileSync(file, `${JSON.stringify({ ...sample(NOW - 20_000), page: 'the user said: ship it tonight' })}\n`);
    const kept = readSamples(file, NOW);
    expect(JSON.stringify(kept)).not.toContain('someone');
    expect(JSON.stringify(kept)).not.toContain('ship it');
    expect(kept.every((s) => Object.keys(s).sort().join() === Object.keys(sample(0)).sort().join())).toBe(true);
  });

  it('4. channels and pages that are not one are dropped', () => {
    const odd = cleanSample(sample(NOW, {
      slowest: [{ channel: 'agent:start', ms: 5 }, { channel: 'rm -rf /', ms: 9 }, { channel: '/Users/someone/x', ms: 9 }, { channel: 'x'.repeat(80), ms: 9 }],
      page: '/agents?id=secret',
    }));
    expect(odd!.slowest).toEqual([{ channel: 'agent:start', ms: 5 }]);
    expect(odd!.page).toBeNull();
    expect(cleanSample(sample(NOW, { page: '/Users/someone/projects' }))!.page).toBeNull();
    expect(cleanSample(sample(NOW, { page: '/settings/error-reports' }))!.page).toBe('/settings/error-reports');
  });

  it('5. numbers that are not numbers make no sample', () => {
    for (const bad of [{ heapUsedMb: NaN }, { rssMb: -1 }, { loopP95Ms: Infinity }, { agents: '3' as unknown as number }, { at: 'now' as unknown as number }]) {
      expect(cleanSample(sample(NOW, bad))).toBeNull();
    }
  });

  it('6. a sample from the future is not kept', () => {
    appendSample(file, sample(NOW + 3 * 3_600_000), NOW);
    appendSample(file, sample(NOW - 60_000), NOW);
    expect(readSamples(file, NOW).map((s) => s.at)).toEqual([NOW - 60_000]);
  });

  it('7. a file that cannot be read or parsed throws nothing', () => {
    fs.writeFileSync(file, '\u0000\u0001garbage');
    expect(() => appendSample(file, sample(NOW), NOW)).not.toThrow();
    expect(readSamples(file, NOW).map((s) => s.at)).toEqual([NOW]);
    expect(readSamples(path.join(dir, 'none', 'nothing.jsonl'), NOW)).toEqual([]);
    expect(() => appendSample(path.join(dir, 'none', 'nothing.jsonl'), sample(NOW), NOW)).not.toThrow();
  });

  it.skipIf(!hasPosixModes())('8. readable by its owner only', () => {
    appendSample(file, sample(NOW), NOW);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('9. what is read to leave holds only the channels registered and the pages of the app', () => {
    appendSample(file, sample(NOW - 60_000, {
      slowest: [{ channel: 'usage:tasks', ms: 118 }, { channel: 'ship-it-tonight', ms: 50 }, { channel: 'acme:merger', ms: 9 }],
      page: '/usage',
    }), NOW);
    appendSample(file, sample(NOW - 30_000, { page: '/secret-plans' }), NOW);
    const known = { channels: new Set(['usage:tasks', 'claude:getData']), pages: APP_PAGES };
    const kept = readSamples(file, NOW, known);
    expect(kept.map((s) => s.slowest)).toEqual([[{ channel: 'usage:tasks', ms: 118 }], [{ channel: 'usage:tasks', ms: 118 }, { channel: 'claude:getData', ms: 10 }]]);
    expect(kept.map((s) => s.page)).toEqual(['/usage', null]);
    // Read with no vocabulary (this machine's own file), the sample is as it was written.
    expect(readSamples(file, NOW)[0].slowest).toHaveLength(3);
  });

  it('10. the pages of the app are the routes of src/app, and /', () => {
    const app = path.resolve(__dirname, '../../../src/app');
    const routes = fs.readdirSync(app, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(app, d.name, 'page.tsx')))
      .map((d) => `/${d.name}`);
    expect([...APP_PAGES].sort()).toEqual(['/', ...routes].sort());
  });

  describe('11. on Windows (stubbed), readable by its owner only', () => {
    const SID = 'S-1-5-21-1111-2222-3333-1001';
    const HOST = process.platform;
    let icacls: string[][];
    let failIcacls: boolean;
    beforeEach(() => {
      icacls = [];
      failIcacls = false;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const answer = (file: string, args: readonly string[]): string => {
        if (file.endsWith('whoami.exe')) return `"host\\someone","${SID}"\r\n`;
        if (file.endsWith('icacls.exe')) {
          icacls.push([...args]);
          if (failIcacls && args.includes('/inheritance:r') && !String(args[0]).endsWith('.staging')) throw Object.assign(new Error('icacls failed'), { status: 5 });
          return '';
        }
        throw new Error(`unexpected ${file}`);
      };
      vi.mocked(childProcess.execFileSync).mockImplementation(((file: string, args: readonly string[]) => answer(file, args)) as never);
      vi.mocked(childProcess.execFile).mockImplementation(((file: string, args: readonly string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
        try { cb(null, answer(file, args), ''); } catch (e) { cb(e as Error, '', ''); }
        return { stdin: null };
      }) as never);
    });
    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: HOST, configurable: true });
      vi.mocked(childProcess.execFileSync).mockReset();
      vi.mocked(childProcess.execFile).mockReset();
    });

    it('each write is born in the closed staging directory, the user and SYSTEM only, then renamed', async () => {
      const priv = path.join(dir, 'private');
      await closeSecretsToOtherAccounts([file], priv);
      icacls = [];
      appendSample(file, sample(NOW - 60_000), NOW);
      const closed = icacls.filter((a) => a.includes('/inheritance:r'));
      expect(closed.length, 'one icacls per write').toBe(1);
      expect(path.dirname(closed[0][0])).toBe(path.join(priv, '.staging'));
      expect(closed[0].slice(1)).toEqual(['/inheritance:r', '/grant:r', `*${SID}:(F)`, '*S-1-5-18:(F)']);
      expect(readSamples(file, NOW).map((s) => s.at)).toEqual([NOW - 60_000]);
      expect(fs.readdirSync(path.join(priv, '.staging'))).toEqual([]);
    });

    it('an icacls that fails is said, and the sample lands all the same', async () => {
      const priv = path.join(dir, 'private');
      await closeSecretsToOtherAccounts([file], priv);
      failIcacls = true;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(() => appendSample(file, sample(NOW - 60_000), NOW)).not.toThrow();
        expect(readSamples(file, NOW).map((s) => s.at)).toEqual([NOW - 60_000]);
        expect(warn.mock.calls.flat().join(' ')).toMatch(/\[secret-acl\].*keeps the access list its folder hands down/);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
