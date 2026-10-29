import { execFile } from 'child_process';
import * as os from 'os';
import { HeavySlot, SLOTS_DEFAULT, type SlotAsk, type SlotMachine, type SlotSnapshot, type SlotTicket } from './heavy-slot';
import { readMachine, swapOutMbPer10s } from './health/machine';
import { readProcesses } from './stall-watch';
import type { AppSettings } from '../types';

/**
 * The heavy-run slot in the app (services/heavy-slot.ts holds the rules): its world read from the machine and the
 * settings, a pass every second while anything is held or waited for (the leases whose process ended go, the free
 * slots go to the queue), and a read of the machine every 30 seconds during a run for the alerts.
 *
 * Settings: `heavySlots`, the ceiling of runs at once since 2.0.6 (default 3; the machine's room decides below it,
 * services/heavy-slot.ts), `heavySlotMinDiskGb` (15), `heavySlotMinFreeMemPct` (20). The machine is read as the
 * health samples read it (health/machine.ts), with the pages swapped out per 10 s since the last reading: about 0.2 s
 * on macOS, at most every 5 seconds.
 *
 * What the window's Resources page reads (the Frontend's notes of #535), in one call (`heavySlot:status`) and in the
 * event sent on each change (`heavySlot:changed`): the settings and floors, the machine's last reading, the holders
 * with their pid and the memory and CPU of their tree (one `ps`, at most every 2 seconds; none on Windows), the
 * waiters in order with why, and the day's alerts with whom each was sent to.
 */

export interface SlotView {
  id: string;
  state: 'granted' | 'waiting';
  /** 1 for the next to be granted. */
  position?: number;
  why?: string;
  priority: SlotTicket['priority'];
  /** Asked for `gate` without being an orchestrator: given `normal`. */
  clamped?: true;
  /** What the run is: the command `tars-slot run` runs, or the label its asker gave. */
  label: string;
  agentId: string;
  agentName: string;
  project: string;
  /** The process that holds the lease. */
  pid: number;
  askedAt: string;
  grantedAt?: string;
  /** Granted inside this holder's lease. */
  nestedIn?: string;
  /** Held by the agent's CLI (heavy_slot_take): given back when its turn ends. */
  untilTurnEnds?: true;
  alerts: string[];
}

/** A holder's process and everything under it: how many, their memory (RSS) and their CPU now. */
export interface SlotTree { processes: number; memoryMb: number; cpuPct: number }

export interface SlotAlert {
  at: string;
  ticket: string;
  agentName: string;
  project: string;
  label: string;
  text: string;
  /** Whom it was sent to: the holder (its run prints it), its orchestrator (or why not), the window. */
  sentTo: string[];
}

export interface SlotStatus {
  slots: number;
  floors: { diskGb: number; memFreePct: number };
  machine: (SlotMachine & {
    at: string; memFreeMb: number | null; swapUsedMb: number | null; load1: number | null;
    /** The machine's memory, and the free memory `memFreePct` speaks of (the share of it): "6.2 GB, 26 % of 24 GB".
     *  `memFreeMb` is another figure (free and speculative pages on macOS), which the share does not count alone. */
    memTotalMb: number | null; memFreeShareMb: number | null;
  }) | null;
  holders: Array<SlotView & { tree?: SlotTree }>;
  waiting: SlotView[];
  /** Since midnight, oldest first. */
  alerts: SlotAlert[];
}

export interface SlotRuntimeDeps {
  getAppSettings: () => AppSettings;
  /** The holder's orchestrator, told as Tars: how it went ('typed', or why not). */
  tellOrchestrator: (projectPath: string, text: string, unless?: string) => Promise<string>;
  /** The holder itself, told as Tars, when its lease went back without it: its turn ended, or the owner gave it back. */
  tellAgent: (agentId: string, text: string) => Promise<string>;
  broadcast: (channel: string, payload: unknown) => void;
}

const MACHINE_EVERY_MS = 5_000;
const TREES_EVERY_MS = 2_000;
const PASS_EVERY_MS = 1_000;
const WATCH_EVERY_PASSES = 30;

let slot: HeavySlot | undefined;
let runtimeDeps: SlotRuntimeDeps | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let settings: () => AppSettings = () => ({}) as AppSettings;
let lastMachine: SlotStatus['machine'] = null;
let previousSwap: { at: number; swapUsedMb: number | null } | undefined;
let previousSwapOuts: { at: number; swapOutBytes: number | null } | undefined;
let trees: { at: number; rows: Array<{ pid: number; ppid: number; kb: number; cpu: number }> } | undefined;
const alerts: SlotAlert[] = [];

function floors(): SlotStatus['floors'] {
  const s = settings();
  return { diskGb: Number(s.heavySlotMinDiskGb ?? 15), memFreePct: Number(s.heavySlotMinFreeMemPct ?? 20) };
}

