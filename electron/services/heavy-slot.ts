import * as crypto from 'crypto';
import * as path from 'path';
import { redactSecrets } from '../utils/redact-secrets';

/**
 * One heavy-run slot for the whole machine (2.0.5, lot 2 item A of the resources plan the owner approved on 28/10):
 * the test suites, builds, dev servers, Docker and simulators of every project's agents take it in turn.
 *
 * Measured before: a `next dev` takes 6 to 7 GB of swap, the load reached 300, and each project's orchestrator built
 * its own lock (kotsna's mkdir, parallel's heavy-run.lock, 1212's rule 198), which coordinated nothing between
 * projects and stayed taken when its agent died. 1212 read the free space at the start only, while the swap grew
 * during the run.
 *
 * - A lease is held by a live process, the asking agent's (under its terminal, where the process table can be read):
 *   when that process ends, killed or crashed, the lease goes with it. No lock is left by a dead agent. An agent with
 *   no terminal is refused, and so is a lease on Tars's own process or one of its parents, on every system.
 * - A lease taken with the MCP tool is held by the agent's CLI, which lives for hours: it is given back when that
 *   agent's turn ends (the Audit's M2 on #537), so an agent that forgets cannot hold the machine's slot for good.
 *   A `tars-slot run` lease is its own process's, and ends with it. The owner gives back any lease from the window.
 * - A queue: a release gate before ordinary work before background work, then arrival. Only an orchestrator may
 *   ask for `gate` (it orders its project's merges and releases); anyone else asking for it gets `normal`, and is
 *   told.
 * - An ask from under a holder's process (a git hook inside its own run: kotsna's pre-push hook runs inside `git
 *   push`) is granted at once, inside that lease, and takes no slot: the holder never waits behind itself. Only
 *   inside a lease of the same agent: another agent is never let in ahead of the queue.
 * - The machine is read before a grant: under the disk or the memory floor, the grant waits and the waiter is told
 *   the floor and the figure. A figure the system cannot give does not block. During a run, the disk is read again:
 *   alerts at 10, 6 and 3 GB, and on fast swap growth, to the holder, its orchestrator and the window.
 * - Tars never ends a run by itself (an ansible run, a `fly ssh` or a build talking to the Sparks must never be
 *   ended by anything automatic): this slot is given no way to end a process.
 *
 * The world it lives in is passed in (heavy-slot-runtime.ts in the app, a stand-in in its tests).
 */

export type SlotPriority = 'gate' | 'normal' | 'background';
export const SLOT_PRIORITIES: readonly SlotPriority[] = ['gate', 'normal', 'background'];
const RANK: Record<SlotPriority, number> = { gate: 0, normal: 1, background: 2 };

/** The disk thresholds said during a run, in GB, and the swap growth said as fast, in MB a minute. */
export const DISK_ALERTS_GB = [10, 6, 3] as const;
export const SWAP_FAST_MB_PER_MIN = 1000;
const SWAP_ALERT_EVERY_MS = 5 * 60_000;
export const SLOTS_MAX = 8;

export interface SlotMachine {
  diskFreeGb: number | null;
  memFreePct: number | null;
  swapGrowthMbPerMin: number | null;
}

export interface SlotWorld {
  /** How many slots: a setting, 1 when it is not an integer from 1 to SLOTS_MAX. */
  slots(): number;
  floors(): { diskGb: number; memFreePct: number };
  machine(): Promise<SlotMachine>;
  /** pid and ppid of every process, or undefined where the table cannot be read (Windows). */
  processes(): Promise<Array<{ pid: number; ppid: number }> | undefined>;
  alive(pid: number): boolean;
  now(): number;
  changed(): void;
  /** Said to the holder (on its ticket, which its run reads), its orchestrator and the window. */
  alert(ticket: SlotTicket, text: string): void;
  /** Tars's own process and its parent: no lease is held on them (their parents are found in the table). */
  tars(): number[];
}

export interface SlotAsk {
  agentId: string;
  agentName: string;
  projectPath: string;
  /** The process that holds the lease: the run's own, or the CLI's for an MCP call. */
  pid: number;
  priority: SlotPriority;
  label: string;
  orchestrator: boolean;
  /** The asking agent's terminal: the lease's process must be under it, where the table can be read. */
  terminalPid?: number;
  /** Held by the agent's CLI (the MCP tool): given back when the agent's turn ends. */
  untilTurnEnds?: boolean;
}

