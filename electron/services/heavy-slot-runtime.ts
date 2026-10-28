import { HeavySlot, type SlotAsk, type SlotMachine, type SlotSnapshot, type SlotTicket } from './heavy-slot';
import { readMachine } from './health/machine';
import { readProcesses } from './stall-watch';
import type { AppSettings } from '../types';

/**
 * The heavy-run slot in the app (services/heavy-slot.ts holds the rules): its world read from the machine and the
 * settings, a pass every second while anything is held or waited for (the leases whose process ended go, the free
 * slots go to the queue), and a read of the machine every 30 seconds during a run for the alerts.
 *
 * Settings: `heavySlots` (default 1), `heavySlotMinDiskGb` (15), `heavySlotMinFreeMemPct` (20). The machine is read
 * as the health samples read it (health/machine.ts): about 0.2 s on macOS, at most every 5 seconds while a grant
 * waits on it.
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
  label: string;
  agentId: string;
  agentName: string;
  project: string;
  askedAt: string;
  grantedAt?: string;
  /** Granted inside this holder's lease. */
  nestedIn?: string;
  alerts: string[];
}

export interface SlotStatus { slots: number; holders: SlotView[]; waiting: SlotView[] }

export interface SlotRuntimeDeps {
  getAppSettings: () => AppSettings;
  /** The holder's orchestrator, told as Tars (api-routes/kanban-routes.ts, tellOrchestratorAsTars). */
  tellOrchestrator: (projectPath: string, text: string) => void;
  broadcast: (channel: string, payload: unknown) => void;
}

const MACHINE_EVERY_MS = 5_000;
const PASS_EVERY_MS = 1_000;
const WATCH_EVERY_PASSES = 30;

let slot: HeavySlot | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function view(t: SlotTicket, snap: SlotSnapshot): SlotView {
  const position = t.grantedAt === undefined ? snap.waiting.findIndex(w => w.id === t.id) + 1 : undefined;
  return {
    id: t.id, state: t.grantedAt === undefined ? 'waiting' : 'granted', ...(position ? { position } : {}),
    ...(t.why ? { why: t.why } : {}), priority: t.priority, ...(t.clamped ? { clamped: true as const } : {}),
    label: t.label, agentId: t.agentId, agentName: t.agentName, project: t.project,
    askedAt: new Date(t.askedAt).toISOString(), ...(t.grantedAt !== undefined ? { grantedAt: new Date(t.grantedAt).toISOString() } : {}),
    ...(t.nestedIn ? { nestedIn: t.nestedIn } : {}), alerts: [...t.alerts],
  };
}

export function slotStatus(): SlotStatus {
  if (!slot) return { slots: 1, holders: [], waiting: [] };
  const snap = slot.snapshot();
  return { slots: snap.slots, holders: snap.holders.map(t => view(t, snap)), waiting: snap.waiting.map(t => view(t, snap)) };
}

export function startHeavySlot(deps: SlotRuntimeDeps): void {
  if (slot) return;
  let machine: { at: number; value: SlotMachine } | undefined;
  let previous: { at: number; swapUsedMb: number | null } | undefined;
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
  };
  slot = new HeavySlot({
    slots: () => Number(deps.getAppSettings().heavySlots ?? 1),
    floors: () => {
      const s = deps.getAppSettings();
      return { diskGb: Number(s.heavySlotMinDiskGb ?? 15), memFreePct: Number(s.heavySlotMinFreeMemPct ?? 20) };
    },
    machine: async () => {
      const now = Date.now();
      if (machine && now - machine.at < MACHINE_EVERY_MS) return machine.value;
      const m = await readMachine({ previous, now });
      previous = { at: now, swapUsedMb: m.swapUsedMb };
      machine = { at: now, value: { diskFreeGb: m.diskFreeGb, memFreePct: m.memFreePct, swapGrowthMbPerMin: m.swapGrowthMbPerMin } };
      return machine.value;
    },
    processes: async () => (await readProcesses())?.map(p => ({ pid: p.pid, ppid: p.ppid })),
    alive,
    now: () => Date.now(),
    changed: () => deps.broadcast('heavySlot:changed', slotStatus()),
    alert: (ticket, text) => {
      deps.broadcast('heavySlot:alert', { ticket: ticket.id, agentName: ticket.agentName, project: ticket.project, text });
      deps.tellOrchestrator(ticket.projectPath, `The heavy-run slot: ${text}. Tars never stops a run by itself: ${ticket.agentName} or you decide whether it goes on.`);
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
