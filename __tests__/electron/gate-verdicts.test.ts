import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TraceStore } from '../../electron/services/trace-store';
import { TraceUploader } from '../../electron/services/trace-upload';
import { parseVerdict, recordVerdict, ciVerdicts, type VerdictDeps } from '../../electron/services/gate-verdicts';
import { registerVerdictRoutes } from '../../electron/services/api-routes/verdict-routes';

/**
 * Gate verdicts as data (trace feature B2): QA's, the Audit's or CI's MERGE or NO-MERGE on a pull request's head,
 * recorded by the agent that gates, linked to the traced turns that made that head or an ancestor of it on the pull
 * request's branch, and carried in those sessions' outcome as `gates`.
 *
 * How it fails, written before the code (27/11):
 * 1. A verdict for a head no traced turn made is refused, or links to a session anyway, or moves one.
 * 2. A head reached by several turns (a turn that made no commit leaves the head as it was), or by several sessions,
 *    links only one of them.
 * 3. Turns whose head is an ancestor of the judged one on the pull request's branch are left out; or, after a force
 *    push, turns whose head is no longer an ancestor are linked; or turns of another branch are.
 * 4. A verdict recorded twice is two records, or moves the sessions' change sequence twice; a changed verdict for the
 *    same gate, pull request and head is a second entry instead of the latest.
 * 5. A verdict recorded without an agent's own token, or naming another agent than the token's, is taken; the record
 *    does not keep who recorded it.
 * 6. gh absent, or slow, makes the record fail or hang; without it and without a branch given, ancestors are guessed.
 * 7. A verdict links to sessions of another project than the recording agent's.
 * 8. A malformed verdict (an unknown gate or verdict, a pull request that is not a number, a head that is not a hash,
 *    a negative count) is written.
 * 9. A deleted session keeps its links.
 * 10. The upload sends a gate's report path (a local path).
 * 11. CI: checks all passed are not a MERGE, one failed not a NO-MERGE; checks still running, none at all, or gh
 *     absent record something.
 * Added before its code, once the code above was written and the back office's limit read (27/11):
 * 12. A long session gated on many heads outgrows what the back office takes for an outcome (16 KiB): every verdict
 *     on a head lists every turn before it, so its upload is refused whole. The turns go as ranges, and the newest
 *     gates are kept within a budget, the others counted.
 */

let home: string;
let repo: string;
let store: TraceStore;
const T = 1_800_000_000_000;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgSign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
const commit = (file: string, text: string, msg: string) => { fs.writeFileSync(path.join(repo, file), text); git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };

/** A session of `project` on `branch` whose turns ended on these heads. */
function session(traceId: string, project: string, branch: string, heads: string[], startedAt = T) {
  store.openTrace({ traceId, projectPath: project, agentId: 'worker', harness: 'qwen-code', endpointId: 'ep-000001', model: 'm', startedAt });
  const body = (v: unknown) => Buffer.from(JSON.stringify(v));
  heads.forEach((h, i) => {
    const at = startedAt + 1000 * (i + 1);
    store.ingest({
      traceId, agentId: 'worker', surface: 'openai_chat', startedAt: at, endedAt: at + 10, status: 200, contentType: 'application/json',
      requestBody: body({ model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: `turn ${i}` }], tools: [{ type: 'function', function: { name: 'bash' } }] }),
      responseBody: body({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      attempts: 1, heldMs: 0,
    });
    store.setTurnWorkspace(traceId, at, { endHead: h });
  });
  store.endTrace(traceId, startedAt + 100_000, { branch, head: heads[heads.length - 1] });
}

const gatesOf = (traceId: string) => (store.session(traceId)!.outcome?.gates ?? []) as Array<Record<string, unknown>>;
const noGh: VerdictDeps['gh'] = () => Promise.reject(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));

