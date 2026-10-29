import { describe, it, expect, vi } from 'vitest';
import {
  HeavySlot, type SlotWorld, type SlotMachine,
  SETTLE_MS, SLOTS_DEFAULT, DISK_RESERVE_GB_PER_RUN, SWAPOUTS_10S_MAX, MACHINE_READ_TIMEOUT_MS,
} from '../../../electron/services/heavy-slot';

/**
 * One heavy-run slot for the whole machine (2.0.5, lot 2 item A of ressources-agents-proposition-2810.md, the
 * owner's go of 28/10): test suites, builds, dev servers, Docker and simulators of every project's agents take it in
 * turn. Each project's orchestrator had built its own lock (kotsna's mkdir, parallel's heavy-run.lock, 1212's rule
 * 198): nothing coordinated the projects, a dead agent left its lock taken, and 1212 read the free space at the start
 * only, while the swap grew during the run (a `next dev` takes 6 to 7 GB of it).
 *
 * Every way it can fail, written before the code (2026-10-28):
 *  H1. Two asks hold the slot at once (one slot), or a second ask is granted while the first holder runs.
 *  H2. The queue ignores priority (a release gate behind ordinary work, ordinary work behind background work), or
 *      ignores arrival within a priority.
 *  H3. Anyone takes the highest priority: an agent that is not an orchestrator asks for `gate` and jumps the queue.
 *      It is clamped to `normal`, and the answer says so.
 *  H4. A lease outlives its process: the holder killed or crashed, the slot stays taken (the orphan locks of the
 *      three projects). A waiter whose process died is still granted, and holds the slot for nobody.
 *  H5. A lease names a process that is not the asking agent's (pid 1, another agent's): it would never end, or end
 *      with someone else. Refused, where the process table can be read.
 *  H6. The holder deadlocks itself: a git hook inside its own run (a pre-push hook in `git push`) asks again and
 *      waits behind its own lease. An ask from under a holder's process is granted at once, inside that lease.
 *  H7. The machine is not read before a grant: granted with the disk or the memory under the floor. Or the waiter
 *      is not told why it waits (the holder, or the floor and the figure).
 *  H8. A figure the system cannot give (null: Windows's swap) blocks every grant forever.
 *  H9. During a run nothing is said as the disk fills (10, 6 and 3 GB) or the swap grows fast; or the same alert is
 *      repeated at every read.
 * H10. Tars stops a run by itself (an ansible run or a build talking to the Sparks must never be ended by anything
 *      automatic): the world gives the slot no way to end a process, and an alert changes nothing of the lease.
 * H11. A ticket is given back, or read, by another agent than the one that asked.
 * H12. The slot count is a setting: two slots grant two asks; a setting that is not a number in range is 1.
 * And from the Audit's gate of #537 (AUDIT-PR537.md), written before their code:
 * H13. (L1) Where the pid cannot be checked, a lease sits on anything: an agent with no terminal is taken at its
 *      word, and a lease on Tars's own process or one of its parents never ends. Refused, with or without a table.
 * H14. (L1) An ask rides another agent's lease: given that holder's pid (where no table can be read), it is granted
 *      at once inside it, ahead of the queue. Only a lease of the same agent nests.
 * H15. (M2) A lease taken with heavy_slot_take is held by the agent's CLI, which lives for hours: an agent that
 *      forgets to give it back holds the machine's only slot until it sleeps, an orchestrator for good, and every
 *      `tars-slot run` of every project waits. It is given back when that agent's turn ends (its Stop, or idle on
 *      record), granted or still waiting; a `tars-slot run` lease, held by its own process, is not.
 * H16. (M2) The owner cannot give a lease back from the window: any ticket is given back by the window's call, which
 *      names whose it was.
 * H17. (L2) A run's label is its command line, read by every agent and the window: a secret in it (a token, a URL's
 *      password) is shown there. Masked before it is recorded.
 * And from the orchestrator's note on #539's row (28/10):
 * H18. A waiter's reason names when the holder took the slot in UTC, while the window shows local time: it says the
 *      time in the machine's own zone, the window's.
 * And from the owner's decision of 29/10 (2.0.6): runs are admitted by the machine's room, not by a fixed count. With
 * one slot every project's runs queued behind a 3-hour run; with two fixed, two runs started together on a full
 * machine and the swap grew 3 GB a minute. Written before the code (29/10):
 * H19. A second run is admitted on a full disk: with runs holding, the disk must keep the floor plus a reserve for
 *      each of them (their swap files and artefacts live on it).
 * H20. Two runs are admitted in the same settle window: a run's boot is its spike (2 to 3 GB of swap a minute
 *      measured), so after a grant no other is admitted until the settle time has passed, the reading that admits
 *      the next one then including the last one's climb.
 * H21. A run that ends during the settle time still holds the next one back, though its climb is over.
 * H22. A reading that never comes hangs every pass, and one that throws breaks it: either is an unknown machine,
 *      which never blocks a first run (as H8) and holds back a further one, saying it waits for a reading.
 * H23. A further run is admitted while the machine swaps out (the swapouts of the last 10 s, as room-check.sh reads
 *      them).
 * H24. The ceiling is not one: a ceiling of 1 admits a second run when there is room. A setting out of range, or
 *      none, is not the default ceiling (3).
 * H25. The room decides out of order: the head of the queue (gate, then normal, then background, then arrival) is
 *      the one admitted when room comes, one a pass.
 * H26. No run can hold above the floors: with nothing holding, the floors alone decide, never the reserve, the
 *      settle time or the swapouts.
 */

