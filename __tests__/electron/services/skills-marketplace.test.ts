import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import {
  marketplaceListing, resetMarketplaceCache, MARKETPLACE_CACHE_FILE, MARKETPLACE_TTL_MS,
} from '../../../electron/services/skills-marketplace';

/**
 * Extensions fetched skills.sh on every visit, about a second before the page
 * could show anything (the Audit, 2026-09-23). The listing is now served from
 * the last one at once and fetched again behind it once it is an hour old.
 */

const page = (skills: Array<{ source: string; name: string; installs: number }>) =>
  `<script>self.__next_f.push([1,"initialSkills\\":${JSON.stringify(skills).replace(/"/g, '\\"')}"])</script>`;

let fetches: number;
let serve: () => Promise<Response>;

beforeEach(() => {
  resetMarketplaceCache();
  fs.rmSync(MARKETPLACE_CACHE_FILE, { force: true });
  fetches = 0;
  serve = async () => new Response(page([{ source: 'a/b', name: 'first', installs: 1500 }]));
  vi.stubGlobal('fetch', vi.fn(async () => { fetches++; return serve(); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const names = (listing: { skills: Array<{ name: string }> | null }) => listing.skills?.map(s => s.name);

describe('the skills.sh listing', () => {
  it('waits on the network only the first time, and keeps what it fetched on disk', async () => {
    const first = await marketplaceListing();
    const second = await marketplaceListing();

    expect(names(first)).toEqual(['first']);
    expect(first.skills![0]).toMatchObject({ rank: 1, repo: 'a/b', installs: '1.5K', installsNum: 1500 });
    expect(second).toBe(first);
    expect(fetches).toBe(1);
    expect(JSON.parse(fs.readFileSync(MARKETPLACE_CACHE_FILE, 'utf-8')).skills[0].name).toBe('first');
  });

  it('serves the kept listing after a restart without fetching', async () => {
    await marketplaceListing();
    resetMarketplaceCache();

    const afterRestart = await marketplaceListing();

    expect(names(afterRestart)).toEqual(['first']);
    expect(fetches).toBe(1);
  });

  it('once an hour old, answers the old listing at once and the new one next time', async () => {
    const first = await marketplaceListing();
    serve = async () => new Response(page([{ source: 'c/d', name: 'second', installs: 7 }]));

    const stale = await marketplaceListing(first.fetchedAt! + MARKETPLACE_TTL_MS + 1);
    expect(names(stale)).toEqual(['first']);
    await vi.waitFor(() => expect(fetches).toBe(2));
    await vi.waitFor(async () => expect(names(await marketplaceListing())).toEqual(['second']));
  });

  it('keeps the old listing when skills.sh fails or changes its page', async () => {
    const first = await marketplaceListing();
    serve = async () => { throw new Error('offline'); };
    await marketplaceListing(first.fetchedAt! + MARKETPLACE_TTL_MS + 1);
    await vi.waitFor(() => expect(fetches).toBe(2));
    // Let that refresh finish: one in flight is shared, not started again.
    await new Promise(resolve => setTimeout(resolve, 20));
    serve = async () => new Response('<html>redesigned</html>');
    await marketplaceListing(first.fetchedAt! + MARKETPLACE_TTL_MS + 1);
    await vi.waitFor(() => expect(fetches).toBe(3));

    expect(names(await marketplaceListing())).toEqual(['first']);
  });

  it('says there is nothing when the very first fetch fails, and fetches once for callers arriving together', async () => {
    serve = async () => new Response('down', { status: 503 });
    const [a, b] = await Promise.all([marketplaceListing(), marketplaceListing()]);

    expect(a).toEqual({ skills: null });
    expect(b).toEqual({ skills: null });
    expect(fetches).toBe(1);
  });
});

describe('a listing nobody vouches for', () => {
  // ~/.tars is in every agent's --add-dir, so the kept listing is a file any
  // agent can write, and skills.sh is someone else's server. What is served
  // reaches the Extensions page, and `repo` becomes the github URL
  // `npx skills add` installs from when the user clicks Install.
  //
  // How this fails, written before the code (the Audit, gate of #144):
  // 1. A planted entry is served as is: a well-known name beside a `repo`
  //    that is a URL, a path that climbs (`../..`), an option (`-x/y`), or
  //    has spaces or too many segments.
  // 2. An entry whose fields are not what the page reads (a name that is not
  //    a string, installs that are not a number) reaches a page that calls
  //    toLowerCase on it.
  // 3. One bad entry throws the whole listing away, good entries included.
  // 4. A kept file with no valid entry is served as an empty listing, and
  //    nothing is fetched to replace it.
  // 5. The network is trusted more than the file: skills.sh's own entries go
  //    through the same check.
  // 6. An HTTP error from skills.sh drops the listing that was kept.
  const good = { rank: 1, name: 'frontend-design', repo: 'anthropics/skills/frontend-design', installs: '1.2K', installsNum: 1200 };
  const plant = (skills: unknown[], fetchedAt = Date.now()) =>
    fs.writeFileSync(MARKETPLACE_CACHE_FILE, JSON.stringify({ skills, fetchedAt }));

  it('drops a planted entry whose repo is not owner/name or owner/name/skill, and serves the rest', async () => {
    plant([
      good,
      { ...good, rank: 2, repo: 'https://evil.example/owner/name' },
      { ...good, rank: 3, repo: '../..' },
      { ...good, rank: 4, repo: '-x/y' },
      { ...good, rank: 5, repo: 'owner/na me' },
      { ...good, rank: 6, repo: 'a/b/c/d' },
      { ...good, rank: 7, repo: 'owner/..' },
      { ...good, rank: 8, repo: 'owner' },
      { ...good, rank: 9, repo: 42 },
      { ...good, rank: 10, repo: 'vercel-labs/agent-skills' },
    ]);

    const listing = await marketplaceListing();

    expect(listing.skills!.map(s => s.repo)).toEqual(['anthropics/skills/frontend-design', 'vercel-labs/agent-skills']);
    expect(fetches, 'a listing with valid entries was fetched again').toBe(0);
  });

  it('drops an entry whose fields are not what the page reads', async () => {
    plant([
      good,
      { ...good, name: 7 },
      { ...good, name: '' },
      { ...good, installsNum: 'many' },
      { ...good, installs: undefined },
      { ...good, rank: -1 },
      null,
      'frontend-design',
    ]);

    const listing = await marketplaceListing();

    expect(listing.skills).toEqual([good]);
  });

  it('fetches afresh when nothing kept is valid, rather than serving an empty list', async () => {
    plant([{ ...good, repo: 'https://evil.example/x' }]);

    const listing = await marketplaceListing();

    expect(fetches).toBe(1);
    expect(names(listing)).toEqual(['first']);
  });

  it('checks what skills.sh sends the same way', async () => {
    serve = async () => new Response(page([
      { source: 'a/b', name: 'first', installs: 1500 },
      { source: '../../etc', name: 'planted', installs: 9 },
      { source: 'c/d', name: 'second', installs: 7 },
    ]));

    expect(names(await marketplaceListing())).toEqual(['first', 'second']);
  });

  it('keeps the listing it had when skills.sh answers with an HTTP error', async () => {
    const first = await marketplaceListing();
    serve = async () => new Response('Service Unavailable', { status: 503 });

    await marketplaceListing(first.fetchedAt! + MARKETPLACE_TTL_MS + 1);
    await vi.waitFor(() => expect(fetches).toBe(2));
    await new Promise(resolve => setTimeout(resolve, 20));
    // Forget what memory holds, as a restart does: only the file is left.
    resetMarketplaceCache();

    expect(names(await marketplaceListing()), 'the 503 dropped the listing').toEqual(['first']);
  });
});

describe('the install count main writes beside the number (QA, after #359)', () => {
  // The page writes each count from installsNum (src/lib/install-count.ts), and
  // falls back to this text when a count cannot be vouched for. Main wrote it
  // in thousands alone, a ".0" dropped: "1113K" beside the page's "1.3M".
  //
  // How it fails, written before the code (2026-10-13):
  // 1. A count of a million or more is written in thousands ("1113K").
  // 2. A count on a round thousand loses its decimal ("2K" for "2.0K").
  // 3. A count that rounds up to the next unit stays in the one below
  //    ("1000.0K" for 999,950).
  // 4. A count under a thousand is changed.
  it('is written as the page writes it: one decimal, in K, M or B', async () => {
    serve = async () => new Response(page([
      { source: 'a/b', name: 'm', installs: 1_113_000 },
      { source: 'a/c', name: 'k', installs: 2_000 },
      { source: 'a/d', name: 'edge', installs: 999_950 },
      { source: 'a/e', name: 'small', installs: 999 },
      { source: 'a/f', name: 'b', installs: 2_400_000_000 },
    ]));
    const listing = await marketplaceListing();
    expect(listing.skills!.map((s) => s.installs)).toEqual(['1.1M', '2.0K', '1.0M', '999', '2.4B']);
  });
});
