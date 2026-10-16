/**
 * The download counter: GitHub's own count, which the site reads and keeps
 * nothing of. The privacy policy says so ("The download counter shows GitHub's
 * own count of release downloads. The site keeps no download log.").
 *
 * Each release's installers are counted, one per system: the .dmg, the
 * Windows setup and the AppImage (src/lib/platforms.ts, installerOs).
 * latest-mac.yml is fetched by every installed Tars at each update check and
 * the zip is what a Mac's update downloads, so counting them would count
 * update checks and updates, not people downloading Tars: on 2026-09-24 they
 * were 1,434 of 1,439. On Windows and Linux the updater downloads that same
 * setup or AppImage, so their count holds updates as well; a Mac's does not.
 * Counting every system was the orchestrator's call of 16/10, for parity, and
 * the maintainer's to reverse.
 */

import { builds, installerOs, newestPublished, type Builds, type Release as PlatformRelease } from './platforms';

export const REPO = 'cooper-labs-tech/Tars';

interface Asset {
  name: string;
  download_count?: number;
}

interface Release {
  assets?: Asset[];
}

type GitHubRelease = Release & PlatformRelease;

export function countInstallerDownloads(releases: Release[]): number {
  return releases.reduce(
    (total, release) => total + (release.assets ?? [])
      .filter(asset => installerOs(asset.name) !== null)
      .reduce((sum, asset) => sum + (asset.download_count ?? 0), 0),
    0,
  );
}

const PER_PAGE = 100;
/** Two thousand releases: past that, the answer is not a list that ends. */
const MAX_PAGES = 20;

/**
 * Every release GitHub has, newest first, from every page. Null when any page
 * does not come back whole, or the pages never end: no answer is better than
 * a partial one.
 */
async function readReleases(fetchImpl: typeof fetch): Promise<GitHubRelease[] | null> {
  const releases: GitHubRelease[] = [];
  try {
    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) return null;
      const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases?per_page=${PER_PAGE}&page=${page}`, {
        headers: { Accept: 'application/vnd.github+json' },
        // An hour of cache keeps the site well inside the unauthenticated rate limit.
        next: { revalidate: 3600 },
      } as RequestInit);
      if (!res.ok) return null;
      const batch: unknown = await res.json();
      if (!Array.isArray(batch)) return null;
      releases.push(...(batch as GitHubRelease[]));
      if (batch.length < PER_PAGE) break;
    }
  } catch {
    return null;
  }
  return releases;
}

/**
 * Every release's installer downloads, from every page GitHub has. Null when
 * any page does not come back whole, or the pages never end: no count is
 * better than a false one.
 */
export async function downloadCount(fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const releases = await readReleases(fetchImpl);
  return releases ? countInstallerDownloads(releases) : null;
}

/**
 * What the page reads: the count, for each system the version of its newest
 * build, and the newest published release (src/lib/platforms.ts), so a system
 * no release has a build for says when it comes, and names a version only
 * while that version is still to come. All null when GitHub did not answer
 * whole.
 */
export async function releaseStats(fetchImpl: typeof fetch = fetch): Promise<{ total: number | null; builds: Builds | null; latest: string | null }> {
  const releases = await readReleases(fetchImpl);
  if (!releases) return { total: null, builds: null, latest: null };
  return { total: countInstallerDownloads(releases), builds: builds(releases), latest: newestPublished(releases) };
}
