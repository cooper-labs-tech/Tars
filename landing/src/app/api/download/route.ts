import { NextResponse } from 'next/server';
import { REPO } from '../../../lib/downloads';
import { OSES, newestBuild, type Arch, type Os, type Release } from '../../../lib/platforms';

/**
 * Where the download comes from.
 *
 * This used to be a hardcoded URL, and it pointed at
 * `Charlie85270/dorothy/releases/download/1.2.9/dorothy-1.2.9-arm64.dmg`: the
 * upstream project's build, three minor versions behind, from a repository this
 * fork deliberately never touches. Every visitor who clicked "Download for Mac"
 * got someone else's app.
 *
 * Resolving the releases at request time means a button cannot go stale again,
 * and it can only ever serve a build from this repository.
 *
 * A link names its system (`?os=mac|windows|linux`, and `&arch=arm64` for an
 * arm64 visitor): the page reads the visitor's system in the browser, and this
 * route reads nothing of the request but its link. It serves that system's
 * installer from the newest published release that has one (a release's
 * Windows files are added after its macOS ones), and sends a link whose
 * system no release has a build for, or that names none, back to the page,
 * which says when it comes (design/landing.pen, Landing · downloads per OS).
 *
 * Nothing about the download is kept. The route used to keep the time, the
 * platform and the browser of each one in a database; the counter now reads
 * GitHub's own count (src/lib/downloads.ts), as the privacy policy says.
 */
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

/** The releases GitHub lists first, newest first; enough to cover a release whose files are still being uploaded. */
async function recentReleases(): Promise<Release[] | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
      headers: { Accept: 'application/vnd.github+json' },
      // A release lands rarely; an hour of cache keeps us well inside the
      // unauthenticated rate limit.
      next: { revalidate: 3600 },
    } as RequestInit);
    if (!res.ok) return null;
    const list: unknown = await res.json();
    return Array.isArray(list) ? (list as Release[]) : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const asked = params.get('os');
  const os = (OSES as readonly string[]).includes(asked ?? '') ? (asked as Os) : null;
  const page = new URL('/#download', request.url);
  if (!os) return NextResponse.redirect(page);

  const releases = await recentReleases();
  // Send people to the releases page rather than to a wrong binary.
  if (!releases) return NextResponse.redirect(RELEASES_PAGE);

  const arch: Arch | null = params.get('arch') === 'arm64' ? 'arm64' : null;
  const build = newestBuild(os, releases, arch);
  return NextResponse.redirect(build ? build.asset.browser_download_url : page);
}
