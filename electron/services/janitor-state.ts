import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { approveJanitor, scanJanitor, type JanitorItem, type JanitorOps, type JanitorReport, type JanitorWorld } from './janitor-rules';
import { reportForProject, type DiskReport } from './disk-report';

/**
 * The disk janitor as the window reads it (window.electronAPI.diskJanitor; the Frontend's contract on #539 and #543,
 * frames `Resources (2.0.5) · disk` and `· disk · states` of #535): one state, sent on each change, holding the
 * last scan (when, who asked, running, how far, its items with their outcomes), the deletions under way (item n of
 * N, checking again, deleted or kept), the never list in words, the log of what was freed read back from
 * janitor.log, and the scans agents asked for.
 *
 * An agent's scan (GET /api/janitor/scan) runs the whole scan, so the owner sees every item and who asked, but the
 * agent is answered with its own project's items only, and at most once in five minutes (the Audit's Info 1 on
 * #542). Only the window approves.
 */

export type JanitorOutcome = { kind: 'deleted' | 'kept' | 'failed'; bytes?: number | null; why?: string | null };
export type JanitorStateItem = {
  id: string;
  kind: JanitorItem['kind'];
  /** A folder's exact absolute path; for Docker, the image or the VM by name. */
  path: string;
  label: string;
  bytes: number | null;
  rule: string;
  why: string;
  details?: JanitorItem['details'];
  outcome?: JanitorOutcome | null;
};
export type JanitorState = {
  scan: null | {
    at: number;
    /** An agent's name when an agent asked; null when the window did. */
    askedBy: string | null;
    running: boolean;
    progress: { what: string; done: number; total: number; foundBytes: number } | null;
    items: JanitorStateItem[];
  };
  deleting: null | { done: number; total: number; freedBytes: number; current?: { path: string; phase: 'checking' | JanitorOutcome['kind'] } };
  /** What is never proposed nor deleted, in words. */
  never: string[];
  /** What was freed and kept, read back from the log, oldest first. */
  log: Array<{ at: number; what: string; bytes: number | null }>;
  /** The scans agents asked for, newest last. */
  requests: Array<{ at: number; by: string; project: string; items: number }>;
  /**
   * The cleanups agents asked the owner for (POST /api/janitor/request, disk_cleanup_request), newest last: items of
   * the last scan in the asker's project, with why. Nothing goes until the owner approves one, in one click
   * (diskJanitor:approveRequest), each item checked again as for any approval.
   */
  cleanupRequests: CleanupRequest[];
  /** What agents leave behind, per project and per agent, made after each scan (services/disk-report.ts). */
  report: DiskReport | null;
  error: string | null;
};

export type CleanupRequest = {
  id: string;
  at: number;
  by: string;
  byId: string;
  project: string;
  ids: string[];
  /**
   * Each item as the window shows it, what it is and the rule it matched (the Audit's L1 on #606), and, once this
   * request's approval has processed it, what became of it: kept on the request past later scans (QA's F2 on #606).
   */
  items: Array<Pick<JanitorStateItem, 'id' | 'kind' | 'label' | 'path' | 'bytes' | 'rule' | 'outcome'>>;
  bytes: number;
  /** What this request's approval freed, the bytes of its items deleted; 0 until the owner approves it. */
  freedBytes: number;
  why: string;
  state: 'waiting' | 'approved';
  approvedAt?: number;
};

/** A scan as an agent waits for it: its project's items of the last ended scan, and whether one runs now. */
export type ScanAnswer = { running: boolean; progress: NonNullable<JanitorState['scan']>['progress']; items: JanitorItem[]; at: number | null };
export type RequestAnswer = { ok: true; id: string; items: number; bytes: number } | { ok: false; status: number; error: string };

export const NEVER_WORDS: readonly string[] = [
  '~/.tars-private', '~/Documents', 'the uv cache', 'the Trash', 'Xcode, the iOS runtimes and simulators (~/Library/Developer)',
  'any Docker volume', 'a project\'s own folder', 'a worktree an agent of the fleet works in', 'a worktree with uncommitted work',
  'a worktree with ignored files other than rebuildable caches, or in the middle of a rebase or a merge',
  'anything a process runs in or from (and, on Linux, holds open)',
];

const AGENT_EVERY_MS = 5 * 60_000;
const REQUESTS_KEPT = 50;
const REQUEST_IDS_MAX = 200;
const REQUEST_WHY_MAX = 300;

function inside(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** janitor.log and its .1, oldest first: each line's time, its words, and the bytes it freed. */
function readLog(file: string): JanitorState['log'] {
  const out: JanitorState['log'] = [];
  for (const f of [`${file}.1`, file]) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const m = /^(\S+) \[janitor\] (.*)$/.exec(line);
      if (!m) continue;
      const at = Date.parse(m[1]);
      if (!Number.isFinite(at)) continue;
      const freed = /: freed (\d+) bytes$/.exec(m[2]);
      out.push({ at, what: m[2], bytes: freed ? Number(freed[1]) : null });
    }
  }
  return out;
}

