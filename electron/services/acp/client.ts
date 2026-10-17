import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { refuseWhileQuitting } from '../../core/quit-state';
import { getPath, killTree, realFs, resolveCliBinary, withPath, type FsProbe } from '../../platform';

/**
 * An Agent Client Protocol session against one agent process.
 *
 * The value over typing into a PTY is that a turn *returns*: `session/prompt`
 * resolves with a stop reason and the turn's token usage, so a delegated task
 * has a receipt instead of a keystroke and a hope. Tool calls, plans and
 * permission requests arrive as structured events rather than as ANSI text to
 * be scraped, and the same conversation works against every agent that speaks
 * the protocol.
 */

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export interface AcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  totalTokens?: number;
}

export interface TurnResult {
  stopReason: StopReason;
  usage?: AcpUsage;
  /** Everything the agent said this turn, concatenated. */
  text: string;
  /** Tool calls it made, in order. */
  toolCalls: { title: string; kind?: string; status?: string }[];
  costUSD?: number;
  /**
   * What the turn started and left running when it ended: background
   * commands, monitors, wakeups. A delegated run ends with its turn, and all
   * of it is stopped with the agent (see backgroundOf).
   */
  background: string[];
}

/**
 * The name to report for a tool call that leaves work running after the turn,
 * or null. Claude Code has three: a Bash command started with
 * `run_in_background`, a Monitor, and a ScheduleWakeup (claude-agent-acp
 * titles those two by their tool name). In a terminal session each brings the
 * agent back when it fires; in a delegated run nothing does, since the run
 * ends with the turn and the agent is stopped.
 */
function backgroundOf(title: string, rawInput: unknown): string | null {
  const input = (rawInput ?? {}) as { run_in_background?: unknown; command?: unknown; description?: unknown };
  if (input.run_in_background === true) {
    return typeof input.command === 'string' ? input.command : typeof input.description === 'string' ? input.description : title;
  }
  if (title === 'Monitor' || title === 'ScheduleWakeup') return title;
  return null;
}

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: { name: string; value: string }[];
}

export interface SessionOptions {
  cwd: string;
  env?: Record<string, string>;
  mcpServers?: McpServerSpec[];
  /** How permission requests are answered when the agent asks. */
  permissionMode?: 'plan' | 'normal' | 'auto' | 'bypass';
  /** Tools the agent must not be allowed to use, by name fragment. */
  denyTools?: string[];
  /** Variables of Tars's own environment the agent must not inherit (its Claude account's). */
  unsetEnv?: string[];
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const INITIALIZE_TIMEOUT = 90_000;
const DEFAULT_TURN_TIMEOUT = 30 * 60_000;
/** How much of what an agent writes to stderr is kept, to say why it stopped. */
const STDERR_TAIL = 4_000;

/**
 * What a launch that failed means, in words the agent that delegated can act
 * on. ENOENT alone is ambiguous: spawn reports a working directory that is
 * gone with the same code as a command that is nowhere on PATH, and names the
 * command either way.
 */
function launchFailure(err: NodeJS.ErrnoException, command: string, cwd: string, searched: string | undefined): Error {
  if (err.code === 'ENOENT' && !fs.existsSync(cwd)) {
    return new Error(`could not start the agent: its working directory ${cwd} does not exist`);
  }
  if (err.code === 'ENOENT') {
    const install = command === 'npx' ? 'npx comes with Node.js: install Node.js' : 'Install it';
    return new Error(`could not start the agent: ${command} was not found. Tars looked in ${searched || 'an empty PATH'}. ${install}, or set where it lives in Settings > CLI Paths.`);
  }
  return new Error(`could not start the agent: ${command}: ${err.message}`);
}

/**
 * What start() spawns for a launch the registry named, in the environment the
 * agent gets: the command and its arguments as given on darwin and linux, and
 * on win32 the file the platform layer resolves the name to. There
 * `npx` is npx.cmd, which spawn cannot start without a shell and libuv does
 * not even find, so the shim is read through to the node.exe and script it
 * would run, the registry's arguments after them. The child gets its PATH
 * under one name, the value Tars set (path-env.ts withPath). A command that
 * cannot be resolved fails as a launch that could not find it does.
 */
export function resolveAgentLaunch(
  launch: { command: string; args: string[] },
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  disk: FsProbe = realFs,
): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const searched = getPath(env, platform);
  const childEnv = searched === undefined ? env : withPath(env, searched, platform);
  const binary = resolveCliBinary(launch.command, childEnv, platform, disk);
  if (!binary.ok) {
    const cause = binary.reason === 'not-found'
      ? Object.assign(new Error(binary.detail), { code: 'ENOENT' })
      : new Error(binary.detail);
    throw launchFailure(cause, launch.command, cwd, searched);
  }
  return { file: binary.file, args: [...binary.prefixArgs, ...launch.args], env: childEnv as NodeJS.ProcessEnv };
}

