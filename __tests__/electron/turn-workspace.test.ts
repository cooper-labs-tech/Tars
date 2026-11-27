import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TraceStore, type TraceOutcome } from '../../electron/services/trace-store';
import { safeGit } from '../../electron/utils/safe-git';
import { TraceUploader } from '../../electron/services/trace-upload';
import { sessionDocument } from '../../electron/services/trace-export';
import { turnStats, survival, WorkspaceRecorder, type PathHistory } from '../../electron/services/turn-workspace';

/**
 * What each traced turn changed in the repository, and how much of it lasted (trace feature B1): the turn's start
 * and end (HEAD and a hash of the working tree), its files and lines, and at the session's end, then again when its
 * branch merges or is deleted, the share of the lines it added that are still in the final tree.
 *
 * How it fails, written before the code (27/11):
 * 1. A turn that changed nothing gets counts other than zero, or a survival (there is nothing to survive).
 * 2. A turn's files and lines are miscounted across several files.
 * 3. Lines a later turn removes still count as surviving; a turn none of whose lines survive is not `reverted`.
 * 4. A line a later turn removes and another adds back with the same text is credited to the first.
 * 5. A file a later turn deletes still counts its lines as surviving.
 * 6. A file whose content is unknown (lost with a restart, a read that failed) makes the turn's line counts 0 instead
 *    of null; or a binary or oversized file (git counts no lines for one either) is counted in lines, or makes the
 *    other files' lines null, or is left out of the files.
 * 7. The final tree at a merge is not the default branch's: an edit there, or a file absent there, changes nothing.
 * 8. On a real repository, across commits and dirty edits, the recorder gets a turn's start or end head, its tree,
 *    its counts or its survival wrong, or the store and the session document do not show them.
 * 9. A slow snapshot that finishes after the next one swaps two boundaries.
 * 10. A session's deletion leaves its workspace rows, or the file versions kept to measure survival.
 * 11. The upload carries a path or a line of content, a field that is not a number, a flag, a hash or a basis, or an
 *     unknown value sent as 0.
 * 12. Survival written after the session ended does not move the session's change sequence, so a reader and the
 *     uploader never see it; or a recount with nothing new moves it.
 * 13. The branch's merge or deletion is not noticed, or a branch still open, or a session on the default branch, is
 *     taken for merged.
 * Added after the code, when mutant W16 of the bench survived (27/11):
 * 14. A side request (no tools, or a system prompt other than the session's) is taken at its arrival for a turn's
 *     start, and snapshots the checkout where ingest() opens no turn; or a tool's result does; or the session's first
 *     request, or a new instruction, does not.
 * Added before their code after the Audit's read at 08e5b439d (27/11):
 * 15. (M1) Sessions that can never be measured on the default branch (on it already, no branch) stay first in line,
 *     and once ten of them wait, no other session is ever measured; one still open, or unknown, is asked again at
 *     every sweep without end.
 * 16. (L1) A file a later turn renames without a change reads as the first turn reverted and the renaming turn its
 *     author.
 * 17. (L1) The same file renamed on the default branch after the merge reads as reverted there.
 * 18. (L2) A branch merged by a squash or a rebase, its local branch kept, stays 'open' for good, though its pull
 *     request is merged.
 * 19. (L3) A session that touched many files with long paths asks git for all of them in one command line, which
 *     Windows refuses past 32,767 characters: the measure is lost.
 */

const H = (versions: Array<string | null | undefined>, p = 'f.txt'): PathHistory => ({ path: p, versions });