export interface SlotTicket {
  id: string;
  agentId: string;
  agentName: string;
  project: string;
  projectPath: string;
  pid: number;
  priority: SlotPriority;
  /** Asked for `gate` without being an orchestrator: given `normal`. */
  clamped?: true;
  label: string;
  /** Held by the agent's CLI (the MCP tool): given back when the agent's turn ends. */
  untilTurnEnds?: true;
  askedAt: number;
  grantedAt?: number;
  /** Granted inside this holder's lease (an ask from under its process). */
  nestedIn?: string;
  /** Why it waits: who holds the slot, or the floor and the figure. */
  why?: string;
  /** What was said during its run, oldest first. */
  alerts: string[];
  /** The lowest disk threshold already said, and when the swap was last said. */
  diskSaid?: number;
  swapSaidAt?: number;
}

export interface SlotSnapshot { slots: number; holders: SlotTicket[]; waiting: SlotTicket[] }

function under(pid: number, ancestor: number, parentOf: Map<number, number>): boolean {
  const seen = new Set<number>();
  for (let at: number | undefined = pid; at !== undefined && at > 1 && !seen.has(at); at = parentOf.get(at)) {
    if (at === ancestor) return true;
    seen.add(at);
  }
  return false;
}

export class HeavySlot {
  private tickets = new Map<string, SlotTicket>();

  constructor(private world: SlotWorld) {}

  private slots(): number {
    const n = this.world.slots();
    return Number.isInteger(n) && n >= 1 && n <= SLOTS_MAX ? n : 1;
  }

  private holders(): SlotTicket[] {
    return [...this.tickets.values()].filter(t => t.grantedAt !== undefined && !t.nestedIn).sort((a, b) => a.grantedAt! - b.grantedAt!);
  }

