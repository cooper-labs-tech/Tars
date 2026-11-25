import './home-guard';
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Leftovers, RECORDS_ITS_PID, endLeftUnder, processesUnder, takePidsRecordedIn } from './leftover-processes';

/**
 * The witness for leftover-processes.ts, which the ACP tests end their
 * leftover processes through.
 *
 * How it can fail:
 *  1. a process the test saw, still running, is left running;
 *  2. win32: a process that holds an id only since the test saw it, which
 *     Windows handed out again once the one the test meant had exited, is
 *     ended: any process of the machine, a vitest worker included;
 *  3. an id that is not a positive integer is signalled: 0 is the caller's
 *     own process on Windows and its whole process group elsewhere, -1 every
 *     process the account may signal.
 *
 * Written on 2026-10-19, before the code, after 130 fake ACP agents were found
 * stopped (state T, parent 1), all started from
 * /T/tars-vitest-run-<id>/tars-vitest-file-<id>/tars-acp-<id>/, and ended by
 * hand. A delegated run's stop (endProcessTree in acp/client.ts) stops the
 * run's processes with SIGSTOP and reads ps before it sends SIGTERM and
 * SIGCONT; the test does not wait for it, and a worker that ends in between
 * leaves them stopped for good. What a test starts by way of the code under
 * test, the test ends in its own teardown, and what still runs from the run's
 * folder at its end fails the run (tmpdir-run.ts). The ways that can fail:
 *  4. a process started from the folder and stopped by SIGSTOP is missed, or
 *     found and left alive: a SIGTERM waits for a SIGCONT that never comes,
 *     and only SIGKILL ends a stopped process;
 *  5. a process started from the folder and still running is missed;
 *  6. a process whose command line names another folder, whose name only
 *     begins like this one's (run-1 beside run-10), is found, and ended;
 *  7. a process that ends on its own within the grace is counted as left: as
 *     the run ends, its workers' children read the end of their stdin and go;
 *  8. a fake agent's id, which the code under test starts and the test never
 *     sees, is not where the test's teardown reads it, so the teardown ends
 *     nothing;
 *  9. an id a teardown took is taken again by the next one, and ended again:
 *     on Windows another process may hold it by then, seen as new.
 * A zombie, exited and not yet reaped, has no command line any more (ps shows
 * `<defunct>` on macOS and Linux), so no folder can be read from it; the code
 * skips one all the same where a ps would show it.
 */

const started: ChildProcess[] = [];
// SIGKILL: a test below stops its process, and a stopped process takes a SIGTERM only once continued.
afterEach(() => { for (const child of started.splice(0)) { try { process.kill(child.pid!, 'SIGKILL'); } catch { /* gone */ } } });

function running(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  started.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', () => resolve(child));
    child.once('error', reject);
  });
}

const exited = (child: ChildProcess) => new Promise<boolean>(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
  const timer = setTimeout(() => resolve(false), 5_000);
  child.once('exit', () => { clearTimeout(timer); resolve(true); });
});

describe('the leftovers a test ends', { timeout: 60_000 }, () => {
  it('ends a process it saw that still runs (1)', async () => {
    const child = await running();
    const leftovers = new Leftovers();
    leftovers.push(child.pid!);

    leftovers.end();

    expect(await exited(child)).toBe(true);
  });

  it.runIf(process.platform === 'win32')('leaves a process created after its id was seen, which is not the one seen (2)', async () => {
    const child = await running();
    // Seen a minute before this process existed: the id was another's then.
    const leftovers = new Leftovers(() => Date.now() - 60_000);
    leftovers.push(child.pid!);

    leftovers.end();

    expect(await exited(child)).toBe(false);
  });

  it('never keeps an id that is not a positive integer (3)', () => {
    const leftovers = new Leftovers();
    expect(leftovers.push(0, -1, Number.NaN, 1.5, Number(''))).toBe(0);
    // Were 0 kept, this would end this very worker on Windows, and the file
    // would report nothing.
    leftovers.end();
  });

  it.skipIf(process.platform === 'win32')('ends a process it saw while it is stopped (4)', async () => {
    const child = await running();
    process.kill(child.pid!, 'SIGSTOP');
    const leftovers = new Leftovers();
    leftovers.push(child.pid!);

    leftovers.end();

    expect(await exited(child)).toBe(true);
  });
});