/**
 * The last lines an agent wrote to stderr, without stack frames or the update
 * notice npx prints after the agent it ran has died: why it stopped, in its
 * own words.
 */
function lastWords(stderr: string): string {
  const lines = stderr.split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('at ') && !line.startsWith('npm notice'));
  const words = lines.slice(-2).join('; ').slice(-400);
  return words ? `: ${words}` : '';
}

/** How long a stopped run's processes get to end on SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 2_000;

/**
 * How many times the end of a tree reads it again, every group it knows
 * stopped (SIGSTOP), before it signals, until a read adds no group. A process
 * started while the first ps ran was in no read, and its parent could die at
 * the SIGTERM before any read saw it: in a group of its own, reparented to
 * launchd, nothing tied it to the run any more (the QA's B1 on #358: 22 runs
 * out of 22 on its bench, and acp-delegation.spec.ts red 3 runs out of 5).
 * Stopped, a parent starts nothing more, and what it started is under it at
 * the next read. A tree that keeps growing is ended as far as the reads saw.
 */
const FREEZE_READS = 5;

type ProcessRow = { pid: number; ppid: number; pgid: number; zombie: boolean; age?: number };
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,stat=,etime='];

/** ps's elapsed time, `[[dd-]hh:]mm:ss`, in seconds; undefined when it gives none. */
function ageOf(etime: string | undefined): number | undefined {
  const match = etime?.match(/^(?:(\d+)-)?(?:(\d+):)?(?:(\d+):)?(\d+)$/);
  if (!match) return undefined;
  const [, days, a, b, seconds] = match;
  // With two colons the fields are hh:mm:ss, with one mm:ss.
  const [hours, minutes] = b !== undefined ? [a, b] : [undefined, a];
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes ?? 0) * 60 + Number(seconds);
}

export function parseProcessTable(out: string): ProcessRow[] {
  return out.split('\n').map(line => line.trim().split(/\s+/))
    .filter(cols => cols.length >= 4 && cols.slice(0, 3).every(c => /^\d+$/.test(c)))
    .map(([pid, ppid, pgid, stat, etime]) => ({
      pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), zombie: stat.startsWith('Z'), age: ageOf(etime),
    }));
}

/** Every process, from ps, the same on macOS and Linux. Undefined when ps cannot be run. */
export function processTable(): Promise<ProcessRow[] | undefined> {
  return new Promise(resolve => {
    execFile('ps', PS_ARGS, { timeout: 5_000 }, (err, out) => resolve(err ? undefined : parseProcessTable(String(out))));
  });
}

/** The same, read while the caller waits, for at most `timeoutMs`: for the quit, which nothing outlives. */
export function processTableNow(timeoutMs: number): ProcessRow[] | undefined {
  try {
    return parseProcessTable(String(execFileSync('ps', PS_ARGS, { timeout: timeoutMs })));
  } catch {
    return undefined;
  }
}

/**
 * The processes some roots lead, and every process group found among their
 * descendants.
 *
 * The roots' own groups are not enough. Claude Code's Bash tool runs each
 * command in a group of its own, and a run whose claude could not pass the stop
 * on (wedged, SIGSTOPped by the Audit on #191) left its `zsh -c` and `sleep`
 * alive, reparented to launchd, once npm, the adapter and claude had died with
 * their group. So the tree is read from ps before the first signal, while the
 * parents that tie those groups to the run are still alive, its groups held
 * still while it is read again (FREEZE_READS), and read again before the
 * last, from every process already known, for what was started in between.
 * Tars's own group, and init's, are never signalled. With no ps, the roots'
 * own groups still are.
 */
