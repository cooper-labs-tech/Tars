'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentStatus } from '@/types/electron';
import { reviewProjects, searchRows, type SearchRow } from '@/lib/review-repositories';

/**
 * Every project Review reads and every repository in it (2.0.4, #472): the last scan of each at once, a scan's
 * findings as they come (review.onRepositoriesEvent), and the search over every repository and changed file
 * (review.onSearchEvent). The page never names a path main did not find.
 */

type ReviewApi = NonNullable<NonNullable<Window['electronAPI']>['review']>;
type Started = Awaited<ReturnType<ReviewApi['repositories']>>;
type Snapshot = NonNullable<Extract<Started, { cached?: unknown }>['cached']>;
export type ReviewRepository = Snapshot['repositories'][number];
export type ReviewState = Snapshot['state'];
type RepositoriesEvent = Parameters<Parameters<ReviewApi['onRepositoriesEvent']>[0]>[0];
type SearchEvent = Parameters<Parameters<ReviewApi['onSearchEvent']>[0]>[0];

export interface ProjectView {
  path: string;
  /** Added in Tars by hand: removable from its list. */
  custom: boolean;
  /** Undefined while its first scan runs. */
  state?: ReviewState;
  repositories: ReviewRepository[];
  skipped: Array<{ path: string; why: string }>;
  scanning: boolean;
  progress?: { foldersRead: number; repos: number };
  error?: string;
  /** Main's reason the window's project rule no longer takes this folder (2.0.7): said in its place, nothing scanned. */
  refused?: string;
}

export interface SearchState {
  query: string;
  rows: SearchRow[];
  done: boolean;
  error?: string;
}

const upsert = (list: ReviewRepository[], repo: ReviewRepository) => {
  const i = list.findIndex((r) => r.path === repo.path);
  if (i < 0) return [...list, repo];
  const next = [...list];
  next[i] = repo;
  return next;
};

