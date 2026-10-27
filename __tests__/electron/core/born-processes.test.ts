import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bornTagOf, envTokensOfPs, parseEnviron, tarsAndItsParents, spareReason,
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
 */

const ADDRESS = 'http://127.0.0.1:31415';
const started: ChildProcess[] = [];
afterEach(() => {
  for (const c of started.splice(0)) { try { process.kill(c.pid!, 'SIGKILL'); } catch { /* gone */ } }
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A detached node process (its own session, as setsid makes it) with this environment, ignoring SIGTERM if told. */
function detached(env: Record<string, string>, opts: { deafToTerm?: boolean } = {}): ChildProcess {
  const script = `${opts.deafToTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1 << 30);`;
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH ?? '', ...env } });
  child.unref();
  started.push(child);
  return child;
}
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
    let reads = 0;
    // The second read (before the SIGKILL) says the pid is another process's now.
    const read = async () => (++reads === 1 ? readBornProcesses({ address: ADDRESS }) : []);
    const result = await endBornProcesses('agent-born-4', { address: ADDRESS, graceMs: 300, read });
    expect(result.ended).toEqual([]);
    expect(alive(deaf.pid!)).toBe(true);
  });

  it('4. keeps an ansible run of the agent alive, and says it', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-born-'));
    const fake = path.join(dir, 'ansible-playbook');
    fs.writeFileSync(fake, `#!${process.execPath}\nsetInterval(() => {}, 1 << 30);\n`, { mode: 0o755 });
    const run = spawn(fake, ['site.yml'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH ?? '', CLAUDE_AGENT_ID: 'agent-born-5', CLAUDE_MGR_API_URL: ADDRESS } });
    run.unref();
    started.push(run);
    await until(async () => !!((await readBornProcesses({ address: ADDRESS })) ?? []).some(p => p.pid === run.pid));
    const result = await endBornProcesses('agent-born-5', { address: ADDRESS, graceMs: 300 });
    expect(result.ended).toEqual([]);
    expect(result.spared.map(p => p.pid)).toEqual([run.pid]);
    expect(alive(run.pid!)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('where the environment cannot be read', () => {
  it('6. Windows: unknown, and nothing ended', async () => {
    expect(await readBornProcesses({ address: ADDRESS, platform: 'win32' })).toBeUndefined();
    const result = await endBornProcesses('agent-born-6', { address: ADDRESS, platform: 'win32', graceMs: 10 });
    expect(result).toEqual({ ended: [], spared: [], unknown: true });
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
