import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';

/**
 * An Agent Client Protocol session against one agent process. Unlike a
 * keystroke into a PTY, a turn returns (`session/prompt` resolves with a stop
 * reason and its token usage), and tool calls, plans and permission requests
 * arrive as events, the same on every agent that speaks the protocol.
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
  /** What the turn left running (backgroundOf), stopped with the agent: a run ends with its turn. */
  background: string[];
}

/**
 * The name to report for a tool call that leaves work running past the turn, or
 * null: a Bash `run_in_background`, a Monitor, a ScheduleWakeup (claude-agent-acp
 * titles the last two by tool name). Nothing brings a delegated run back for them.
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
  permissionMode?: 'normal' | 'auto' | 'bypass';
  /** Tools the agent must not be allowed to use, by name fragment. */
  denyTools?: string[];
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
 * A failed launch in words the delegating agent can act on. ENOENT alone is
 * ambiguous: spawn gives it, naming the command, for a missing working
 * directory as for a command nowhere on PATH.
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

/** Why an agent stopped, in its own words: its last stderr lines, without stack
 *  frames or the update notice npx prints after the agent it ran has died. */
function lastWords(stderr: string): string {
  const lines = stderr.split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('at ') && !line.startsWith('npm notice'));
  const words = lines.slice(-2).join('; ').slice(-400);
  return words ? `: ${words}` : '';
}

/** How long a stopped run's processes get to end on SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 2_000;

type ProcessRow = { pid: number; ppid: number; pgid: number; zombie: boolean };
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,stat='];

function parseProcessTable(out: string): ProcessRow[] {
  return out.split('\n').map(line => line.trim().split(/\s+/))
    .filter(cols => cols.length >= 4 && cols.slice(0, 3).every(c => /^\d+$/.test(c)))
    .map(([pid, ppid, pgid, stat]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), zombie: stat.startsWith('Z') }));
}

/** Every process, from ps, the same on macOS and Linux. Undefined when ps cannot be run. */
function processTable(): Promise<ProcessRow[] | undefined> {
  return new Promise(resolve => {
    execFile('ps', PS_ARGS, { timeout: 5_000 }, (err, out) => resolve(err ? undefined : parseProcessTable(String(out))));
  });
}

/** The same, read while the caller waits: for the quit, which nothing outlives. */
function processTableNow(): ProcessRow[] | undefined {
  try {
    return parseProcessTable(String(execFileSync('ps', PS_ARGS, { timeout: 2_000 })));
  } catch {
    return undefined;
  }
}

/**
 * The processes some roots lead, and every process group among their
 * descendants: Claude Code's Bash tool runs each command in a group of its own,
 * and a wedged run (SIGSTOPped by the Audit on #191) left its `zsh -c` and
 * `sleep` alive, reparented to launchd, once its own group had died. So ps is
 * read before the first signal, while the parents still tie those groups to the
 * run, and again before the last, for what started in between. Tars's group and
 * init's are never signalled; with no ps, the roots' own groups still are.
 */
class ProcessTree {
  private readonly known: Set<number>;
  private readonly groups: Set<number>;
  private ownGroup: number | undefined;

  constructor(roots: number[]) {
    this.known = new Set(roots);
    this.groups = new Set(roots);
  }

  grow(table: ProcessRow[] | undefined): void {
    if (!table) return;
    this.ownGroup = table.find(row => row.pid === process.pid)?.pgid;
    for (let grew = true; grew;) {
      grew = false;
      for (const row of table) {
        if (!this.known.has(row.pid) && this.known.has(row.ppid)) { this.known.add(row.pid); grew = true; }
      }
    }
    for (const row of table) if (this.known.has(row.pid)) this.groups.add(row.pgid);
  }

  private get targets(): number[] {
    return [...this.groups].filter(group => group > 1 && group !== this.ownGroup && group !== process.pid);
  }