describe('turn counts and survival', () => {
  it('1: a turn that changed nothing', () => {
    const h = [H(['a\n', 'a\nb\n', 'a\nb\n'])];
    expect(turnStats(h, 1)).toEqual({ files: 0, added: 0, removed: 0 });
    expect(survival(h, 2)[1]).toEqual({ changed: 0, survived: null, reverted: false });
  });

  it('2: files and lines across several files', () => {
    const h = [H([null, 'x\ny\nz\n'], 'a.txt'), H(['1\n2\n', '1\n3\n'], 'b.txt'), H(['same\n', 'same\n'], 'c.txt')];
    expect(turnStats(h, 0)).toEqual({ files: 2, added: 4, removed: 1 });
  });

  it('3: lines a later turn removes do not survive, and a turn left with none is reverted', () => {
    const h = [H(['', 'l1\nl2\nl3\n', 'l1\nl3\nn1\nn2\n', 'l1\nl3\n'])];
    const s = survival(h, 3);
    expect(s[0]).toEqual({ changed: 3, survived: 2, reverted: false });
    expect(s[1]).toEqual({ changed: 2, survived: 0, reverted: true });
    expect(s[2]).toEqual({ changed: 0, survived: null, reverted: false });
  });

  it('4: a line removed and added back belongs to the turn that added it back', () => {
    const h = [H(['', 'keep\nx\n', 'keep\n', 'keep\nx\n'])];
    const s = survival(h, 3);
    expect(s[0]).toEqual({ changed: 2, survived: 1, reverted: false });
    expect(s[2]).toEqual({ changed: 1, survived: 1, reverted: false });
  });

  it('5: a file a later turn deletes keeps none of its lines', () => {
    const h = [H([null, 'a\nb\n', null], 'gone.txt'), H(['k\n', 'k\nadded\n', 'k\nadded\n'], 'kept.txt')];
    expect(survival(h, 2)[0]).toEqual({ changed: 3, survived: 1, reverted: false });
  });

  it('6: unknown content is null, never 0; a binary file counts as a file and in no line', () => {
    const lost = [H(['', undefined, undefined], 'lost.txt'), H(['a\n', 'a\nb\n', 'a\nb\n'], 'small.txt')];
    expect(turnStats(lost, 0)).toEqual({ files: 2, added: null, removed: null });
    expect(survival(lost, 2)[0]).toEqual({ changed: null, survived: null, reverted: null });
    const binary = [H([{ binary: 'b0' }, { binary: 'b1' }, { binary: 'b1' }], 'img.png'), H(['a\n', 'a\nb\n', 'a\nb\n'], 'small.txt')];
    expect(turnStats(binary, 0)).toEqual({ files: 2, added: 1, removed: 0 });
    expect(survival(binary, 2)[0]).toEqual({ changed: 1, survived: 1, reverted: false });
    expect(turnStats(binary, 1)).toEqual({ files: 0, added: 0, removed: 0 });
  });

  it('16: lines followed through a rename at a boundary; the renaming turn changed none', () => {
    const h = [H([null, 'l1\nl2\n', null, null], 'a.txt'), H([null, null, 'l1\nl2\n', 'l1\nl2\nl3\n'], 'b.txt')];
    const renames = [{ index: 2, from: 'a.txt', to: 'b.txt' }];
    expect(turnStats(h, 1, renames)).toEqual({ files: 1, added: 0, removed: 0 });
    const s = survival(h, 3, undefined, renames);
    expect(s[0]).toEqual({ changed: 2, survived: 2, reverted: false });
    expect(s[1]).toEqual({ changed: 0, survived: null, reverted: false });
    expect(s[2]).toEqual({ changed: 1, survived: 1, reverted: false });
  });

  it('7: at a merge, the default branch\'s version is the final one', () => {
    const h = [H(['', 'a\nb\nc\n'], 'x.txt'), H([null, 'y1\n'], 'y.txt')];
    expect(survival(h, 1)[0]).toEqual({ changed: 4, survived: 4, reverted: false });
    const final = new Map<string, string | null | undefined>([['x.txt', 'a\nc\nd\n'], ['y.txt', null]]);
    expect(survival(h, 1, final)[0]).toEqual({ changed: 4, survived: 2, reverted: false });
  });
});