export function useReviewProjects() {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState<SearchState | null>(null);
  /** scanId -> the project it reads, and the repositories it found so far (shown once it is done when a list was kept). */
  const scans = useRef(new Map<string, { project: string; found: ReviewRepository[]; replace: boolean }>());
  const searchId = useRef<string | null>(null);
  /** Events that came before the call that names their scan or search had answered: replayed once it has. */
  const earlyScans = useRef(new Map<string, RepositoriesEvent[]>());
  const earlySearches = useRef(new Map<string, SearchEvent[]>());
  const keepEarly = <E,>(map: Map<string, E[]>, id: string, event: E) => {
    const kept = map.get(id) ?? [];
    if (kept.length < 5000) kept.push(event);
    map.set(id, kept);
  };
  const takeEarly = <E,>(map: Map<string, E[]>, id: string): E[] => {
    const kept = map.get(id) ?? [];
    map.delete(id);
    return kept;
  };
  const onScanEvent = useRef<(event: RepositoriesEvent) => void>(() => {});
  const onSearch = useRef<(event: SearchEvent) => void>(() => {});

  const patch = useCallback((path: string, change: (p: ProjectView) => ProjectView) => {
    setProjects((prev) => prev.map((p) => (p.path === path ? change(p) : p)));
  }, []);

  const scan = useCallback(async (path: string, refresh: boolean) => {
    const review = window.electronAPI?.review;
    if (!review?.repositories) return;
    let started: Started;
    try {
      started = await review.repositories(path, refresh ? { refresh: true } : undefined);
    } catch (err) {
      patch(path, (p) => ({ ...p, scanning: false, error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    if ('error' in started) {
      // A project the window's project rule refuses: main's reason in its place, not an error of reading.
      const refused = 'code' in started && started.code === 'refused_project';
      patch(path, (p) => (refused
        ? { ...p, scanning: false, repositories: [], skipped: [], refused: started.error, error: undefined }
        : { ...p, scanning: false, error: started.error }));
      return;
    }
    const cached = started.cached;
    if (started.scanId) scans.current.set(started.scanId, { project: path, found: [], replace: !!cached });
    patch(path, (p) => ({
      ...p,
      ...(cached ? { state: cached.state, repositories: cached.repositories, skipped: cached.skipped } : {}),
      scanning: !!started.scanId,
      error: undefined,
    }));
    if (started.scanId) for (const event of takeEarly(earlyScans.current, started.scanId)) onScanEvent.current(event);
  }, [patch]);

  const loadProjects = useCallback(async () => {
    const api = window.electronAPI;
    const [agents, listed] = await Promise.all([
      api?.agent?.list?.().catch(() => []) ?? [],
      api?.fs?.listProjects?.().catch(() => []) ?? [],
    ]);
    const custom = new Set((listed ?? []).filter((p) => p.custom).map((p) => p.path.replace(/[\\/]+$/, '')));
    // A project the window's project rule refuses (fs.listProjects' `refused`): listed with main's reason, never scanned.
    const refusedOf = new Map((listed ?? []).filter((p) => p.refused).map((p) => [p.path.replace(/[\\/]+$/, ''), p.refused as string]));
    const paths = reviewProjects((agents ?? []) as AgentStatus[], listed ?? []);
    setProjects((prev) => paths.map((path) => {
      const known = prev.find((p) => p.path === path);
      const refused = refusedOf.get(path);
      if (refused) return { ...(known ?? { path, custom: custom.has(path) }), repositories: [], skipped: [], scanning: false, refused, error: undefined, state: undefined };
      return known ?? { path, custom: custom.has(path), repositories: [], skipped: [], scanning: true };
    }));
    setLoaded(true);
    return paths.filter((path) => !refusedOf.has(path));
  }, []);

  useEffect(() => {
    const review = window.electronAPI?.review;
    if (!review?.onRepositoriesEvent) return;
    onScanEvent.current = (event: RepositoriesEvent) => {
      const at = scans.current.get(event.scanId);
      if (!at) { keepEarly(earlyScans.current, event.scanId, event); return; }
      if (event.kind === 'progress') {
        patch(at.project, (p) => ({ ...p, progress: { foldersRead: event.foldersRead, repos: event.repos } }));
      } else if (event.kind === 'repository') {
        at.found = upsert(at.found, event.repository);
        if (!at.replace) patch(at.project, (p) => ({ ...p, repositories: upsert(p.repositories, event.repository) }));
      } else if (event.kind === 'done') {
        scans.current.delete(event.scanId);
        const found = at.found;
        patch(at.project, (p) => ({
          ...p,
          scanning: false,
          progress: undefined,
          state: event.state ?? p.state,
          skipped: event.skipped ?? p.skipped,
          repositories: event.error ? p.repositories : found,
          error: event.error,
        }));
      }
    };
    onSearch.current = (event: SearchEvent) => {
      if (event.searchId !== searchId.current) { keepEarly(earlySearches.current, event.searchId, event); return; }
      if (event.kind === 'batch') {
        setSearch((s) => (s ? { ...s, rows: [...s.rows, ...searchRows(event.groups)] } : s));
      } else {
        setSearch((s) => (s ? { ...s, done: true, error: event.error } : s));
      }
    };
    const offScan = review.onRepositoriesEvent((event) => onScanEvent.current(event));
    const offSearch = review.onSearchEvent?.((event) => onSearch.current(event));
    return () => { offScan(); offSearch?.(); };
  }, [patch]);

  const loadAll = useCallback(async (refresh: boolean) => {
    const paths = await loadProjects();
    await Promise.all(paths.map((path) => scan(path, refresh)));
  }, [loadProjects, scan]);

  useEffect(() => { void loadAll(false); }, [loadAll]);

  const find = useCallback(async (query: string) => {
    const review = window.electronAPI?.review;
    if (searchId.current) void review?.cancel?.(searchId.current);
    searchId.current = null;
    earlySearches.current.clear();
    const q = query.trim();
    if (!q || !review?.search) { setSearch(null); return; }
    setSearch({ query: q, rows: [], done: false });
    const started = await review.search(q);
    if ('error' in started) { setSearch({ query: q, rows: [], done: true, error: started.error }); return; }
    searchId.current = started.searchId;
    for (const event of takeEarly(earlySearches.current, started.searchId)) onSearch.current(event);
  }, []);

  const remove = useCallback(async (path: string) => {
    const answer = await window.electronAPI?.fs?.removeCustomProject?.(path);
    if (answer?.success) setProjects((prev) => prev.filter((p) => p.path !== path));
    return answer;
  }, []);

  return { projects, loaded, search, find, refresh: () => loadAll(true), remove };
}
