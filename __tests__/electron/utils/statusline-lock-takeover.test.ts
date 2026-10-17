import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { STATUSLINE_SCRIPT } from '../../../electron/utils/statusline';
import { shHooksNotShipped } from '../../setup/platform-limits';

/**
 * Taking over the token-stats lock a dead render left, and releasing one's
 * own, with several renders at once.
 *
 * A render that finds the lock held waits a second, and if the lock is then
 * over 5 s old, it takes the holder for dead and takes the lock over. That
 * takeover was `rmdir` then `mkdir`. Two renders that had judged the same dead
 * lock stale could both pass there: the second removed the lock the first had
 * just taken, and both wrote the count at once (the Audit's review of #216). A
 * render also released its lock by removing whatever lock was there. So a
 * render slow past 5 s, whose lock had been taken over, removed the new
 * holder's (QA's gate of #216).
 *
 * How it fails, written before the code:
 * 1. a render that judged a dead lock stale removes it after another render has
 *    taken it over, and writes beside that render;
 * 2. a render's release removes a lock that is no longer its own;
 * 3. a lock 5 s old is taken for dead. QA's surviving mutant of #216 set the
 *    threshold to 1 s and no test saw it;
 * 4. a lock 6 s old, left by a render killed while it held it, is never taken
 *    over, and every render after it skips its write;
 * 5. a render killed while taking a dead lock over leaves something behind that
 *    stops every later takeover;
 * 6. two renders are inside the takeover of the same dead lock at once, so the
 *    one that comes second removes the lock the first has just taken.
 *
 * As in statusline-lock.test.ts, the installed script runs through bash and jq
 * in a temp HOME, with stand-ins on the PATH that act at the one moment that
 * matters:
 * - `date`, asked for the entry's date while the lock is held, holds a render
 *   there until told to go. Asked for the time, it can give a frozen one, so
 *   that an age is exact however loaded the machine is;
 * - `stat`, asked for the lock's age, lets another render take the lock over
 *   before handing back the age it read.
 * A dead holder is a render killed with SIGKILL while it holds the lock, so the
 * lock is left exactly as the script leaves it.
 */

const STAND_IN_DATE = `#!/bin/bash
# FREEZE_NOW: the time a render reads, frozen, so that the ages it works out
# do not grow while it waits its second, however loaded the machine is.
if [ "\${1:-}" = "+%s" ] && [ -n "\${FREEZE_NOW:-}" ]; then
  echo "$FREEZE_NOW"
  exit 0
fi
# The entry's date is asked for while the lock is held. A render named in
# HOLD_AS says so, and waits there holding the lock until told to go.
if [ "\${1:-}" = "+%Y-%m-%d" ] && [ -n "\${HOLD_AS:-}" ]; then
  touch "$HOME/$HOLD_AS.holds"
  n=0
  while [ ! -e "$HOME/$HOLD_AS.go" ] && [ ! -e "$HOME/all.go" ] && [ $n -lt 600 ]; do sleep 0.05; n=$((n + 1)); done
fi
exec /bin/date "$@"
`;

const STAND_IN_STAT = `#!/bin/bash
# The lock's age, read by a render that found it held. Reads that work are
# counted, and INTERLEAVE and KILL_AT name one of them.
# - INTERLEAVE: at that read, render A (a.json, HOLD_AS=A) comes in, its clock
#   frozen at that moment. It either takes the lock over and holds it, or ends.
#   Only then is the age read before A came handed back.
# - KILL_AT: at that read, this render and its stand-ins are killed with
#   SIGKILL.
lock="$HOME/.dorothy/token-stats.lock"
for last; do :; done
if [ "$last" = "$lock" ] && before=$(/usr/bin/stat "$@" 2>/dev/null); then
  count=$(( $(cat "$HOME/lock-stats" 2>/dev/null || echo 0) + 1 ))
  echo "$count" > "$HOME/lock-stats"
  if [ "\${KILL_AT:-}" = "$count" ]; then
    kill -9 0
  fi
  if [ "\${INTERLEAVE:-}" = "$count" ]; then
    now="\${FREEZE_NOW:-$(/bin/date +%s)}"
    (INTERLEAVE= KILL_AT= HOLD_AS=A FREEZE_NOW="$now" bash "$SCRIPT" < "$HOME/a.json"; touch "$HOME/A.ended") > "$HOME/a.out" 2>&1 &
    n=0
    while [ ! -e "$HOME/A.holds" ] && [ ! -e "$HOME/A.ended" ] && [ $n -lt 600 ]; do sleep 0.05; n=$((n + 1)); done
  fi
  printf '%s\\n' "$before"
  exit 0
fi
exec /usr/bin/stat "$@"
`;

