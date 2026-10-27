import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { API_PORT } from '../constants';
import { buildFullPath } from '../utils/path-builder';
import { redactSecrets } from '../utils/redact-secrets';

/**
 * What an agent started, wherever it went: found by its birth tag, ended by its PID (2.0.5, the owner's lot 2 of
 * 28/10, item C of ressources-agents-proposition-2810.md).
 *
 * A stop ends the terminal's tree (pty-manager.ts, endTerminalTree), read from ps by parentage, and on Linux by
 * session (#520). A process started detached escapes both: nohup and a group of its own, then its parent gone, it
 * is init's or launchd's; with setsid it is in a session of its own too. Measured: after stop_agent, 1212-Capital's
 * Playwright run and Next servers kept running; kotsna's 5 dev servers (14 processes) ran 10 days with no session;
 * Tars's own e2e left 20 `my-cli` orphans since 19/10.
 *
 * What every one of them keeps is its environment, inherited from the agent's terminal (agent-pty.ts):
 * CLAUDE_AGENT_ID, the agent, and CLAUDE_MGR_API_URL, the Tars it answers to by its port. Both are the tag: the id
 * alone is shared by an e2e run's fake agents (`x-claude`) and by the sandbox's copy of agents.json, which a stop
 * in one Tars must never reach in another. A process that empties its environment (`env -i`) carries no tag.
 *
 * Read where the system gives another process's environment to its user: Linux, /proc/<pid>/environ, exact;
 * macOS, `ps -E`, which appends the environment to the arguments, so its words after the arguments read with ps
 * a moment before are taken, and a process whose arguments changed in between is left out. Windows gives it to
 * native code only (the process's PEB): unknown, and nothing is claimed there.
 *
 * macOS shows no environment of a platform binary (/bin/sleep, /bin/sh, /bin/zsh): such a process carries no
 * readable tag and is not found. What agents leave running (node, python, a Homebrew program) is readable.
 *
 * Never Tars itself nor a parent of it (a Tars started from an agent's terminal), and never, by the owner's limits,
 * an ansible run or a `fly ssh` session, nor a shared daemon (SHARED_DAEMONS), with everything each started: those
 * are kept and said. Never the agent's own terminal either, when it got one again while the stop ran. Stopped by
 * PID: SIGTERM, then after the grace SIGKILL to what is still there and still tagged, read again just before.
 */

export const AGENT_TAG = 'CLAUDE_AGENT_ID';
export const TARS_TAG = 'CLAUDE_MGR_API_URL';
export const DEFAULT_GRACE_MS = 3_000;

/** This Tars's address, as every agent terminal it starts gets it (agent-pty.ts). */
export function tarsAddress(): string {
  return `http://127.0.0.1:${API_PORT}`;
}

export interface BornProcess { pid: number; ppid: number; agentId: string; command: string }

/** /proc/<pid>/environ: its NUL-separated entries. */
export function parseEnviron(raw: string): string[] {
  return raw.split('\0').filter(Boolean);
}

/**
 * macOS: the environment's words in a line of `ps -E -o command=`, which is the arguments, a space, then the
 * environment; undefined when that line does not start with the arguments read before (the process changed).
 */
export function envTokensOfPs(withEnv: string, args: string): string[] | undefined {
  if (withEnv === args) return [];
  if (!withEnv.startsWith(`${args} `)) return undefined;
  return withEnv.slice(args.length + 1).split(' ').filter(Boolean);
}

/** The agent a process was born of, when its environment holds both tags and the address is this Tars's. */
export function bornTagOf(entries: string[], address: string): string | undefined {
  let agentId: string | undefined;
  let ours = false;
  for (const entry of entries) {
    if (entry.startsWith(`${AGENT_TAG}=`)) agentId = entry.slice(AGENT_TAG.length + 1);
    else if (entry === `${TARS_TAG}=${address}`) ours = true;
  }
  return ours && agentId ? agentId : undefined;
}

/**
 * macOS: the words of ps -E are split on spaces, so a value can hold a word that looks like a tag (a name set to
 * `x CLAUDE_AGENT_ID=<other>`). Either tag seen twice: the process is nobody's, never another agent's (the
 * Audit's L1 on #523).
 */
export function macTagOf(words: string[], address: string): string | undefined {
  const count = (tag: string) => words.filter(word => word.startsWith(`${tag}=`)).length;
  if (count(AGENT_TAG) !== 1 || count(TARS_TAG) > 1) return undefined;
  return bornTagOf(words, address);
}