type World = SlotWorld & { set: (m: Partial<SlotMachine>) => void; dead: Set<number>; t: number; alerts: Array<{ ticket: string; text: string }>; table: Array<{ pid: number; ppid: number }> | undefined };

function world(over: Partial<{ slots: number; diskGb: number; memFreePct: number }> = {}): World {
  let machine: SlotMachine = { diskFreeGb: 200, memFreePct: 60, swapGrowthMbPerMin: 0 };
  const w: World = {
    dead: new Set<number>(),
    t: 1_000_000,
    alerts: [],
    // Terminals 100 (agent a), 200 (agent b), 300 (orchestrator o); 101 is a's CLI, 102 a tars-slot run under it, 103
    // a git hook under that run; 201 b's CLI; 301 o's CLI.
    table: [
      { pid: 101, ppid: 100 }, { pid: 102, ppid: 101 }, { pid: 103, ppid: 102 }, { pid: 104, ppid: 101 },
      { pid: 201, ppid: 200 }, { pid: 202, ppid: 201 }, { pid: 301, ppid: 300 }, { pid: 302, ppid: 301 },
      // Tars (900), its parent (899) and the parent's parent (898); a's terminal is Tars's child.
      { pid: 900, ppid: 899 }, { pid: 899, ppid: 898 }, { pid: 898, ppid: 1 }, { pid: 100, ppid: 900 },
    ],
    set: (m) => { machine = { ...machine, ...m }; },
    slots: () => over.slots ?? 1,
    floors: () => ({ diskGb: over.diskGb ?? 15, memFreePct: over.memFreePct ?? 20 }),
    machine: async () => machine,
    processes: async () => w.table,
    alive: (pid) => !w.dead.has(pid),
    now: () => w.t,
    changed: () => {},
    alert: (ticket, text) => { w.alerts.push({ ticket: ticket.id, text }); },
    tars: () => [900, 899],
  };
  return w;
}

const ask = (pid: number, agentId: string, priority: 'gate' | 'normal' | 'background' = 'normal', extra: { orchestrator?: boolean; terminalPid?: number; untilTurnEnds?: boolean } = {}) => ({
  ...(extra.untilTurnEnds ? { untilTurnEnds: true } : {}),
  agentId, agentName: agentId.toUpperCase(), projectPath: `/p/${agentId}`, pid, priority, label: `${agentId}'s run`,
  orchestrator: extra.orchestrator ?? false, terminalPid: extra.terminalPid ?? (pid >= 300 ? 300 : pid >= 200 ? 200 : 100),
});

