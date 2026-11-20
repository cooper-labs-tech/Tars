import '../../setup/home-guard';
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TARS_LANE, laneOf, HERMES_SIGNED_OUT, TARS_TASK_MARK, MEASURED_HERMES_VERSIONS, measuredHermes,
  listTasks, getTask, createParkedTask, claimTask, reportProgress, completeTask, moveTask, deleteTask,
  migrateLocalTasks, fileParkedTask, type KanbanCaller,
} from '../../../electron/services/kanban-board';
import { FakeHermes } from '../../fixtures/fake-hermes';

/**
 * Every agent uses the kanban freely, the session never dies silently, and
 * Hermes never takes a Tars task, whatever its version (brief of 18/10).
 *
 * Measured on Hermes 0.21.5 (the version the maintainer's gateway runs, tag
 * v2026.9.24) and 0.21.1 (v2026.9.7), each with its own router and its own
 * dispatcher ticking in a throwaway HERMES_HOME
 * (~/Documents/Tars-revue-2026-09-24/dbe-kanban-free-1810/bench):
 * - both spawn `ready` and `review` rows whose assignee is a Hermes profile, and
 *   skip a `tars:` lane as skipped_nonspawnable;
 * - both promote `todo`, and the auto-decomposer takes every `triage` task;
 * - neither dispatches, promotes nor decomposes `scheduled`, on any lane;
 * - neither lets a task be created `scheduled` (the create body has no status),
 *   nor moved from `scheduled` to `done`, `blocked` or `review` (409);
 * - 0.21.5 refuses `done` with no result and no summary: "completion blocked:
 *   <id> has no result or summary evidence" (400). 0.21.1 took it.
 *
 * How this can fail, written before the code:
 * 17. the session expired (every call 401, as on 17/10): each tool passes on
 *     "Hermes refused: Unauthorized", which tells an agent nothing it can do,
 *     and differs from one tool to the next; or a task created before the
 *     refusal is reported as filed;
 * 18. a task Tars files carries nothing in its body that says it is Tars's
 *     agents', so Hermes's own assistant reading the board adopts it; or the
 *     mark pushes the "Filed by" line off the end and its filer can no longer
 *     delete it;
 * 19. mark_task_done with an empty summary fails on 0.21.5, and the task stays
 *     claimed while the agent was told nothing it can act on;
 * 20. on a Hermes whose rules were not measured, a claim leaves the task `ready`,
 *     a state whose handling there nobody knows; the only state proven safe on
 *     every measured version is `scheduled`;
 * 21. on such a Hermes, a task claimed `scheduled` can then not be finished,
 *     released or reported on, or its release goes through a Hermes lane;
 * 22. a version string that only starts like a measured one ("0.21.5.1",
 *     "0.21.10", a canary) is taken as measured; or no version at all is;
 * 18b. a task Tars files itself (fileParkedTask: the error triage's, the local board's)
 *     carries no mark, or carries it twice;
 * 21b. on such a Hermes, finishing goes through `ready` on the agent's lane;
 *     when `done` is then refused, the task is left `ready` there, the one state
 *     not proven safe on that version, and the agent is told nothing was written,
 *     or, the session lapsing between the two calls, only that Tars is signed
 *     out (the Audit's M1 on #452);
 * 23. a note Tars writes on the board beside a claim or a release ("Claimed by",
 *     "Released by") is refused, and the tool says nothing of it: the board then
 *     shows no trace of who took the task, while the agent was told all went well.
 */

const TARS = '/Users/you/tars';
const dune: KanbanCaller = { agentId: 'aaaa1111-0000-4000-8000-000000000001', name: 'Dune', projectPath: TARS };
const dove: KanbanCaller = { agentId: 'bbbb2222-0000-4000-8000-000000000002', name: 'Dove', projectPath: TARS };

let h: FakeHermes;
beforeEach(() => { h = new FakeHermes(); });

async function filed(caller = dune, title = 'Measure the Usage page') {
  const r = await createParkedTask(h, caller, { title, description: 'Where the four seconds go.' });
  if (!r.ok) throw new Error(r.error);
  return r.value.id;
}

describe('17. a session Hermes no longer accepts is said, in one sentence, by every tool', () => {
  it('answers every tool with the same sentence that says what to do', async () => {
    const id = await filed();
    h.signedOut = true;
    const answers = [
      await listTasks(h, dune, {}),
      await getTask(h, dune, id),
      await createParkedTask(h, dune, { title: 'Another', description: '' }),
      await claimTask(h, dune, id),
      await reportProgress(h, dune, id, 50),
      await completeTask(h, dune, id, 'done'),
      await moveTask(h, dune, id, 'backlog'),
      await deleteTask(h, dune, id),
    ];
    for (const a of answers) {
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.error).toBe(HERMES_SIGNED_OUT);
    }
    expect(HERMES_SIGNED_OUT).toMatch(/Settings/);
    expect(HERMES_SIGNED_OUT).toMatch(/sign in/i);
  });

  it('says a task was created and not parked when the session ends between the two', async () => {
    const realUpdate = h.update.bind(h);
    h.update = async (id, patch) => { h.signedOut = true; const r = await realUpdate(id, patch); return r; };
    const r = await createParkedTask(h, dune, { title: 'Half filed', description: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/was created but not parked/);
      expect(r.error).toContain(HERMES_SIGNED_OUT);
    }
  });
});