describe('the recorder', () => {
  let home: string;
  let repo: string;
  let store: TraceStore;
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgSign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text);
  const T = 1_800_000_000_000;

  /** A turn-opening request at `at`, so the store has the turn the recorder's boundary names. */
  function turnAt(traceId: string, at: number, text: string) {
    const body = (v: unknown) => Buffer.from(JSON.stringify(v));
    store.ingest({
      traceId, agentId: 'agent-1', surface: 'openai_chat', startedAt: at, endedAt: at + 50, status: 200, contentType: 'application/json',
      requestBody: body({ model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: text }], tools: [{ type: 'function', function: { name: 'bash' } }] }),
      responseBody: body({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      attempts: 1, heldMs: 0,
    });
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-ws-'));
    repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    write('readme.md', 'base\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'c0');
    git('checkout', '-q', '-b', 'feat/x');
    store = new TraceStore(path.join(home, 'traces.db'));
    store.openTrace({ traceId: 'tr-1', projectPath: repo, agentId: 'agent-1', harness: 'qwen-code', endpointId: 'ep-000001', model: 'm', startedAt: T });
  });
  afterEach(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  /**
   * Three turns: a commit of two files, a dirty edit, a turn that takes the second one's lines back. Each boundary's
   * snapshot is awaited before the turn's edits, as the model's answer comes between them in the app; what follows it
   * (the counts, the kept versions) runs on its own, in order.
   */
  async function threeTurns(rec: WorkspaceRecorder) {
    const c0 = git('rev-parse', 'HEAD');
    await rec.turnStarted('tr-1', T + 1000, repo);
    turnAt('tr-1', T + 1000, 'turn one');
    write('a.txt', 'a1\na2\na3\n');
    write('b.txt', 'b1\nb2\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');
    const c1 = git('rev-parse', 'HEAD');
    await rec.turnStarted('tr-1', T + 2000, repo);
    turnAt('tr-1', T + 2000, 'turn two');
    write('a.txt', 'a1\na3\nn1\nn2\n');
    await rec.turnStarted('tr-1', T + 3000, repo);
    turnAt('tr-1', T + 3000, 'turn three');
    write('a.txt', 'a1\na3\n');
    await rec.sessionEnded('tr-1', T + 4000, repo);
    await rec.idle('tr-1');
    store.endTrace('tr-1', T + 4000, { branch: 'feat/x', head: c1 });
    return { c0, c1 };
  }

  it('8: heads, trees, counts and survival of three turns on a real repository, in the store and the document', async () => {
    const rec = new WorkspaceRecorder({ store });
    const { c0, c1 } = await threeTurns(rec);
    const turns = store.session('tr-1')!.turns;
    expect(turns.map(t => t.workspace?.startHead)).toEqual([c0, c1, c1]);
    expect(turns.map(t => t.workspace?.endHead)).toEqual([c1, c1, c1]);
    expect(new Set(turns.map(t => t.workspace?.endTree)).size).toBe(3);
    expect(turns[0].workspace?.startTree).toMatch(/^[0-9a-f]{64}$/);
    expect(turns.map(t => [t.workspace?.files, t.workspace?.linesAdded, t.workspace?.linesRemoved])).toEqual([[2, 5, 0], [1, 2, 1], [1, 0, 2]]);
    expect(turns.map(t => [t.workspace?.changedLines, t.workspace?.survivedLines, t.workspace?.reverted, t.workspace?.survivalBasis]))
      .toEqual([[5, 4, false, 'session_end'], [2, 0, true, 'session_end'], [0, null, false, 'session_end']]);
    const doc = sessionDocument(store, 'tr-1')!;
    expect(doc.turns[0].workspace).toMatchObject({ start_head: c0, end_head: c1, files: 2, lines_added: 5, changed_lines: 5, survived_lines: 4 });
  });

  it('9: a slow snapshot does not swap two boundaries', async () => {
    let calls = 0;
    const rec = new WorkspaceRecorder({
      store,
      // The first snapshot is held 300 ms: it must still be the first boundary.
      delay: async () => { if (calls++ === 0) await new Promise(r => setTimeout(r, 300)); },
    });
    const { c0, c1 } = await threeTurns(rec);
    const turns = store.session('tr-1')!.turns;
    expect(turns[0].workspace?.startHead).toBe(c0);
    expect(turns[0].workspace?.endHead).toBe(c1);
  });

  it('10: a deleted session takes its workspace rows and kept versions with it', async () => {
    const rec = new WorkspaceRecorder({ store });
    await threeTurns(rec);
    expect(store.workspaceHistories('tr-1').length).toBeGreaterThan(0);
    store.remove({ traceIds: ['tr-1'] });
    expect(store.workspaceHistories('tr-1')).toEqual([]);
    expect(store.workspaceTurns('tr-1')).toEqual([]);
  });

  it('11: the upload carries numbers and hashes only', async () => {
    const rec = new WorkspaceRecorder({ store });
    const { c1 } = await threeTurns(rec);
    const installFile = path.join(home, 'private', 'traces-install.json');
    const u = new TraceUploader({
      store, installFile, settings: () => ({ url: '' }), setDeletion: () => {}, eligible: () => true,
      scrubContext: () => ({ homeDirs: [os.homedir()], knownSecrets: [], envValues: [] }), withdrawConsent: () => {},
      client: { name: 'tars', version: '0', platform: process.platform },
    });
    const preview = u.preview('tr-1')!;
    const sent = JSON.stringify(preview.document.batches);
    const turns = preview.document.batches.flatMap(b => (b.body as { turns: Array<Record<string, unknown>> }).turns);
    const FIELDS = ['startHead', 'endHead', 'startTree', 'endTree', 'filesChanged', 'linesAdded', 'linesRemoved', 'changedLines', 'survivedLines', 'reverted', 'survivalBasis'];
    for (const t of turns) {
      for (const k of FIELDS.filter(f => f in t)) {
        const v = t[k];
        const fits = typeof v === 'number' || typeof v === 'boolean' || /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(String(v)) || ['session_end', 'merged', 'deleted'].includes(String(v));
        expect(fits, `${k} = ${JSON.stringify(v)}: a number, a flag, a hash or a basis`).toBe(true);
      }
    }
    // What the turns changed never goes: no path, no line of content.
    for (const word of ['a.txt', 'b.txt', 'a1\\n', 'n1\\n']) expect(sent).not.toContain(word);
    expect(turns.map(t => t.endHead)).toEqual([c1, c1, c1]);
    expect(turns[0]).toMatchObject({ filesChanged: 2, linesAdded: 5, linesRemoved: 0, changedLines: 5, survivedLines: 4, reverted: false, survivalBasis: 'session_end' });
    expect(turns[2].survivedLines).toBeUndefined();
    // Unknown is left out, never sent as 0.
    expect(turns[2]).not.toHaveProperty('survivedLines');
  });

  it('12 and 13: a merge is noticed, survival measured on the default branch, and the change sequence moves once', async () => {
    const rec = new WorkspaceRecorder({ store });
    await threeTurns(rec);
    const seq = store.seqOf('tr-1')!;
    // Still open: nothing.
    expect(await rec.finalize('tr-1', repo)).toBe('open');
    expect(store.seqOf('tr-1')).toBe(seq);
    // The agent's last edit committed, merged into main, where a line of a.txt is edited after: what survives is
    // measured there.
    git('commit', '-q', '-am', 'c2');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge', 'feat/x');
    write('a.txt', 'a1 edited\na3\n');
    git('commit', '-q', '-am', 'edit on main');
    expect(await rec.finalize('tr-1', repo)).toBe('merged');
    const turns = store.session('tr-1')!.turns;
    expect(turns[0].workspace).toMatchObject({ changedLines: 5, survivedLines: 3, survivalBasis: 'merged' });
    const moved = store.seqOf('tr-1')!;
    expect(moved).toBeGreaterThan(seq);
    // Asked again with nothing new: the sequence stays.
    expect(await rec.finalize('tr-1', repo)).toBe('done');
    expect(store.seqOf('tr-1')).toBe(moved);
  });

  it('15: sessions never measurable leave the line, and one merged behind ten of them is measured at the next sweep', async () => {
    const rec = new WorkspaceRecorder({ store });
    const main = git('rev-parse', 'main');
    // Eleven ended sessions on main, all older than the one on feat/x.
    for (let i = 0; i < 11; i++) {
      const id = `tr-main-${i}`;
      store.openTrace({ traceId: id, projectPath: repo, agentId: 'agent-1', harness: 'qwen-code', endpointId: 'ep-000001', model: 'm', startedAt: T - 100_000 + i });
      store.setTurnWorkspace(id, T - 100_000 + i, {});
      store.setSurvival(id, [{ startedAt: T - 100_000 + i, changedLines: 0, survivedLines: null, reverted: false }], 'session_end', T);
      store.endTrace(id, T - 50_000 + i, { branch: 'main', head: main });
    }
    await threeTurns(rec);
    git('commit', '-q', '-am', 'c2');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge', 'feat/x');
    const dirOf = () => repo;
    await rec.finalizeDue(dirOf, 10, T + 10_000);
    await rec.finalizeDue(dirOf, 10, T + 3_610_000);
    expect(store.session('tr-1')!.turns[0].workspace?.survivalBasis).toBe('merged');
    // Nothing left in line: the sessions on main are done with, the merged one too.
    expect(store.workspaceToFinalize(10, T + 7_210_000)).toEqual([]);
  });

  it('15: a branch still open is asked again later, not at every sweep, and no more past its age', async () => {
    const rec = new WorkspaceRecorder({ store });
    await threeTurns(rec);
    expect((await rec.finalizeDue(() => repo, 10, T + 10_000)).map(r => r.result)).toEqual(['open']);
    expect(store.workspaceToFinalize(10, T + 20_000), 'asked again at once').toEqual([]);
    expect(store.workspaceToFinalize(10, T + 2 * 3_600_000).map(s => s.traceId), 'asked again later').toEqual(['tr-1']);
    expect(store.workspaceToFinalize(10, T + 15 * 86_400_000), 'past its age').toEqual([]);
  });

  it('16: a file a later turn renames without a change keeps its lines on a real repository', async () => {
    const rec = new WorkspaceRecorder({ store });
    await rec.turnStarted('tr-1', T + 1000, repo);
    turnAt('tr-1', T + 1000, 'turn one');
    write('a.txt', 'l1\nl2\nl3\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');
    await rec.turnStarted('tr-1', T + 2000, repo);
    turnAt('tr-1', T + 2000, 'turn two');
    git('mv', 'a.txt', 'b.txt');
    git('commit', '-q', '-m', 'rename');
    await rec.sessionEnded('tr-1', T + 3000, repo);
    await rec.idle('tr-1');
    const turns = store.session('tr-1')!.turns;
    expect(turns.map(t => [t.workspace?.files, t.workspace?.linesAdded, t.workspace?.linesRemoved])).toEqual([[1, 3, 0], [1, 0, 0]]);
    expect(turns.map(t => [t.workspace?.changedLines, t.workspace?.survivedLines, t.workspace?.reverted])).toEqual([[3, 3, false], [0, null, false]]);
  });

  it('17: a file renamed on the default branch after the merge keeps its lines there', async () => {
    const rec = new WorkspaceRecorder({ store });
    await threeTurns(rec);
    git('commit', '-q', '-am', 'c2');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge', 'feat/x');
    git('mv', 'a.txt', 'renamed-on-main.txt');
    git('commit', '-q', '-m', 'rename on main');
    expect(await rec.finalize('tr-1', repo)).toBe('merged');
    expect(store.session('tr-1')!.turns[0].workspace).toMatchObject({ changedLines: 5, survivedLines: 4, reverted: false, survivalBasis: 'merged' });
  });

  it('18: a squash merge, its branch kept, is merged when the pull request says so, and measured by content', async () => {
    const rec = new WorkspaceRecorder({ store });
    const { c1 } = await threeTurns(rec);
    git('commit', '-q', '-am', 'c2');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--squash', 'feat/x');
    git('commit', '-q', '-m', 'squashed');
    expect(await rec.finalize('tr-1', repo), 'no pull request known: still open').toBe('open');
    // What #675's PR watch writes into the outcome once the pull request is merged (outcome.pr).
    store.endTrace('tr-1', T + 4000, { branch: 'feat/x', head: c1, pr: { number: 7, state: 'merged', at: T + 5000 } } as TraceOutcome);
    expect(await rec.finalize('tr-1', repo)).toBe('merged');
    expect(store.session('tr-1')!.turns[0].workspace).toMatchObject({ changedLines: 5, survivedLines: 4, survivalBasis: 'merged' });
  });

  it('19: the paths go to git in command lines Windows takes (32,767 characters at most)', async () => {
    const calls: string[][] = [];
    const rec = new WorkspaceRecorder({
      store,
      git: (dir, args, opts) => {
        calls.push(args);
        if (args.join(' ').length > 32_767) return Promise.reject(Object.assign(new Error('spawn ENAMETOOLONG'), { code: 'ENAMETOOLONG' }));
        return safeGit(dir, args, opts);
      },
    });
    await rec.turnStarted('tr-1', T + 1000, repo);
    turnAt('tr-1', T + 1000, 'many files');
    for (let i = 0; i < 400; i++) {
      fs.mkdirSync(path.join(repo, 'a-folder-with-a-long-name-'.padEnd(60, 'x')), { recursive: true });
      write(path.join('a-folder-with-a-long-name-'.padEnd(60, 'x'), `a-file-with-a-long-name-${String(i).padStart(4, '0')}.txt`), `line ${i}\n`);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'many');
    await rec.sessionEnded('tr-1', T + 2000, repo);
    await rec.idle('tr-1');
    store.endTrace('tr-1', T + 2000, { branch: 'feat/x', head: git('rev-parse', 'HEAD') });
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge', 'feat/x');
    expect(await rec.finalize('tr-1', repo)).toBe('merged');
    expect(store.session('tr-1')!.turns[0].workspace).toMatchObject({ changedLines: 400, survivedLines: 400, survivalBasis: 'merged' });
    expect(calls.some(a => a[0] === 'ls-tree'), 'the paths were asked of git').toBe(true);
    expect(Math.max(...calls.map(a => a.join(' ').length))).toBeLessThanOrEqual(32_767);
  });

  it('14: a request opens a turn at its arrival by ingest()\'s own rule', () => {
    const body = (v: unknown) => Buffer.from(JSON.stringify(v));
    const TOOLS = [{ type: 'function', function: { name: 'bash' } }];
    const main = (messages: unknown[]) => body({ model: 'm', messages: [{ role: 'system', content: 's' }, ...messages], tools: TOOLS });
    expect(store.opensTurnAt('no-such-trace', 'openai_chat', main([{ role: 'user', content: 'x' }]))).toBe(false);
    // The session's first request, with tools under its system prompt: a turn.
    expect(store.opensTurnAt('tr-1', 'openai_chat', main([{ role: 'user', content: 'first' }]))).toBe(true);
    // A title call (no tools), and a memory call (another system prompt): side requests, never a turn.
    expect(store.opensTurnAt('tr-1', 'openai_chat', body({ model: 'm', messages: [{ role: 'system', content: 'Generate a title.' }, { role: 'user', content: 'first' }] }))).toBe(false);
    turnAt('tr-1', T + 1000, 'first');
    expect(store.opensTurnAt('tr-1', 'openai_chat', body({ model: 'm', messages: [{ role: 'system', content: 'Remember this.' }, { role: 'user', content: 'second' }], tools: TOOLS }))).toBe(false);
    // A tool's result continues the turn; a new instruction opens the next.
    expect(store.opensTurnAt('tr-1', 'openai_chat', main([{ role: 'user', content: 'first' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'ok' }]))).toBe(false);
    expect(store.opensTurnAt('tr-1', 'openai_chat', main([{ role: 'user', content: 'second' }]))).toBe(true);
  });

  it('13: a branch deleted unmerged is measured on the default branch; a session on the default branch is left', async () => {
    const rec = new WorkspaceRecorder({ store });
    await threeTurns(rec);
    git('commit', '-q', '-am', 'c2');
    git('checkout', '-q', 'main');
    git('branch', '-q', '-D', 'feat/x');
    expect(await rec.finalize('tr-1', repo)).toBe('deleted');
    expect(store.session('tr-1')!.turns[0].workspace).toMatchObject({ changedLines: 5, survivedLines: 0, reverted: true, survivalBasis: 'deleted' });
    store.openTrace({ traceId: 'tr-main', projectPath: repo, agentId: 'agent-1', harness: 'qwen-code', endpointId: 'ep-000001', model: 'm', startedAt: T + 10_000 });
    store.endTrace('tr-main', T + 20_000, { branch: 'main', head: git('rev-parse', 'HEAD') });
    expect(await rec.finalize('tr-main', repo)).toBe('default-branch');
  });
});