export class ProcessTree {
  private readonly known: Set<number>;
  private readonly groups: Set<number>;
  private ownGroup: number | undefined;
  private firstReadAt: number | undefined;
  /** Taken over by the quit (absorb): the quit's signals end it, and its own send nothing more. */
  private retired = false;

  constructor(roots: number[]) {
    this.known = new Set(roots);
    this.groups = new Set(roots);
  }

  /**
   * Adds what `table` shows under the processes already known. From the second
   * read on, a known pid younger than the time since the first read, whose
   * parent is not the run's, is another process that took the id since (the
   * Audit's gate of #199): it is dropped, and a group of the run's whose id it
   * took by leading one with it. (pid, ppid) pairs cannot tell: launchd is the
   * parent of a reparented process and of many a new one. ps gives the age in
   * whole seconds, so an id taken within a second of the first read passes.
   */
  grow(table: ProcessRow[] | undefined, now: number = Date.now()): void {
    if (!table) return;
    this.ownGroup = table.find(row => row.pid === process.pid)?.pgid;
    if (this.firstReadAt === undefined) {
      this.firstReadAt = now;
    } else {
      const elapsed = (now - this.firstReadAt) / 1000;
      for (const row of table) {
        if (!this.known.has(row.pid) || row.age === undefined || this.known.has(row.ppid)) continue;
        if (row.age >= elapsed - 1) continue;
        this.known.delete(row.pid);
        if (row.pgid === row.pid) this.groups.delete(row.pgid);
      }
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const row of table) {
        if (!this.known.has(row.pid) && this.known.has(row.ppid)) { this.known.add(row.pid); grew = true; }
      }
    }
    for (const row of table) if (this.known.has(row.pid)) this.groups.add(row.pgid);
  }

  /** The groups a signal goes to: never Tars's own, nor init's. */
  get targets(): number[] {
    return [...this.groups].filter(group => group > 1 && group !== this.ownGroup && group !== process.pid);
  }

  signal(sig: NodeJS.Signals): void {
    if (this.retired) return;
    for (const group of this.targets) {
      try { process.kill(-group, sig); } catch { /* the group is gone */ }
    }
  }

  /**
   * Makes another tree's processes and groups this one's, and retires it: a
   * stop still on its way when Tars quits is the quit's to end, and once the
   * quit has, that stop must not signal the tree again, where a new process
   * may have taken a group's id by then.
   */
  absorb(other: ProcessTree): void {
    for (const pid of other.known) this.known.add(pid);
    for (const group of other.groups) this.groups.add(group);
    other.retired = true;
  }

  /**
   * Holds the tree still while it is read again (FREEZE_READS): every group
   * known is stopped (SIGSTOP), then the tree grows from `read`, until a read
   * adds no group. Whoever calls it continues them (SIGCONT) once its own
   * signal is sent, so that each stopped process takes it as it goes on.
   */
  freeze(read: () => ProcessRow[] | undefined): void {
    for (let round = 0; round < FREEZE_READS; round++) {
      const stopped = new Set(this.targets);
      this.signal('SIGSTOP');
      this.grow(read());
      if (this.targets.every(group => stopped.has(group))) return;
    }
  }

  /** The same, with a read that gives the event loop back: a delegated run's stop, while Tars goes on. */
  async freezeAsync(read: () => Promise<ProcessRow[] | undefined>): Promise<void> {
    for (let round = 0; round < FREEZE_READS; round++) {
      const stopped = new Set(this.targets);
      this.signal('SIGSTOP');
      this.grow(await read());
      if (this.targets.every(group => stopped.has(group))) return;
    }
  }

  /** Whether a live process is left in any of the groups. A zombie is not: its
   *  parent, Tars for the process it spawned, reaps it once the thread is free. */
  anyLeft(table: ProcessRow[] | undefined): boolean {
    if (!table) return this.targets.some(group => { try { process.kill(-group, 0); return true; } catch { return false; } });
    const targets = new Set(this.targets);
    return table.some(row => targets.has(row.pgid) && !row.zombie);
  }
}