describe('18. every task Tars files says it is Tars\'s agents\'', () => {
  it('carries the mark in its body, on the Tars lane, with the filer line still last', async () => {
    const id = await filed();
    const t = h.tasks.get(id)!;
    expect(t.assignee).toBe(TARS_LANE);
    expect(t.body).toContain(TARS_TASK_MARK);
    expect(TARS_TASK_MARK).toMatch(/Hermes/);
    expect((t.body ?? '').trimEnd().endsWith(`(Tars agent ${dune.agentId}).`)).toBe(true);
    // The filer can still delete it, which reads that last line.
    expect((await deleteTask(h, dune, id)).ok).toBe(true);
  });

  it('marks the tasks moved from the local board too', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-free-'));
    const file = path.join(dir, 'kanban-tasks.json');
    fs.writeFileSync(file, JSON.stringify([{ id: 'l1', title: 'Old task', column: 'backlog', projectPath: TARS }]));
    const out = await migrateLocalTasks(h, file, path.join(dir, 'moved.json'));
    expect(out.moved).toBe(1);
    expect([...h.tasks.values()][0].body).toContain(TARS_TASK_MARK);
  });
});

describe('18b. a task Tars files itself carries the mark once', () => {
  it('marks what fileParkedTask files, the error triage\'s included, and never twice', async () => {
    const r = await fileParkedTask(h, { title: 'TypeError in agent-watch', body: 'Seen 3 times since 02:10.', tenant: TARS, key: 'tars-sentry:1' });
    expect(r.ok).toBe(true);
    const body = [...h.tasks.values()][0].body ?? '';
    expect(body.startsWith('Seen 3 times since 02:10.')).toBe(true);
    expect(body.split(TARS_TASK_MARK).length - 1).toBe(1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-free-'));
    const file = path.join(dir, 'kanban-tasks.json');
    fs.writeFileSync(file, JSON.stringify([{ id: 'l2', title: 'Old', column: 'backlog', projectPath: TARS }]));
    await migrateLocalTasks(h, file, path.join(dir, 'moved.json'));
    const moved = [...h.tasks.values()].find(t => t.title === 'Old')!.body ?? '';
    expect(moved.split(TARS_TASK_MARK).length - 1).toBe(1);
  });
});

describe('19. finishing with no summary still finishes, on 0.21.5', () => {
  it('writes a summary of its own when the agent gave none', async () => {
    h.requireDoneEvidence = true;
    h.hermesVersion = '0.21.5';
    const id = await filed();
    expect((await claimTask(h, dune, id)).ok).toBe(true);
    const r = await completeTask(h, dune, id, '   ');
    expect(r.ok).toBe(true);
    expect(h.tasks.get(id)!.status).toBe('done');
    expect(String(h.tasks.get(id)!.result ?? '').trim()).not.toBe('');
  });
});

describe('20. on a Hermes whose rules were not measured, a claimed task stays scheduled', () => {
  it('claims on the agent\'s lane without leaving scheduled', async () => {
    h.hermesVersion = '0.22.0';
    const id = await filed();
    const r = await claimTask(h, dune, id);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.column).toBe('ongoing'); expect(r.value.heldByCaller).toBe(true); }
    const t = h.tasks.get(id)!;
    expect(t.status).toBe('scheduled');
    expect(t.assignee).toBe(laneOf(dune.agentId));
    // Ready only at its creation, on the Tars lane: never once claimed.
    const readies = h.history.get(id)!.filter(x => x.status === 'ready');
    expect(readies).toEqual([{ status: 'ready', assignee: TARS_LANE }]);
    // A second agent is still refused: the lane is the claim.
    const second = await claimTask(h, dove, id);
    expect(second.ok).toBe(false);
  });

  it('claims ready on the agent\'s lane on a measured Hermes, as before', async () => {
    h.hermesVersion = '0.21.5';
    const id = await filed();
    expect((await claimTask(h, dune, id)).ok).toBe(true);
    expect(h.tasks.get(id)!.status).toBe('ready');
    expect(h.tasks.get(id)!.assignee).toBe(laneOf(dune.agentId));
  });

  it('takes a Hermes that names no version as unmeasured', async () => {
    h.hermesVersion = undefined;
    const id = await filed();
    expect((await claimTask(h, dune, id)).ok).toBe(true);
    expect(h.tasks.get(id)!.status).toBe('scheduled');
  });
});