/** Tars and every parent of it, from a table of (pid, ppid): never ended, whatever their environment. */
export function tarsAndItsParents(table: Array<{ pid: number; ppid: number }>, self: number = process.pid): Set<number> {
  const parentOf = new Map(table.map(row => [row.pid, row.ppid]));
  const chain = new Set<number>();
  for (let pid: number | undefined = self; pid !== undefined && pid > 0 && !chain.has(pid); pid = parentOf.get(pid)) chain.add(pid);
  return chain;
}

/**
 * Programs that serve every project, whoever started them, kept by a stop (the owner, 28/10): colima, the Docker VM
 * kotsna's Supabase and parallel's tests run in, its limactl and the Virtualization process; docker; VS Code
 * opened with `code .`. Named by their exact executable paths, resolved where they are links (Homebrew's bin/
 * into its Cellar): never by a name or a word of the command, which any script can take. This list only keeps:
 * what a stop ends is decided by the birth tag alone.
 */
export const SHARED_DAEMONS: ReadonlyArray<{ name: string; paths: string[] }> = [
  { name: 'colima', paths: ['/opt/homebrew/bin/colima', '/usr/local/bin/colima', '/home/linuxbrew/.linuxbrew/bin/colima'] },
  { name: 'limactl', paths: ['/opt/homebrew/bin/limactl', '/usr/local/bin/limactl', '/home/linuxbrew/.linuxbrew/bin/limactl'] },
  { name: 'the Virtualization framework', paths: ['/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine'] },
  { name: 'docker', paths: [
    '/opt/homebrew/bin/docker', '/usr/local/bin/docker', '/usr/bin/docker', '/usr/bin/dockerd', '/usr/bin/containerd',
    '/Applications/Docker.app/Contents/Resources/bin/docker', '/Applications/Docker.app/Contents/MacOS/com.docker.backend',
  ] },
  { name: 'VS Code', paths: [
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
    '/usr/share/code/code',
  ] },
];

/** Each listed path that exists, resolved, to the daemon's name. */
export function sharedDaemonPaths(list: ReadonlyArray<{ name: string; paths: string[] }> = SHARED_DAEMONS): Map<string, string> {
  const out = new Map<string, string>();
  for (const daemon of list) {
    for (const p of daemon.paths) {
      try { out.set(fs.realpathSync(p), daemon.name); } catch { /* not on this machine */ }
    }
  }
  return out;
}

/** An ssh ControlMaster's title (`ssh: <ControlPath> [mux]`): reparented to init or launchd when its parent ends. */
const MUX = /^ssh: (\S+) \[mux\]$/;

/**
 * Why a process is kept whatever it was born of (the owner's limits of 28/10), or undefined: an ansible run, a
 * `fly ssh` session, ansible's or colima's ssh master (by its title), or a shared daemon by its executable.
 */
export function spareReason(command: string, executable?: string, shared?: Map<string, string>): string | undefined {
  const words = command.trim().split(/\s+/);
  const names = words.slice(0, 3).map(word => path.basename(word));
  if (names.some(name => /^ansible(-[a-z]+)?$/.test(name))) return 'an ansible run';
  const fly = names.findIndex(name => name === 'fly' || name === 'flyctl');
  if (fly >= 0 && words[fly + 1] === 'ssh') return 'a fly ssh session';
  const mux = MUX.exec(command.trim());
  if (mux && mux[1].includes('/.ansible/cp/')) return 'an ansible run';
  if (mux && /\/\.(colima|lima)\//.test(mux[1])) return 'a shared daemon (colima)';
  const daemon = executable ? shared?.get(executable) : undefined;
  return daemon ? `a shared daemon (${daemon})` : undefined;
}

/**
 * The executable each process runs, as the system resolves it: macOS, the first `txt` file lsof gives (one call
 * for all of them); Linux, /proc/<pid>/exe. Read for the agent's processes only, when a stop ends them.
 */
export async function executablesOf(pids: number[], platform: NodeJS.Platform = process.platform): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  if (platform === 'linux') {
    for (const pid of pids) {
      try { out.set(pid, fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '')); } catch { /* gone, or not ours */ }
    }
  } else if (platform === 'darwin') {
    const listed = await run('lsof', ['-a', '-p', pids.join(','), '-d', 'txt', '-Fpn']);
    let pid = 0;
    for (const line of listed.out.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid && !out.has(pid)) out.set(pid, line.slice(1));
    }
  }
  return out;
}