let c0: string; let c1: string; let c2: string; let c2b: string; let other: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-verdicts-'));
  repo = path.join(home, 'project-a');
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  c0 = commit('readme.md', 'base\n', 'c0');
  git('checkout', '-q', '-b', 'feat/x');
  c1 = commit('a.txt', 'one\n', 'c1');
  c2 = commit('a.txt', 'one\ntwo\n', 'c2');
  // The branch force-pushed: c2 rewritten as c2b, on c1.
  git('checkout', '-q', '-b', 'rewritten', c1);
  c2b = commit('a.txt', 'one\nTWO\n', 'c2 rewritten');
  git('checkout', '-q', '-b', 'feat/other', 'main');
  other = commit('b.txt', 'other\n', 'other branch');
  store = new TraceStore(path.join(home, 'traces.db'));
  session('s1', repo, 'feat/x', [c1, c2, c2]);
  session('s2', repo, 'feat/x', [c2], T + 200_000);
  session('s3', repo, 'feat/other', [other], T + 300_000);
  // On main, ended on c0: an ancestor of every head here, but not on the pull request's branch.
  session('s4', repo, 'main', [c0], T + 350_000);
  session('q1', '/elsewhere/project-q', 'feat/x', [c2], T + 400_000);
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const caller = () => ({ agentId: 'qa-agent', projectPath: repo, folder: repo });
const deps = (over: Partial<VerdictDeps> = {}): VerdictDeps => ({ store, gh: noGh, now: () => T + 1_000_000, ...over });
const v = (over: Record<string, unknown> = {}) => {
  const p = parseVerdict({ gate: 'qa', pr: 12, head: c2, verdict: 'merge', branch: 'feat/x', testCommand: 'npm test', passed: 40, failed: 0, skipped: 2, report: '/home/someone/reports/qa-12.md', ...over });
  if (!p.ok) throw new Error(p.error);
  return p.verdict;
};

