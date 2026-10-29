import * as fs from 'fs';
import { execFileSync } from 'child_process';

/**
 * The machine's PTY pool: how many terminals are open, out of how many it allows, and how many Tars holds (2.0.6,
 * item 1; its failures: __tests__/electron/core/pty-pool.test.ts). Read for the health samples and the Resources
 * page, and when a terminal cannot be opened, to say why.
 *
 * macOS keeps one /dev/ttysNNN node per allocated pty, a master whose slave was closed included (measured:
 * reports/pty-leak-runs/probe4.js), out of kern.tty.ptmx_max (511 by default). Linux counts them in
 * /proc/sys/kernel/pty/nr, out of /proc/sys/kernel/pty/max. Windows' ConPTY has no such pool: null.
 */
export interface PtyPool {
  inUse: number;
  max: number;
  /** The PTY masters this process holds: one per open terminal, unless some were never given back. */
  tars: number | null;
  /** The terminals Tars has open (core/pty-spawn.ts counts them), when known. */
  open?: number;
}

export interface PtyPoolIo {
  platform: NodeJS.Platform;
  listDev(): string[];
  sysctlMax(): number | null;
  readFile(file: string): string;
  ownMasters(): number | null;
}

let ptmxMax: number | null | undefined;

const majorOf = (rdev: number) => (rdev >>> 24) & 0xff;

const defaultIo: PtyPoolIo = {
  platform: process.platform,
  listDev: () => fs.readdirSync('/dev'),
  sysctlMax: () => {
    if (ptmxMax === undefined) {
      try { ptmxMax = Number(execFileSync('sysctl', ['-n', 'kern.tty.ptmx_max'], { encoding: 'utf8', timeout: 2000 }).trim()) || null; } catch { ptmxMax = null; }
    }
    return ptmxMax;
  },
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  ownMasters: () => {
    try {
      if (process.platform === 'darwin') {
        const ptmx = majorOf(fs.statSync('/dev/ptmx').rdev);
        let n = 0;
        for (const name of fs.readdirSync('/dev/fd')) {
          try { const st = fs.fstatSync(Number(name)); if (st.isCharacterDevice() && majorOf(st.rdev) === ptmx) n++; } catch { /* the listing's own */ }
        }
        return n;
      }
      if (process.platform === 'linux') {
        let n = 0;
        for (const name of fs.readdirSync('/proc/self/fd')) {
          try { const to = fs.readlinkSync(`/proc/self/fd/${name}`); if (to === '/dev/ptmx' || to === '/dev/pts/ptmx') n++; } catch { /* closed meanwhile */ }
        }
        return n;
      }
    } catch { /* unreadable: unknown */ }
    return null;
  },
};