/** The first of `roots` met walking up from `pid` (itself included), through the parents the table knows. */
function rootAbove(pid: number, roots: Set<number>, parentOf: Map<number, number>): number | undefined {
  const seen = new Set<number>();
  for (let at: number | undefined = pid; at !== undefined && at > 1 && !seen.has(at); at = parentOf.get(at)) {
    if (roots.has(at)) return at;
    seen.add(at);
  }
  return undefined;
}

/** A process as a stop and the watch say it: `pid <n>: <command>`, secrets masked, cut. */
export function describeBorn(p: { pid: number; command: string }, why?: string): string {
  return `pid ${p.pid}: ${redactSecrets(p.command).replace(/\s+/g, ' ').slice(0, 120)}${why ? ` (${why})` : ''}`;
}

function run(file: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: boolean; out: string; missing?: boolean }> {
  return new Promise(resolve => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024, timeout: 10_000, ...opts }, (err, stdout) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      resolve({ ok: !err, out: String(stdout ?? ''), ...(code === 'ENOENT' ? { missing: true } : {}) });
    });
  });
}

const LINE = /^\s*(\d+)\s+(\d+)\s(.*)$/;

async function readMac(address: string): Promise<BornProcess[] | undefined> {
  const plain = await run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command=']);
  const withEnv = await run('ps', ['-A', '-E', '-ww', '-o', 'pid=,ppid=,command=']);
  if (!plain.ok || !withEnv.ok) return undefined;
  const args = new Map<number, { ppid: number; command: string }>();
  for (const line of plain.out.split('\n')) {
    const m = LINE.exec(line);
    if (m) args.set(Number(m[1]), { ppid: Number(m[2]), command: m[3].trim() });
  }
  const table = [...args].map(([pid, row]) => ({ pid, ppid: row.ppid }));
  const tars = tarsAndItsParents(table);
  const born: BornProcess[] = [];
  for (const line of withEnv.out.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const before = args.get(pid);
    if (!before || tars.has(pid)) continue;
    const tokens = envTokensOfPs(m[3].trim(), before.command);
    const agentId = tokens && macTagOf(tokens, address);
    if (agentId) born.push({ pid, ppid: before.ppid, agentId, command: before.command });
  }
  return born;
}

function readLinux(address: string): BornProcess[] | undefined {
  let pids: number[];
  try {
    pids = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number);
  } catch {
    return undefined;
  }
  const rows: Array<{ pid: number; ppid: number; agentId?: string; command: string }> = [];
  for (const pid of pids) {
    try {
      // `pid (comm) state ppid ...`: comm may hold spaces and parentheses, so the ppid is read after the last ')'.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      let agentId: string | undefined;
      // Another user's environment is not readable: EACCES, and it is not ours.
      try { agentId = bornTagOf(parseEnviron(fs.readFileSync(`/proc/${pid}/environ`, 'utf8')), address); } catch { /* not ours */ }
      const command = agentId ? fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') : '';
      rows.push({ pid, ppid, agentId, command });
    } catch {
      // Gone between the listing and the read.
    }
  }
  const tars = tarsAndItsParents(rows);
  return rows.filter((row): row is BornProcess => !!row.agentId && !tars.has(row.pid));
}

/**
 * Every process of this Tars's agents that the system shows: one read of the whole table. Undefined where the
 * environment of another process cannot be read (Windows), or the read failed.
 */
