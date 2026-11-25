import '../../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addHermesTaskComment, createHermesTask, deleteHermesTask, fetchHermesBoard, getHermesTask, hermesVersion, updateHermesTask,
} from '../../../electron/services/hermes-client';
import {
  TARS_TASK_MARK, claimTask, completeTask, createParkedTask, deleteTask, getTask, listTasks, moveTask, reportProgress,
  type KanbanCaller, type KanbanHermes,
} from '../../../electron/services/kanban-board';
import type { HermesConnection } from '../../../electron/types/hermes';

/**
 * Against a real Hermes: its own kanban router and its own dispatcher, ticking
 * every half second in a throwaway HERMES_HOME (__tests__/fixtures/hermes-kanban-bench.py).
 * Two agents of one project file, list, read, claim, hand to each other, report
 * on, finish, release and delete tasks through Tars's kanban code, and Hermes's dispatcher, promotion
 * and decomposer never take one of them.
 *
 * Runs where a Hermes checkout is: TARS_HERMES_TREE (a Hermes source tree, a
 * tag of it say) and TARS_HERMES_PYTHON (a python with its dependencies, the
 * venv of an install). Skipped elsewhere, the CI included. The asserted values
 * are printed on one line that starts with KANBAN-LIVE, the run's artefact.
 *
 * How this can fail, written before the code:
 * 1. a task an agent filed, claimed or released is spawned by the dispatcher, promoted,
 *    or listed for decomposition, on the version measured;
 * 2. a task passes through todo, triage, running, review or blocked, or is ready on a lane
 *    that is not Tars's, at any tick;
 * 3. one of the tools fails on that version (0.21.5 refuses done with no summary);
 * 4. a task lands without Tars's mark in its body;
 * 5. the dispatcher was not running, so "nothing taken" proved nothing: the run asserts
 *    it ticked after the last write.
 */

const TREE = process.env.TARS_HERMES_TREE;
const PYTHON = process.env.TARS_HERMES_PYTHON;
const live = !!TREE && !!PYTHON && fs.existsSync(path.join(TREE, 'hermes_cli'));

const P = '/Users/you/live-project';
const dune: KanbanCaller = { agentId: 'aaaa1111-0000-4000-8000-0000000000a1', name: 'Dune', projectPath: P };
const dove: KanbanCaller = { agentId: 'bbbb2222-0000-4000-8000-0000000000b2', name: 'Dove', projectPath: P };

let bench: ChildProcess | undefined;
let dir = '';
let tickLog = '';
let h: KanbanHermes;

