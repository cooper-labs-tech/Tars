import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bornTagOf, macTagOf, envTokensOfPs, parseEnviron, tarsAndItsParents, spareReason, sharedDaemonPaths,
  readBornProcesses, endBornProcesses, stopLabelledContainers, type BornProcess,
} from '../../../electron/core/born-processes';

/**
 * What an agent started, found by its birth tag (2.0.5, the owner's lot 2 of 28/10, item C of
 * ressources-agents-proposition-2810.md): every process an agent starts inherits its terminal's environment,
 * CLAUDE_AGENT_ID (the agent) and CLAUDE_MGR_API_URL (the Tars it answers to, by its port). A stop ends what
 * holds both, reparented and detached processes included, by PID; Docker containers by their label
 * `tars.agent=<id>`. Never by a pattern.
 *
 * Measured before: after stop_agent, 1212-Capital's Playwright run and Next servers kept running; kotsna's 5 dev
 * servers (14 processes) ran 10 days with no session; Tars's own e2e left 20 `my-cli` orphans (PPID 1).
 *
 * How it fails, written before the code:
 * 1. A process whose environment holds the agent's id and this Tars's address is not found: on Linux from
 *    /proc/<pid>/environ, on macOS from `ps -E`, whose environment follows the arguments; reparented to init or
 *    launchd, or in a session of its own, included.
 * 2. Over-reach: a process is taken that holds the agent's id with another Tars's address (the sandbox on 31499,
 *    an e2e run, whose fake agents share ids like `x-claude`, and the sandbox's copy of agents.json shares real
 *    ids), or with no address, or holds the id only in its arguments (a grep for it), or (Linux) inside another
 *    variable's value. On macOS the environment is read as words after the arguments: a variable whose value
 *    holds " CLAUDE_AGENT_ID=<id> " and " CLAUDE_MGR_API_URL=<this address> " both is taken; that is left open.
 *    A process whose arguments changed between the two reads of ps is not taken.
 * 3. Tars itself, or one of its parents (a Tars started from an agent's terminal, an e2e run's app), is taken.
 * 4. The owner's limits: an ansible run or a `fly ssh` session is ended; it is kept, and said.
 * 5. A process that ignores SIGTERM outlives the stop; or a pid that is no longer the agent's by the time of the
 *    SIGKILL (its process ended and the id went to another) is killed.
 * 6. Windows: something is ended, or a process claimed, where the environment of another process cannot be read
 *    without native code: the reader says unknown.
 * 7. Docker: a container labelled `tars.agent=<id>` outlives the stop, one of another agent is stopped, or a
 *    machine with no docker (or no daemon) fails the stop.
 *
 * And after the Audit's gate of 4991b383 (AUDIT-PR523.md), written before the fix:
 * 8. M1: a kept run loses what it runs through, so it fails anyway: an ansible run's ssh children, and its
 *    ControlPersist master (`ssh: ~/.ansible/cp/... [mux]`), reparented to init or launchd, are ended.
 * 9. M2: a terminal the agent got again while the stop ran (a start from the window during the grace) is ended
 *    by that stop: its shell and its CLI carry the same tag.
 * 10. Shared daemons: colima (the Docker VM other projects run in), its limactl and the Virtualization process,
 *    docker, VS Code opened with `code .`, started by an agent, carry its tag and are ended with it, and every
 *    project loses them. They are kept by their exact executable path, resolved: never by a name or a word of
 *    the command, which any script can take; and that list only keeps, it never ends anything.
 * 11. L1 (macOS): one word injected in a variable's value (a name holding ` CLAUDE_AGENT_ID=<other>`) moves a
 *    process to another agent, whose stop ends it.
 * 5 again (L3): a SIGKILL a test cannot see, its process a zombie of the test's own until reaped: the
 *    processes here are orphans, reaped by init or launchd as soon as they die.
 * 10 again (the Audit's L5 at 1f9cd23c): on macOS the executables are read with lsof, and when it fails or times out
 *    no shared daemon is known: a colima an agent started is ended, with every project's containers. A process whose
 *    executable could not be read must be kept, and said.
 * 8 again (the Audit's re-check of 7243ef48e): the subtree is walked through the tagged processes alone, and macOS
 *    shows no environment of a platform binary: a kept run's task started through /bin/sh (every local ansible
 *    module runs as `/bin/sh -c '<python> AnsiballZ_...'`) is not under the run, and is ended.
 */