/**
 * Ends the process `root` leads and everything under it: its groups stopped
 * and read again until the tree stops growing (FREEZE_READS), SIGTERM, then
 * SIGKILL two seconds on.
 */
async function endProcessTree(root: number): Promise<void> {
  const tree = new ProcessTree([root]);
  stopsUnderway.add(tree);
  tree.grow(await processTable());
  await tree.freezeAsync(processTable);
  // A stopped process takes its SIGTERM as it continues.
  tree.signal('SIGTERM');
  tree.signal('SIGCONT');
  const last = setTimeout(() => {
    void processTable().then(table => { tree.grow(table); tree.signal('SIGKILL'); }).finally(() => stopsUnderway.delete(tree));
  }, STOP_GRACE_MS);
  last.unref();
}

/**
 * The trees a stop is ending, from its first read until its SIGKILL. Tars's
 * quit ends them as its own (endProcessTreesNow): it is handed the runs still
 * running only, and a stop caught between its SIGSTOP and its SIGCONT would
 * leave its groups stopped for good, an orphaned one included, and lose its
 * SIGKILL with the app (the Audit's Low 1 on #422).
 */
const stopsUnderway = new Set<ProcessTree>();

/**
 * win32's stop: the process Tars spawned and everything under it, by
 * `taskkill /T /F` (platform/kill-tree.ts). Windows has neither
 * process groups nor ps, and `child.kill()` ends the root alone: npx's node,
 * the adapter, the CLI and the commands it ran lived on. A child that has
 * already exited is left: the tree taskkill walks starts at it, and Windows
 * may have given its id to another process once Node let go of it. Should
 * taskkill fail, the root is ended through its own handle, and it is said.
 */
function endProcessTreeOnWindows(child: ChildProcessWithoutNullStreams, pid: number): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  killTree(pid).catch(err => {
    console.error(`[acp] could not end the processes under ${pid}, ending ${pid} alone:`, err);
    child.kill();
  });
}

/**
 * win32's quit: the same taskkill, run while the quit waits, under the quit's
 * deadline. killTree's runner is made synchronous, so each tree is ended when
 * this returns. A root whose taskkill fails or runs out of time is ended by
 * its id, which is still its own: Node holds its handle until the exit is
 * read, and the event loop reads nothing while the quit holds it.
 */
function endProcessTreesOnWindowsNow(roots: number[], deadline: number): void {
  for (const root of roots) {
    let failed = false;
    killTree(root, 'win32', {
      execFile: (file, args) => {
        try {
          const left = deadline - Date.now();
          if (left <= 20) throw new Error('no time was left before the quit');
          execFileSync(file, args, { timeout: left, windowsHide: true, stdio: 'ignore' });
          return Promise.resolve();
        } catch (err) {
          failed = true;
          const status = (err as { status?: unknown }).status;
          return Promise.reject(Object.assign(err as Error, typeof status === 'number' ? { code: status } : {}));
        }
      },
    }).catch(err => console.error(`[acp] quit: could not end the processes under ${root}:`, err));
    if (failed) {
      try { process.kill(root); } catch { /* it is gone */ }
    }
  }
}

/**
 * How long the quit may read the runs' trees before it signals them, the first
 * read of ps and the freeze's together. Under load a ps takes a few hundred
 * milliseconds (100 to 620 ms each, measured at load 220 to 230 on
 * 2026-10-17), and the freeze needs one read after the first.
 */
const QUIT_READS_MS = 2_000;
/** One read of ps at the quit at most. */
const QUIT_READ_MAX_MS = 1_000;
/** How long the quit waits for delegated runs to end on SIGTERM before SIGKILL, from the SIGTERM. */
const QUIT_GRACE_MS = 1_000;
/** And for the read of ps before the SIGKILL, past that. */
const QUIT_LAST_READ_MS = 500;
const QUIT_POLL_MS = 50;