async function machineNow(): Promise<SlotMachine> {
  const now = Date.now();
  if (lastMachine && now - Date.parse(lastMachine.at) < MACHINE_EVERY_MS) return lastMachine;
  const m = await readMachine({ previous: previousSwap, now });
  const total = os.totalmem() > 0 ? Math.round(os.totalmem() / (1024 * 1024)) : null;
  previousSwap = { at: now, swapUsedMb: m.swapUsedMb };
  // MB swapped out per 10 s since the last reading: during a run the alerts read the machine every 30 s, so a
  // further run is admitted on a recent rate (health/machine.ts swapOutMbPer10s).
  const outs = swapOutMbPer10s(previousSwapOuts, { at: now, swapOutBytes: m.swapOutBytes ?? null });
  previousSwapOuts = { at: now, swapOutBytes: m.swapOutBytes ?? null };
  lastMachine = {
    at: new Date(now).toISOString(), diskFreeGb: m.diskFreeGb, memFreePct: m.memFreePct, memFreeMb: m.memFreeMb,
    memTotalMb: total, memFreeShareMb: total !== null && m.memFreePct !== null ? Math.round((m.memFreePct / 100) * total) : null,
    swapUsedMb: m.swapUsedMb, swapGrowthMbPerMin: m.swapGrowthMbPerMin, swapOutMbPer10s: outs, load1: m.load1,
  };
  return lastMachine;
}

/** pid, ppid, RSS and %CPU of every process: one `ps`, macOS and Linux; undefined on Windows or when it fails. */
function readTable(): Promise<Array<{ pid: number; ppid: number; kb: number; cpu: number }> | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined);
  return new Promise(done => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,%cpu='], { maxBuffer: 16 * 1024 * 1024, timeout: 5_000 }, (err, stdout) => {
      if (err) return done(undefined);
      const rows: Array<{ pid: number; ppid: number; kb: number; cpu: number }> = [];
      for (const line of String(stdout).split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s*$/.exec(line);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), kb: Number(m[3]), cpu: Number(m[4].replace(',', '.')) });
      }
      done(rows);
    });
  });
}

async function treeOf(pid: number): Promise<SlotTree | undefined> {
  if (!trees || Date.now() - trees.at >= TREES_EVERY_MS) {
    const rows = await readTable();
    trees = rows ? { at: Date.now(), rows } : undefined;
  }
  if (!trees) return undefined;
  const inside = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of trees.rows) if (!inside.has(r.pid) && inside.has(r.ppid)) { inside.add(r.pid); grew = true; }
  }
  const mine = trees.rows.filter(r => inside.has(r.pid));
  if (mine.length === 0) return undefined;
  const tenth = (n: number) => Math.round(n * 10) / 10;
  return { processes: mine.length, memoryMb: tenth(mine.reduce((s, r) => s + r.kb, 0) / 1024), cpuPct: tenth(mine.reduce((s, r) => s + r.cpu, 0)) };
}

function view(t: SlotTicket, snap: SlotSnapshot): SlotView {
  const position = t.grantedAt === undefined ? snap.waiting.findIndex(w => w.id === t.id) + 1 : undefined;
  return {
    id: t.id, state: t.grantedAt === undefined ? 'waiting' : 'granted', ...(position ? { position } : {}),
    ...(t.why ? { why: t.why } : {}), priority: t.priority, ...(t.clamped ? { clamped: true as const } : {}),
    label: t.label, agentId: t.agentId, agentName: t.agentName, project: t.project, pid: t.pid,
    askedAt: new Date(t.askedAt).toISOString(), ...(t.grantedAt !== undefined ? { grantedAt: new Date(t.grantedAt).toISOString() } : {}),
    ...(t.nestedIn ? { nestedIn: t.nestedIn } : {}), ...(t.untilTurnEnds ? { untilTurnEnds: true as const } : {}), alerts: [...t.alerts],
  };
}

/** The day's alerts: those since local midnight. */
function todaysAlerts(): SlotAlert[] {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  while (alerts.length && Date.parse(alerts[0].at) < midnight.getTime()) alerts.shift();
  return [...alerts];
}

export async function slotStatus(): Promise<SlotStatus> {
  if (!lastMachine) await machineNow().catch(() => undefined);
  if (!slot) return { slots: SLOTS_DEFAULT, floors: floors(), machine: lastMachine, holders: [], waiting: [], alerts: todaysAlerts() };
  const snap = slot.snapshot();
  const holders = await Promise.all(snap.holders.map(async t => {
    const tree = await treeOf(t.pid).catch(() => undefined);
    return { ...view(t, snap), ...(tree ? { tree } : {}) };
  }));
  return {
    slots: snap.slots, floors: floors(), machine: lastMachine, holders,
    waiting: snap.waiting.map(t => view(t, snap)), alerts: todaysAlerts(),
  };
}