const count = (text: string): number | null => {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** The pool as it stands, or null where there is none (Windows) or it cannot be read. */
/**
 * An E2E spec's pool limit (DOROTHY_E2E_PTY_MAX, core/pty-spawn.ts useTestPtyMax): read under DOROTHY_E2E only, as
 * DOROTHY_HEALTH_EVERY_MS is, never by a packaged build, and only as a whole count of at least 1; else null.
 */
export function ptyTestMax(env: NodeJS.ProcessEnv, packaged: boolean): number | null {
  if (packaged || env.DOROTHY_E2E !== '1') return null;
  const text = env.DOROTHY_E2E_PTY_MAX ?? '';
  return /^[1-9]\d*$/.test(text) ? Number(text) : null;
}

export function readPtyPool(io: PtyPoolIo = defaultIo): PtyPool | null {
  try {
    if (io.platform === 'darwin') {
      const max = io.sysctlMax();
      if (!max) return null;
      const inUse = io.listDev().filter(name => /^ttys\d+$/.test(name)).length;
      return { inUse, max, tars: io.ownMasters() };
    }
    if (io.platform === 'linux') {
      const inUse = count(io.readFile('/proc/sys/kernel/pty/nr'));
      const max = count(io.readFile('/proc/sys/kernel/pty/max'));
      if (inUse === null || !max) return null;
      return { inUse, max, tars: io.ownMasters() };
    }
  } catch { /* unreadable: no figure rather than a made-up one */ }
  return null;
}

/**
 * The PTYs one start opens: on macOS node-pty takes a spare master before the real one (so that it is not fd 0 to 2),
 * so a start needs two free, and with one free it fails; on Linux forkpty opens one (the Audit's M1 on #553).
 */
const perStart = (platform: NodeJS.Platform) => (platform === 'darwin' ? 2 : 1);

const stopToFree = (platform: NodeJS.Platform) => (perStart(platform) === 2
  ? ' A start on macOS needs two free: stop two agents that do not need their terminal, or close terminals in other apps.'
  : ' Stop an agent that does not need its terminal, or close terminals in other apps, to free one.');

/** How a NoTerminalLeft's words begin: what tells its reason from any other (core/no-terminal.ts clearNoTerminal). */
export const NO_TERMINAL_HEAD = 'No terminal can be opened on this machine:';

/**
 * A terminal the machine refused because its pool is full. Stopping an agent gives its terminal back; a restart of
 * Tars stops every agent and no orchestrator can do it, so it is offered only when Tars holds masters it has no
 * terminal open for, which nothing but a restart frees.
 */
export class NoTerminalLeft extends Error {
  readonly code = 'no_terminal';
  constructor(readonly pool: PtyPool, platform: NodeJS.Platform = process.platform) {
    super(withRemedy(`${NO_TERMINAL_HEAD} ${pool.inUse} of ${pool.max} are in use`, pool, stopToFree(platform)));
    this.name = 'NoTerminalLeft';
  }
}

/** The note the window and the orchestrators get past 80 % of the limit (ptyWarning). */
export function terminalsNearFullNote(pool: PtyPool, platform: NodeJS.Platform = process.platform): string {
  const edge = perStart(platform) === 2 ? ' With fewer than two free no agent can start on macOS:' : ` At ${pool.max} no agent can start:`;
  return withRemedy(`The machine's terminals are filling: ${pool.inUse} of ${pool.max} are in use`, pool,
    `${edge} stop the agents that do not need their terminal.`);
}

/** Whether no start can open a terminal in this pool. */
const isFull = (pool: PtyPool, platform: NodeJS.Platform) => pool.max - pool.inUse < perStart(platform);

/** What the window shows of the pool, word for word: the refusal once full, the warning past 80 %, else nothing. */
export function terminalsNotice(pool: PtyPool, platform: NodeJS.Platform = process.platform): string | null {
  if (isFull(pool, platform)) return new NoTerminalLeft(pool, platform).message;
  return pool.inUse / pool.max >= PTY_WARN_SHARE ? terminalsNearFullNote(pool, platform) : null;
}

/** A restart only for the masters Tars holds with no terminal open for them; else what stopping agents frees. */
function withRemedy(head: string, { tars, open }: PtyPool, stop: string): string {
  if (tars === null) return `${head}.${stop}`;
  if (open !== undefined && tars > open) {
    return `${head}, ${tars} of them held by Tars, which has ${open} open. The other ${tars - open} were never given back, and only a restart of Tars frees them: it stops every agent.`;
  }
  return `${head}, ${tars} of them held by Tars${open === undefined ? '' : ` for its ${open} open terminals`}.${stop}`;
}

/** Whether a refused spawn was refused by a full pool: then the pool says so, else the error stays what it was. */
export function explainSpawnFailure(err: unknown, pool: PtyPool | null, platform: NodeJS.Platform = process.platform): unknown {
  return pool && isFull(pool, platform) ? new NoTerminalLeft(pool, platform) : err;
}

/** What the local API answers for an error its routes threw. */
export function apiAnswerForError(err: unknown): { status: number; body: Record<string, string> } {
  if (err instanceof NoTerminalLeft) return { status: 503, body: { error: err.message, code: err.code } };
  return { status: 500, body: { error: 'Internal server error' } };
}

export const PTY_WARN_SHARE = 0.8;
const PTY_REARM_SHARE = 0.7;

/** One sample's step of the warning: told once past 80 % of the limit, and again only after falling under 70 %. */
export function ptyWarning(warned: boolean, pool: PtyPool | null): { warned: boolean; tell: boolean } {
  if (!pool) return { warned, tell: false };
  const share = pool.inUse / pool.max;
  if (!warned && share >= PTY_WARN_SHARE) return { warned: true, tell: true };
  if (warned && share < PTY_REARM_SHARE) return { warned: false, tell: false };
  return { warned, tell: false };
}
