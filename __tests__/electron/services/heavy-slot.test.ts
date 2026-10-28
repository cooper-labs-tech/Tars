import { describe, it, expect } from 'vitest';
import { HeavySlot, type SlotWorld, type SlotMachine } from '../../../electron/services/heavy-slot';

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

  it('H12. two slots grant two asks; a setting out of range is one slot', async () => {
    const w = world({ slots: 2 });
    const slot = new HeavySlot(w);
    await slot.ask(ask(102, 'a'));
    await slot.ask(ask(202, 'b'));
    await slot.ask(ask(302, 'o'));
    await slot.pump();
    expect(slot.snapshot().holders).toHaveLength(2);
    for (const bad of [0, -1, 1.5, Number.NaN, 99]) {
      const one = new HeavySlot({ ...world(), slots: () => bad });
      await one.ask(ask(102, 'a'));
      await one.ask(ask(202, 'b'));
      await one.pump();
      expect(one.snapshot().holders, String(bad)).toHaveLength(1);
    }
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
    const waiting = await slot.ask(ask(101, 'a', 'normal', { untilTurnEnds: true }));
    const other = await slot.ask(ask(201, 'b', 'normal', { untilTurnEnds: true }));
    await slot.pump();
    expect(slot.get(other.id)?.grantedAt).toBeUndefined();
    const ended = slot.endTurn('a');
    expect(ended.map(t => t.id).sort()).toEqual([tool.id, waiting.id].sort());
    expect(slot.get(tool.id)).toBeUndefined();
    expect(slot.get(waiting.id)).toBeUndefined();
    expect(slot.get(run.id)?.grantedAt).toBeDefined();
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