/** A folder of its own, and a process started from it as the code under test starts one: a script there, detached. */
function folder(name: string): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leftovers-')), name);
  fs.mkdirSync(dir);
  return dir;
}

function startFrom(dir: string, body = 'setInterval(() => {}, 1000);'): Promise<ChildProcess> {
  const script = path.join(dir, 'agent.js');
  fs.writeFileSync(script, `process.stdout.write('ready');\n${body}\n`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
  started.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', () => resolve(child));
    child.once('error', reject);
  });
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('what still runs from a folder, at the end of a run', { timeout: 60_000 }, () => {
  it.skipIf(process.platform === 'win32')('4. finds a process started from it while it is stopped, ends it, and names it', async () => {
    const dir = folder('run');
    const child = await startFrom(dir);
    process.kill(child.pid!, 'SIGSTOP');

    const left = await endLeftUnder(dir, 200);

    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ pid: child.pid });
    expect(left[0].state, 'read while it was stopped').toMatch(/^T/);
    expect(left[0].command).toContain(path.join(dir, 'agent.js'));
    expect(await exited(child), 'still there, stopped').toBe(true);
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('5. finds a process started from it that still runs, ends it, and names it', async () => {
    const dir = folder('run');
    const child = await startFrom(dir);

    expect(processesUnder(dir).map(p => p.pid)).toEqual([child.pid]);
    const left = await endLeftUnder(dir, 200);

    expect(left.map(p => p.pid)).toEqual([child.pid]);
    expect(await exited(child)).toBe(true);
  });

  it('6. leaves a process started from a folder whose name only begins like this one\'s', async () => {
    const dir = folder('run-1');
    const sibling = path.join(path.dirname(dir), 'run-10');
    fs.mkdirSync(sibling);
    const stranger = await startFrom(sibling);

    expect(processesUnder(dir)).toEqual([]);
    expect(await endLeftUnder(dir, 100)).toEqual([]);
    expect(alive(stranger.pid!), 'another folder\'s process was ended').toBe(true);
  });

  it('7. does not count a process that ends on its own within the grace', async () => {
    const dir = folder('run');
    const child = await startFrom(dir, 'setTimeout(() => {}, 300);');

    const left = await endLeftUnder(dir, 5_000);

    expect(left).toEqual([]);
    expect(await exited(child)).toBe(true);
    expect(child.signalCode, 'ended by the guard, not on its own').toBeNull();
  });

  it('8. reads back the id a fake agent recorded at its start, which the code under test started', async () => {
    const dir = folder('acp');
    const script = path.join(dir, 'agent.mjs');
    fs.writeFileSync(script, `${RECORDS_ITS_PID}process.stdout.write('ready');\n`);
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
    started.push(child);

    expect(await exited(child)).toBe(true);
    expect(child.exitCode).toBe(0);
    expect(takePidsRecordedIn(dir)).toEqual([child.pid]);
  });

  it('8. reads no id from a folder where no fake agent started', () => {
    expect(takePidsRecordedIn(folder('none'))).toEqual([]);
  });

  it('9. gives each id once: the next teardown takes only those recorded since', async () => {
    const dir = folder('acp');
    const script = path.join(dir, 'agent.mjs');
    fs.writeFileSync(script, `${RECORDS_ITS_PID}process.stdout.write('ready');\n`);
    const first = spawn(process.execPath, [script], { stdio: 'ignore' });
    started.push(first);
    expect(await exited(first)).toBe(true);

    expect(takePidsRecordedIn(dir)).toEqual([first.pid]);
    expect(takePidsRecordedIn(dir), 'taken twice').toEqual([]);

    const second = spawn(process.execPath, [script], { stdio: 'ignore' });
    started.push(second);
    expect(await exited(second)).toBe(true);
    expect(takePidsRecordedIn(dir)).toEqual([second.pid]);
  });
});
