import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { appendSample, type HealthSample, type SlowCall } from './samples';
import { readAgentTrees, readMachine } from './machine';
import { ptyWarning, type PtyPool } from '../../core/pty-pool';

/**
 * The health sample Tars takes of itself every 5 minutes (2.0.3, monitoring
 * option 2): the main process's memory, its event loop delay over the window,
 * the slowest IPC handlers of the window, the agents, the page open. Written
 * to the bounded file of samples.ts, on this machine only.
 *
 * And since 2.0.5 the machine's memory, swap, disk and load, and each agent's
 * whole tree (machine.ts): about 0.2 s of commands run side by side, off the
 * event loop, never two reads at once.
 */

/** The slowest call of each channel since the last sample. */
export class SlowCalls {
  private slowest = new Map<string, number>();

  note(channel: string, ms: number): void {
    if (ms > (this.slowest.get(channel) ?? -1)) this.slowest.set(channel, ms);
  }

  /** The `n` slowest channels, slowest first, then a new window. */
  take(n = 3): SlowCall[] {
    const out = [...this.slowest].sort((a, b) => b[1] - a[1]).slice(0, n).map(([channel, ms]) => ({ channel, ms: Math.round(ms) }));
    this.slowest.clear();
    return out;
  }
}

export const slowCalls = new SlowCalls();

/**
 * The channels this process registered: what a sample may name when it
 * leaves (samples.ts, Vocabulary). The samples file is in ~/.tars, which
 * agents may write, so a word in the channel's pattern is not one of them.
 */
export class IpcChannels {
  private channels = new Set<string>();

  add(channel: string): void { this.channels.add(channel); }

  known(): ReadonlySet<string> { return this.channels; }
}

export const ipcChannels = new IpcChannels();

type Handler = (event: unknown, ...args: unknown[]) => unknown;

/**
 * Every handler registered from now on, timed where it is registered: its
 * answer and its failure pass through as they were. Called before any
 * handler is registered (main.ts, first thing).
 */
export function timeIpcHandlers(ipc: { handle: (channel: string, fn: Handler) => void }, calls = slowCalls, channels = ipcChannels): void {
  const register = ipc.handle.bind(ipc);
  ipc.handle = (channel: string, fn: Handler) => {
    channels.add(channel);
    return register(channel, async (event: unknown, ...args: unknown[]) => {
      const start = performance.now();
      try {
        return await fn(event, ...args);
      } finally {
        calls.note(channel, performance.now() - start);
      }
    });
  };
}

export interface HealthMonitorOptions {
  file: string;
  everyMs: number;
  agents: () => { total: number; running: number };
  /** The path of the page the window shows, `/usage`, or null. */
  page: () => string | null;
  /** Each agent with a terminal: its id and the terminal's pid, whose tree is weighed (machine.ts). */
  agentTerminals?: () => Array<{ id: string; pid: number }>;
  /** The machine's terminals (core/pty-spawn.ts readTerminals), read with each sample. */
  terminals?: () => PtyPool | null;
  /** Past 80 % of the machine's limit, once, and again only after it fell under 70 % (core/pty-pool.ts). */
  onTerminalsNearFull?: (pool: PtyPool) => void;
  calls?: SlowCalls;
}

const MB = 1024 * 1024;

/** Samples every `everyMs`, until stopped; the timer never holds the app open. */
export function startHealthMonitor(opts: HealthMonitorOptions): { stop(): void } {
  const calls = opts.calls ?? slowCalls;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const take = (): HealthSample => {
    const memory = process.memoryUsage();
    const { total, running } = opts.agents();
    const ms = (ns: number) => (Number.isFinite(ns) ? ns / 1e6 : 0);
    const sample: HealthSample = {
      at: Date.now(),
      heapUsedMb: memory.heapUsed / MB,
      heapTotalMb: memory.heapTotal / MB,
      rssMb: memory.rss / MB,
      loopP50Ms: ms(loop.percentile(50)),
      loopP95Ms: ms(loop.percentile(95)),
      slowest: calls.take(3),
      agents: total,
      running,
      page: opts.page(),
    };
    loop.reset();
    if (opts.terminals) {
      const pool = opts.terminals();
      sample.terminals = pool;
      const step = ptyWarning(terminalsWarned, pool);
      terminalsWarned = step.warned;
      if (step.tell && pool) opts.onTerminalsNearFull?.(pool);
    }
    return sample;
  };
  let terminalsWarned = false;
  // The previous sample's swap, for its growth per minute; and one read at a time, on a machine so loaded that a
  // read outlasts the period (a test's 200 ms).
  let previous: { at: number; swapUsedMb: number | null } | undefined;
  let reading = false;
  const timer = setInterval(() => {
    if (reading) return;
    let sample: HealthSample;
    try {
      sample = take();
    } catch (err) {
      console.warn('[health] a sample failed:', (err as Error).message);
      return;
    }
    reading = true;
    Promise.all([
      readMachine({ previous, now: sample.at }),
      opts.agentTerminals ? readAgentTrees(opts.agentTerminals()) : Promise.resolve(undefined),
    ]).then(([machine, agentTrees]) => {
      previous = { at: sample.at, swapUsedMb: machine.swapUsedMb };
      appendSample(opts.file, { ...sample, machine, ...(agentTrees !== undefined ? { agentTrees } : {}) });
    }).catch((err) => {
      console.warn('[health] the machine could not be read, the sample is kept without it:', (err as Error).message);
      appendSample(opts.file, sample);
    }).finally(() => { reading = false; });
  }, opts.everyMs);
  timer.unref?.();
  return { stop: () => { clearInterval(timer); loop.disable(); } };
}

/** The window's URL as a page path: `app://-/usage/index.html` and `http://localhost:3100/usage/` are `/usage`. */
export function pageOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const path = new URL(url).pathname.replace(/\/index\.html$/, '').replace(/\/+$/, '').toLowerCase();
    return path === '' ? '/' : path;
  } catch {
    return null;
  }
}