const ADDRESS = 'http://127.0.0.1:31415';
const started: Array<{ pid?: number }> = [];
afterEach(() => {
  for (const c of started.splice(0)) { try { process.kill(c.pid!, 'SIGKILL'); } catch { /* gone */ } }
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * A detached node process (its own session, as setsid makes it) with this environment, ignoring SIGTERM if told,
 * started through a parent that exits at once: an orphan, as a nohup'd server is, which init or launchd reaps the
 * moment it dies, so `alive` sees a SIGKILL (the test's own child would stay a zombie until node reaps it).
 * A deaf one says when its handler is in: on Linux /proc finds a process within milliseconds of its start, and a
 * SIGTERM sent before node installs the handler ends it. `script` replaces what it runs.
 */
type Born = { pid: number };
const ready = new Map<Born, string>();
function detached(env: Record<string, string>, opts: { deafToTerm?: boolean; file?: string; args?: string[] } = {}): Born {
  const flag = path.join(process.env.TMPDIR || os.tmpdir(), `tars-born-ready-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const deaf = opts.deafToTerm ? `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(flag)}, '1');` : '';
  const file = opts.file ?? process.execPath;
  const args = opts.args ?? ['-e', `${deaf} setInterval(() => {}, 1 << 30);`];
  const launcher = `const c = require('child_process').spawn(${JSON.stringify(file)}, ${JSON.stringify(args)}, { detached: true, stdio: 'ignore', env: ${JSON.stringify({ PATH: process.env.PATH ?? '', ...env })} }); c.unref(); process.stdout.write(String(c.pid));`;
  const child: Born = { pid: Number(execFileSync(process.execPath, ['-e', launcher], { env: { PATH: process.env.PATH ?? '' } }).toString()) };
  started.push(child);
  if (opts.deafToTerm) ready.set(child, flag);
  return child;
}
const deafReady = async (child: Born) => {
  const flag = ready.get(child)!;
  expect(await until(() => fs.existsSync(flag))).toBe(true);
  fs.rmSync(flag, { force: true });
};
async function until(check: () => boolean | Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, 50)); }
  return false;
}

describe('the birth tag, read', () => {
  it('1, 2. Linux: both entries, exact, in /proc/<pid>/environ', () => {
    const env = (s: string) => parseEnviron(s.split('|').join('\0') + '\0');
    expect(bornTagOf(env(`PATH=/bin|CLAUDE_AGENT_ID=a1|CLAUDE_MGR_API_URL=${ADDRESS}`), ADDRESS)).toBe('a1');
    expect(bornTagOf(env('CLAUDE_AGENT_ID=a1|CLAUDE_MGR_API_URL=http://127.0.0.1:31499'), ADDRESS)).toBeUndefined();
    expect(bornTagOf(env('CLAUDE_AGENT_ID=a1'), ADDRESS)).toBeUndefined();
    expect(bornTagOf(env(`NOTE=CLAUDE_AGENT_ID=a1|CLAUDE_MGR_API_URL=${ADDRESS}`), ADDRESS)).toBeUndefined();
    expect(bornTagOf(env(`CLAUDE_AGENT_ID=|CLAUDE_MGR_API_URL=${ADDRESS}`), ADDRESS)).toBeUndefined();
  });

  it('1, 2. macOS: the words of ps -E after the arguments, and none when the arguments changed', () => {
    const args = 'grep -r CLAUDE_AGENT_ID=a1 .';
    const tokens = envTokensOfPs(`${args} PATH=/bin CLAUDE_AGENT_ID=a2 CLAUDE_MGR_API_URL=${ADDRESS}`, args);
    expect(bornTagOf(tokens!, ADDRESS)).toBe('a2');
    // The id in its arguments only: not its tag.
    expect(bornTagOf(envTokensOfPs(`${args} PATH=/bin`, args)!, ADDRESS)).toBeUndefined();
    // Another Tars's address.
    expect(bornTagOf(envTokensOfPs(`${args} CLAUDE_AGENT_ID=a2 CLAUDE_MGR_API_URL=http://127.0.0.1:31499`, args)!, ADDRESS)).toBeUndefined();
    // The arguments changed between the two reads: nothing is told.
    expect(envTokensOfPs(`node other.js CLAUDE_AGENT_ID=a2 CLAUDE_MGR_API_URL=${ADDRESS}`, args)).toBeUndefined();
  });

  it('11. macOS: a word injected in a value claims nothing for another agent; the process is nobody\'s then', () => {
    const args = 'node server.js';
    const words = (env: string) => envTokensOfPs(`${args} ${env}`, args)!;
    expect(macTagOf(words(`CLAUDE_AGENT_ID=a1 CLAUDE_MGR_API_URL=${ADDRESS} CLAUDE_AGENT_NAME=Worker`), ADDRESS)).toBe('a1');
    // CLAUDE_AGENT_NAME follows the id in a terminal's environment: a name holding the other id.
    expect(macTagOf(words(`CLAUDE_AGENT_ID=a1 CLAUDE_MGR_API_URL=${ADDRESS} CLAUDE_AGENT_NAME=x CLAUDE_AGENT_ID=a2`), ADDRESS)).toBeUndefined();
    expect(macTagOf(words(`CLAUDE_AGENT_ID=a1 CLAUDE_MGR_API_URL=http://127.0.0.1:31499 NOTE=x CLAUDE_MGR_API_URL=${ADDRESS}`), ADDRESS)).toBeUndefined();
  });

  it('3. Tars and every parent of it are never the agent\'s', () => {
    const table = [{ pid: 1, ppid: 0 }, { pid: 50, ppid: 1 }, { pid: 60, ppid: 50 }, { pid: 70, ppid: 60 }, { pid: 80, ppid: 1 }];
    expect([...tarsAndItsParents(table, 70)].sort((a, b) => a - b)).toEqual([1, 50, 60, 70]);
  });

  it('4. an ansible run or a fly ssh session is kept, whatever starts it', () => {
    expect(spareReason('ansible-playbook -i hosts site.yml')).toMatch(/ansible/);
    expect(spareReason('/usr/bin/python3 /usr/local/bin/ansible-playbook site.yml')).toMatch(/ansible/);
    expect(spareReason('ansible all -m ping')).toMatch(/ansible/);
    expect(spareReason('fly ssh console -a app')).toMatch(/fly ssh/);
    expect(spareReason('/opt/homebrew/bin/flyctl ssh console')).toMatch(/fly ssh/);
    expect(spareReason('fly deploy')).toBeUndefined();
    expect(spareReason('node node_modules/.bin/next dev')).toBeUndefined();
    expect(spareReason('vim ansible.cfg')).toBeUndefined();
  });
});