describe('21. a task claimed scheduled is reported on, finished and released from there', () => {
  it('reports progress, finishes through the agent\'s lane only, and releases to the Tars lane', async () => {
    h.hermesVersion = '0.22.0';
    const a = await filed(dune, 'First');
    const b = await filed(dune, 'Second');
    expect((await claimTask(h, dune, a)).ok).toBe(true);
    expect((await claimTask(h, dune, b)).ok).toBe(true);
    expect((await reportProgress(h, dune, a, 40)).ok).toBe(true);
    expect((await completeTask(h, dune, a, 'Measured.')).ok).toBe(true);
    expect(h.tasks.get(a)!.status).toBe('done');
    const back = await moveTask(h, dune, b, 'backlog');
    expect(back.ok).toBe(true);
    expect(h.tasks.get(b)!.status).toBe('scheduled');
    expect(h.tasks.get(b)!.assignee).toBe(TARS_LANE);
    for (const id of [a, b]) {
      expect(h.exposures(id)).toEqual([]);
      expect(h.spawnable()).not.toContain(id);
      for (const x of h.history.get(id)!) expect(x.assignee ?? '').toMatch(/^tars:/);
    }
  });
});

describe('21b. a done refused after the ready it needs, on an unmeasured Hermes', () => {
  async function claimedOnUnmeasured() {
    h.hermesVersion = '0.22.0';
    const id = await filed(dune, 'Finish me');
    expect((await claimTask(h, dune, id)).ok).toBe(true);
    expect(h.tasks.get(id)!.status).toBe('scheduled');
    return id;
  }

  it('puts the task back to scheduled and says what was written', async () => {
    const id = await claimedOnUnmeasured();
    const realUpdate = h.update.bind(h);
    h.update = async (taskId, patch) => (patch.status === 'done' ? { success: false as const, error: 'completion blocked' } : realUpdate(taskId, patch));
    const r = await completeTask(h, dune, id, 'Done.');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(`Task ${id} was moved to ready on your lane, then back to scheduled`);
      expect(r.error).not.toContain('Nothing was written');
    }
    expect(h.tasks.get(id)!.status).toBe('scheduled');
    expect(h.tasks.get(id)!.assignee).toBe(laneOf(dune.agentId));
  });

  it('says the task is still ready when it cannot be put back', async () => {
    const id = await claimedOnUnmeasured();
    const realUpdate = h.update.bind(h);
    let readied = false;
    h.update = async (taskId, patch) => {
      if (patch.status === 'ready') { readied = true; return realUpdate(taskId, patch); }
      if (readied && (patch.status === 'done' || patch.status === 'scheduled')) return { success: false as const, error: 'the gateway is restarting' };
      return realUpdate(taskId, patch);
    };
    const r = await completeTask(h, dune, id, 'Done.');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('ready');
      expect(r.error).toContain('could not be put back');
      expect(r.error).not.toContain('Nothing was written');
    }
    expect(h.tasks.get(id)!.status).toBe('ready');
  });

  it('says so beside the signed-out sentence when the session lapses between the two calls', async () => {
    const id = await claimedOnUnmeasured();
    const realUpdate = h.update.bind(h);
    h.update = async (taskId, patch) => {
      const r = await realUpdate(taskId, patch);
      if (patch.status === 'ready') h.signedOut = true;
      return r;
    };
    const r = await completeTask(h, dune, id, 'Done.');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.startsWith(HERMES_SIGNED_OUT)).toBe(true);
      expect(r.error).toContain(`Task ${id} was moved to ready on your lane`);
    }
  });
});

describe('22. which versions count as measured', () => {
  it('takes the measured versions exactly, and nothing that only looks like one', () => {
    expect(MEASURED_HERMES_VERSIONS).toEqual(expect.arrayContaining(['0.21.1', '0.21.5']));
    expect(measuredHermes('0.21.1')).toBe(true);
    expect(measuredHermes('0.21.5')).toBe(true);
    expect(measuredHermes(' 0.21.5 ')).toBe(true);
    for (const v of ['0.21.5.1', '0.21.10', '0.21.51', '0.21.4', '0.21.5+canary.20260929', '0.22.0', '', undefined]) {
      expect(measuredHermes(v)).toBe(false);
    }
  });
});

describe('23. a note Tars could not write on the board is said, never pretended', () => {
  it('says the claim was made and its note was not written, and the same for a release', async () => {
    const id = await filed();
    h.refuseComments = true;
    const claimed = await claimTask(h, dune, id);
    expect(claimed.ok).toBe(true);
    if (claimed.ok) {
      expect(claimed.value.heldByCaller).toBe(true);
      expect(claimed.value.note).toMatch(/not written/);
    }
    const released = await moveTask(h, dune, id, 'backlog');
    expect(released.ok).toBe(true);
    if (released.ok) expect(released.value.note).toMatch(/not written/);
    h.refuseComments = false;
    const again = await claimTask(h, dove, id);
    expect(again.ok && again.value.note).toBeFalsy();
  });
});
