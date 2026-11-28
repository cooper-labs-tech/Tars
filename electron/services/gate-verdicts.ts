import { execFile } from 'child_process';
import { safeGit } from '../utils/safe-git';
import { buildFullPath } from '../utils/path-builder';
import type { TraceStore } from './trace-store';

/**
 * Gate verdicts as data (trace feature B2): QA's, the Audit's or CI's MERGE or NO-MERGE on a pull request's head, so a
 * traced session's outcome carries a pass or fail that does not come from the model judging itself.
 *
 * - **Who records:** an agent, with its own token, in its own name (the route takes the name from the token, and
 *   refuses a body naming another agent), for its own project, with its name and role from the fleet. `qa` and
 *   `audit` only: Tars alone records `ci`, from the pull request's checks. Never on the recorder's own work: a qa or
 *   audit verdict is refused when one of the recorder's own traced turns moved its checkout to the judged head or to
 *   a linked ancestor (a turn that only sat on the head moved nothing).
 * - **One per gate, pull request and head** in a project: the latest stands; the same again changes nothing.
 * - **Linked** to the turns of the recording agent's project whose end head (turn-workspace.ts) is the judged head,
 *   in any session, turns that only sat on it included (the verdict is on the state they ended in; a reader tells
 *   the turns that moved the head by their start head), and to those on the pull request's branch whose end head is
 *   an ancestor of it (`merge-base --is-ancestor`, read-only). The pull request's branch is the verdict's own, else
 *   gh's (`gh pr view`); without either, the exact head alone. A session's branch is its outcome's once it ended,
 *   else the one its folder is on now (`branchOf`). A force-pushed head has the old heads as non-ancestors.
 * - **At a session's end** (relinkSession), the project's verdicts are linked again for it, its branch now known.
 * - **Carried** in each linked session's outcome as `gates`, its change sequence moved only on a change.
 * - **Bounded:** gh and git through execFile with an argv; every end head checked as a hash before git sees it; the
 *   whole call within an overall deadline (`incomplete` when ancestors were left unchecked). gh absent, failing or
 *   slow: nothing more is linked, and no CI verdict is recorded.
 * __tests__/electron/gate-verdicts.test.ts says each way this goes wrong.
 */

export type Gate = 'qa' | 'audit' | 'ci';
export type VerdictValue = 'merge' | 'no_merge';
export interface VerdictInput {
  gate: Gate; pr: number; head: string; verdict: VerdictValue; branch?: string;
  testCommand?: string; passed?: number; failed?: number; skipped?: number; report?: string;
}
/** Who records: the token's agent, its project and folder, its name and role from the fleet. */
export interface VerdictCaller { agentId: string; projectPath: string; folder: string; name?: string; role?: string }
export interface VerdictDeps {
  store: TraceStore;
  /** gh, with an argv, in a folder: its standard output. */
  gh?: (args: string[], cwd?: string) => Promise<string>;
  git?: (dir: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>;
  /** The branch a session still running is on (its folder's), null when unknown. */
  branchOf?: (traceId: string) => Promise<string | null>;
  ghTimeoutMs?: number;
  /** The whole call's deadline, gh and git included (15 s). */
  deadlineMs?: number;
  now?: () => number;
}
export interface RecordResult {
  recorded: boolean;
  /** Why it was not: one of the recorder's own traced turns made the head or a linked ancestor. */
  refused?: 'own-work';
  changed: boolean;
  linked: Array<{ traceId: string; turnIndex: number }>;
  /** Ancestors left unchecked at the deadline. */
  incomplete?: boolean;
}

const GATES: Gate[] = ['qa', 'audit', 'ci'];
const VERDICTS: VerdictValue[] = ['merge', 'no_merge'];
const HEAD = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH = /^[A-Za-z0-9._\/-]{1,200}$/;
/** At most this many distinct heads are asked about as ancestors, for one verdict. */
const MAX_ANCESTOR_CHECKS = 200;
const DEADLINE_MS = 15_000;

/** The verdict's fields, checked: closed values, a pull request number, a hash, counts that are whole and not negative. */
export function parseVerdict(body: Record<string, unknown>): { ok: true; verdict: VerdictInput } | { ok: false; error: string } {
  const gate = body.gate;
  if (!GATES.includes(gate as Gate)) return { ok: false, error: `gate is one of ${GATES.join(', ')}.` };
  const verdict = body.verdict;
  if (!VERDICTS.includes(verdict as VerdictValue)) return { ok: false, error: 'verdict is merge or no_merge.' };
  const pr = body.pr;
  if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) return { ok: false, error: 'pr is the pull request\'s number.' };
  const head = typeof body.head === 'string' ? body.head.toLowerCase() : '';
  if (!HEAD.test(head)) return { ok: false, error: 'head is the judged commit\'s full hash.' };
  const out: VerdictInput = { gate: gate as Gate, pr, head, verdict: verdict as VerdictValue };
  if (body.branch !== undefined) {
    if (typeof body.branch !== 'string' || !BRANCH.test(body.branch)) return { ok: false, error: 'branch is the pull request\'s branch name.' };
    out.branch = body.branch;
  }
  for (const k of ['passed', 'failed', 'skipped'] as const) {
    const n = body[k];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return { ok: false, error: `${k} is a whole count, 0 or more.` };
    out[k] = n;
  }
  if (body.testCommand !== undefined) {
    if (typeof body.testCommand !== 'string' || body.testCommand.length > 500) return { ok: false, error: 'testCommand is the test command, 500 characters at most.' };
    out.testCommand = body.testCommand;
  }
  if (body.report !== undefined) {
    if (typeof body.report !== 'string' || body.report.length > 1000) return { ok: false, error: 'report is a path, 1000 characters at most.' };
    out.report = body.report;
  }
  return { ok: true, verdict: out };
}

