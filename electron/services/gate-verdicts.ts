import { execFile } from 'child_process';
import { safeGit } from '../utils/safe-git';
import { buildFullPath } from '../utils/path-builder';
import type { TraceStore } from './trace-store';

/**
 * Gate verdicts as data (trace feature B2): QA's, the Audit's or CI's MERGE or NO-MERGE on a pull request's head, so a
 * traced session's outcome carries a pass or fail that does not come from the model judging itself.
 *
 * - **Who records:** an agent, with its own token, in its own name (the route takes the name from the token, and
 *   refuses a body naming another agent), for its own project; any agent of the project may record, and the record
 *   keeps who did. Tars itself records the `ci` gate from the pull request's checks.
 * - **One per gate, pull request and head** in a project: the latest stands; the same again changes nothing.
 * - **Linked** to the turns of the recording agent's project whose end head (turn-workspace.ts) is the judged head,
 *   in any session, and to those on the pull request's branch whose end head is an ancestor of it
 *   (`merge-base --is-ancestor`, read-only, bounded). The branch is the verdict's own, else gh's (`gh pr view`,
 *   bounded); without either, the exact head alone. A force-pushed head has the old heads as non-ancestors.
 * - **Carried** in each linked session's outcome as `gates`, its change sequence moved only on a change.
 * - **gh** runs through execFile with an argv and a bound; absent, failing or slow, nothing more is linked and no CI
 *   verdict is recorded.
 * __tests__/electron/gate-verdicts.test.ts says each way this goes wrong.
 */

export type Gate = 'qa' | 'audit' | 'ci';
export type VerdictValue = 'merge' | 'no_merge';
export interface VerdictInput {
  gate: Gate; pr: number; head: string; verdict: VerdictValue; branch?: string;
  testCommand?: string; passed?: number; failed?: number; skipped?: number; report?: string;
}
export interface VerdictCaller { agentId: string; projectPath: string; folder: string }
export interface VerdictDeps {
  store: TraceStore;
  /** gh, with an argv, in a folder: its standard output. */
  gh?: (args: string[], cwd?: string) => Promise<string>;
  git?: (dir: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>;
  ghTimeoutMs?: number;
  now?: () => number;
}

const GATES: Gate[] = ['qa', 'audit', 'ci'];
const VERDICTS: VerdictValue[] = ['merge', 'no_merge'];
const HEAD = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH = /^[A-Za-z0-9._\/-]{1,200}$/;
/** At most this many distinct heads are asked about as ancestors, for one verdict. */
const MAX_ANCESTOR_CHECKS = 200;

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
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
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

function runners(deps: VerdictDeps) {
  const ghTimeout = deps.ghTimeoutMs ?? 10_000;
  const gh = deps.gh ?? defaultGh(ghTimeout);
  const git = deps.git ?? ((dir: string, args: string[], opts: { timeout: number }) => safeGit(dir, args, opts));
  return {
    gh: (args: string[], cwd?: string) => bounded(gh(args, cwd), ghTimeout),
    git,
  };
}

/** The pull request's branch, from gh; null when gh is absent, slow or says nothing. */
async function prBranch(deps: VerdictDeps, caller: VerdictCaller, pr: number): Promise<string | null> {
  try {
    const out = JSON.parse(await runners(deps).gh(['pr', 'view', String(pr), '--json', 'headRefName'], caller.folder)) as { headRefName?: unknown };
    return typeof out.headRefName === 'string' && BRANCH.test(out.headRefName) ? out.headRefName : null;
  } catch {
    return null;
  }
}

/** Records the verdict and links it; the turns linked, and whether anything changed. */
export async function recordVerdict(deps: VerdictDeps, caller: VerdictCaller, v: VerdictInput): Promise<{ recorded: true; changed: boolean; linked: Array<{ traceId: string; turnIndex: number }> }> {
  const now = (deps.now ?? Date.now)();
  const store = deps.store;
  const candidates = store.verdictCandidates(caller.projectPath);
  const linked = candidates.filter(c => c.endHead === v.head);
  const branch = v.branch ?? (await prBranch(deps, caller, v.pr));
  if (branch) {
    const onBranch = candidates.filter(c => c.branch === branch && c.endHead !== v.head);
    const heads = [...new Set(onBranch.map(c => c.endHead))].slice(0, MAX_ANCESTOR_CHECKS);
    const { git } = runners(deps);
    const ancestors = new Set<string>();
    for (const h of heads) {
      const isAncestor = await git(caller.folder, ['merge-base', '--is-ancestor', h, v.head], { timeout: 5000 }).then(() => true, () => false);
      if (isAncestor) ancestors.add(h);
    }
    linked.push(...onBranch.filter(c => ancestors.has(c.endHead)));
  }
  const changed = store.inTransaction(() => {
    const put = store.putVerdict({
      projectPath: caller.projectPath, gate: v.gate, pr: v.pr, head: v.head, verdict: v.verdict, at: now, by: caller.agentId,
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
  };
}

/**
 * CI's verdict on a pull request, from its checks (`gh pr checks --json`), recorded by Tars: all passed is MERGE, one
 * failed or cancelled NO-MERGE; checks still running, none at all, or gh absent or slow, nothing.
 */
export async function ciVerdicts(deps: VerdictDeps, caller: VerdictCaller, pr: number): Promise<{ verdict: VerdictValue } | null> {
  const { gh } = runners(deps);
  try {
    const view = JSON.parse(await gh(['pr', 'view', String(pr), '--json', 'headRefName,headRefOid'], caller.folder)) as { headRefName?: unknown; headRefOid?: unknown };
    const head = typeof view.headRefOid === 'string' ? view.headRefOid.toLowerCase() : '';
    if (!HEAD.test(head)) return null;
    const checks = JSON.parse(await gh(['pr', 'checks', String(pr), '--json', 'name,state,bucket'], caller.folder)) as Array<{ bucket?: unknown }>;
    if (!Array.isArray(checks) || checks.length === 0) return null;
    if (checks.some(c => c.bucket === 'pending')) return null;
    const failed = checks.filter(c => c.bucket === 'fail' || c.bucket === 'cancel').length;
    const passed = checks.filter(c => c.bucket === 'pass').length;
    const skipped = checks.filter(c => c.bucket === 'skipping').length;
    const verdict: VerdictValue = failed ? 'no_merge' : 'merge';
    const branch = typeof view.headRefName === 'string' && BRANCH.test(view.headRefName) ? view.headRefName : undefined;
    await recordVerdict(deps, { ...caller, agentId: 'tars' }, { gate: 'ci', pr, head, verdict, branch, testCommand: 'gh pr checks', passed, failed, skipped });
    return { verdict };
  } catch {
    return null;
  }
}