// The real ps or /proc of this machine: macOS and Linux. Windows says unknown (6).
const posix = describe.skipIf(process.platform === 'win32');

posix('the birth tag, on this machine', () => {
  it('1, 2. finds a detached process of the agent and of this Tars, and nothing of another Tars or untagged', async () => {
    const mine = detached({ CLAUDE_AGENT_ID: 'agent-born-1', CLAUDE_MGR_API_URL: ADDRESS });
    const sandbox = detached({ CLAUDE_AGENT_ID: 'agent-born-1', CLAUDE_MGR_API_URL: 'http://127.0.0.1:31499' });
    const untagged = detached({ NOTE: 'agent-born-1' });
    let found: BornProcess[] | undefined;
    await until(async () => { found = await readBornProcesses({ address: ADDRESS }); return !!found?.some(p => p.pid === mine.pid); });
    const ofAgent = found!.filter(p => p.agentId === 'agent-born-1').map(p => p.pid);
    expect(ofAgent).toContain(mine.pid);
    expect(ofAgent).not.toContain(sandbox.pid);
    expect(ofAgent).not.toContain(untagged.pid);
    expect(found!.some(p => p.pid === process.pid)).toBe(false);
  });

  it('5. ends them by pid, SIGKILL after the grace for one deaf to SIGTERM, and keeps another agent\'s', async () => {
    const polite = detached({ CLAUDE_AGENT_ID: 'agent-born-2', CLAUDE_MGR_API_URL: ADDRESS });
    const deaf = detached({ CLAUDE_AGENT_ID: 'agent-born-2', CLAUDE_MGR_API_URL: ADDRESS }, { deafToTerm: true });
    const other = detached({ CLAUDE_AGENT_ID: 'agent-born-3', CLAUDE_MGR_API_URL: ADDRESS });
    await until(async () => ((await readBornProcesses({ address: ADDRESS })) ?? []).filter(p => p.agentId === 'agent-born-2').length === 2);
    await deafReady(deaf);
    const began = Date.now();
    const result = await endBornProcesses('agent-born-2', { address: ADDRESS, graceMs: 600 });
    expect(result.unknown).toBe(false);
    expect(result.ended.sort()).toEqual([polite.pid, deaf.pid].sort());
    expect(await until(() => !alive(polite.pid!) && !alive(deaf.pid!))).toBe(true);
    expect(Date.now() - began).toBeGreaterThanOrEqual(500);
    expect(alive(other.pid!)).toBe(true);
  });

  it('5. does not kill a pid that is no longer the agent\'s by the time of the SIGKILL', async () => {
    const deaf = detached({ CLAUDE_AGENT_ID: 'agent-born-4', CLAUDE_MGR_API_URL: ADDRESS }, { deafToTerm: true });
    await until(async () => !!((await readBornProcesses({ address: ADDRESS })) ?? []).some(p => p.pid === deaf.pid));
    await deafReady(deaf);
    let reads = 0;
    // The second read (before the SIGKILL) says the pid is another process's now.
    const read = async () => (++reads === 1 ? readBornProcesses({ address: ADDRESS }) : []);
    const result = await endBornProcesses('agent-born-4', { address: ADDRESS, graceMs: 300, read });
    expect(result.ended).toEqual([]);
    // A SIGKILL takes a moment to land, and the orphan is reaped as soon as it does.
    expect(await until(() => !alive(deaf.pid!), 500)).toBe(false);
  });

  it('4. keeps an ansible run of the agent alive, and says it', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-born-'));
    const fake = path.join(dir, 'ansible-playbook');
    fs.writeFileSync(fake, `#!${process.execPath}\nsetInterval(() => {}, 1 << 30);\n`, { mode: 0o755 });
    const run = detached({ CLAUDE_AGENT_ID: 'agent-born-5', CLAUDE_MGR_API_URL: ADDRESS }, { file: fake, args: ['site.yml'] });
    await until(async () => !!((await readBornProcesses({ address: ADDRESS })) ?? []).some(p => p.pid === run.pid));
    const result = await endBornProcesses('agent-born-5', { address: ADDRESS, graceMs: 300 });
    expect(result.ended).toEqual([]);
    expect(result.spared.map(p => p.pid)).toEqual([run.pid]);
    expect(alive(run.pid!)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('8. keeps what a kept ansible run works through: its ssh child, as the Audit\'s probe ran it', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-born-'));
    const ssh = path.join(dir, 'ssh');
    fs.writeFileSync(ssh, `#!${process.execPath}\nsetInterval(() => {}, 1 << 30);\n`, { mode: 0o755 });
    const childPid = path.join(dir, 'child.pid');
    const fake = path.join(dir, 'ansible-playbook');
    fs.writeFileSync(fake, `#!${process.execPath}
const c = require('child_process').spawn(${JSON.stringify(ssh)}, ['-o', 'ControlMaster=auto', 'host'], { stdio: 'ignore' });
require('fs').writeFileSync(${JSON.stringify(childPid)}, String(c.pid));
setInterval(() => {}, 1 << 30);
`, { mode: 0o755 });
    const run = detached({ CLAUDE_AGENT_ID: 'agent-born-10', CLAUDE_MGR_API_URL: ADDRESS }, { file: fake, args: ['site.yml'] });
    expect(await until(() => fs.existsSync(childPid) && fs.readFileSync(childPid, 'utf8').length > 0)).toBe(true);
    const child = { pid: Number(fs.readFileSync(childPid, 'utf8')) };
    started.push(child);
    await until(async () => ((await readBornProcesses({ address: ADDRESS })) ?? []).filter(p => p.agentId === 'agent-born-10').length === 2);
    const result = await endBornProcesses('agent-born-10', { address: ADDRESS, graceMs: 300 });
    expect(result.ended).toEqual([]);
    expect(result.spared.map(p => p.pid).sort()).toEqual([run.pid, child.pid].sort());
    expect(alive(run.pid) && alive(child.pid)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('8. keeps a kept run\'s task started through /bin/sh, as the Audit\'s re-check probed it', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-born-'));
    const grandPid = path.join(dir, 'grand.pid');
    // The task: a tagged node process (as a Homebrew or uv python is), under a shell macOS shows no environment of.
    const task = `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1 << 30)" "${grandPid}"; true`;
    const fake = path.join(dir, 'ansible-playbook');
    fs.writeFileSync(fake, `#!${process.execPath}
require('child_process').spawn('/bin/sh', ['-c', ${JSON.stringify(task)}], { stdio: 'ignore' });
setInterval(() => {}, 1 << 30);
`, { mode: 0o755 });
    const run = detached({ CLAUDE_AGENT_ID: 'agent-born-13', CLAUDE_MGR_API_URL: ADDRESS }, { file: fake, args: ['site.yml'] });
    expect(await until(() => fs.existsSync(grandPid) && fs.readFileSync(grandPid, 'utf8').length > 0)).toBe(true);
    const grand = { pid: Number(fs.readFileSync(grandPid, 'utf8')) };
    started.push(grand);
    await until(async () => !!((await readBornProcesses({ address: ADDRESS })) ?? []).some(p => p.pid === grand.pid));
    const result = await endBornProcesses('agent-born-13', { address: ADDRESS, graceMs: 300 });
    expect(result.ended).toEqual([]);
    expect(result.spared.map(p => p.pid)).toContain(grand.pid);
    expect(await until(() => !alive(grand.pid), 500)).toBe(false);
    expect(alive(run.pid)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('9. leaves out a terminal the agent got again while the stop ran, and still ends the rest', async () => {
    const tag = { CLAUDE_AGENT_ID: 'agent-born-11', CLAUDE_MGR_API_URL: ADDRESS };
    // The new terminal: a shell whose child is its CLI, both tagged as agent-pty.ts tags them; node for both, since
    // macOS shows no environment of a platform binary (/bin/sh, sleep).
    const cliScript = `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' }).pid`;
    const shell = detached(tag, { args: ['-e', `require('fs').writeFileSync(process.argv[1], String(${cliScript})); setInterval(() => {}, 1 << 30);`, path.join(process.env.TMPDIR || os.tmpdir(), `tars-born-cli-${process.pid}`)] });
    const cliFile = path.join(process.env.TMPDIR || os.tmpdir(), `tars-born-cli-${process.pid}`);
    expect(await until(() => fs.existsSync(cliFile) && fs.readFileSync(cliFile, 'utf8').trim().length > 0)).toBe(true);
    const cli = { pid: Number(fs.readFileSync(cliFile, 'utf8').trim()) };
    started.push(cli);
    fs.rmSync(cliFile, { force: true });
    const old = detached(tag);
    await until(async () => ((await readBornProcesses({ address: ADDRESS })) ?? []).filter(p => p.agentId === 'agent-born-11').length === 3);
    let asked = 0;
    // Asked after the read, as the stop asks for the agent's terminal at that moment.
    const result = await endBornProcesses('agent-born-11', { address: ADDRESS, graceMs: 300, terminal: () => { asked++; return shell.pid; } });
    expect(asked).toBeGreaterThan(0);
    expect(result.ended).toEqual([old.pid]);
    expect(await until(() => !alive(old.pid))).toBe(true);
    expect(alive(shell.pid) && alive(cli.pid)).toBe(true);
  });

  it('10. keeps a shared daemon by its exact executable path, and ends the same program elsewhere', async () => {
    const tag = { CLAUDE_AGENT_ID: 'agent-born-12', CLAUDE_MGR_API_URL: ADDRESS };
    // node stands for the daemon: the list names its executable, as SHARED_DAEMONS names colima's (a link to it
    // resolved: the next describe). Not sleep: macOS shows no environment of a platform binary, so no tag.
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-born-'));
    const shared = sharedDaemonPaths([{ name: 'a test daemon', paths: [process.execPath] }]);
    // The same program elsewhere: a copy (a clone on APFS, no space taken).
    const copy = path.join(dir, 'node');
    fs.copyFileSync(process.execPath, copy, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(copy, 0o755);
    const daemon = detached(tag);
    const sameNameElsewhere = detached(tag, { file: copy, args: ['-e', 'setInterval(() => {}, 1 << 30);'] });
    await until(async () => ((await readBornProcesses({ address: ADDRESS })) ?? []).filter(p => p.agentId === 'agent-born-12').length === 2);
    const result = await endBornProcesses('agent-born-12', { address: ADDRESS, graceMs: 300, shared });
    expect(result.spared.map(p => [p.pid, p.why])).toEqual([[daemon.pid, 'a shared daemon (a test daemon)']]);
    expect(result.ended).toEqual([sameNameElsewhere.pid]);
    expect(alive(daemon.pid)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(process.platform !== 'darwin')('10. lsof failing, on macOS', () => {
  it('keeps, and says, a process whose executable could not be read, rather than ending a shared daemon', async () => {
    const daemon = detached({ CLAUDE_AGENT_ID: 'agent-born-14', CLAUDE_MGR_API_URL: ADDRESS });
    await until(async () => !!((await readBornProcesses({ address: ADDRESS })) ?? []).some(p => p.pid === daemon.pid));
    // The daemon is a shared one by its executable, but the lsof that would say so cannot run.
    const shared = sharedDaemonPaths([{ name: 'a test daemon', paths: [process.execPath] }]);
    const result = await endBornProcesses('agent-born-14', { address: ADDRESS, graceMs: 300, shared, lsof: '/nonexistent/lsof' });
    expect(result.ended).toEqual([]);
    expect(result.spared.map(p => [p.pid, p.why])).toEqual([[daemon.pid, 'its executable could not be read (it may be a shared daemon)']]);
    expect(alive(daemon.pid)).toBe(true);
  });
});

describe('what is kept, by the owner\'s limits and the shared daemons', () => {
  it('8. ansible\'s ControlPersist master and colima\'s are kept by their title; another ssh is not', () => {
    expect(spareReason('ssh: /Users/someone/.ansible/cp/0123abcd [mux]')).toMatch(/ansible/);
    expect(spareReason('ssh: /Users/someone/.colima/_lima/colima/ssh.sock [mux]')).toMatch(/colima/);
    expect(spareReason('ssh: /tmp/elsewhere.sock [mux]')).toBeUndefined();
    expect(spareReason('ssh -o ControlPath=/Users/someone/.ansible/cp/x host')).toBeUndefined();
    expect(spareReason('ssh deploy@host')).toBeUndefined();
  });

  it('10. a shared daemon is named by its executable path, resolved; never by its name or its command', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-shared-'));
    const real = path.join(dir, 'Cellar', 'colima', '0.8.1', 'bin', 'colima');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '');
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.symlinkSync(real, path.join(dir, 'bin', 'colima'));
    const shared = sharedDaemonPaths([{ name: 'colima', paths: [path.join(dir, 'bin', 'colima'), path.join(dir, 'missing', 'colima')] }]);
    expect(spareReason('colima start', fs.realpathSync(real), shared)).toBe('a shared daemon (colima)');
    expect(spareReason('colima start', path.join(dir, 'other', 'colima'), shared)).toBeUndefined();
    expect(spareReason('colima start', undefined, shared)).toBeUndefined();
    expect(spareReason('/opt/homebrew/bin/colima start')).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('where the environment cannot be read', () => {
  it('6. Windows: unknown, and nothing ended', async () => {
    expect(await readBornProcesses({ address: ADDRESS, platform: 'win32' })).toBeUndefined();
    const result = await endBornProcesses('agent-born-6', { address: ADDRESS, platform: 'win32', graceMs: 10 });
    expect(result).toEqual({ ended: [], endedProcesses: [], spared: [], unknown: true });
  });
});

posix('Docker containers labelled with the agent', () => {
  /** A stand-in docker on PATH: `ps` answers the containers whose label filter it was given, `stop` records them. */
  function standIn(containers: Record<string, string>): { dir: string; stopped: () => string[] } {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-docker-'));
    const log = path.join(dir, 'stopped');
    fs.writeFileSync(path.join(dir, 'docker'), `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2); const all = ${JSON.stringify(containers)};
if (a[0] === 'ps') { const f = a[a.indexOf('--filter') + 1] || ''; const want = f.startsWith('label=tars.agent=') ? f.slice('label=tars.agent='.length) : null;
  process.stdout.write(Object.keys(all).filter(id => want !== null && all[id] === want).map(id => id + '\\n').join('')); }
else if (a[0] === 'stop') { fs.appendFileSync(${JSON.stringify(log)}, a.slice(1).filter(x => !x.startsWith('-')).join('\\n') + '\\n'); }
`, { mode: 0o755 });
    return { dir, stopped: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
  }

  it('7. stops the agent\'s containers, by their label, and no other\'s', async () => {
    const docker = standIn({ c1: 'agent-born-7', c2: 'agent-born-8', c3: 'agent-born-7' });
    const result = await stopLabelledContainers('agent-born-7', { path: docker.dir });
    expect(result).toEqual({ stopped: ['c1', 'c3'], unknown: false });
    expect(docker.stopped().sort()).toEqual(['c1', 'c3']);
    fs.rmSync(docker.dir, { recursive: true, force: true });
  });

  it('7. a machine with no docker: unknown, and the stop goes on', async () => {
    const empty = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-nodocker-'));
    expect(await stopLabelledContainers('agent-born-9', { path: empty })).toEqual({ stopped: [], unknown: true });
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