  signal(sig: NodeJS.Signals): void {
    for (const group of this.targets) {
      try { process.kill(-group, sig); } catch { /* the group is gone */ }
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

/** Ends the process `root` leads and everything under it: SIGTERM, then SIGKILL two seconds on. */
async function endProcessTree(root: number): Promise<void> {
  const tree = new ProcessTree([root]);
  tree.grow(await processTable());
  tree.signal('SIGTERM');
  const last = setTimeout(() => {
    void processTable().then(table => { tree.grow(table); tree.signal('SIGKILL'); });
  }, STOP_GRACE_MS);
  last.unref();
}

/** How long the quit waits for delegated runs to end on SIGTERM before SIGKILL. */
const QUIT_GRACE_MS = 1_000;
const QUIT_POLL_MS = 50;

/**
 * Ends the processes these roots lead, and everything under them, before it
 * returns: SIGTERM, up to QUIT_GRACE_MS while anything is left, SIGKILL. For the
 * quit, where the stop's timer never fires (#197: a wedged run whole 14 s after).
 */
export function endProcessTreesNow(roots: number[]): void {
  if (roots.length === 0) return;
  const tree = new ProcessTree(roots);
  tree.grow(processTableNow());
  tree.signal('SIGTERM');
  const until = Date.now() + QUIT_GRACE_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < until) {
    if (!tree.anyLeft(processTableNow())) return;
    Atomics.wait(pause, 0, 0, QUIT_POLL_MS);
  }
  tree.grow(processTableNow());
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
    const env = { ...process.env, ...this.options.env };
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so that stop() ends the CLI under npx or the
      // adapter, and the commands under the CLI (the Audit's table, #6).
      // Windows has no groups: the kill there is the process alone.
      detached: process.platform !== 'win32',
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
    // A failed launch (command nowhere on PATH, folder gone) is reported here
    // only, with no 'exit' after it. Re-emitted on this session, where nothing
    // listened, it was thrown: the "Uncaught Exception" window of 2026-09-18,
    // while initialize waited its 90 s. It fails what is waiting instead.
    child.on('error', err => this.fail(launchFailure(err, this.launch.command, this.options.cwd, env.PATH)));
    // The same on the way in: EPIPE on stdin, an agent that stopped reading.
    // Nothing can reach it, so the session is over and the agent is stopped.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      this.fail(new Error(`the agent stopped reading its input (${err.code ?? err.message})`));
      child.kill();
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
   * Picks the session's permission mode. Some agents default to "deny anything
   * not pre-approved", which silently blocks the MCP tools we inject; `default`
   * sends every risky call back as a session/request_permission we answer, so
   * the deny list is enforced the same on every agent.
   */
  private async selectMode(session: Record<string, unknown>): Promise<void> {
    const modes = session.modes as
      | { currentModeId?: string; availableModes?: { id: string }[] }
      | undefined;
    const available = new Set((modes?.availableModes ?? []).map(m => m.id));
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
   * Sets an option the agent offered for this session, its model or effort
   * (`session/set_config_option`; ACP has no command line). Answers whether it
   * took, and says why not: the turn runs either way, and a setting that silently
   * did not apply is how delegations ran on the CLI's defaults.
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

  /** What the turn in flight has said and done so far: a turn stopped at its limit answers nothing else. */
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
    if (!pid || process.platform === 'win32') {
      child.kill();
      return;
    }
    void endProcessTree(pid);
  }

  /**
   * For the quit: marks the run ended and hands back the process id to end
   * with endProcessTreesNow, all runs at once. Undefined when there is nothing
   * to end, or on Windows, where the process is killed here, having no group.
   */
  releaseForQuit(): number | undefined {
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (!child) return undefined;
    if (!child.pid || process.platform === 'win32') {
      child.kill();
      return undefined;
    }
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
   * Answers a permission request without a human in the loop: a denied tool is
   * denied by the protocol, on every agent, not by a flag one CLI supports.
   */
  private answerPermission(id: number | undefined, params: Record<string, unknown>): void {
    if (id === undefined) return;

    const toolCall = (params.toolCall ?? {}) as { title?: string; kind?: string };
    const options = (params.options ?? []) as { optionId: string; kind?: string; name?: string }[];
    const label = `${toolCall.title ?? ''} ${toolCall.kind ?? ''}`.toLowerCase();

    const denied = (this.options.denyTools ?? []).some(fragment => label.includes(fragment.toLowerCase()));
    const wanted = denied
      ? ['reject_once', 'reject_always']
      : this.options.permissionMode === 'normal'
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