function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), Math.max(0, ms));
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** gh where a shell finds it; its output even on the exit codes gh gives with JSON (checks failing or pending). */
const defaultGh = (timeoutMs: number) => (args: string[], cwd?: string) => new Promise<string>((resolve, reject) => {
  execFile('gh', args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, PATH: buildFullPath() } },
    (err, stdout) => {
      if (!err) { resolve(String(stdout)); return; }
      if (String(stdout ?? '').trim().startsWith('[') || String(stdout ?? '').trim().startsWith('{')) { resolve(String(stdout)); return; }
      reject(err);
    });
});

/** The call's runners, each within what is left of its deadline. */
function runners(deps: VerdictDeps, deadline: number) {
  const ghTimeout = deps.ghTimeoutMs ?? 10_000;
  const gh = deps.gh ?? defaultGh(ghTimeout);
  const git = deps.git ?? ((dir: string, args: string[], opts: { timeout: number }) => safeGit(dir, args, opts));
  const left = () => deadline - Date.now();
  return {
    left,
    gh: (args: string[], cwd?: string) => bounded(gh(args, cwd), Math.min(ghTimeout, left())),
    /** The heads among `heads` that are ancestors of `head`; incomplete when the deadline or the cap left some unasked. */
    async ancestors(folder: string, heads: string[], head: string): Promise<{ found: Set<string>; incomplete: boolean }> {
      const found = new Set<string>();
      const asked = heads.filter(h => HEAD.test(h)).slice(0, MAX_ANCESTOR_CHECKS);
      for (let i = 0; i < asked.length; i++) {
        const ms = Math.min(5000, left());
        if (ms <= 0) return { found, incomplete: true };
        const yes = await bounded(git(folder, ['merge-base', '--is-ancestor', asked[i], head], { timeout: ms }), ms).then(() => true, () => false);
        if (yes) found.add(asked[i]);
      }
      return { found, incomplete: heads.filter(h => HEAD.test(h)).length > asked.length };
    },
  };
}

/** The pull request's branch, from gh; null when gh is absent, slow or says nothing. */
async function prBranch(run: ReturnType<typeof runners>, caller: VerdictCaller, pr: number): Promise<string | null> {
  try {
    const out = JSON.parse(await run.gh(['pr', 'view', String(pr), '--json', 'headRefName'], caller.folder)) as { headRefName?: unknown };
    return typeof out.headRefName === 'string' && BRANCH.test(out.headRefName) ? out.headRefName : null;
  } catch {
    return null;
  }
}