export function startHeavySlot(deps: SlotRuntimeDeps): void {
  if (slot) return;
  settings = deps.getAppSettings;
  runtimeDeps = deps;
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
  };
  const announce = () => { void slotStatus().then(s => deps.broadcast('heavySlot:changed', s)).catch(() => undefined); };
  slot = new HeavySlot({
    slots: () => Number(settings().heavySlots ?? SLOTS_DEFAULT),
    floors,
    machine: machineNow,
    processes: async () => (await readProcesses())?.map(p => ({ pid: p.pid, ppid: p.ppid })),
    alive,
    now: () => Date.now(),
    tars: () => [process.pid, process.ppid],
    changed: announce,
    alert: (ticket, text) => {
      const entry: SlotAlert = {
        at: new Date().toISOString(), ticket: ticket.id, agentName: ticket.agentName, project: ticket.project,
        label: ticket.label, text, sentTo: [`${ticket.agentName} (its run)`, 'the window'],
      };
      alerts.push(entry);
      deps.broadcast('heavySlot:alert', entry);
      deps.tellOrchestrator(ticket.projectPath, `The heavy-run slot: ${text}. Tars never stops a run by itself: ${ticket.agentName} or you decide whether it goes on.`)
        .then(delivery => { entry.sentTo.push(delivery === 'typed' ? `${ticket.project}'s orchestrator` : `${ticket.project}'s orchestrator: not told (${delivery})`); announce(); })
        .catch(() => { entry.sentTo.push(`${ticket.project}'s orchestrator: not told`); announce(); });
    },
  });
  let passes = 0;
  let running = false;
  timer = setInterval(() => {
    if (!slot?.busy() || running) return;
    running = true;
    passes++;
    const watch = passes % WATCH_EVERY_PASSES === 0;
    slot.pump().then(() => (watch ? slot?.watch() : undefined))
      .catch(err => console.warn('[heavy-slot] pass failed:', err))
      .finally(() => { running = false; });
  }, PASS_EVERY_MS);
  timer.unref?.();
}

export function stopHeavySlot(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Asked: queued, or granted at once inside its holder's lease; the pass that follows grants a free slot. */
export async function askSlot(a: SlotAsk): Promise<SlotView> {
  if (!slot) throw new Error('the heavy-run slot is not running');
  const t = await slot.ask(a);
  await slot.pump();
  return view(slot.get(t.id) ?? t, slot.snapshot());
}

export function slotTicketOf(id: string, agentId: string): SlotView | undefined {
  const t = slot?.ticketOf(id, agentId);
  return t && slot ? view(t, slot.snapshot()) : undefined;
}

export function giveSlotBack(id: string, agentId: string): boolean {
  const done = slot?.giveBack(id, agentId) ?? false;
  if (done) void slot?.pump().catch(err => console.warn('[heavy-slot] pass failed:', err));
  return done;
}

/**
 * A lease that went back without its holder giving it: told to the holder and its project's orchestrator (once when
 * they are the same agent), and kept with the day's alerts for the window, with whom it reached.
 */
function tellReturned(t: SlotTicket, why: string): void {
  const deps = runtimeDeps;
  const text = `The heavy-run slot: ${t.agentName}'s lease (${t.label}) was given back: ${why}.`;
  const entry: SlotAlert = {
    at: new Date().toISOString(), ticket: t.id, agentName: t.agentName, project: t.project, label: t.label, text, sentTo: ['the window'],
  };
  alerts.push(entry);
  deps?.broadcast('heavySlot:alert', entry);
  if (!deps) return;
  const said = (to: string) => (delivery: string) => { entry.sentTo.push(delivery === 'typed' ? to : `${to}: not told (${delivery})`); };
  const holder = `${t.agentName}`;
  void deps.tellAgent(t.agentId, `${text} Take it again with heavy_slot_take for your next heavy run, or run it under \`tars-slot run\`, whose lease is its own process.`)
    .then(said(holder), () => said(holder)('failed'))
    .then(() => deps.tellOrchestrator(t.projectPath, text, t.agentId))
    .then(delivery => { if (delivery !== 'self') said(`${t.project}'s orchestrator`)(delivery); }, () => said(`${t.project}'s orchestrator`)('failed'))
    .finally(() => void slotStatus().then(s => deps.broadcast('heavySlot:changed', s)).catch(() => undefined));
}

/** The agent's turn ended (its Stop, or idle on record): what it took with heavy_slot_take goes back, and the queue moves. */
export function slotTurnEnded(agentId: string): void {
  const ended = slot?.endTurn(agentId) ?? [];
  for (const t of ended) if (t.grantedAt !== undefined && !t.nestedIn) tellReturned(t, 'its turn ended, and a lease taken with heavy_slot_take ends with the turn');
  if (ended.length) void slot?.pump().catch(err => console.warn('[heavy-slot] pass failed:', err));
}

/** The owner, from the window: any lease or ask goes back. False when there is no such ticket. */
export function giveSlotBackForOwner(id: string): boolean {
  const t = slot?.giveBackForOwner(id);
  if (!t) return false;
  tellReturned(t, 'the owner gave it back from the window');
  void slot?.pump().catch(err => console.warn('[heavy-slot] pass failed:', err));
  return true;
}