/**
 * Ends the processes these roots lead, and everything under them, before it
 * returns: their groups held still while read again (FREEZE_READS), SIGTERM,
 * a wait of at most QUIT_GRACE_MS that ends as soon as nothing is left, then
 * SIGKILL. For the quit, where the stop's timer would
 * never fire (measured on #197: a wedged run was whole 14 s after the quit).
 *
 * The reads before the signals have QUIT_READS_MS between them, and the grace
 * starts at the SIGTERM. They shared one deadline with the grace, a second and
 * a half from the start, and a ps slowed by load used it up: the freeze's read
 * was not made, and a process born during the first read was left (the QA's
 * Info on #358, 1 quit in 60 at load 180).
 *
 * A ps that fails is not run again: each read had its own 2 s timeout once,
 * and a ps that hangs held the quit 6.5 s (the Audit's gate of #199). Each read
 * now has QUIT_READ_MAX_MS at most, or what is left of its time, and after one
 * that failed the groups already known are watched by a signal of 0 and still
 * get theirs. A quit whose ps hangs returns within QUIT_READ_MAX_MS and the
 * grace; one whose ps is slow, within QUIT_READS_MS, the grace and the last
 * read.
 */
export function endProcessTreesNow(roots: number[]): void {
  if (roots.length === 0 && stopsUnderway.size === 0) return;
  const start = Date.now();
  if (process.platform === 'win32') return endProcessTreesOnWindowsNow(roots, start + QUIT_GRACE_MS + QUIT_LAST_READ_MS);
  let psFailed = false;
  const read = (until: number) => {
    const left = Math.min(until - Date.now(), QUIT_READ_MAX_MS);
    if (psFailed || left <= 20) return undefined;
    const table = processTableNow(left);
    if (!table) psFailed = true;
    return table;
  };
  const readsEnd = start + QUIT_READS_MS;
  const tree = new ProcessTree(roots);
  for (const stopping of stopsUnderway) tree.absorb(stopping);
  stopsUnderway.clear();
  tree.grow(read(readsEnd));
  // Held still while read again, as the stop does (FREEZE_READS).
  tree.freeze(() => read(readsEnd));
  tree.signal('SIGTERM');
  tree.signal('SIGCONT');
  const graceEnds = Date.now() + QUIT_GRACE_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < graceEnds) {
    if (!tree.anyLeft(read(graceEnds))) return;
    Atomics.wait(pause, 0, 0, QUIT_POLL_MS);
  }
  tree.grow(read(graceEnds + QUIT_LAST_READ_MS));
  tree.signal('SIGKILL');
}