export async function readBornProcesses(opts: { address?: string; platform?: NodeJS.Platform } = {}): Promise<BornProcess[] | undefined> {
  const address = opts.address ?? tarsAddress();
  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') return readMac(address);
  if (platform === 'linux') return readLinux(address);
  return undefined;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export interface BornEnd {
  /** Sent SIGTERM, and SIGKILL after the grace if still there and still the agent's. */
  ended: number[];
  /** The same, with their commands, to say what was ended. */
  endedProcesses: BornProcess[];
  /** Kept by the owner's limits or as a shared daemon, with everything each started, with why. */
  spared: Array<BornProcess & { why: string }>;
  /** The system gives no environment to read (Windows), or the read failed: nothing was done. */
  unknown: boolean;
}

export interface BornEndOptions {
  address?: string;
  platform?: NodeJS.Platform;
  graceMs?: number;
  read?: () => Promise<BornProcess[] | undefined>;
  /** The pid of the agent's terminal now, asked after each read: one it got again while the stop ran is left alone. */
  terminal?: () => number | undefined;
  /** Shared daemons by resolved executable (sharedDaemonPaths()). */
  shared?: Map<string, string>;
}

/** The agent's processes under its current terminal: its own, not what the stop is for (the Audit's M2 on #523). */
function underTerminal(all: BornProcess[], terminal: number | undefined): Set<number> {
  if (terminal === undefined) return new Set();
  const parentOf = new Map(all.map(p => [p.pid, p.ppid]));
  const roots = new Set([terminal]);
  return new Set(all.filter(p => rootAbove(p.pid, roots, parentOf) !== undefined).map(p => p.pid));
}

/**
 * Ends what the agent started that is still alive, by PID: SIGTERM, then SIGKILL after `graceMs`. A kept process
 * is kept with everything under it (the Audit's M1 on #523: an ansible run works through its ssh children).
 */
export async function endBornProcesses(agentId: string, opts: BornEndOptions = {}): Promise<BornEnd> {
  const read = opts.read ?? (() => readBornProcesses({ address: opts.address, platform: opts.platform }));
  const all = await read();
  if (!all) return { ended: [], endedProcesses: [], spared: [], unknown: true };
  const mine = all.filter(p => p.agentId === agentId);
  const executables = await executablesOf(mine.map(p => p.pid), opts.platform);
  const shared = opts.shared ?? sharedDaemonPaths();
  const whyOf = new Map<number, string>();
  for (const p of mine) { const why = spareReason(p.command, executables.get(p.pid), shared); if (why) whyOf.set(p.pid, why); }
  const parentOf = new Map(all.map(p => [p.pid, p.ppid]));
  const roots = new Set(whyOf.keys());
  const spared: BornEnd['spared'] = [];
  for (const p of mine) {
    const root = rootAbove(p.pid, roots, parentOf);
    if (root === undefined) continue;
    spared.push({ ...p, why: root === p.pid ? whyOf.get(root)! : `started by ${root}, ${whyOf.get(root)}` });
  }
  const kept = new Set(spared.map(p => p.pid));
  const own = underTerminal(all, opts.terminal?.());
  const ending = mine.filter(p => !kept.has(p.pid) && !own.has(p.pid));
  const result = (pids: number[]): BornEnd => ({ ended: pids, endedProcesses: ending.filter(p => pids.includes(p.pid)), spared, unknown: false });
  if (ending.length === 0) return result([]);
  const pids = ending.map(p => p.pid);
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  const deadline = Date.now() + (opts.graceMs ?? DEFAULT_GRACE_MS);
  while (Date.now() < deadline && pids.some(alive)) await new Promise(r => setTimeout(r, 100));
  const left = pids.filter(alive);
  if (left.length === 0) return result(pids);
  // Read again: a pid that is no longer the agent's (ended, its id given to another process), or is now under the
  // terminal the agent got meanwhile, is left alone.
  const again = ((await read()) ?? []);
  const ownNow = underTerminal(again, opts.terminal?.());
  const still = new Set(again.filter(p => p.agentId === agentId && !ownNow.has(p.pid)).map(p => p.pid));
  for (const pid of left) {
    if (!still.has(pid)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  return result(pids.filter(pid => !left.includes(pid) || still.has(pid)));
}

/**
 * The agent's Docker containers, stopped by their label `tars.agent=<id>`, never by a name. An agent labels what it
 * starts (`docker run --label tars.agent=$CLAUDE_AGENT_ID`, said in the agent guide). No docker, or no daemon:
 * unknown, and the stop goes on.
 */
export async function stopLabelledContainers(agentId: string, opts: { path?: string } = {}): Promise<{ stopped: string[]; unknown: boolean }> {
  const env = { ...process.env, PATH: opts.path ?? buildFullPath() };
  const listed = await run('docker', ['ps', '-q', '--filter', `label=tars.agent=${agentId}`], { env });
  if (!listed.ok) return { stopped: [], unknown: true };
  const ids = listed.out.split('\n').map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) return { stopped: [], unknown: false };
  const stopped = await run('docker', ['stop', ...ids], { env });
  return { stopped: stopped.ok ? ids : [], unknown: !stopped.ok };
}

/** The agent's running containers, for the report of what outlives a session: id and name. Undefined: no docker. */
export async function labelledContainers(opts: { path?: string } = {}): Promise<Array<{ id: string; agentId: string; name: string }> | undefined> {
  const env = { ...process.env, PATH: opts.path ?? buildFullPath() };
  const listed = await run('docker', ['ps', '--filter', 'label=tars.agent', '--format', '{{.ID}}\t{{.Label "tars.agent"}}\t{{.Names}}'], { env });
  if (!listed.ok) return undefined;
  return listed.out.split('\n').map(line => line.split('\t')).filter(cols => cols.length === 3 && cols[1])
    .map(([id, agentId, name]) => ({ id, agentId, name }));
}