  private waiting(): SlotTicket[] {
    return [...this.tickets.values()].filter(t => t.grantedAt === undefined)
      .sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.askedAt - b.askedAt);
  }

  /**
   * A ticket for this ask: granted at once inside a holder's lease when its process is under the holder's, else
   * queued (pump grants). Refused for an agent with no terminal, on Tars's own process or a parent of it, and when
   * its process is not under the asking agent's terminal (where the table can be read).
   */
  async ask(a: SlotAsk): Promise<SlotTicket> {
    if (a.terminalPid === undefined) {
      throw new Error('you have no terminal to hold the lease under: a heavy run is asked for from an agent\'s terminal');
    }
    const table = await this.world.processes();
    const parentOf = table ? new Map(table.map(r => [r.pid, r.ppid])) : undefined;
    const tars = new Set(this.world.tars());
    for (const own of [...tars]) {
      for (let at = parentOf?.get(own); at !== undefined && at > 1 && !tars.has(at); at = parentOf?.get(at)) tars.add(at);
    }
    if (tars.has(a.pid)) throw new Error(`process ${a.pid} is Tars's own, or one of its parents: a lease is held by one of your own processes`);
    if (parentOf && a.pid !== a.terminalPid && !under(a.pid, a.terminalPid, parentOf)) {
      throw new Error(`process ${a.pid} is not under your terminal: a lease is held by one of your own processes`);
    }
    const clamped = a.priority === 'gate' && !a.orchestrator;
    const ticket: SlotTicket = {
      id: crypto.randomBytes(6).toString('hex'),
      agentId: a.agentId, agentName: a.agentName, project: path.basename(a.projectPath), projectPath: a.projectPath,
      pid: a.pid, priority: clamped ? 'normal' : a.priority, ...(clamped ? { clamped: true as const } : {}),
      // Every agent and the window read it: a token or a URL's password in a command line is masked first.
      label: redactSecrets(a.label), ...(a.untilTurnEnds ? { untilTurnEnds: true as const } : {}), askedAt: this.world.now(), alerts: [],
    };
    const host = this.holders().find(h => h.agentId === a.agentId && (h.pid === a.pid || (parentOf && under(a.pid, h.pid, parentOf))));
    if (host) {
      ticket.grantedAt = this.world.now();
      ticket.nestedIn = host.id;
    }
    this.tickets.set(ticket.id, ticket);
    this.world.changed();
    return ticket;
  }

  get(id: string): SlotTicket | undefined {
    return this.tickets.get(id);
  }

  /** A ticket as its own agent reads it; another agent's is not given. */
  ticketOf(id: string, agentId: string): SlotTicket | undefined {
    const t = this.tickets.get(id);
    return t && t.agentId === agentId ? t : undefined;
  }

  /** Given back by the agent that asked; with it, every lease granted inside it. */
  giveBack(id: string, agentId: string): boolean {
    const t = this.tickets.get(id);
    if (!t || t.agentId !== agentId) return false;
    this.drop(t);
    this.world.changed();
    return true;
  }

  /** The owner, from the window: any lease or ask, with every lease inside it. The ticket, to say whose it was. */
  giveBackForOwner(id: string): SlotTicket | undefined {
    const t = this.tickets.get(id);
    if (!t) return undefined;
    this.drop(t);
    this.world.changed();
    return t;
  }

  /**
   * The agent's turn ended (its Stop, or idle on record): every lease and ask it took with the MCP tool, held by its
   * CLI, goes back. Its `tars-slot run` leases stay: their own processes hold them. Returns what went back.
   */
  endTurn(agentId: string): SlotTicket[] {
    const ended = [...this.tickets.values()].filter(t => t.agentId === agentId && t.untilTurnEnds && this.tickets.has(t.id));
    for (const t of ended) this.drop(t);
    if (ended.length) this.world.changed();
    return ended;
  }

  private drop(t: SlotTicket): void {
    this.tickets.delete(t.id);
    for (const other of [...this.tickets.values()]) if (other.nestedIn === t.id) this.tickets.delete(other.id);
  }

  /** Leases and asks whose process ended go; then the free slots go to the queue, when the machine allows. */
  async pump(): Promise<void> {
    let changed = false;
    for (const t of [...this.tickets.values()]) {
      if (this.tickets.has(t.id) && !this.world.alive(t.pid)) { this.drop(t); changed = true; }
    }
    const waiting = this.waiting();
    const holders = this.holders();
    let free = this.slots() - holders.length;
    const say = (t: SlotTicket, why: string) => { if (t.why !== why) { t.why = why; changed = true; } };
    if (waiting.length && free <= 0) {
      const held = holders.map(h => `${h.agentName} (${h.label}) since ${new Date(h.grantedAt!).toISOString().slice(11, 16)} UTC`).join(', ');
      for (const t of waiting) say(t, `held by ${held}`);
    } else if (waiting.length) {
      const m = await this.world.machine();
      const f = this.world.floors();
      const floor = m.diskFreeGb !== null && m.diskFreeGb < f.diskGb
        ? `waiting for free disk: ${m.diskFreeGb} GB free, the floor is ${f.diskGb} GB`
        : m.memFreePct !== null && m.memFreePct < f.memFreePct
          ? `waiting for free memory: ${m.memFreePct} % free, the floor is ${f.memFreePct} %`
          : undefined;
      for (const t of waiting) {
        if (floor) { say(t, floor); continue; }
        if (free > 0) {
          t.grantedAt = this.world.now();
          delete t.why;
          free--;
          changed = true;
        } else {
          say(t, `held by ${this.holders().map(h => `${h.agentName} (${h.label})`).join(', ')}`);
        }
      }
    }
    if (changed) this.world.changed();
  }

  /** During a run: the disk at 10, 6 and 3 GB, once each per lease, and fast swap growth, every five minutes at most. */
  async watch(): Promise<void> {
    const holders = this.holders();
    if (holders.length === 0) return;
    const m = await this.world.machine();
    for (const t of holders) {
      const said = (text: string) => { t.alerts.push(text); this.world.alert(t, text); };
      const run = `${t.agentName}'s run (${t.label})`;
      if (m.diskFreeGb !== null) {
        const crossed = DISK_ALERTS_GB.filter(g => m.diskFreeGb! < g && (t.diskSaid === undefined || g < t.diskSaid));
        if (crossed.length) {
          t.diskSaid = Math.min(...crossed);
          said(`free disk is down to ${m.diskFreeGb} GB during ${run}`);
        }
      }
      if (m.swapGrowthMbPerMin !== null && m.swapGrowthMbPerMin >= SWAP_FAST_MB_PER_MIN
        && (t.swapSaidAt === undefined || this.world.now() - t.swapSaidAt >= SWAP_ALERT_EVERY_MS)) {
        t.swapSaidAt = this.world.now();
        said(`the swap grows by ${m.swapGrowthMbPerMin} MB a minute during ${run}`);
      }
    }
  }

  snapshot(): SlotSnapshot {
    return { slots: this.slots(), holders: this.holders(), waiting: this.waiting() };
  }

  /** Whether anything is held or waited for: the runtime's timers run only then. */
  busy(): boolean {
    return this.tickets.size > 0;
  }
}