describe('the queue', () => {
  it('H1. one slot, one holder: the second ask waits, told who holds it', async () => {
    const w = world();
    const slot = new HeavySlot(w);
    const a = await slot.ask(ask(102, 'a'));
    const b = await slot.ask(ask(202, 'b'));
    await slot.pump();
    expect(slot.get(a.id)?.grantedAt).toBeDefined();
    expect(slot.get(b.id)?.grantedAt).toBeUndefined();
    expect(slot.get(b.id)?.why).toMatch(/held by A \(a's run\)/);
    expect(slot.snapshot().holders.map(t => t.id)).toEqual([a.id]);
  });

  it('H2. a release gate before ordinary work before background work, then arrival', async () => {
    const w = world();
    const slot = new HeavySlot(w);
    const holder = await slot.ask(ask(102, 'a'));
    await slot.pump();
    const bg = await slot.ask(ask(104, 'a', 'background'));
    w.t += 1;
    const first = await slot.ask(ask(202, 'b'));
    w.t += 1;
    const gate = await slot.ask(ask(302, 'o', 'gate', { orchestrator: true }));
    w.t += 1;
    const second = await slot.ask(ask(201, 'b'));
    expect(slot.snapshot().waiting.map(t => t.id)).toEqual([gate.id, first.id, second.id, bg.id]);
    const order: string[] = [];
    for (const next of [holder, gate, first, second]) {
      slot.giveBack(next.id, next.agentId);
      await slot.pump();
      order.push(slot.snapshot().holders[0]?.id ?? 'none');
    }
    expect(order).toEqual([gate.id, first.id, second.id, bg.id]);
  });

  it('H3. a worker asking for gate is clamped to normal, and told', async () => {
    const slot = new HeavySlot(world());
    const t = await slot.ask(ask(202, 'b', 'gate'));
    expect(t.priority).toBe('normal');
    expect(t.clamped).toBe(true);
    const o = await slot.ask(ask(302, 'o', 'gate', { orchestrator: true }));
    expect(o.priority).toBe('gate');
    expect(o.clamped).toBeUndefined();
  });

  it('H12. a ceiling of two lets two hold, one a settle time after the other; a setting out of range is the default', async () => {
    const w = world({ slots: 2 });
    const slot = new HeavySlot(w);
    await slot.ask(ask(102, 'a'));
    await slot.ask(ask(202, 'b'));
    await slot.ask(ask(302, 'o'));
    await slot.pump();
    expect(slot.snapshot().holders).toHaveLength(1);
    w.t += SETTLE_MS;
    await slot.pump();
    w.t += SETTLE_MS;
    await slot.pump();
    expect(slot.snapshot().holders).toHaveLength(2);
    for (const bad of [0, -1, 1.5, Number.NaN, 99]) {
      expect(new HeavySlot({ ...world(), slots: () => bad }).snapshot().slots, String(bad)).toBe(SLOTS_DEFAULT);
    }
    expect(SLOTS_DEFAULT).toBe(3);
  });
});

describe('leases held by a live process', () => {
  it('H4. a holder killed gives the slot back by itself; a dead waiter is dropped, never granted', async () => {
    const w = world();
    const slot = new HeavySlot(w);
    const a = await slot.ask(ask(102, 'a'));
    await slot.pump();
    const dead = await slot.ask(ask(104, 'a'));
    const b = await slot.ask(ask(202, 'b'));
    w.dead.add(102);
    w.dead.add(104);
    await slot.pump();
    expect(slot.get(a.id)).toBeUndefined();
    expect(slot.get(dead.id)).toBeUndefined();
    expect(slot.snapshot().holders.map(t => t.id)).toEqual([b.id]);
  });

  it('H5. refuses a lease on a process that is not under the asking agent\'s terminal', async () => {
    const slot = new HeavySlot(world());
    await expect(slot.ask({ ...ask(1, 'a'), terminalPid: 100 })).rejects.toThrow(/not under your terminal/);
    await expect(slot.ask({ ...ask(202, 'a'), terminalPid: 100 })).rejects.toThrow(/not under your terminal/);
    // No process table (Windows): the pid is taken as given, and the lease still ends with it.
    const w = world();
    w.table = undefined;
    const lax = new HeavySlot(w);
    expect((await lax.ask({ ...ask(202, 'a'), terminalPid: 100 })).pid).toBe(202);
  });

  it('H6. an ask from under the holder\'s run is granted at once, inside its lease, and takes no slot', async () => {
    const w = world();
    const slot = new HeavySlot(w);
    const run = await slot.ask(ask(102, 'a'));
    await slot.pump();
    const hook = await slot.ask(ask(103, 'a'));
    expect(hook.grantedAt).toBeDefined();
    expect(hook.nestedIn).toBe(run.id);
    expect(slot.snapshot().holders.map(t => t.id)).toEqual([run.id]);
    // The hook's lease ends with the hook; the run keeps the slot.
    w.dead.add(103);
    await slot.pump();
    expect(slot.get(hook.id)).toBeUndefined();
    expect(slot.get(run.id)?.grantedAt).toBeDefined();
  });

  it('H11. only the agent that asked reads or gives back its ticket', async () => {
    const slot = new HeavySlot(world());
    const a = await slot.ask(ask(102, 'a'));
    await slot.pump();
    expect(slot.giveBack(a.id, 'b')).toBe(false);
    expect(slot.ticketOf(a.id, 'b')).toBeUndefined();
    expect(slot.ticketOf(a.id, 'a')?.id).toBe(a.id);
    expect(slot.giveBack(a.id, 'a')).toBe(true);
    expect(slot.get(a.id)).toBeUndefined();
  });
});

describe('the machine, before a grant and during a run', () => {
  it('H7. a grant waits under the disk or memory floor, and says the floor and the figure', async () => {
    const w = world();
    const slot = new HeavySlot(w);
    w.set({ diskFreeGb: 9.4 });
    const a = await slot.ask(ask(102, 'a'));
    await slot.pump();
    expect(slot.get(a.id)?.grantedAt).toBeUndefined();
    expect(slot.get(a.id)?.why).toBe('waiting for free disk: 9.4 GB free, the floor is 15 GB');
    w.set({ diskFreeGb: 40, memFreePct: 12 });
    await slot.pump();
    expect(slot.get(a.id)?.why).toBe('waiting for free memory: 12 % free, the floor is 20 %');
    w.set({ memFreePct: 35 });
    await slot.pump();
    expect(slot.get(a.id)?.grantedAt).toBeDefined();
  });

  it('H8. a figure the system cannot give does not block', async () => {
    const w = world();
    w.set({ diskFreeGb: null, memFreePct: null, swapGrowthMbPerMin: null });
    const slot = new HeavySlot(w);
    const a = await slot.ask(ask(102, 'a'));
    await slot.pump();
    expect(slot.get(a.id)?.grantedAt).toBeDefined();
  });

  it('H9, H10. alerts at 10, 6 and 3 GB and on fast swap growth, once each; the lease stays', async () => {
    const w = world();
    const slot = new HeavySlot(w);
    const a = await slot.ask(ask(102, 'a'));
    await slot.pump();
    for (const disk of [11, 9.5, 9, 5.8, 5.5, 2.9, 2.5]) {
      w.set({ diskFreeGb: disk });
      await slot.watch();
    }
    expect(w.alerts.map(x => x.text)).toEqual([
      'free disk is down to 9.5 GB during A\'s run (a\'s run)',
      'free disk is down to 5.8 GB during A\'s run (a\'s run)',
      'free disk is down to 2.9 GB during A\'s run (a\'s run)',
    ]);
    w.alerts.length = 0;
    w.set({ swapGrowthMbPerMin: 1500 });
    await slot.watch();
    await slot.watch();
    expect(w.alerts.map(x => x.text)).toEqual(['the swap grows by 1500 MB a minute during A\'s run (a\'s run)']);
    // Five minutes on, still growing: said again.
    w.t += 5 * 60_000;
    await slot.watch();
    expect(w.alerts).toHaveLength(2);
    expect(slot.get(a.id)?.grantedAt).toBeDefined();
    expect(slot.get(a.id)?.alerts).toHaveLength(5);
    expect(Object.keys(w)).not.toContain('kill');
  });
});

describe('the Audit\'s gate of #537', () => {
  it('H13. no terminal to check against, or Tars\'s own process or a parent of it: refused, with or without a table', async () => {
    for (const table of [true, false]) {
      const w = world();
      if (!table) w.table = undefined;
      const slot = new HeavySlot(w);
      await expect(slot.ask({ ...ask(102, 'a'), terminalPid: undefined }), String(table)).rejects.toThrow(/no terminal/);
      for (const pid of [900, 899]) await expect(slot.ask({ ...ask(pid, 'a'), terminalPid: 100 })).rejects.toThrow(/Tars/);
    }
    // The parent's parent, found through the table.
    await expect(new HeavySlot(world()).ask({ ...ask(898, 'a'), terminalPid: 898 })).rejects.toThrow(/Tars/);
  });

  it('H14. only a lease of the same agent nests: another agent giving the holder\'s pid waits its turn', async () => {
    const w = world();
    w.table = undefined;
    const slot = new HeavySlot(w);
    const run = await slot.ask(ask(102, 'a'));
    await slot.pump();
    const rider = await slot.ask({ ...ask(102, 'b'), terminalPid: 200 });
    expect(rider.nestedIn).toBeUndefined();
    expect(rider.grantedAt).toBeUndefined();
    const own = await slot.ask(ask(102, 'a'));
    expect(own.nestedIn).toBe(run.id);
  });

  it('H15. a lease the tool took is given back at its agent\'s turn end, granted or waiting; a run\'s lease is not', async () => {
    const w = world({ slots: 2 });
    const slot = new HeavySlot(w);
    const tool = await slot.ask(ask(101, 'a', 'normal', { untilTurnEnds: true }));
    const run = await slot.ask(ask(102, 'a'));
    await slot.pump();
    // One a pass, and a further run once the last one settled (H20, 2.0.6).
    w.t += SETTLE_MS;
    await slot.pump();
    const waiting = await slot.ask(ask(101, 'a', 'normal', { untilTurnEnds: true }));
    const other = await slot.ask(ask(201, 'b', 'normal', { untilTurnEnds: true }));
    await slot.pump();
    expect(slot.get(other.id)?.grantedAt).toBeUndefined();
    const ended = slot.endTurn('a');
    expect(ended.map(t => t.id).sort()).toEqual([tool.id, waiting.id].sort());
    expect(slot.get(tool.id)).toBeUndefined();
    expect(slot.get(waiting.id)).toBeUndefined();
    expect(slot.get(run.id)?.grantedAt).toBeDefined();
    w.t += SETTLE_MS;
    await slot.pump();
    expect(slot.get(other.id)?.grantedAt).toBeDefined();
    expect(slot.endTurn('a')).toEqual([]);
  });

  it('H16. the window gives back any lease, and is told whose it was', async () => {
    const slot = new HeavySlot(world());
    const a = await slot.ask(ask(102, 'a'));
    await slot.pump();
    expect(slot.giveBackForOwner(a.id)?.agentId).toBe('a');
    expect(slot.get(a.id)).toBeUndefined();
    expect(slot.giveBackForOwner(a.id)).toBeUndefined();
  });

  it('H17. a secret in the label is masked before it is recorded', async () => {
    const slot = new HeavySlot(world());
    const token = ['ghp_', 'B'.repeat(8), 'C'.repeat(8), 'D'.repeat(8)].join('');
    const t = await slot.ask({ ...ask(102, 'a'), label: `curl -H "Authorization: Bearer ${token}" && psql postgres://app:hunter2secret@db/x` });
    expect(t.label).not.toContain(token);
    expect(t.label).not.toContain('hunter2secret');
    expect(t.label).toMatch(/^curl -H "Authorization: Bearer /);
  });
});

describe('the reason a waiter reads', () => {
  it('H18. names the holder\'s start in the machine\'s own zone, not UTC', async () => {
    const zone = process.env.TZ;
    process.env.TZ = 'Asia/Dubai';
    try {
      const w = world();
      const slot = new HeavySlot(w);
      const a = await slot.ask(ask(102, 'a'));
      const b = await slot.ask(ask(202, 'b'));
      await slot.pump();
      const at = new Date(slot.get(a.id)!.grantedAt!);
      const local = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
      expect(slot.get(b.id)?.why).toContain(`since ${local}`);
      expect(slot.get(b.id)?.why).not.toContain('UTC');
    } finally {
      if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    }
  });
});

describe('admitted by the machine\'s room (2.0.6)', () => {
  /** One run holding (a's), granted now; the next asks wait for room. */
  async function oneHolding(over: Parameters<typeof world>[0] = {}) {
    const w = world({ slots: 3, ...over });
    const slot = new HeavySlot(w);
    const first = await slot.ask(ask(102, 'a'));
    await slot.pump();
    expect(slot.get(first.id)?.grantedAt).toBeDefined();
    return { w, slot, first };
  }

  it('H19. a further run needs the floor plus a reserve for each run holding', async () => {
    const { w, slot } = await oneHolding();
    const b = await slot.ask(ask(202, 'b'));
    w.t += SETTLE_MS;
    w.set({ diskFreeGb: 15 + DISK_RESERVE_GB_PER_RUN - 1 });
    await slot.pump();
    expect(slot.get(b.id)?.grantedAt).toBeUndefined();
    expect(slot.get(b.id)?.why).toBe(`waiting for free disk: 24 GB free, a further run needs 25 GB (the floor of 15 GB and ${DISK_RESERVE_GB_PER_RUN} GB for each of the 1 run holding)`);
    w.set({ diskFreeGb: 15 + DISK_RESERVE_GB_PER_RUN });
    await slot.pump();
    expect(slot.get(b.id)?.grantedAt).toBeDefined();
  });

  it('H20. never two in the same settle window: the next one waits for the last one\'s climb to be read', async () => {
    const { w, slot } = await oneHolding();
    const b = await slot.ask(ask(202, 'b'));
    w.t += SETTLE_MS - 1_000;
    await slot.pump();
    expect(slot.get(b.id)?.grantedAt).toBeUndefined();
    expect(slot.get(b.id)?.why).toMatch(/^waiting for the last run to settle: A's run started \d+ s ago, a further run is read for after \d+ s$/);
    w.t += 1_000;
    await slot.pump();
    expect(slot.get(b.id)?.grantedAt).toBeDefined();
  });

  it('H21. a run that ends during the settle time no longer holds the next one back', async () => {
    const { w, slot } = await oneHolding();
    const b = await slot.ask(ask(202, 'b'));
    w.t += 5_000;
    w.dead.add(102);
    await slot.pump();
    expect(slot.get(b.id)?.grantedAt).toBeDefined();
  });

  it('H22. a reading that never comes, or throws, is unknown: a first run goes, a further one waits for a reading', async () => {
    vi.useFakeTimers();
    try {
      const w = world({ slots: 3 });
      w.machine = () => new Promise(() => {});
      const slot = new HeavySlot(w);
      const a = await slot.ask(ask(102, 'a'));
      const first = slot.pump();
      await vi.advanceTimersByTimeAsync(MACHINE_READ_TIMEOUT_MS);
      await first;
      expect(slot.get(a.id)?.grantedAt).toBeDefined();
      const b = await slot.ask(ask(202, 'b'));
      w.t += SETTLE_MS;
      w.machine = async () => { throw new Error('vm_stat failed'); };
      await slot.pump();
      expect(slot.get(b.id)?.grantedAt).toBeUndefined();
      expect(slot.get(b.id)?.why).toBe('waiting for a reading of the machine: its free disk or memory could not be read');
    } finally { vi.useRealTimers(); }
  });

  it('H23. a further run waits while the machine swaps out, as room-check.sh reads it', async () => {
    const { w, slot } = await oneHolding();
    const b = await slot.ask(ask(202, 'b'));
    w.t += SETTLE_MS;
    w.set({ swapOutsPer10s: SWAPOUTS_10S_MAX + 1 });
    await slot.pump();
    expect(slot.get(b.id)?.why).toBe(`waiting for the machine to stop swapping: ${SWAPOUTS_10S_MAX + 1} pages swapped out in 10 s (at most ${SWAPOUTS_10S_MAX})`);
    w.set({ swapOutsPer10s: SWAPOUTS_10S_MAX });
    await slot.pump();
    expect(slot.get(b.id)?.grantedAt).toBeDefined();
  });

  it('H24. a ceiling of 1 never admits a second run, whatever the room', async () => {
    const w = world({ slots: 1 });
    const slot = new HeavySlot(w);
    await slot.ask(ask(102, 'a'));
    await slot.pump();
    const b = await slot.ask(ask(202, 'b'));
    w.t += 10 * SETTLE_MS;
    await slot.pump();
    expect(slot.get(b.id)?.grantedAt).toBeUndefined();
    expect(slot.get(b.id)?.why).toMatch(/^held by A \(a's run\) since \d\d:\d\d; at most 1 run at once$/);
  });

  it('H25. the head of the queue is the one admitted when room comes, one a pass', async () => {
    const { w, slot } = await oneHolding();
    const bg = await slot.ask(ask(202, 'b', 'background'));
    const gate = await slot.ask(ask(302, 'o', 'gate', { orchestrator: true }));
    w.t += SETTLE_MS;
    await slot.pump();
    expect(slot.get(gate.id)?.grantedAt).toBeDefined();
    expect(slot.get(bg.id)?.grantedAt).toBeUndefined();
  });

  it('H26. with nothing holding, the floors alone decide: not the reserve, the settle time or the swapouts', async () => {
    const w = world({ slots: 3 });
    w.set({ diskFreeGb: 16, swapOutsPer10s: 50_000 });
    const slot = new HeavySlot(w);
    const a = await slot.ask(ask(102, 'a'));
    await slot.pump();
    expect(slot.get(a.id)?.grantedAt).toBeDefined();
    w.dead.add(102);
    const b = await slot.ask(ask(202, 'b'));
    await slot.pump();
    expect(slot.get(b.id)?.grantedAt).toBeDefined();
  });
});
