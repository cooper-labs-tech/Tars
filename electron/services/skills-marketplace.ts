import * as fs from 'fs';
import { dataPath } from '../constants';
import { writeAtomicSync } from '../utils/secret-file';

/**
 * The skills.sh directory, for the Extensions page. The last listing is served
 * at once (from memory, or ~/.dorothy/skills-marketplace.json after a restart)
 * and fetched again behind it once it is over an hour old: fetched on every
 * visit, it cost about a second of someone else's server, and nothing showed
 * when that server was down (the Audit, 2026-09-23). A failed fetch keeps what
 * was there.
 */

export interface MarketplaceSkill {
  rank: number;
  name: string;
  repo: string;
  installs: string;
  installsNum: number;
}

export interface MarketplaceListing {
  skills: MarketplaceSkill[] | null;
  /** When the listing served was fetched, in ms since the epoch; absent when there is none. */
  fetchedAt?: number;
}

export const MARKETPLACE_CACHE_FILE = dataPath('skills-marketplace.json');
export const MARKETPLACE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

let kept: { skills: MarketplaceSkill[]; fetchedAt: number } | null = null;
let inFlight: Promise<MarketplaceListing> | null = null;

/**
 * One path segment of a GitHub `owner/repo/skill`: letters, digits, `_`, `.`
 * and `-`, not starting with `-` (an option to whatever reads it) and not `.`
 * or `..` (a path that climbs out of github.com/<owner>).
 */
function repoSegment(segment: string): boolean {
  return /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/.test(segment) && segment !== '.' && segment !== '..';
}

/**
 * Whether an entry is one the Extensions page can show and install from. The
 * listing comes from someone else's server into a folder every agent can
 * write, and `repo` is what Install hands `npx skills add
 * https://github.com/<repo>`, so a planted entry could put a well-known name
 * on somebody else's repository (the Audit, gate of #144); the page calls
 * toLowerCase on the other fields. Checked from the network and from the file.
 */
function validSkill(entry: unknown): entry is MarketplaceSkill {
  if (!entry || typeof entry !== 'object') return false;
  const s = entry as Record<string, unknown>;
  if (typeof s.repo !== 'string') return false;
  const segments = s.repo.split('/');
  return (segments.length === 2 || segments.length === 3) && segments.every(repoSegment)
    && typeof s.name === 'string' && s.name.length > 0 && s.name.length <= 200 && !/[\u0000-\u001f\u007f]/.test(s.name)
    && Number.isInteger(s.rank) && (s.rank as number) >= 1
    && typeof s.installs === 'string' && s.installs.length <= 16
    && typeof s.installsNum === 'number' && Number.isFinite(s.installsNum) && s.installsNum >= 0;
}

/** The listing as skills.sh publishes it in its page, or null when it cannot be read. */
export function parseMarketplace(html: string): MarketplaceSkill[] | null {
  const match = html.match(/initialSkills.*?(\[\{.*?\}\])/);
  if (!match) return null;
  const raw = match[1].replace(/\\"/g, '"');
  const allSkills: { source: string; name: string; installs: number }[] = JSON.parse(raw);
  // The directory publishes ~600 skills; the old 300 cap hid half of them
  // behind a search box that only filters what was already downloaded.
  const skills = allSkills.map((s, i) => ({
    rank: i + 1,
    name: s.name,
    repo: s.source,
    installs: s.installs >= 1000
      ? `${(s.installs / 1000).toFixed(1).replace(/\.0$/, '')}K`
      : String(s.installs),
    installsNum: s.installs,
  })).filter(validSkill);
  return skills.length > 0 ? skills : null;
}

function readKept(): typeof kept {
  if (kept) return kept;
  try {
    const parsed = JSON.parse(fs.readFileSync(MARKETPLACE_CACHE_FILE, 'utf-8'));
    // Only the entries that pass, and nothing kept when none does: an empty
    // listing served from a spoiled file would never be fetched again.
    const skills = Array.isArray(parsed?.skills) ? parsed.skills.filter(validSkill) : [];
    if (skills.length > 0 && typeof parsed.fetchedAt === 'number' && Number.isFinite(parsed.fetchedAt)) {
      kept = { skills, fetchedAt: parsed.fetchedAt };
    }
  } catch {
    // Nothing kept yet, or unreadable: the next fetch writes it.
  }
  return kept;
}

function refresh(): Promise<MarketplaceListing> {
  if (inFlight) return inFlight;
  inFlight = (async (): Promise<MarketplaceListing> => {
    try {
      const res = await fetch('https://skills.sh/', {
        headers: { 'User-Agent': 'Tars/1.0' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      // A failure leaves `kept` as it was, in memory and on disk: whoever asks
      // next is served it. This result is only awaited when nothing was kept.
      const skills = res.ok ? parseMarketplace(await res.text()) : null;
      if (!skills) return { skills: null };
      kept = { skills, fetchedAt: Date.now() };
      try {
        writeAtomicSync(MARKETPLACE_CACHE_FILE, JSON.stringify(kept));
      } catch (err) {
        console.warn('[marketplace] could not keep the listing:', err);
      }
      return kept;
    } catch {
      return { skills: null };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** The listing to show now: the kept one at once, refreshed behind it when stale. */
export async function marketplaceListing(now = Date.now()): Promise<MarketplaceListing> {
  const current = readKept();
  if (!current) return refresh();
  if (now - current.fetchedAt > MARKETPLACE_TTL_MS) void refresh();
  return current;
}

/** Test seam. */
export function resetMarketplaceCache(): void {
  kept = null;
  inFlight = null;
}
