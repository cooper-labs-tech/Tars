import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { agents } from '../core/agent-manager';
import { broadcastToAllWindows } from '../utils/broadcast';
import { projectRefusal, projectRefusalAsync, takePlaces } from '../utils/window-file-access';
import {
  scanProject, repositoryState, searchRepositories, mayReview,
  type ProjectScan, type RepositoryState,
} from '../services/review-repositories';

/**
 * Review's channels for every repository of a project (services/review-repositories.ts).
 * The window names a project, never a path to read: a project is one Tars
 * knows (its list, its agents'), and a repository one a scan found in it or an
 * agent's own folder (the Audit's R2.4). What a scan finds, and what a search
 * matches, come back as events, as they are found, under the id the call
 * answered; each project's last scan is kept, and read again on Refresh.
 * Both lists are files agents write, so a project, and a repository, is judged
 * by the window's project rule where it is used (2.0.7): only that one is looked
 * at, so a project on a share nobody answers for holds nothing else up.
 */

/** The projects Tars knows: its list and its agents'. */
export function knownProjects(): string[] {
  let listed: string[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'projects.json'), 'utf-8'));
    if (Array.isArray(parsed)) listed = parsed.filter((p): p is string => typeof p === 'string');
  } catch { /* none */ }
  return [...new Set([...listed, ...[...agents.values()].map((a) => a.projectPath).filter((p): p is string => !!p)])];
}

const agentFolders = () => [...agents.values()].map((a) => ({ id: a.id, name: a.name || a.id, path: a.worktreePath || a.projectPath || '' }));

interface Kept { scan: ProjectScan; states: Map<string, RepositoryState> }
const kept = new Map<string, Kept>();

/** What the window may review: every repository a scan found, every project and agent folder Tars knows. */
export function reviewablePaths(): Set<string> {
  const out = new Set<string>(knownProjects());
  for (const a of agents.values()) {
    if (a.projectPath) out.add(a.projectPath);
    if (a.worktreePath) out.add(a.worktreePath);
  }
  for (const k of kept.values()) for (const r of k.scan.repos) out.add(r);
  return out;
}

/** The refusal Review's older channels answer for a path Tars did not find. */
export function refuseUnknownRepository(repoPath: unknown): { success: false; error: string } | null {
  if (!mayReview(repoPath, reviewablePaths())) return { success: false, error: 'Not a repository Tars found in a project or an agent\'s folder.' };
  // The rule's places hold what is under them: a repository in a refused project is refused by its own path.
  const refusal = projectRefusal(repoPath);
  return refusal ? { success: false, error: refusal } : null;
}

const running = new Map<string, AbortController>();
let nextId = 1;

/** At most `n` of these running at once, the rest waiting their turn. */
function limited(n: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

async function scanAndRead(projectPath: string, scanId: string, signal: AbortSignal): Promise<Kept> {
  const send = (event: Record<string, unknown>) => broadcastToAllWindows('review:repositories:event', { scanId, projectPath, ...event });
  const states = new Map<string, RepositoryState>();
  const pending: Promise<void>[] = [];
  // Four repositories read at a time, each sent as soon as it is read.
  const four = limited(4);
  const scan = await scanProject(projectPath, {
    signal,
    onProgress: (foldersRead, repos) => send({ kind: 'progress', foldersRead, repos }),
    onRepo: (repo) => {
      send({ kind: 'found', repo });
      pending.push(four(async () => {
        if (signal.aborted) return;
        const s = await repositoryState(repo, agentFolders());
        states.set(s.path, s);
        send({ kind: 'repository', repository: s });
      }));
    },
  });
  await Promise.all(pending);
  const result = { scan, states };
  if (!signal.aborted) kept.set(projectPath, result);
  send({ kind: 'done', state: scan.state, skipped: scan.skipped, foldersRead: scan.foldersRead, repos: scan.repos.length });
  return result;
}

export function registerReviewHandlers(): void {
  /**
   * A project's repositories: what was kept from its last scan at once, then,
   * when asked (`refresh`) or never scanned, a scan whose findings come as
   * `review:repositories:event` under the answered `scanId`.
   */
  ipcMain.handle('review:repositories', async (_e, p: { projectPath?: unknown; refresh?: unknown } = {}) => {
    const projectPath = typeof p.projectPath === 'string' ? p.projectPath : '';
    if (!knownProjects().includes(projectPath)) return { error: 'Not a project Tars knows.', code: 'unknown_project' };
    const refusal = await projectRefusalAsync(projectPath);
    if (refusal) return { error: refusal, code: 'refused_project' };
    const last = kept.get(projectPath);
    const cached = last ? { state: last.scan.state, skipped: last.scan.skipped, repositories: [...last.states.values()] } : undefined;
    if (last && p.refresh !== true) return { cached };
    const scanId = `scan-${nextId++}`;
    const controller = new AbortController();
    running.set(scanId, controller);
    void scanAndRead(projectPath, scanId, controller.signal)
      .catch((err) => broadcastToAllWindows('review:repositories:event', { scanId, projectPath, kind: 'done', error: (err as Error).message }))
      .finally(() => running.delete(scanId));
    return { scanId, ...(cached ? { cached } : {}) };
  });

  /**
   * Every repository's name and path and every changed file, in every project
   * Tars knows, with no limit: `review:search:event` batches under the
   * answered `searchId`, then `done` with the count. A project never scanned
   * is scanned first.
   */
  ipcMain.handle('review:search', async (_e, p: { query?: unknown } = {}) => {
    const query = typeof p.query === 'string' ? p.query : '';
    if (!query.trim()) return { error: 'Nothing to search for.', code: 'empty_query' };
    const searchId = `search-${nextId++}`;
    const controller = new AbortController();
    running.set(searchId, controller);
    const send = (event: Record<string, unknown>) => broadcastToAllWindows('review:search:event', { searchId, ...event });
    void (async () => {
      const entries: Array<{ project: string; repos: RepositoryState[] }> = [];
      const places = await takePlaces();
      for (const project of knownProjects()) {
        if (controller.signal.aborted) break;
        if (await projectRefusalAsync(project, places)) continue;
        const k = kept.get(project) ?? await scanAndRead(project, `${searchId}-scan`, controller.signal);
        entries.push({ project, repos: [...k.states.values()] });
      }
      const total = await searchRepositories(query, entries, (groups) => send({ kind: 'batch', groups }), controller.signal);
      send({ kind: 'done', total, cancelled: controller.signal.aborted });
    })().catch((err) => send({ kind: 'done', error: (err as Error).message })).finally(() => running.delete(searchId));
    return { searchId };
  });

  /** Stops a scan or a search where it stands. */
  ipcMain.handle('review:cancel', async (_e, p: { id?: unknown } = {}) => {
    const controller = typeof p.id === 'string' ? running.get(p.id) : undefined;
    controller?.abort();
    return { cancelled: !!controller };
  });
}