export class AcpSession extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private sessionId: string | null = null;
  /** The configuration options the agent offered when the session opened. */
  private configOptionIds = new Set<string>();
  private closed = false;
  private stderrTail = '';

  /** Text and tool calls for the turn currently in flight. */
  private turnText: string[] = [];
  private turnTools: { title: string; kind?: string; status?: string }[] = [];
  /** Tool calls of this turn that leave work running past it, by toolCallId. */
  private turnBackground = new Map<string, string>();
  /** This turn's tool calls by toolCallId, so an update can name one better. */
  private turnToolsById = new Map<string, { title: string; kind?: string; status?: string }>();
  private turnUsage: AcpUsage | undefined;
  private turnCost: number | undefined;

  constructor(
    private readonly launch: { command: string; args: string[] },
    private readonly options: SessionOptions,
  ) {
    super();
  }

  /** Spawns the agent, negotiates the protocol and opens a session. */
  async start(): Promise<{ sessionId: string; agentName?: string; capabilities?: unknown }> {
    refuseWhileQuitting('delegated run');
    const given: NodeJS.ProcessEnv = { ...process.env };
    for (const name of this.options.unsetEnv ?? []) delete given[name];
    Object.assign(given, this.options.env);
    let target: ReturnType<typeof resolveAgentLaunch>;
    try {
      target = resolveAgentLaunch(this.launch, given, this.options.cwd);
    } catch (err) {
      this.closed = true;
      throw err;
    }
    const env = target.env;
    const child = spawn(target.file, target.args, {
      cwd: this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so that stop() ends what it started too: the
      // command Tars spawns is npx or an adapter, the CLI runs under it, and
      // the commands the CLI runs under that (the Audit's table, #6). Windows
      // has no groups to signal: stop() ends the tree there by taskkill.
      detached: process.platform !== 'win32',
      // No console window for the agent: the main process has none to share.
      windowsHide: true,
    });
    this.child = child;

    child.stdout.on('data', chunk => this.onStdout(chunk.toString()));
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL);
      this.emit('stderr', text);
    });
    child.on('exit', code => {
      this.fail(new Error(`agent exited (code ${code})${lastWords(this.stderrTail)}`));
      this.emit('exit', code);
    });
    // A launch that fails, the command nowhere on PATH or the folder gone, is
    // reported here and only here: no 'exit' follows it. It used to be emitted
    // again on this session, where nothing listened, and an 'error' nobody
    // hears is thrown: in the main process, the "Uncaught Exception" window
    // JeanBrasse saw on 2026-09-18, while the initialize below waited out its 90
    // seconds. It fails what is waiting instead, that initialize first.
    child.on('error', err => this.fail(launchFailure(err, this.launch.command, this.options.cwd, getPath(env, process.platform))));
    // The same class on the way in: writing to an agent that has stopped
    // reading raises EPIPE on its stdin. Nothing can reach it any more, so the
    // session is over, and the agent is stopped rather than left behind.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      this.fail(new Error(`the agent stopped reading its input (${err.code ?? err.message})`));
      // On win32 the tree, as stop() ends it: once the root is gone, taskkill
      // can no longer find what runs under it.
      if (process.platform === 'win32' && child.pid) endProcessTreeOnWindows(child, child.pid);
      else child.kill();
    });

    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    }, INITIALIZE_TIMEOUT) as { agentInfo?: { name?: string }; agentCapabilities?: unknown };

    const session = await this.request('session/new', {
      cwd: this.options.cwd,
      mcpServers: (this.options.mcpServers ?? []).map(s => ({
        name: s.name,
        command: s.command,
        args: s.args,
        env: s.env ?? [],
      })),
    }, INITIALIZE_TIMEOUT) as { sessionId: string };

    this.sessionId = session.sessionId;
    const offered = (session as { configOptions?: { id?: unknown }[] }).configOptions;
    this.configOptionIds = new Set((Array.isArray(offered) ? offered : [])
      .map(option => option?.id)
      .filter((id): id is string => typeof id === 'string'));
    await this.selectMode(session as unknown as Record<string, unknown>);

    return {
      sessionId: session.sessionId,
      agentName: init?.agentInfo?.name,
      capabilities: init?.agentCapabilities,
    };
  }

  /**
   * Picks the session's permission mode.
   *
   * The default on some agents is "deny anything not pre-approved", which
   * silently blocks the very MCP tools we inject. Choosing `default` puts the
   * decision back on the client: every risky call arrives as a
   * session/request_permission we answer ourselves, which is how the deny list
   * ends up enforced identically on every agent.
   */
  private async selectMode(session: Record<string, unknown>): Promise<void> {
    const modes = session.modes as
      | { currentModeId?: string; availableModes?: { id: string }[] }
      | undefined;
    const available = new Set((modes?.availableModes ?? []).map(m => m.id));
    // A run held to plan (core/permission-ceiling.ts) runs in plan or not at
    // all: any other mode would be broader than its asker's.
    if (this.options.permissionMode === 'plan') {
      if (!available.has('plan')) {
        throw new Error('permission_escalation_denied: this run is held to plan mode, and the agent offers no plan mode');
      }
      if (modes?.currentModeId === 'plan') return;
      await this.request('session/set_mode', { sessionId: this.sessionId, modeId: 'plan' }, 15_000);
      this.emit('mode', 'plan');
      return;
    }
    if (available.size === 0) return;

    const wantsArbitration = (this.options.denyTools?.length ?? 0) > 0
      || this.options.permissionMode === 'normal';

    const preference = wantsArbitration
      ? ['default', 'auto', 'acceptEdits']
      : this.options.permissionMode === 'bypass'
        ? ['bypassPermissions', 'acceptEdits', 'default']
        : ['acceptEdits', 'default', 'auto'];

    const target = preference.find(id => available.has(id));
    if (!target || target === modes?.currentModeId) return;

    try {
      await this.request('session/set_mode', { sessionId: this.sessionId, modeId: target }, 15_000);
      this.emit('mode', target);
    } catch (err) {
      this.emit('stderr', `could not set session mode to ${target}: ${String(err)}`);
    }
  }

  /**
   * Sets one of the options the agent offered for this session, such as its
   * model or its effort (`session/set_config_option`). ACP has no command line
   * to put them on: a session is configured once it is open. Answers whether
   * the agent took the value, and says why not when it did not, because the
   * turn runs either way and a setting that silently did not apply is how a
   * delegation came to run on the CLI's defaults.
   */
  async setConfigOption(configId: string, value: string): Promise<boolean> {
    if (!this.sessionId) throw new Error('session not started');
    if (!this.configOptionIds.has(configId)) {
      this.emit('stderr', `the agent offers no ${configId} option, so ${value} was not applied`);
      return false;
    }
    try {
      await this.request('session/set_config_option', { sessionId: this.sessionId, configId, value }, 15_000);
      return true;
    } catch (err) {
      this.emit('stderr', `could not set ${configId} to ${value}: ${String(err)}`);
      return false;
    }
  }

  /** Sends a prompt and resolves when the agent finishes the turn. */
  async prompt(text: string, timeoutMs = DEFAULT_TURN_TIMEOUT): Promise<TurnResult> {
    if (!this.sessionId) throw new Error('session not started');

    this.turnText = [];
    this.turnTools = [];
    this.turnBackground = new Map();
    this.turnToolsById = new Map();
    this.turnUsage = undefined;
    this.turnCost = undefined;

    const result = await this.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }, timeoutMs) as { stopReason?: StopReason; usage?: AcpUsage };

    return {
      stopReason: result?.stopReason ?? 'end_turn',
      usage: result?.usage ?? this.turnUsage,
      text: this.turnText.join(''),
      toolCalls: this.turnTools,
      costUSD: this.turnCost,
      background: [...this.turnBackground.values()],
    };
  }

  /**
   * What the turn in flight has said and done so far: for a turn stopped at
   * its limit, which otherwise answered nothing however far it had got.
   */
  partialTurn(): { text: string; toolCalls: { title: string; kind?: string; status?: string }[]; background: string[] } {
    return { text: this.turnText.join(''), toolCalls: this.turnTools, background: [...this.turnBackground.values()] };
  }

  async cancel(): Promise<void> {
    if (!this.sessionId || this.closed) return;
    try {
      await this.notify('session/cancel', { sessionId: this.sessionId });
    } catch {
      // the kill below is the real stop
    }
  }

  /** Ends the run, and every process it started (endProcessTree): SIGTERM,
   *  then SIGKILL two seconds on for whatever did not go. */
  stop(): void {
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    const pid = child.pid;
    if (!pid) {
      child.kill();
      return;
    }
    if (process.platform === 'win32') return endProcessTreeOnWindows(child, pid);
    void endProcessTree(pid);
  }

  /**
   * For the quit: marks the run ended and hands back the process id to end
   * with endProcessTreesNow, all runs at once. Undefined when there is nothing
   * to end.
   */
  releaseForQuit(): number | undefined {
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (!child) return undefined;
    if (!child.pid) {
      child.kill();
      return undefined;
    }
    // An exited root's id may be another process's by now, and taskkill /T
    // would end that one's tree (see endProcessTreeOnWindows).
    if (process.platform === 'win32' && (child.exitCode !== null || child.signalCode !== null)) return undefined;
    return child.pid;
  }

  get isRunning(): boolean {
    return !!this.child && !this.closed;
  }

  /** Ends the session: nothing more is written, and every call still waiting fails with `err`. */
  private fail(err: Error): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /* ── wire ─────────────────────────────────────────────── */

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit('stderr', line);
        continue;
      }

      const id = message.id as number | undefined;
      if (id !== undefined && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (message.error) {
          const err = message.error as { message?: string };
          p.reject(new Error(err?.message ?? 'agent error'));
        } else {
          p.resolve(message.result);
        }
        continue;
      }

      if (typeof message.method === 'string') {
        this.onAgentMessage(message);
      }
    }
  }

  private onAgentMessage(message: Record<string, unknown>): void {
    const method = message.method as string;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const id = message.id as number | undefined;

    if (method === 'session/update') {
      this.onUpdate((params.update ?? {}) as Record<string, unknown>);
      return;
    }

    if (method === 'session/request_permission') {
      this.answerPermission(id, params);
      return;
    }

    // Anything else the agent asks of the client gets an empty acknowledgement
    // rather than silence, which would hang its turn.
    if (id !== undefined) this.respond(id, {});
  }

  private onUpdate(update: Record<string, unknown>): void {
    const kind = update.sessionUpdate as string;

    // A run held to plan whose session leaves plan, whatever made it: the
    // caller ends the run (delegate.ts, permission_escalation_denied).
    if (kind === 'current_mode_update' && this.options.permissionMode === 'plan') {
      const mode = typeof update.currentModeId === 'string' ? update.currentModeId : '';
      if (mode !== 'plan') this.emit('breach', mode || 'unknown');
      return;
    }

    if (kind === 'agent_message_chunk') {
      const content = update.content as { text?: string } | undefined;
      if (content?.text) {
        this.turnText.push(content.text);
        this.emit('text', content.text);
      }
      return;
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const title = (update.title as string) || (update.rawInput as { command?: string } | undefined)?.command || 'tool';
      const entry = { title, kind: update.kind as string | undefined, status: update.status as string | undefined };
      const id = update.toolCallId as string | undefined;
      if (kind === 'tool_call') {
        this.turnTools.push(entry);
        if (id) this.turnToolsById.set(id, entry);
      } else if (id && update.title) {
        // The adapter emits a call first under a placeholder ("Terminal") and
        // its command in an update: name it by what it ran.
        const recorded = this.turnToolsById.get(id);
        if (recorded) recorded.title = title;
      }
      // Read on the update too: the adapter emits a call before its input.
      const left = backgroundOf(title, update.rawInput);
      if (left && id) this.turnBackground.set(id, left);
      this.emit('tool', entry);
      return;
    }

    if (kind === 'usage_update') {
      this.turnUsage = {
        inputTokens: update.inputTokens as number | undefined,
        outputTokens: update.outputTokens as number | undefined,
        totalTokens: update.used as number | undefined,
      };
      const cost = update.cost as { amount?: number } | undefined;
      if (typeof cost?.amount === 'number') this.turnCost = cost.amount;
      this.emit('usage', this.turnUsage);
      return;
    }

    if (kind === 'plan') {
      this.emit('plan', update.entries);
      return;
    }

    this.emit('update', update);
  }

  /**
   * Answers a permission request without a human in the loop. This is the
   * guardrail that finally works on every agent rather than only on Claude:
   * a denied tool is denied by the protocol, not by a flag one CLI happens to
   * support.
   */
  private answerPermission(id: number | undefined, params: Record<string, unknown>): void {
    if (id === undefined) return;

    const toolCall = (params.toolCall ?? {}) as { title?: string; kind?: string };
    const options = (params.options ?? []) as { optionId: string; kind?: string; name?: string }[];
    const label = `${toolCall.title ?? ''} ${toolCall.kind ?? ''}`.toLowerCase();

    // Held to plan (core/permission-ceiling.ts), nothing is approved: Claude
    // leaves plan by asking (ExitPlanMode, sent by claude-agent-acp 0.70.0 as
    // this request, its options switching the session's mode), and the
    // allow_once chosen here let a plan-held run out of plan, and every edit
    // after it through (the Audit's B1 on #364). "No, keep planning" is its
    // reject_once.
    const held = this.options.permissionMode === 'plan';
    const denied = held || (this.options.denyTools ?? []).some(fragment => label.includes(fragment.toLowerCase()));
    const wanted = denied
      ? ['reject_once', 'reject_always']
      : this.options.permissionMode === 'normal' || this.options.permissionMode === 'plan'
        ? ['allow_once']
        : ['allow_always', 'allow_once'];

    const chosen = wanted.map(kind => options.find(o => o.kind === kind)).find(Boolean)
      ?? (denied ? undefined : options[0]);

    this.emit('permission', { tool: toolCall.title, denied, decision: chosen?.optionId });

    this.respond(id, chosen
      ? { outcome: { outcome: 'selected', optionId: chosen.optionId } }
      : { outcome: { outcome: 'cancelled' } });
  }

  private respond(id: number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.child || this.closed) return Promise.reject(new Error('agent not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(message: unknown): void {
    if (!this.child || this.closed) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