describe('gate verdicts', () => {
  it('1: a verdict for a head no traced turn made is kept, links nothing, and moves no session', async () => {
    const seq = store.seqOf('s1');
    const r = await recordVerdict(deps(), caller(), v({ head: 'f'.repeat(40) }));
    expect(r.recorded).toBe(true);
    expect(r.linked).toEqual([]);
    expect(store.seqOf('s1')).toBe(seq);
    expect(gatesOf('s1')).toEqual([]);
  });

  it('2 and 3: every turn on the head, in every session of the project, and the ancestors on the branch', async () => {
    const seq = store.seqOf('s1')!;
    const r = await recordVerdict(deps(), caller(), v());
    expect(r.linked.map(l => `${l.traceId}:${l.turnIndex}`).sort()).toEqual(['s1:0', 's1:1', 's1:2', 's2:0']);
    expect(gatesOf('s1')).toEqual([{ kind: 'qa', verdict: 'merge', at: T + 1_000_000, pr: 12, head: c2, turns: [[0, 2]], by: 'qa-agent', testCommand: 'npm test', passed: 40, failed: 0, skipped: 2, report: '/home/someone/reports/qa-12.md' }]);
    expect(store.seqOf('s1')!).toBeGreaterThan(seq);
    expect(gatesOf('s3'), 'another branch').toEqual([]);
    expect(gatesOf('s4'), 'an ancestor on another branch').toEqual([]);
  });

  it('3: after a force push, the old head\'s turns are not linked, the common ancestor\'s are', async () => {
    const r = await recordVerdict(deps(), caller(), v({ head: c2b, branch: 'feat/x' }));
    expect(r.linked.map(l => `${l.traceId}:${l.turnIndex}`)).toEqual(['s1:0']);
  });

  it('4: recorded twice is one record; a changed verdict replaces it; the sequence moves only on a change', async () => {
    await recordVerdict(deps(), caller(), v());
    const seq = store.seqOf('s1');
    const again = await recordVerdict(deps(), caller(), v());
    expect(again.changed).toBe(false);
    expect(store.seqOf('s1')).toBe(seq);
    expect(gatesOf('s1')).toHaveLength(1);
    const changed = await recordVerdict(deps({ now: () => T + 2_000_000 }), caller(), v({ verdict: 'no_merge', failed: 3 }));
    expect(changed.changed).toBe(true);
    expect(gatesOf('s1')).toHaveLength(1);
    expect(gatesOf('s1')[0]).toMatchObject({ verdict: 'no_merge', failed: 3, at: T + 2_000_000 });
    expect(store.seqOf('s1')!).toBeGreaterThan(seq!);
    // Another gate on the same head is a gate of its own.
    await recordVerdict(deps(), { ...caller(), agentId: 'audit-agent' }, v({ gate: 'audit' }));
    expect(gatesOf('s1').map(g => `${g.kind}:${g.verdict}:${g.by}`).sort()).toEqual(['audit:merge:audit-agent', 'qa:no_merge:qa-agent']);
  });

  it('5: the route takes an agent\'s own token only, never a claimed name, and keeps who recorded', async () => {
    const recorded: unknown[] = [];
    const routes: Array<{ pattern: unknown; handler: (req: unknown, send: (d: unknown, s?: number) => void) => Promise<void> }> = [];
    registerVerdictRoutes({ post: (p: unknown, h: never) => routes.push({ pattern: p, handler: h }), get: () => undefined } as never, {
      callerOf: (id) => (id === 'qa-agent' ? { agentId: id, projectPath: repo, folder: repo } : undefined),
      record: async (c, verdict) => { recorded.push({ by: c.agentId, verdict }); return { recorded: true, changed: true, linked: [] }; },
    });
    const route = routes.find(r => r.pattern === '/api/verdicts')!;
    const call = async (req: Record<string, unknown>) => {
      let out: { data: unknown; status: number } = { data: null, status: 0 };
      await route.handler({ body: {}, ...req }, (data, status = 200) => { out = { data, status }; });
      return out;
    };
    const body = { gate: 'qa', pr: 12, head: c2, verdict: 'merge' };
    expect((await call({ body })).status, 'the shared token').toBe(403);
    expect((await call({ body, callerAgentId: 'qa-agent', internal: false })).status).toBe(200);
    expect((await call({ body: { ...body, agentId: 'audit-agent' }, callerAgentId: 'qa-agent' })).status, 'another agent named').toBe(403);
    expect((await call({ body: { ...body, by: 'audit-agent' }, callerAgentId: 'qa-agent' })).status, 'another recorder named').toBe(403);
    expect((await call({ body: { ...body, pr: 'twelve' }, callerAgentId: 'qa-agent' })).status, 'malformed').toBe(400);
    expect(recorded).toEqual([{ by: 'qa-agent', verdict: expect.objectContaining({ gate: 'qa', pr: 12, head: c2, verdict: 'merge' }) }]);
  });

  it('6: gh absent or slow: recorded at once, by the exact head alone when no branch is given', async () => {
    const r = await recordVerdict(deps(), caller(), v({ branch: undefined }));
    expect(r.linked.map(l => `${l.traceId}:${l.turnIndex}`).sort()).toEqual(['s1:1', 's1:2', 's2:0']);
    const slow: VerdictDeps['gh'] = () => new Promise(() => undefined);
    const at = Date.now();
    const s = await recordVerdict(deps({ gh: slow, ghTimeoutMs: 200, now: () => T + 3_000_000 }), caller(), v({ branch: undefined, gate: 'audit' }));
    expect(Date.now() - at).toBeLessThan(5_000);
    expect(s.recorded).toBe(true);
    // gh answering with the branch: the ancestors on it come in.
    const fast: VerdictDeps['gh'] = async (args) => (args.includes('view') ? JSON.stringify({ headRefName: 'feat/x' }) : '[]');
    const f = await recordVerdict(deps({ gh: fast }), caller(), v({ branch: undefined, gate: 'ci' }));
    expect(f.linked.map(l => `${l.traceId}:${l.turnIndex}`).sort()).toEqual(['s1:0', 's1:1', 's1:2', 's2:0']);
  });

  it('7: never a session of another project', async () => {
    await recordVerdict(deps(), caller(), v());
    expect(gatesOf('q1')).toEqual([]);
  });

  it('8: a malformed verdict is refused with its reason', () => {
    for (const bad of [{ gate: 'lint' }, { verdict: 'maybe' }, { pr: 'twelve' }, { pr: -1 }, { head: 'not-a-hash' }, { passed: -2 }, { failed: 1.5 }, { testCommand: 'x'.repeat(2000) }]) {
      const p = parseVerdict({ gate: 'qa', pr: 12, head: c2, verdict: 'merge', ...bad });
      expect(p.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseVerdict({ gate: 'audit', pr: 12, head: c2.toUpperCase(), verdict: 'no_merge' })).toMatchObject({ ok: true, verdict: { head: c2 } });
  });

  it('9: a deleted session takes its links with it', async () => {
    await recordVerdict(deps(), caller(), v());
    store.remove({ traceIds: ['s1'] });
    expect(store.verdictLinksOf('s1')).toEqual([]);
    expect(store.verdictLinksOf('s2').length).toBe(1);
  });

  it('10: the upload carries the gates without their report path', async () => {
    await recordVerdict(deps(), caller(), v());
    const u = new TraceUploader({
      store, installFile: path.join(home, 'private', 'traces-install.json'), settings: () => ({ url: '' }), setDeletion: () => {},
      eligible: () => true, scrubContext: () => ({ homeDirs: [os.homedir()], knownSecrets: [], envValues: [] }), withdrawConsent: () => {},
      client: { name: 'tars', version: '0', platform: process.platform },
    });
    const doc = u.preview('s1')!;
    const sessionRow = (doc.document.batches[0].body as { sessions: Array<{ outcome?: { gates?: Array<Record<string, unknown>> } }> }).sessions[0];
    expect(sessionRow.outcome?.gates?.[0]).toMatchObject({ kind: 'qa', verdict: 'merge', pr: 12, turns: [[0, 2]] });
    expect(JSON.stringify(doc.document)).not.toContain('qa-12.md');
  });

  it('11: CI from the pull request\'s checks: all passed is MERGE, one failed NO-MERGE, running, none or no gh nothing', async () => {
    const checks = (list: unknown[]): VerdictDeps['gh'] => async (args) => (args.includes('checks') ? JSON.stringify(list) : JSON.stringify({ headRefName: 'feat/x', headRefOid: c2 }));
    expect((await ciVerdicts(deps({ gh: checks([{ name: 'test', bucket: 'pass' }, { name: 'lint', bucket: 'pass' }]) }), caller(), 12))?.verdict).toBe('merge');
    expect(gatesOf('s1').find(g => g.kind === 'ci')).toMatchObject({ verdict: 'merge', by: 'tars', head: c2 });
    expect((await ciVerdicts(deps({ gh: checks([{ name: 'test', bucket: 'pass' }, { name: 'lint', bucket: 'fail' }]) }), caller(), 12))?.verdict).toBe('no_merge');
    expect(await ciVerdicts(deps({ gh: checks([{ name: 'test', bucket: 'pending' }]) }), caller(), 13)).toBeNull();
    expect(await ciVerdicts(deps({ gh: checks([]) }), caller(), 14)).toBeNull();
    expect(await ciVerdicts(deps(), caller(), 15)).toBeNull();
  });

  it('12: a long session gated on many heads keeps an outcome the back office takes: ranges, the newest gates, the rest counted', async () => {
    const heads = Array.from({ length: 400 }, (_, i) => (i < 200 ? c1 : c2));
    session('long', repo, 'feat/x', heads, T + 500_000);
    for (let pr = 1; pr <= 80; pr++) {
      await recordVerdict(deps({ now: () => T + 2_000_000 + pr }), caller(), v({ pr, head: pr % 2 ? c2 : c1, testCommand: 'npm test -- --reporter=dot', report: `/home/someone/reports/qa-${pr}.md` }));
    }
    const outcome = store.session('long')!.outcome as { gates?: Array<Record<string, unknown>>; gatesOmitted?: number };
    expect(JSON.stringify(outcome).length, 'the stored outcome').toBeLessThanOrEqual(12 * 1024);
    const kept = outcome.gates ?? [];
    expect(kept.length).toBeGreaterThan(10);
    expect(kept.length + (outcome.gatesOmitted ?? 0), 'every gate kept or counted').toBe(80);
    expect(kept.map(g => g.pr), 'the newest gates kept').toContain(80);
    expect(kept.map(g => g.pr)).not.toContain(1);
    expect(kept.find(g => g.pr === 80)!.turns, 'a head on c1 (pr 80): the first 200 turns, one range').toEqual([[0, 199]]);
    expect(kept.find(g => g.pr === 79)!.turns, 'a head on c2: every turn, c1 an ancestor').toEqual([[0, 399]]);
    const u = new TraceUploader({
      store, installFile: path.join(home, 'private', 'traces-install.json'), settings: () => ({ url: '' }), setDeletion: () => {},
      eligible: () => true, scrubContext: () => ({ homeDirs: [os.homedir()], knownSecrets: [], envValues: [] }), withdrawConsent: () => {},
      client: { name: 'tars', version: '0', platform: process.platform },
    });
    const row = (u.preview('long')!.document.batches[0].body as { sessions: Array<{ outcome?: unknown }> }).sessions[0];
    expect(Buffer.byteLength(JSON.stringify(row.outcome)), 'the uploaded outcome, under the back office\'s 16 KiB').toBeLessThanOrEqual(16 * 1024);
  }, 60_000);
});