interface Tick { tick: number; spawned?: string[]; triage?: string[]; promoted?: number; skipped_nonspawnable?: string[]; tasks?: Record<string, [string, string | null]>; error?: string }
const ticks = (): Tick[] => (fs.existsSync(tickLog) ? fs.readFileSync(tickLog, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe.skipIf(!live)('the kanban against a real Hermes, its dispatcher ticking', () => {
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-live-'));
    tickLog = path.join(dir, 'ticks.jsonl');
    const port = 39300 + Math.floor(Math.random() * 600);
    bench = spawn(PYTHON!, [path.join(__dirname, '../../fixtures/hermes-kanban-bench.py'), TREE!, path.join(dir, 'home'), String(port), tickLog, '0.5'],
      { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    const conn: HermesConnection = { mode: 'remote', url: `http://127.0.0.1:${port}`, authMode: 'token' };
    h = {
      board: tenant => fetchHermesBoard(conn, undefined, tenant),
      get: id => getHermesTask(conn, id),
      create: task => createHermesTask(conn, task),
      update: (id, patch) => updateHermesTask(conn, id, patch),
      remove: id => deleteHermesTask(conn, id),
      comment: (id, body) => addHermesTaskComment(conn, id, body),
      version: () => hermesVersion(conn),
    };
    for (let i = 0; i < 120 && !(await h.version!()); i++) await sleep(250);
  }, 60_000);

  afterAll(async () => {
    if (bench?.pid && bench.exitCode === null) {
      const exited = new Promise(r => bench!.once('exit', r));
      process.kill(bench.pid, 'SIGTERM');
      await exited;
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('files, claims, reports, finishes, releases and deletes, and Hermes takes none of them', async () => {
    const version = await h.version!();
    expect(version).toBeTruthy();
    const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };

    const a = ok(await createParkedTask(h, dune, { title: 'Measure the board', description: 'First.' })).id;
    const b = ok(await createParkedTask(h, dune, { title: 'Write the spec', description: 'Second.', priority: 'high' })).id;
    const c = ok(await createParkedTask(h, dove, { title: 'Tidy up', description: 'Third.' })).id;
    expect(ok(await listTasks(h, dove, {})).map(t => t.id).sort()).toEqual([a, b, c].sort());

    expect(ok(await claimTask(h, dune, a)).heldByCaller).toBe(true);
    expect(ok(await claimTask(h, dove, b)).heldByCaller).toBe(true);
    expect((await claimTask(h, dove, a)).ok).toBe(false);
    ok(await reportProgress(h, dune, a, 60));
    const detail = ok(await getTask(h, dove, a));
    expect(detail.comments.some(c => c.startsWith('Progress: 60%'))).toBe(true);
    expect(detail.description).toContain(TARS_TASK_MARK);
    ok(await completeTask(h, dune, a, ''));
    ok(await moveTask(h, dove, b, 'backlog'));
    ok(await claimTask(h, dune, b));
    ok(await completeTask(h, dune, b, 'Spec written.'));
    // Handed to another agent of the project: claimed on its lane.
    const handed = ok(await claimTask(h, dune, c, dove));
    expect(handed.heldByCaller).toBe(false);
    ok(await moveTask(h, dove, c, 'backlog'));
    ok(await deleteTask(h, dove, c));

    // Several ticks after the last write, so that "nothing taken" means something.
    const lastWrite = ticks().at(-1)?.tick ?? 0;
    for (let i = 0; i < 40 && (ticks().at(-1)?.tick ?? 0) < lastWrite + 6; i++) await sleep(250);
    const seen = ticks();
    expect(seen.at(-1)!.tick).toBeGreaterThanOrEqual(lastWrite + 6);
    // The ticks after the last write ran clean: a tick that failed on the
    // database before (0.21.5 can race its own WAL at start) proved nothing either way.
    expect(seen.filter(t => t.tick > lastWrite && t.error)).toEqual([]);

    const ours = [a, b, c];
    const taken = seen.flatMap(t => [...(t.spawned ?? []), ...(t.triage ?? [])]).filter(id => ours.includes(id));
    expect(taken).toEqual([]);
    const exposed = seen.flatMap(t => Object.entries(t.tasks ?? {})
      .filter(([id]) => ours.includes(id))
      .filter(([, [status, assignee]]) => ['todo', 'triage', 'running', 'review', 'blocked'].includes(status) || (status === 'ready' && !(assignee ?? '').startsWith('tars:')))
      .map(([id, s]) => ({ tick: t.tick, id, s })));
    expect(exposed).toEqual([]);
    expect(seen.reduce((n, t) => n + (t.promoted ?? 0), 0)).toBe(0);

    const finals: Record<string, unknown> = {};
    for (const id of [a, b]) {
      const r = await h.get(id);
      expect(r.success).toBe(true);
      const d = (r as { detail: { task: { status: string; body: string; assignee: string }; events?: Array<{ kind: string }> } }).detail;
      expect(d.task.status).toBe('done');
      expect(d.task.body).toContain(TARS_TASK_MARK);
      expect((d.events ?? []).map(e => e.kind).filter(k => ['promoted', 'claimed', 'spawned', 'decomposed'].includes(k))).toEqual([]);
      finals[id] = { status: d.task.status, assignee: d.task.assignee, events: (d.events ?? []).map(e => e.kind) };
    }
    console.log(`KANBAN-LIVE ${JSON.stringify({
      version, ticks: seen.length, lastWriteTick: lastWrite, taken, exposed, finals,
      nonspawnableSeen: [...new Set(seen.flatMap(t => t.skipped_nonspawnable ?? []))].filter(id => ours.includes(id)),
    })}`);
  }, 90_000);
});
