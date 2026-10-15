import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as download } from '../../landing/src/app/api/download/route';
import { GET as stats } from '../../landing/src/app/api/stats/route';

/**
 * The landing's two routes once it offers macOS, Windows and Linux alike
 * (landing/src/app/api/download/route.ts, landing/src/app/api/stats/route.ts),
 * as `Landing · downloads per OS` in design/landing.pen asks: a button names
 * its system, the route serves that system's file, and the page learns from
 * the stats which systems have a build. Written before the code, as the ways
 * they can fail:
 * 1. the system a link asks for is ignored: a Mac's dmg served to a Windows
 *    link, or the first file of the release whatever the link says;
 * 2. a system no release has a build for is sent a file anyway (another
 *    system's, or an update file), instead of back to the page, which says
 *    when it comes;
 * 3. the newest release is the only one read, so Windows has nothing while
 *    the newest release's Windows files are still being uploaded;
 * 4. a link that names no system, or one Tars has no build for, is served a
 *    Mac's dmg as before, rather than the page that offers each visitor theirs;
 * 5. the architecture a link asks for is ignored when the release has both;
 * 6. GitHub does not answer, or answers an error, and the visitor is sent
 *    anywhere but the releases page;
 * 7. the stats say nothing of which systems have a build, or say a system has
 *    one when GitHub did not answer.
 */

const asset = (name: string) => ({ name, browser_download_url: `https://github.com/cooper-labs-tech/Tars/releases/download/x/${name}`, download_count: 1 });
const release = (tag: string, names: string[]) => ({ tag_name: tag, draft: false, prerelease: false, assets: names.map(asset) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const RELEASES = [
  release('v2.0.4', ['latest-mac.yml', 'Tars-2.0.4-arm64.dmg', 'Tars-2.0.4-arm64-mac.zip', 'Tars-2.0.4.AppImage', 'Tars-2.0.4-arm64.AppImage']),
  release('v2.0.3', ['Tars-2.0.3-arm64.dmg', 'Tars-Setup-2.0.3.exe', 'Tars-Windows-2.0.3-x64.zip']),
];
const MAC_ONLY = [release('v2.0.2', ['latest-mac.yml', 'Tars-2.0.2-arm64.dmg', 'Tars-2.0.2-arm64-mac.zip'])];
const RELEASES_PAGE = 'https://github.com/cooper-labs-tech/Tars/releases/latest';

/** GitHub, answering every list of releases with these. */
const github = (answer: () => Promise<Response>) => vi.stubGlobal('fetch', vi.fn(answer));
const where = async (query: string) => {
  const res = await download(new Request(`https://tars.example/api/download${query}`));
  expect([302, 303, 307, 308]).toContain(res.status);
  return res.headers.get('location');
};
const fileOf = (location: string | null) => location?.split('/').pop();

afterEach(() => { vi.unstubAllGlobals(); });

describe('the download a link asks for (1, 3, 5)', () => {
  it('serves each system its own file', async () => {
    github(async () => json(RELEASES));
    expect(fileOf(await where('?os=mac'))).toBe('Tars-2.0.4-arm64.dmg');
    expect(fileOf(await where('?os=linux'))).toBe('Tars-2.0.4.AppImage');
  });

  it('serves Windows the newest release that has its setup, while the newest one has none yet', async () => {
    github(async () => json(RELEASES));
    expect(fileOf(await where('?os=windows'))).toBe('Tars-Setup-2.0.3.exe');
  });

  it('serves the architecture the link asks for', async () => {
    github(async () => json(RELEASES));
    expect(fileOf(await where('?os=linux&arch=arm64'))).toBe('Tars-2.0.4-arm64.AppImage');
  });
});

describe('a system with no build, or no system (2, 4)', () => {
  it('sends a system no release has a build for back to the page, which says when it comes', async () => {
    github(async () => json(MAC_ONLY));
    expect(await where('?os=windows')).toBe('https://tars.example/#download');
    expect(await where('?os=linux')).toBe('https://tars.example/#download');
  });

  it.each(['', '?os=', '?os=android', '?os=MAC'])('sends a link that names no system Tars has (%s) to the page', async query => {
    github(async () => json(RELEASES));
    expect(await where(query)).toBe('https://tars.example/#download');
  });
});

describe('when GitHub does not answer (6)', () => {
  it.each([
    ['a rate limit', async () => json({ message: 'API rate limit exceeded' }, 403)],
    ['a server error', async () => json({}, 502)],
    ['no network', async () => { throw new TypeError('fetch failed'); }],
    ['an answer that is not a list', async () => json({ message: 'Not Found' })],
  ])('sends the visitor to the releases page on %s', async (_what, answer) => {
    github(answer as () => Promise<Response>);
    expect(await where('?os=mac')).toBe(RELEASES_PAGE);
  });
});

describe('the stats the page reads (7)', () => {
  it('says the version of each system\'s newest build, with the count', async () => {
    github(async () => json(RELEASES));
    const body = await (await stats()).json();
    expect(body.builds).toEqual({ mac: '2.0.4', windows: '2.0.3', linux: '2.0.4' });
    expect(typeof body.total).toBe('number');
  });

  it('says no system has a build today but macOS', async () => {
    github(async () => json(MAC_ONLY));
    expect((await (await stats()).json()).builds).toEqual({ mac: '2.0.2', windows: null, linux: null });
  });

  it('says nothing of builds when GitHub did not answer, rather than that none has one', async () => {
    github(async () => json({}, 502));
    expect(await (await stats()).json()).toEqual({ total: null, builds: null });
  });
});
