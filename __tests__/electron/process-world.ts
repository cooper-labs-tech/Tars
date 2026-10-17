/**
 * A process table and the signals its processes get, in memory, for the tests of how Tars ends a tree of processes
 * (acp-tree-late-child.test.ts, terminal-tree-late-child.test.ts). Each read prints the table as
 * `ps -A -o pid=,ppid=,pgid=,stat=,etime=` does, then runs what was scheduled for after that read: a process started
 * while ps ran, after its snapshot. So a race is the same at every run and on every host.
 *
 * What a signal does, as the kernel does it: SIGKILL ends a process, stopped or not; SIGSTOP stops it; SIGCONT lets it
 * go on, and it then takes what it was sent meanwhile; SIGTERM and SIGHUP end it unless it ignores them, and a shell
 * that gets SIGHUP sends it to its jobs, as bash does, once it runs again (a microtask later here), not at once. An
 * ended process's children go to init (ppid 1).
 */
export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  state: 'running' | 'stopped' | 'dead';
  /** What it was sent while stopped, taken when it goes on. */
  pending: string[];
  /** Signals it ignores. */
  ignores: string[];
  /** A shell's jobs: the groups it sends SIGHUP to on its own hangup. */
  jobs: number[];
  /** What it does as it goes on after SIGCONT, when nothing it was sent ended it: a CLI starting one command more. */
  onContinue?: () => void;
}

export class World {
  readonly procs = new Map<number, Proc>();
  readonly signals: Array<{ target: number; sig: string }> = [];
  reads = 0;
  private readonly afterRead = new Map<number, () => void>();
  private everyRead: (() => void) | undefined;
  private readonly deaths = new Map<number, Array<() => void>>();

  add(pid: number, ppid: number, pgid: number, opts: { ignores?: string[]; jobs?: number[]; onContinue?: () => void } = {}): void {
    this.procs.set(pid, { pid, ppid, pgid, state: 'running', pending: [], ignores: opts.ignores ?? [], jobs: opts.jobs ?? [], onContinue: opts.onContinue });
  }

  /** What happens right after the `read`-th snapshot, while ps is still running. */
  after(read: number, then: () => void): void {
    this.afterRead.set(read, then);
  }

  afterEach(then: () => void): void {
    this.everyRead = then;
  }

  /** Calls `then` once `pid` has ended, as node-pty reports a terminal's exit. */
  onDeath(pid: number, then: () => void): void {
    this.deaths.set(pid, [...(this.deaths.get(pid) ?? []), then]);
  }

  print(): string {
    const out = [...this.procs.values()].filter(p => p.state !== 'dead')
      .map(p => `${p.pid} ${p.ppid} ${p.pgid} ${p.state === 'stopped' ? 'T' : 'S'} 00:01`).join('\n');
    this.reads += 1;
    this.afterRead.get(this.reads)?.();
    this.everyRead?.();
    return out;
  }

  /** process.kill, as Tars calls it: written down in `signals`. */
  kill(target: number, sig: string | number): true {
    this.signals.push({ target, sig: String(sig) });
    return this.send(target, sig);
  }

  /** A signal from inside the table (a shell's hangup to its jobs): not Tars's, so not in `signals`. */
  private send(target: number, sig: string | number): true {
    const members = [...this.procs.values()].filter(p => p.state !== 'dead' && (target < 0 ? p.pgid === -target : p.pid === target));
    if (!members.length) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    if (sig !== 0 && sig !== '0') for (const p of members) this.deliver(p, String(sig));
    return true;
  }

  private deliver(p: Proc, sig: string): void {
    if (p.state === 'dead') return;
    if (sig === 'SIGKILL') return this.end(p);
    if (sig === 'SIGSTOP') { p.state = 'stopped'; return; }
    if (sig === 'SIGCONT') {
      p.state = 'running';
      for (const held of p.pending.splice(0)) this.deliver(p, held);
      if (p.state === 'running') p.onContinue?.();
      return;
    }
    if (p.state === 'stopped') { p.pending.push(sig); return; }
    if (p.ignores.includes(sig)) return;
    if (sig === 'SIGHUP' && p.jobs.length) {
      const jobs = [...p.jobs];
      queueMicrotask(() => { for (const job of jobs) { try { this.send(-job, 'SIGHUP'); } catch { /* the job is gone */ } } });
    }
    this.end(p);
  }

  private end(p: Proc): void {
    p.state = 'dead';
    for (const child of this.procs.values()) if (child.state !== 'dead' && child.ppid === p.pid) child.ppid = 1;
    for (const then of this.deaths.get(p.pid) ?? []) then();
  }

  alive(pid: number): boolean {
    const p = this.procs.get(pid);
    return !!p && p.state !== 'dead';
  }
}
