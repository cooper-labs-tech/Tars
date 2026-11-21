import '../setup/home-guard';
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { countDmgDownloads, downloadCount } from '../../landing/src/lib/downloads';

/**
 * The landing's download counter, and the download log it no longer keeps
 * (landing/src/lib/downloads.ts, landing/src/app/api/). The privacy policy of
 * 1.9.0 says: "The download counter shows GitHub's own count of release
 * downloads. The site keeps no download log." Written before the code, as the
 * ways it can fail:
 * 1. every asset is counted: latest-mac.yml is fetched by every installed
 *    Tars at each update check, and the zip is what an update downloads, so
 *    the figure counts update checks (1,423 of the 1,439 on 2026-09-24) and
 *    updates, not people downloading Tars;
 * 2. the latest release alone is counted, and the figure falls to zero at
 *    each release;
 * 3. only the first page of releases is read (GitHub returns 30 unless asked,
 *    100 at most), and the count stops growing once there are more;
 * 4. GitHub does not answer, or answers an error or a rate limit, and the
 *    counter shows 0 or a partial sum as if it were the count;
 * 5. something in the site still writes a log of who downloads: a store
 *    client, the User-Agent or the time of a download kept;
 * 6. an answer whose pages never end (a full page every time) keeps the
 *    counter reading, and asking GitHub, for ever.
 */

const rel = (...assets: Array<[string, number]>) => ({ assets: assets.map(([name, download_count]) => ({ name, download_count })) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** The page a request asks for: `per_page=100` holds "page=1" too, so never match the text. */
const pageOf = (url: string | URL | Request) => new URL(String(url)).searchParams.get('page');

describe('what the counter counts (1, 2)', () => {
  it('counts the .dmg of every release, and nothing an installed app fetches to update', () => {
    const releases = [
      rel(['latest-mac.yml', 16], ['Tars-1.8.1-arm64-mac.zip', 1], ['Tars-1.8.1-arm64.dmg', 1], ['Tars-1.8.1-arm64.dmg.blockmap', 3]),
      rel(['latest-mac.yml', 6], ['Tars-1.8.0-arm64-mac.zip', 1], ['Tars-1.8.0-arm64.dmg', 4]),
      rel(['Tars-1.2.0.DMG', 2]),
    ];
    expect(countDmgDownloads(releases)).toBe(7);
  });

  it('counts a release without assets, or an asset without a count, as nothing', () => {
    expect(countDmgDownloads([{}, { assets: [] }, { assets: [{ name: 'Tars.dmg' }] }])).toBe(0);
  });
});

describe('reading GitHub (3, 4)', () => {
  it('reads every page of releases, a hundred at a time', async () => {
    const asked: string[] = [];
    const page1 = Array.from({ length: 100 }, () => rel(['Tars.dmg', 1]));
    const page2 = [rel(['Tars.dmg', 5]), rel(['latest-mac.yml', 50])];
    const fetchImpl = async (url: string | URL | Request) => {
      asked.push(String(url));
      return json(pageOf(url) === '1' ? page1 : page2);
    };
    expect(await downloadCount(fetchImpl as typeof fetch)).toBe(105);
    expect(asked).toEqual([
      'https://api.github.com/repos/cooper-labs-tech/Tars/releases?per_page=100&page=1',
      'https://api.github.com/repos/cooper-labs-tech/Tars/releases?per_page=100&page=2',
    ]);
  });

  it.each([
    ['a rate limit', async () => json({ message: 'API rate limit exceeded' }, 403)],
    ['a server error', async () => json({}, 502)],
    ['no network', async () => { throw new TypeError('fetch failed'); }],
    ['an answer that is not a list', async () => json({ message: 'Not Found' })],
  ])('has no count at all on %s, never a false one', async (_what, fetchImpl) => {
    expect(await downloadCount(fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it('has no count when a later page fails, rather than the sum of the pages before it', async () => {
    const page1 = Array.from({ length: 100 }, () => rel(['Tars.dmg', 1]));
    const fetchImpl = async (url: string | URL | Request) => (pageOf(url) === '1' ? json(page1) : json({}, 500));
    expect(await downloadCount(fetchImpl as typeof fetch)).toBeNull();
  });

  it('stops at twenty pages, with no count, when the list never ends (6)', async () => {
    let asked = 0;
    const full = Array.from({ length: 100 }, () => rel(['Tars.dmg', 1]));
    const fetchImpl = async () => {
      asked += 1;
      if (asked > 200) throw new Error('still asking');
      return json(full);
    };
    expect(await downloadCount(fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(asked).toBe(20);
  });
});

describe('the site keeps no download log (5)', () => {
  const LANDING = path.resolve(__dirname, '../../landing');
  const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return /\.(ts|tsx|js|mjs)$/.test(e.name) ? [full] : [];
  });

  it('reads the source it scans', () => {
    const files = sources(path.join(LANDING, 'src'));
    expect(files.some(f => f.endsWith(path.join('api', 'download', 'route.ts')))).toBe(true);
    expect(files.length).toBeGreaterThan(5);
  });

  it('has no store client and keeps nothing of a download: no Upstash, no Redis, no User-Agent', () => {
    const hits = sources(path.join(LANDING, 'src'))
      // A robots.txt rule's `userAgent` is no log: reading the request's header is.
      .filter(f => /upstash|redis|lpush|headers\.get\(\s*['"]user-agent/i.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(LANDING, f));
    expect(hits).toEqual([]);
  });

  it('depends on no store', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(LANDING, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).filter(d => /upstash|redis|@vercel\/kv/.test(d))).toEqual([]);
  });
});
