import * as fs from 'fs';
import * as path from 'path';
import { approveJanitor, scanJanitor, type JanitorItem, type JanitorOps, type JanitorReport, type JanitorWorld } from './janitor-rules';

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
  error: string | null;
};

export const NEVER_WORDS: readonly string[] = [
  '~/.tars-private', '~/Documents', 'the uv cache', 'the Trash', 'Xcode, the iOS runtimes and simulators (~/Library/Developer)',
  'any Docker volume', 'a project\'s own folder', 'a worktree an agent of the fleet works in', 'a worktree with uncommitted work',
  'a worktree with ignored files other than rebuildable caches, or in the middle of a rebase or a merge',
  'anything a process runs in or from (and, on Linux, holds open)',
];

const AGENT_EVERY_MS = 5 * 60_000;
const REQUESTS_KEPT = 50;

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
}) {
  let scan: JanitorState['scan'] = null;
  let raw: JanitorItem[] = [];
  let deleting: JanitorState['deleting'] = null;
  let error: string | null = null;
  const requests: JanitorState['requests'] = [];
  const byAgent = new Map<string, { at: number; items: JanitorItem[] }>();
  let running: Promise<JanitorItem[]> | undefined;

  const state = (): JanitorState => ({
    scan: scan ? { ...scan, items: scan.items.map(i => ({ ...i })) } : null,
    deleting: deleting ? { ...deleting } : null, never: [...NEVER_WORDS], log: readLog(deps.logFile), requests: [...requests], error,
  });
  const tell = () => { try { deps.broadcast(state()); } catch { /* no window */ } };

  async function runScan(askedBy: string | null): Promise<JanitorItem[]> {
    scan = { at: Date.now(), askedBy, running: true, progress: null, items: [] };
    error = null;
    tell();
    try {
      raw = await scanJanitor(await deps.world(), p => { if (scan) { scan.progress = p; tell(); } });
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

  return {
    state,
    /** A scan, the window's (null) or an agent's: the agent is answered with its own project's items, once in five minutes. */
    async scan(asker: { id: string; name: string; project: string } | null): Promise<JanitorItem[]> {
      if (asker) {
        // By its id: two agents of the same name in two projects are two askers (the Audit's L1).
        const seen = byAgent.get(asker.id);
        if (seen && Date.now() - seen.at < (deps.agentEveryMs ?? AGENT_EVERY_MS)) return seen.items;
      }
      running ??= runScan(asker?.name ?? null).finally(() => { running = undefined; });
      const items = await running;
      if (!asker) return items;
      const mine = items.filter(i => (i.path && inside(i.path, asker.project)) || (i.project && inside(i.project, asker.project)));
      byAgent.set(asker.id, { at: Date.now(), items: mine });
      requests.push({ at: Date.now(), by: asker.name, project: asker.project, items: mine.length });
      if (requests.length > REQUESTS_KEPT) requests.shift();
      tell();
      return mine;
    },
    /** The owner's approval, told as it goes. */
    async approve(ids: string[]): Promise<JanitorReport> {
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
    },
  };
}