/** Records the verdict and links it, unless it is on the recorder's own work; the turns linked, and what changed. */
export async function recordVerdict(deps: VerdictDeps, caller: VerdictCaller, v: VerdictInput): Promise<RecordResult> {
  const now = (deps.now ?? Date.now)();
  const run = runners(deps, Date.now() + (deps.deadlineMs ?? DEADLINE_MS));
  const store = deps.store;
  // Heads from the store are checked before anything uses them: one that is not a hash never reaches git.
  const candidates = store.verdictCandidates(caller.projectPath).filter(c => HEAD.test(c.endHead));
  // A session still running has no branch in its outcome yet: the one its folder is on.
  const branchOfRunning = new Map<string, string | null>();
  if (deps.branchOf) {
    for (const traceId of new Set(candidates.filter(c => !c.branch).map(c => c.traceId))) {
      const ms = Math.min(5000, run.left());
      const b = ms > 0 ? await bounded(deps.branchOf(traceId), ms).catch(() => null) : null;
      branchOfRunning.set(traceId, b && BRANCH.test(b) && b !== 'HEAD' ? b : null);
    }
  }
  const branchOf = (c: (typeof candidates)[number]) => c.branch ?? branchOfRunning.get(c.traceId) ?? null;
  const linked = candidates.filter(c => c.endHead === v.head);
  const branch = v.branch ?? (await prBranch(run, caller, v.pr));
  let incomplete = false;
  if (branch) {
    const onBranch = candidates.filter(c => branchOf(c) === branch && c.endHead !== v.head);
    const r = await run.ancestors(caller.folder, [...new Set(onBranch.map(c => c.endHead))], v.head);
    incomplete = r.incomplete;
    linked.push(...onBranch.filter(c => r.found.has(c.endHead)));
  }
  // Never a verdict on one's own work: a turn of the recorder's own that moved its checkout to the head or an ancestor.
  if (v.gate !== 'ci' && linked.some(c => c.agentId === caller.agentId && c.startHead !== c.endHead)) {
    return { recorded: false, refused: 'own-work', changed: false, linked: [] };
  }
  const changed = store.inTransaction(() => {
    const put = store.putVerdict({
      projectPath: caller.projectPath, gate: v.gate, pr: v.pr, head: v.head, verdict: v.verdict, at: now, by: caller.agentId,
      byName: caller.name, byRole: caller.role, branch: branch ?? undefined,
      testCommand: v.testCommand, passed: v.passed, failed: v.failed, skipped: v.skipped, report: v.report,
    });
    const moved = store.setVerdictLinks(put.id, linked.map(l => ({ traceId: l.traceId, startedAt: l.startedAt })));
    const touched = new Set([...moved, ...(put.changed ? store.verdictTraces(put.id) : [])]);
    let any = put.changed || moved.length > 0;
    for (const traceId of touched) any = store.refreshGates(traceId) || any;
    return any;
  });
  return {
    recorded: true, changed,
    linked: linked.map(l => ({ traceId: l.traceId, turnIndex: l.turnIndex })).sort((a, b) => (a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : a.turnIndex - b.turnIndex)),
    ...(incomplete ? { incomplete: true } : {}),
  };
}

/**
 * At a session's end, its branch now in its outcome: the project's verdicts linked again for its turns (the exact
 * head, and the ancestors on the verdict's branch when it is the session's), links only added. Whether any moved;
 * the session's gates then rebuilt.
 */
export async function relinkSession(deps: VerdictDeps, traceId: string, folder: string): Promise<boolean> {
  const store = deps.store;
  const s = store.session(traceId);
  if (!s) return false;
  const run = runners(deps, Date.now() + (deps.deadlineMs ?? DEADLINE_MS));
  const branch = s.outcome?.branch;
  const mine = store.verdictCandidates(s.session.projectPath).filter(c => c.traceId === traceId && HEAD.test(c.endHead));
  if (!mine.length) return false;
  const heads = new Set(mine.map(c => c.endHead));
  let added = 0;
  for (const vd of store.projectVerdicts(s.session.projectPath)) {
    const onBranch = !!branch && vd.branch === branch;
    if (!onBranch && !heads.has(vd.head)) continue;
    const links = mine.filter(c => c.endHead === vd.head);
    if (onBranch) {
      const r = await run.ancestors(folder, [...heads].filter(h => h !== vd.head), vd.head);
      links.push(...mine.filter(c => r.found.has(c.endHead)));
    }
    added += store.addVerdictLinks(vd.id, traceId, links.map(l => l.startedAt));
  }
  if (!added) return false;
  store.refreshGates(traceId);
  return true;
}

/**
 * CI's verdict on a pull request, from its checks (`gh pr checks --json`), recorded by Tars: all passed is MERGE, one
 * failed or cancelled NO-MERGE; checks still running, none at all, or gh absent or slow, nothing.
 */
export async function ciVerdicts(deps: VerdictDeps, caller: VerdictCaller, pr: number): Promise<{ verdict: VerdictValue } | null> {
  const run = runners(deps, Date.now() + (deps.deadlineMs ?? DEADLINE_MS));
  try {
    const view = JSON.parse(await run.gh(['pr', 'view', String(pr), '--json', 'headRefName,headRefOid'], caller.folder)) as { headRefName?: unknown; headRefOid?: unknown };
    const head = typeof view.headRefOid === 'string' ? view.headRefOid.toLowerCase() : '';
    if (!HEAD.test(head)) return null;
    const checks = JSON.parse(await run.gh(['pr', 'checks', String(pr), '--json', 'name,state,bucket'], caller.folder)) as Array<{ bucket?: unknown }>;
    if (!Array.isArray(checks) || checks.length === 0) return null;
    if (checks.some(c => c.bucket === 'pending')) return null;
    const failed = checks.filter(c => c.bucket === 'fail' || c.bucket === 'cancel').length;
    const passed = checks.filter(c => c.bucket === 'pass').length;
    const skipped = checks.filter(c => c.bucket === 'skipping').length;
    const verdict: VerdictValue = failed ? 'no_merge' : 'merge';
    const branch = typeof view.headRefName === 'string' && BRANCH.test(view.headRefName) ? view.headRefName : undefined;
    await recordVerdict(deps, { ...caller, agentId: 'tars', name: 'Tars', role: 'tars' }, { gate: 'ci', pr, head, verdict, branch, testCommand: 'gh pr checks', passed, failed, skipped });
    return { verdict };
  } catch {
    return null;
  }
}