const view = (i: JanitorItem): JanitorStateItem => ({
  id: i.id, kind: i.kind, path: i.path ?? (i.kind === 'docker-image' ? `docker image ${i.ref}` : i.label), label: i.label,
  bytes: i.kind === 'docker-vm-trim' ? null : i.sizeBytes, rule: i.rule, why: i.why, ...(i.details ? { details: i.details } : {}),
});

export function createJanitor(deps: {
  world: () => Promise<JanitorWorld>;
  /** The world of an approval's re-check: sizes are not measured again. */
  worldForCheck?: () => Promise<JanitorWorld>;
  ops: JanitorOps;
  logFile: string;
  broadcast: (state: JanitorState) => void;
  agentEveryMs?: number;
  /** What agents leave behind, made from the scan's world and items (services/disk-report.ts). */
  report?: (world: JanitorWorld, items: JanitorItem[]) => Promise<DiskReport>;
}) {
  let scan: JanitorState['scan'] = null;
  let raw: JanitorItem[] = [];
  /** The last ended scan's items: what an agent is answered while another runs, and what a request may name. */
  let ended: { at: number; items: JanitorItem[] } | null = null;
  let report: DiskReport | null = null;
  let started = 0;
  const cleanupRequests: CleanupRequest[] = [];
  let deleting: JanitorState['deleting'] = null;
  let error: string | null = null;
  const requests: JanitorState['requests'] = [];
  const byAgent = new Map<string, { at: number; items: JanitorItem[] }>();
  let running: Promise<JanitorItem[]> | undefined;

  const state = (): JanitorState => ({
    scan: scan ? { ...scan, items: scan.items.map(i => ({ ...i })) } : null,
    deleting: deleting ? { ...deleting } : null, never: [...NEVER_WORDS], log: readLog(deps.logFile), requests: [...requests],
    cleanupRequests: cleanupRequests.map(r => ({
      ...r, ids: [...r.ids], items: r.items.map(i => ({ ...i, ...(i.outcome ? { outcome: { ...i.outcome } } : {}) })),
    })), report, error,
  });
  const tell = () => { try { deps.broadcast(state()); } catch { /* no window */ } };

  async function runScan(askedBy: string | null): Promise<JanitorItem[]> {
    started++;
    scan = { at: Date.now(), askedBy, running: true, progress: null, items: [] };
    error = null;
    tell();
    try {
      const world = await deps.world();
      raw = await scanJanitor(world, p => { if (scan) { scan.progress = p; tell(); } });
      ended = { at: scan.at, items: raw };
      if (deps.report) {
        try {
          report = await deps.report(world, raw);
        } catch (err) {
          console.warn('[janitor] the report could not be made:', (err as Error).message);
        }
      }
      scan = { ...scan, running: false, progress: null, items: raw.map(view) };
      return raw;
    } catch (err) {
      error = `the scan failed: ${(err as Error).message}`;
      scan = { ...scan, running: false, progress: null };
      return [];
    } finally {
      tell();
    }
  }

  const inProject = (i: JanitorItem, project: string) => (!!i.path && inside(i.path, project)) || (!!i.project && inside(i.project, project));

  const janitor = {
    state,
    /**
     * A scan, the window's (null) or an agent's: the agent is answered with its own project's items, once in five
     * minutes. `by` names who started one with no agent asking (the periodic scan); never two at once.
     */
    async scan(asker: { id: string; name: string; project: string } | null, opts: { by?: string } = {}): Promise<JanitorItem[]> {
      if (asker) {
        // By its id: two agents of the same name in two projects are two askers (the Audit's L1).
        const seen = byAgent.get(asker.id);
        if (seen && Date.now() - seen.at < (deps.agentEveryMs ?? AGENT_EVERY_MS)) return seen.items;
      }
      running ??= runScan(asker?.name ?? opts.by ?? null).finally(() => { running = undefined; });
      const items = await running;
      if (!asker) return items;
      const mine = items.filter(i => inProject(i, asker.project));
      byAgent.set(asker.id, { at: Date.now(), items: mine });
      requests.push({ at: Date.now(), by: asker.name, project: asker.project, items: mine.length });
      if (requests.length > REQUESTS_KEPT) requests.shift();
      tell();
      return mine;
    },
    /**
     * An agent's scan, waited for `waitMs` at most (2.0.7): the whole scan outlasted the 30 s an MCP call waits under
     * load on the owner's Mac (19/11). Answered when it ends, or at the wait's end with `running` and the items of the
     * last ended scan in the agent's project; the scan goes on, and a later ask joins it.
     */
    async scanFor(asker: { id: string; name: string; project: string }, waitMs: number): Promise<ScanAnswer> {
      const asked = janitor.scan(asker);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>(r => { timer = setTimeout(() => r(null), Math.max(0, waitMs)); });
      try {
        const items = await Promise.race([asked, late]);
        if (items) return { running: false, progress: null, items, at: byAgent.get(asker.id)?.at ?? ended?.at ?? null };
      } finally {
        clearTimeout(timer);
      }
      asked.catch(() => undefined);
      return { running: true, progress: scan?.progress ?? null, items: (ended?.items ?? []).filter(i => inProject(i, asker.project)), at: ended?.at ?? null };
    },
    /**
     * An agent asks the owner for a cleanup (2.0.7): ids of the last ended scan, every one in its project, and why.
     * Recorded for the window, never deleting anything; the owner approves it in one click (approveRequest).
     */
    request(asker: { id: string; name: string; project: string }, ids: unknown, why: unknown): RequestAnswer {
      if (!Array.isArray(ids) || !ids.length || ids.length > REQUEST_IDS_MAX || !ids.every(i => typeof i === 'string')) {
        return { ok: false, status: 400, error: `ids are the ids of the janitor's items (disk_scan), 1 to ${REQUEST_IDS_MAX}` };
      }
      if (typeof why !== 'string' || !why.trim() || why.length > REQUEST_WHY_MAX) {
        return { ok: false, status: 400, error: `why is a short text, ${REQUEST_WHY_MAX} characters at most` };
      }
      const known = new Map((ended?.items ?? []).map(i => [i.id, i]));
      const unique = [...new Set(ids as string[])];
      const foreign = unique.filter(id => !known.has(id) || !inProject(known.get(id)!, asker.project));
      if (foreign.length) {
        return { ok: false, status: 403, error: `not items of the last scan in your project: ${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ', ...' : ''}` };
      }
      const request: CleanupRequest = {
        id: `jr-${randomBytes(4).toString('hex')}`, at: Date.now(), by: asker.name, byId: asker.id, project: asker.project,
        ids: unique, bytes: unique.reduce((sum, id) => sum + (known.get(id)?.sizeBytes ?? 0), 0), freedBytes: 0, why: why.trim(), state: 'waiting',
        items: unique.map(id => { const v = view(known.get(id)!); return { id: v.id, kind: v.kind, label: v.label, path: v.path, bytes: v.bytes, rule: v.rule }; }),
      };
      cleanupRequests.push(request);
      if (cleanupRequests.length > REQUESTS_KEPT) cleanupRequests.shift();
      tell();
      return { ok: true, id: request.id, items: unique.length, bytes: request.bytes };
    },
    /** The owner's one click on a request: its ids approved, as any approval; once. */
    async approveRequest(id: string): Promise<JanitorReport> {
      const request = cleanupRequests.find(r => r.id === id);
      if (!request) throw new Error('no such request');
      if (request.state !== 'waiting') throw new Error('this request was approved already');
      if (deleting) throw new Error('an approval is already under way');
      request.state = 'approved';
      request.approvedAt = Date.now();
      tell();
      return approveIds(request.ids, request);
    },
    /** The last report as an agent of `project` reads it, or null before the first scan. */
    reportFor(project: string): DiskReport | null {
      return report ? reportForProject(report, project) : null;
    },
    /** How many scans ran: a test reads that two asks share one. */
    scansStarted(): number {
      return started;
    },
    /** The owner's approval, told as it goes. */
    approve(ids: string[]): Promise<JanitorReport> {
      return approveIds(ids);
    },
  };

  /**
   * An approval of these ids, told as it goes; for a request's approval, each outcome is also kept on that request's
   * item, and what was deleted added to its freedBytes. The window's approval of the same ids from the scan's list
   * writes nothing into a request: only that request's own approval does.
   */
  async function approveIds(ids: string[], request?: CleanupRequest): Promise<JanitorReport> {
    if (deleting) throw new Error('an approval is already under way');
    const n = new Set(ids).size;
    deleting = { done: 0, total: n, freedBytes: 0 };
    tell();
    const pathOf = (id: string) => scan?.items.find(i => i.id === id)?.path ?? id;
    try {
      return await approveJanitor(ids, deps.worldForCheck ?? deps.world, {
        ...deps.ops,
        checking: (id) => { if (deleting) { deleting.current = { path: pathOf(id), phase: 'checking' }; tell(); } },
        done: (id, outcome) => {
          const item = scan?.items.find(i => i.id === id);
          if (item) item.outcome = outcome;
          const asked = request?.items.find(i => i.id === id);
          if (request && asked) {
            asked.outcome = { ...outcome };
            if (outcome.kind === 'deleted') request.freedBytes += outcome.bytes ?? 0;
          }
          if (deleting) {
            deleting.done++;
            if (outcome.kind === 'deleted') deleting.freedBytes += outcome.bytes ?? 0;
            deleting.current = { path: pathOf(id), phase: outcome.kind };
          }
          tell();
        },
      });
    } finally {
      deleting = null;
      tell();
    }
  }
  return janitor;
}
