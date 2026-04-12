import { NextResponse, type NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 3600; // ISR: revalidate every hour

interface RawSkill {
  source: string;
  skillId: string;
  name: string;
  installs: number;
}

interface MappedSkill {
  rank: number;
  name: string;
  repo: string;
  installs: string;
  installsNum: number;
}

function formatInstalls(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

// Full cache of all skills from the SSR payload
let allSkillsCache: { skills: MappedSkill[]; ts: number } | null = null;
// Search result cache: keyed by query string
const searchCache = new Map<string, { skills: MappedSkill[]; ts: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const SEARCH_CACHE_TTL = 10 * 60 * 1000; // 10 minutes for search results

/** Fetch and cache all skills from the skills.sh SSR payload */
async function getAllSkills(): Promise<MappedSkill[] | null> {
  if (allSkillsCache && Date.now() - allSkillsCache.ts < CACHE_TTL) {
    return allSkillsCache.skills;
  }

  try {
    const res = await fetch('https://skills.sh/', {
      next: { revalidate: 3600 },
      headers: { 'User-Agent': 'Dorothy/1.0' },
    });

    if (!res.ok) return null;

    const html = await res.text();

    // Extract the initialSkills JSON array from the SSR payload
    const match = html.match(/initialSkills.*?(\[\{.*?\}\])/);
    if (!match) return null;

    const raw = match[1].replace(/\\"/g, '"');
    const allRaw: RawSkill[] = JSON.parse(raw);

    // Map ALL skills (no cap) — the SSR payload usually has ~300
    const skills = allRaw.map((s, i) => ({
      rank: i + 1,
      name: s.name,
      repo: s.source,
      installs: formatInstalls(s.installs),
      installsNum: s.installs,
    }));

    allSkillsCache = { skills, ts: Date.now() };
    return skills;
  } catch {
    return null;
  }
}

/** Search skills.sh API — returns up to 100 fuzzy-matched results */
async function searchSkillsRemote(query: string): Promise<MappedSkill[] | null> {
  const cacheKey = query.toLowerCase().trim();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
    return cached.skills;
  }

  try {
    const res = await fetch(
      `https://skills.sh/api/search?q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'Dorothy/1.0' } }
    );
    if (!res.ok) return null;

    const data = await res.json();
    if (!data?.skills || !Array.isArray(data.skills)) return null;

    const skills: MappedSkill[] = (data.skills as RawSkill[]).map((s, i) => ({
      rank: i + 1,
      name: s.name,
      repo: s.source,
      installs: formatInstalls(s.installs),
      installsNum: s.installs,
    }));

    searchCache.set(cacheKey, { skills, ts: Date.now() });

    // Evict old search cache entries (keep at most 50)
    if (searchCache.size > 50) {
      const oldest = [...searchCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) searchCache.delete(oldest[0]);
    }

    return skills;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)));
  const query = searchParams.get('q')?.trim() || '';

  let skills: MappedSkill[] | null = null;

  if (query && query.length >= 2) {
    // For search queries, try the skills.sh search API first (up to 100 results)
    const remote = await searchSkillsRemote(query);
    if (remote && remote.length > 0) {
      skills = remote;
    } else {
      // Fallback: filter the cached full list
      const all = await getAllSkills();
      if (all) {
        const q = query.toLowerCase();
        skills = all.filter(
          s => s.name.toLowerCase().includes(q) || s.repo.toLowerCase().includes(q)
        );
      }
    }
  } else {
    // No search query — return from the full cached list
    skills = await getAllSkills();
  }

  if (!skills) {
    return NextResponse.json({ error: 'Failed to fetch skills' }, { status: 502 });
  }

  const total = skills.length;
  const start = (page - 1) * limit;
  const paged = skills.slice(start, start + limit);

  // Re-rank the paged results relative to full list position
  const result = {
    skills: paged.map((s, i) => ({ ...s, rank: start + i + 1 })),
    total,
    page,
    pageSize: limit,
    hasMore: start + limit < total,
    fetchedAt: new Date().toISOString(),
  };

  return NextResponse.json(result);
}