// Every case starts real renders, each waiting its second on a held lock: under
// load that is well past vitest's default 5 s (a load average of 89 measured).
vi.setConfig({ testTimeout: 60_000 });

let script: string;
const homes: string[] = [];
const children: ChildProcess[] = [];

beforeAll(() => {
  if (shHooksNotShipped()) return;
  const jq = spawnSync('jq', ['--version'], { encoding: 'utf-8' });
  if (jq.status !== 0) throw new Error('jq is not on PATH: the status line needs it, and so do these cases');
  // The bash status line, the reference hooks/statusline.mjs follows: Tars runs that one everywhere since 2.0.4.
  script = path.join(os.homedir(), '.dorothy', 'statusline.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, STATUSLINE_SCRIPT, { mode: 0o755 });
});

afterEach(async () => {
  for (const home of homes) fs.writeFileSync(path.join(home, 'all.go'), '');
  for (const child of children.splice(0)) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  // A render let go by all.go ends within moments: give it those before its HOME goes.
  await new Promise(resolve => setTimeout(resolve, 300));
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function input(session: string): string {
  return JSON.stringify({ session_id: session, model: { display_name: 'Opus 5' }, context_window: {}, cost: {} });
}

async function until(condition: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function bench() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-stats-takeover-'));
  homes.push(home);
  const dorothy = path.join(home, '.dorothy');
  fs.mkdirSync(dorothy);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'date'), STAND_IN_DATE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'stat'), STAND_IN_STAT, { mode: 0o755 });
  const lock = path.join(dorothy, 'token-stats.lock');
  const stats = path.join(dorothy, 'token-stats.json');
  const env = (extra: Record<string, string> = {}) => ({ PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, SCRIPT: script, ...extra });
  const at = (name: string) => path.join(home, name);

  /** A render run to its end. */
  const render = (session: string, extra: Record<string, string> = {}) => spawnSync('bash', [script], {
    input: input(session), cwd: home, encoding: 'utf-8', env: env(extra),
  });

  /** A render started in its own process group, left running. */
  const start = (session: string, extra: Record<string, string> = {}) => {
    const child = spawn('bash', [script], { cwd: home, env: env(extra), detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    children.push(child);
    child.stdin!.end(input(session));
    return child;
  };

  const ended = (child: ChildProcess) => until(() => child.exitCode !== null || child.signalCode !== null, 'a render to end');

  /** Every file and folder the lock is made of, backdated to a whole second. Returns that second. */
  const backdate = (seconds: number): number => {
    const second = Math.floor(Date.now() / 1000) - seconds;
    const when = new Date(second * 1000);
    const walk = (entry: string): void => {
      if (fs.statSync(entry).isDirectory()) for (const name of fs.readdirSync(entry)) walk(path.join(entry, name));
      fs.utimesSync(entry, when, when);
    };
    for (const name of fs.readdirSync(dorothy)) if (name.startsWith('token-stats.lock')) walk(path.join(dorothy, name));
    return second;
  };

  /** A render killed with SIGKILL while it holds the lock, `seconds` ago. Returns the lock's time, in seconds. */
  const deadHolder = async (seconds: number): Promise<number> => {
    const child = start('sK', { HOLD_AS: 'K' });
    await until(() => fs.existsSync(at('K.holds')), 'render K to hold the lock');
    process.kill(-child.pid!, 'SIGKILL');
    await ended(child);
    return backdate(seconds);
  };

  const sessions = (): string[] => (fs.existsSync(stats) ? Object.keys(JSON.parse(fs.readFileSync(stats, 'utf-8'))) : []);

  return { home, lock, at, render, start, ended, backdate, deadHolder, sessions };
}

// The Node status line's side: node-statusline.test.ts.
describe.skipIf(shHooksNotShipped())('taking over the token-stats lock, and releasing it', () => {
  it('1. a render that judged a dead lock stale leaves it to the render that took it over first', async () => {
    const b = bench();
    await b.deadHolder(60);
    fs.writeFileSync(b.at('a.json'), input('sA'));

    const run = b.render('sB', { INTERLEAVE: '1' });

    expect(run.status, run.stderr).toBe(0);
    expect(fs.existsSync(b.at('A.holds')), 'render A never took the lock over').toBe(true);
    expect(fs.existsSync(b.lock), "render A's lock was removed while A held it").toBe(true);
    expect(b.sessions(), 'render B wrote beside render A').not.toContain('sB');

    fs.writeFileSync(b.at('A.go'), '');
    await until(() => !fs.existsSync(b.lock) && b.sessions().includes('sA'), 'render A to write and release');
  });

  it('2. a render slow past 5 s leaves, as it releases, the lock another render took over from it', async () => {
    const b = bench();
    const slow = b.start('sS', { HOLD_AS: 'S' });
    await until(() => fs.existsSync(b.at('S.holds')), 'render S to hold the lock');
    b.backdate(60);
    const taker = b.start('sT', { HOLD_AS: 'T' });
    await until(() => fs.existsSync(b.at('T.holds')), 'render T to take the lock over');

    fs.writeFileSync(b.at('S.go'), '');
    await b.ended(slow);

    expect(fs.existsSync(b.lock), "render S's release removed render T's lock").toBe(true);
    fs.writeFileSync(b.at('T.go'), '');
    await b.ended(taker);
    expect(fs.existsSync(b.lock)).toBe(false);
    // T read the file before S wrote, so T's write replaces S's: what a lock
    // taken from a render still alive costs. The release is what is tested.
    expect(b.sessions()).toContain('sT');
  });

  it('3. a lock 5 s old is not taken for dead', async () => {
    const b = bench();
    const since = await b.deadHolder(60);

    const run = b.render('sB', { FREEZE_NOW: String(since + 5) });

    expect(run.status, run.stderr).toBe(0);
    expect(b.sessions()).not.toContain('sB');
    expect(fs.existsSync(b.lock)).toBe(true);
  });

  it('4. a lock 6 s old, its holder dead, is taken over', async () => {
    const b = bench();
    const since = await b.deadHolder(60);

    const run = b.render('sB', { FREEZE_NOW: String(since + 6) });

    expect(run.status, run.stderr).toBe(0);
    expect(b.sessions()).toContain('sB');
    expect(fs.existsSync(b.lock)).toBe(false);
  });

  it('5. a render killed while taking a dead lock over does not stop the next takeover', async () => {
    const b = bench();
    await b.deadHolder(60);
    // Killed at its second read of the lock's age: when there is one, it is
    // taken in the middle of the takeover.
    const killed = b.start('sR', { KILL_AT: '2' });
    await b.ended(killed);
    fs.rmSync(b.at('lock-stats'), { force: true });
    b.backdate(60);

    const run = b.render('sN');

    expect(run.status, run.stderr).toBe(0);
    expect(b.sessions()).toContain('sN');
    expect(fs.readdirSync(path.dirname(b.lock)).filter(name => name.startsWith('token-stats.lock')), 'left behind').toEqual([]);
  });

  it('6. a render that comes in while another is taking the dead lock over leaves the takeover to it', async () => {
    const b = bench();
    await b.deadHolder(60);
    fs.writeFileSync(b.at('a.json'), input('sA'));

    // Render A comes in at render B's second read of the lock's age: when
    // there is one, B is in the middle of its takeover.
    const run = b.render('sB', { INTERLEAVE: '2' });

    expect(run.status, run.stderr).toBe(0);
    expect(fs.existsSync(b.at('A.holds')), 'render A took the lock over while render B was taking it over').toBe(false);
    expect(b.sessions()).toContain('sB');
    await until(() => !fs.existsSync(b.lock), 'the lock to be released');
  });
});
