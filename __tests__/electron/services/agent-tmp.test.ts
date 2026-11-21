import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { TMP_ROOT, agentTmpEnv, enforceTmpRetention, shortIdOf } from '../../../electron/services/agent-tmp';
import { DATA_DIR } from '../../../electron/constants';
import { hasPosixModes } from '../../setup/platform-limits';
import { cannotSymlink } from '../../setup/symlink-privilege';

/**
 * A durable temporary folder per agent (RD-REDEMARRAGE.md, 2.1; JeanBrasse's yes of 2026-10-05): macOS empties /private/tmp
 * and the app's /var/folders/.../T at every boot, and with them every agent's scratchpad and the output of its
 * background tasks (about 45 GB on the night of 2026-10-01). Each agent gets ~/.tars/tmp/<short id>/: `t/` as the
 * TMPDIR of its commands, `c/` as Claude Code's CLAUDE_CODE_TMPDIR. Kept 7 days and 20 GB in all, or the disk fills up
 * again as it did that night.
 *
 * How it can fail, written before the code:
 *  1. A CLI gets a folder the boot wipes: no TMPDIR or no CLAUDE_CODE_TMPDIR, or one outside ~/.tars/tmp.
 *  2. Two agents share a folder, or one agent gets another folder at its next launch (its scratchpad lost to it); the
 *     path is long enough to break a Unix socket under it.
 *  3. The folder is not there when the CLI starts, is readable by other accounts, or is a link someone planted to send
 *     the agent's files elsewhere, and the link is followed.
 *  4. The retention deletes something younger than 7 days (dated by the newest change in it, a file or a folder, not
 *     by its top folder alone), or anything of an agent whose CLI is running.
 *  5. It keeps more than the cap while older things could go, or deletes the newest first.
 *  6. With under 30 GB free on the disk, the cap stays at 20 GB instead of 10 GB.
 *  7. A deleted agent's folder stays for ever.
 *  8. It follows a link out of ~/.tars/tmp, and measures or deletes what the link points at; or it deletes anything
 *     outside the root, or the root itself when it is a link.
 *  9. A deletion is not logged.
 * 10. Something it cannot read or delete stops the pass.
 * 11. (the Audit's gate of #306) The root is checked once, then a long pass deletes by path: an agent that swaps
 *     ~/.tars/tmp for a link while the pass runs makes Tars delete an entry of the same name elsewhere.
 * Measured on 2026-10-13 (~/.tars/tmp: 22 GB, 1.24 million files, 21 agents), and written before the code:
 * 12. An agent whose CLI runs keeps everything for as long as it runs: one agent's folder held 18.5 GB, its project's
 *     test sandboxes and build folders in `t/` (5,638 `staging-job-machines-*`, 3,793 build folders, 945 `e2e-step-*`),
 *     and the pass deleted nothing, "what is left belongs to agents whose CLI runs". Its `t/` entries and the folders
 *     of its ended sessions in `c/` go once nothing touched them for a day; the folder of the session it runs (or
 *     would resume) never does, however old.
 * 13. The pass walks every file of every agent every hour, even when nothing can go: 1.36 million lstat and 94,000
 *     readdir, 49 s, 7 s of it on the main thread. A unit seen young cannot be old enough to go before its limit, so it
 *     is not walked again until then; its size is refreshed every 6 hours.
 * 14. (the Audit's M1 on #384) A running CLI's socket goes after a day: claude 2.1.296 keeps its messaging socket at
 *     `c/cc-socks/<pid>.sock`, dated its start and never touched, and a server an agent starts keeps one in `t/` (tmux,
 *     an editor, ssh). While its agent runs, a unit holding a socket or a FIFO is kept, and in `c/` only an ended
 *     session's folder is a leftover.
 * 14b. The other way round: a socket or a FIFO its server left behind, its agent stopped, stays forever. The 7-day
 *     rule takes it as any unit.
 * 15. (L1) A unit measured old, then written to, goes at the next pass on the date measured before: the measure is
 *     reused only while it says the unit is young.
 * 16. (L3) A unit written between its measure and its deletion (a pass can take 100 s) goes anyway: its top's date is
 *     read again just before it is deleted.
 * From QA's gate of #601's stack (agent-tmp.log, 21/11 02:18 UTC), written before the code:
 * 17. What a live process uses goes on its dates alone: running a binary changes no date, and QA's `t/codex-0170`
 *     (380 MB) and `t/kimi-2.6.3` went while the gate ran them, the conformance skipping codex and Kimi. A unit that a
 *     live process uses (its executable, its current folder, a file it holds open, or a path its command line names)
 *     is kept, by every rule (a day, 7 days, the cap), whoever's process it is.
 * 18. The processes cannot be read (no lsof, a read that never ends): the pass deletes on dates alone. It deletes
 *     nothing that pass, and says so.
 * 19. A path in use is spelled another way than the unit (macOS's /tmp is /private/tmp, a home reached through a
 *     link): both spellings of the unit are compared.
 * 20. A prefix is taken for a folder: `t/tool` in use keeps `t/tool-old`, or a path outside the root keeps something.
 * 21. A tool run within the day and ended goes: running an executable moves its access time (measured on APFS 21/11;
 *     Linux's relatime too), so an executable's access time counts as a use. A data file's does not: reading it does
 *     not move it on APFS (unless older than its change), and a daily indexer's reads would keep everything on Linux.
 * 22. (Windows) A unit in use is half deleted: a recursive removal deletes what it can, then fails on what Windows
 *     holds (a running image, a process's current folder), and the processes' own paths are not all read there. The
 *     unit is moved aside first, in one step, which Windows refuses while it is used: kept whole. (On macOS and Linux
 *     a move is never refused for use, and the processes' paths are read: 17.)
 * 23. A pass that deletes nothing reads the processes: they are read once a unit is about to go, once per pass.
 * From the Audit's L1 on #627 (816c06672):
 * 24. The cap deletes what the pass before 17 kept: a unit kept for its use still counted toward the cap, so the cap
 *     went on to the next oldest idle unit (A in use, the oldest; B idle; the cap met once A goes: B went), and a unit
 *     of a running agent kept by the day rule pushed the total over the cap, taking an idle unit of an agent at rest.
 *     A unit a process uses does not count toward the cap: the pass deletes what it deleted before, less what is used.
 *     The same for a tool run recently (21): the cap orders units by their changes, as before, a run never moving an
 *     idle unit ahead of it, and what was run counts out of the cap.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const GB = 1024 ** 3;
let root: string;
let outside: string;
let logs: string[];

/** A file of `bytes`, written `ageDays` ago, in folders last changed then too (a folder's own date is activity). */
function put(rel: string, bytes = 10, ageDays = 0): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
  const at = new Date(NOW - ageDays * DAY);
  fs.utimesSync(file, at, at);
  age(path.dirname(rel), ageDays);
  return file;
}
/** Dates a folder and every folder above it inside the root, as a long-untouched tree would be. */
function age(rel: string, ageDays: number) {
  const at = new Date(NOW - ageDays * DAY);
  let dir = path.join(root, rel);
  while (dir.startsWith(root + path.sep)) {
    fs.utimesSync(dir, at, at);
    dir = path.dirname(dir);
  }
}
const exists = (rel: string) => fs.existsSync(path.join(root, rel));

function deps(over: Partial<Parameters<typeof enforceTmpRetention>[0]> = {}) {
  return {
    root, now: () => NOW, liveAgentIds: () => [] as string[], knownAgentIds: () => ['worker', 'lead'],
    freeBytes: () => 200 * GB, log: (line: string) => { logs.push(line); }, ...over,
  };
}

beforeEach(() => {
  root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-agent-tmp-')), 'tmp');
  fs.mkdirSync(root);
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-agent-tmp-outside-'));
  logs = [];
});

afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("an agent's folder", () => {
  it('1, 2. TMPDIR and CLAUDE_CODE_TMPDIR under ~/.tars/tmp, one folder per agent, the same at every launch, short', () => {
    expect(TMP_ROOT).toBe(path.join(DATA_DIR, 'tmp'));
    const a = agentTmpEnv('0941a7e6-7262-4068-ba83-68b7e0de1773', root);
    const again = agentTmpEnv('0941a7e6-7262-4068-ba83-68b7e0de1773', root);
    const b = agentTmpEnv('6bd992b2-e7b5-4e27-8b25-e82a8e43e7bd', root);

    expect(a).toEqual(again);
    expect(a.TMPDIR).toBe(path.join(root, shortIdOf('0941a7e6-7262-4068-ba83-68b7e0de1773'), 't'));
    expect(a.CLAUDE_CODE_TMPDIR).toBe(path.join(root, shortIdOf('0941a7e6-7262-4068-ba83-68b7e0de1773'), 'c'));
    expect(path.dirname(b.TMPDIR)).not.toBe(path.dirname(a.TMPDIR));
    expect(shortIdOf('x')).toMatch(/^[0-9a-f]{10}$/);
    expect(path.join(TMP_ROOT, shortIdOf('x'), 'c').length - DATA_DIR.length).toBeLessThanOrEqual(20);
  });

  it('3. is there before the CLI starts, its owner alone, and a planted link is replaced, not followed', () => {
    const id = 'worker';
    // Only where this account may make a link (symlink-privilege.ts): the folders are checked everywhere.
    if (!cannotSymlink()) fs.symlinkSync(outside, path.join(root, shortIdOf(id)));

    const env = agentTmpEnv(id, root);

    for (const dir of [path.dirname(env.TMPDIR), env.TMPDIR, env.CLAUDE_CODE_TMPDIR]) {
      const st = fs.lstatSync(dir);
      expect(st.isDirectory() && !st.isSymbolicLink()).toBe(true);
      if (hasPosixModes()) expect(st.mode & 0o777).toBe(0o700);
    }
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe('the retention', () => {
  const W = () => shortIdOf('worker');
  const L = () => shortIdOf('lead');

  it('4. deletes what nothing touched for 7 days, dated by its newest file, and keeps the rest', async () => {
    put(`${W()}/t/old-scratch/a.txt`, 10, 9);
    put(`${W()}/t/old-file.log`, 10, 8);
    put(`${W()}/t/mixed/old.txt`, 10, 20);
    put(`${W()}/t/mixed/new.txt`, 10, 1);
    put(`${W()}/c/claude-501/-work-tars/sess-old/tasks/x.output`, 10, 10);
    put(`${W()}/c/claude-501/-work-tars/sess-new/scratchpad/y.md`, 10, 2);
    age(`${W()}/t/mixed`, 30);
    age(`${W()}/c/claude-501/-work-tars/sess-new`, 30);

    await enforceTmpRetention(deps());

    expect(exists(`${W()}/t/old-scratch`)).toBe(false);
    expect(exists(`${W()}/t/old-file.log`)).toBe(false);
    expect(exists(`${W()}/c/claude-501/-work-tars/sess-old`)).toBe(false);
    expect(exists(`${W()}/t/mixed/old.txt`), 'a unit goes whole or not at all').toBe(true);
    expect(exists(`${W()}/c/claude-501/-work-tars/sess-new/scratchpad/y.md`)).toBe(true);
    expect(exists(`${W()}/t`)).toBe(true);
  });

  it('12. an agent whose CLI runs keeps what was touched within a day, and its live session whatever its age', async () => {
    put(`${W()}/t/sandbox-of-a-test-run/home/x.json`, 10, 2);
    put(`${W()}/t/build-folder/ssr/chunk.js`, 10, 1.5);
    put(`${W()}/t/fresh.txt`, 10, 0.5);
    put(`${W()}/c/claude-501/-work-tars/live-session/scratchpad/big.bin`, 10, 30);
    put(`${W()}/c/claude-501/-work-tars/resumable-session/scratchpad/a.md`, 10, 20);
    put(`${W()}/c/claude-501/-work-tars/ended-session/scratchpad/old.md`, 10, 3);
    put(`${W()}/c/claude-501/-work-tars/ended-but-fresh/scratchpad/new.md`, 10, 0.2);

    await enforceTmpRetention(deps({
      liveAgentIds: () => ['worker'],
      sessionsOf: (id: string) => (id === 'worker' ? ['live-session', 'resumable-session'] : []),
    }));

    expect(exists(`${W()}/t/sandbox-of-a-test-run`)).toBe(false);
    expect(exists(`${W()}/t/build-folder`)).toBe(false);
    expect(exists(`${W()}/t/fresh.txt`)).toBe(true);
    expect(exists(`${W()}/c/claude-501/-work-tars/live-session/scratchpad/big.bin`)).toBe(true);
    expect(exists(`${W()}/c/claude-501/-work-tars/resumable-session/scratchpad/a.md`)).toBe(true);
    expect(exists(`${W()}/c/claude-501/-work-tars/ended-session`)).toBe(false);
    expect(exists(`${W()}/c/claude-501/-work-tars/ended-but-fresh/scratchpad/new.md`)).toBe(true);
    expect(logs.join('\n')).toMatch(/untouched for a day, its agent running/);
  });

  it('5. past the cap, deletes the oldest first, down to the cap, live agents aside', async () => {
    put(`${W()}/t/oldest.bin`, 4000, 5);
    put(`${W()}/t/middle.bin`, 4000, 3);
    put(`${L()}/t/newest.bin`, 4000, 1);
    put(`${L()}/t/live-is-lead.bin`, 0, 0);

    await enforceTmpRetention(deps({ capBytes: 9000 }));

    expect(exists(`${W()}/t/oldest.bin`)).toBe(false);
    expect(exists(`${W()}/t/middle.bin`)).toBe(true);
    expect(exists(`${L()}/t/newest.bin`)).toBe(true);

    // Touched within the day: a running agent's, kept over the cap (12 deletes it once a day old).
    put(`${W()}/t/more.bin`, 8000, 0.5);
    await enforceTmpRetention(deps({ capBytes: 9000, liveAgentIds: () => ['worker'] }));
    expect(exists(`${W()}/t/more.bin`), 'live: kept, over the cap or not').toBe(true);
    expect(exists(`${L()}/t/newest.bin`)).toBe(false);
  });

  it('6. with under 30 GB free on the disk, the cap is 10 GB, and the log says why', async () => {
    const result = await enforceTmpRetention(deps({ freeBytes: () => 29 * GB }));
    expect(result.capBytes).toBe(10 * GB);
    expect(logs.join('\n')).toMatch(/30 GB/);

    expect((await enforceTmpRetention(deps())).capBytes).toBe(20 * GB);
  });

  it('7. a deleted agent loses its whole folder after 7 days untouched, not before', async () => {
    put(`${shortIdOf('gone')}/t/a.txt`, 10, 8);
    put(`${shortIdOf('gone-recently')}/t/a.txt`, 10, 2);
    age(shortIdOf('gone'), 8);

    await enforceTmpRetention(deps());

    expect(exists(shortIdOf('gone'))).toBe(false);
    expect(exists(`${shortIdOf('gone-recently')}/t/a.txt`)).toBe(true);
  });

  it.skipIf(cannotSymlink())('8. never follows a link: what it points at is neither measured nor deleted, only the link goes', async () => {
    fs.writeFileSync(path.join(outside, 'precious.txt'), Buffer.alloc(50_000));
    const at = new Date(NOW - 40 * DAY);
    fs.utimesSync(path.join(outside, 'precious.txt'), at, at);
    put(`${W()}/t/keep.txt`, 10, 1);
    fs.symlinkSync(outside, path.join(root, W(), 't', 'escape'));
    fs.lutimesSync(path.join(root, W(), 't', 'escape'), at, at);
    fs.symlinkSync(outside, path.join(root, 'planted-agent'));
    fs.lutimesSync(path.join(root, 'planted-agent'), at, at);

    const result = await enforceTmpRetention(deps({ capBytes: 1000 }));

    expect(fs.existsSync(path.join(outside, 'precious.txt'))).toBe(true);
    expect(fs.existsSync(path.join(root, W(), 't', 'escape'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'planted-agent'))).toBe(false);
    expect(result.removed.every((r) => r.path.startsWith(root + path.sep))).toBe(true);
    expect(result.totalBytes).toBeLessThan(50_000);
  });

  it.skipIf(cannotSymlink())('8. a young link to a large folder weighs as the link it is, so nothing is deleted for what lies behind it', async () => {
    fs.writeFileSync(path.join(outside, 'large.bin'), Buffer.alloc(200_000));
    put(`${W()}/t/keep.txt`, 10, 1);
    fs.symlinkSync(outside, path.join(root, W(), 't', 'link-to-large'));

    const result = await enforceTmpRetention(deps({ capBytes: 100_000 }));

    expect(result.totalBytes).toBeLessThan(100_000);
    expect(result.removed).toEqual([]);
    expect(exists(`${W()}/t/keep.txt`)).toBe(true);
    expect(fs.existsSync(path.join(outside, 'large.bin'))).toBe(true);
  });

  it.skipIf(cannotSymlink())('8. a root that is a link is left alone, and the pass says so', async () => {
    const linked = path.join(path.dirname(root), 'linked-tmp');
    fs.symlinkSync(outside, linked);
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'x');
    const at = new Date(NOW - 40 * DAY);
    fs.utimesSync(path.join(outside, 'precious.txt'), at, at);

    const result = await enforceTmpRetention(deps({ root: linked }));

    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(outside, 'precious.txt'))).toBe(true);
    expect(logs.join('\n')).toMatch(/link/);
  });

  it('9. logs each deletion, with what and why', async () => {
    put(`${W()}/t/old.log`, 10, 9);

    await enforceTmpRetention(deps());

    expect(logs.some((l) => l.includes(path.join(W(), 't', 'old.log')) && /7 days/.test(l))).toBe(true);
  });

  it('10. a unit it cannot read goes on to the next', async () => {
    put(`${W()}/t/locked/inner.txt`, 10, 9);
    put(`${W()}/t/old.log`, 10, 9);
    fs.chmodSync(path.join(root, W(), 't', 'locked'), 0o000);
    try {
      await enforceTmpRetention(deps());
      expect(exists(`${W()}/t/old.log`)).toBe(false);
    } finally {
      if (fs.existsSync(path.join(root, W(), 't', 'locked'))) fs.chmodSync(path.join(root, W(), 't', 'locked'), 0o700);
    }
  });
});

describe('13. what a pass walks', () => {
  const W = () => shortIdOf('worker');
  it('walks a unit seen young again only once it could be old enough, or its size six hours old', async () => {
    put(`${W()}/t/young/a.txt`, 10, 0.1);
    put(`${W()}/t/old/a.txt`, 10, 10);
    const first = await enforceTmpRetention(deps());
    expect(first.walked).toBe(2);
    expect(exists(`${W()}/t/old`)).toBe(false);
    // An hour later: the young unit cannot be 7 days old yet.
    const second = await enforceTmpRetention(deps({ now: () => NOW + 3_600_000 }));
    expect(second.walked).toBe(0);
    // Six hours later: its size is weighed again.
    const third = await enforceTmpRetention(deps({ now: () => NOW + 6 * 3_600_000 + 1 }));
    expect(third.walked).toBe(1);
    // A week later it is walked, found untouched, and goes.
    const later = await enforceTmpRetention(deps({ now: () => NOW + 8 * DAY }));
    expect(later.walked).toBe(1);
    expect(exists(`${W()}/t/young`)).toBe(false);
  });
});

describe("14. what a running agent's CLI still uses", () => {
  const W = () => shortIdOf('worker');
  it.skipIf(process.platform === 'win32')('keeps a socket or a FIFO two days old, and what in c/ is not a session folder', async () => {
    // A short root: a Unix socket's path is limited to about 104 bytes.
    const short = fs.mkdtempSync('/tmp/tt-');
    root = path.join(short, 'tmp');
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, W(), 'c', 'cc-socks'), { recursive: true });
    const sock = path.join(root, W(), 'c', 'cc-socks', '4242.sock');
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      fs.mkdirSync(path.join(root, W(), 't', 'tmux-501'), { recursive: true });
      execFileSync('mkfifo', [path.join(root, W(), 't', 'tmux-501', 'default')]);
      put(`${W()}/c/claude-501/bash-edit-diff/x.diff`, 10, 3);
      put(`${W()}/c/claude-501/bundled-skills/2.1.296/a9c9/SKILL.md`, 10, 3);
      put(`${W()}/t/leftover/a.txt`, 10, 3);
      for (const p of [sock, path.join(root, W(), 't', 'tmux-501', 'default')]) {
        const at = new Date(NOW - 2 * DAY);
        fs.lutimesSync(p, at, at);
      }
      age(`${W()}/c/cc-socks`, 2);
      age(`${W()}/t/tmux-501`, 2);
      await enforceTmpRetention(deps({ liveAgentIds: () => ['worker'] }));
      expect(fs.existsSync(sock), 'the CLI\'s messaging socket').toBe(true);
      expect(exists(`${W()}/t/tmux-501/default`), 'a FIFO a server listens on').toBe(true);
      expect(exists(`${W()}/c/claude-501/bash-edit-diff/x.diff`), 'c/ outside a session folder').toBe(true);
      expect(exists(`${W()}/c/claude-501/bundled-skills/2.1.296/a9c9/SKILL.md`), 'a skill Claude Code unpacked').toBe(true);
      expect(exists(`${W()}/t/leftover`)).toBe(false);
    } finally {
      server.close();
      fs.rmSync(short, { recursive: true, force: true });
    }
  });
});

describe('14b. a dead socket', () => {
  const W = () => shortIdOf('worker');
  it.skipIf(process.platform === 'win32')('goes with the 7-day rule once its agent has stopped', async () => {
    const short = fs.mkdtempSync('/tmp/tt-');
    root = path.join(short, 'tmp');
    fs.mkdirSync(path.join(root, W(), 'c', 'cc-socks'), { recursive: true });
    fs.mkdirSync(path.join(root, W(), 't', 'tmux-501'), { recursive: true });
    const sock = path.join(root, W(), 'c', 'cc-socks', '4242.sock');
    const fifo = path.join(root, W(), 't', 'tmux-501', 'default');
    try {
      // A socket its server left behind: bound, then the process gone.
      const server = net.createServer();
      await new Promise<void>((r) => server.listen(sock, r));
      await new Promise<void>((r) => server.close(() => r()));
      if (!fs.existsSync(sock)) {
        // Node unlinked it on close: leave a socket of the same kind behind by hand.
        execFileSync('python3', ['-c', `import socket; s=socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(sock)})`]);
      }
      execFileSync('mkfifo', [fifo]);
      for (const p of [sock, fifo]) {
        const at = new Date(NOW - 8 * DAY);
        fs.lutimesSync(p, at, at);
      }
      age(`${W()}/c/cc-socks`, 8);
      age(`${W()}/t/tmux-501`, 8);
      await enforceTmpRetention(deps());
      expect(fs.existsSync(sock), 'a dead socket of a stopped agent').toBe(false);
      expect(fs.existsSync(fifo), 'a dead FIFO of a stopped agent').toBe(false);
    } finally {
      fs.rmSync(short, { recursive: true, force: true });
    }
  });
});

describe('15, 16. dates that moved', () => {
  const W = () => shortIdOf('worker');
  it('15. does not delete, on a date measured before, a unit written since', async () => {
    const file = put(`${W()}/t/kept-while-stopped/deep/a.txt`, 10, 2);
    await enforceTmpRetention(deps());
    expect(exists(`${W()}/t/kept-while-stopped`)).toBe(true);
    // Its agent starts and writes into the file it has: no folder's date moves,
    // the file's alone. The next pass, an hour on, is within the 6 hours.
    fs.appendFileSync(file, 'x');
    const at = new Date(NOW + 3_600_000);
    fs.utimesSync(file, at, at);
    await enforceTmpRetention(deps({ now: () => NOW + 3_600_000, liveAgentIds: () => ['worker'] }));
    expect(exists(`${W()}/t/kept-while-stopped`)).toBe(true);
  });

  it('16. does not delete a unit written between its measure and its deletion', async () => {
    put(`${W()}/t/written-meanwhile/a.txt`, 10, 9);
    await enforceTmpRetention(deps({
      liveAgentIds: () => {
        // Asked once the measuring is done: the moment a write lands before the deletions.
        fs.writeFileSync(path.join(root, W(), 't', 'written-meanwhile', 'new.txt'), 'x');
        return [];
      },
    }));
    expect(exists(`${W()}/t/written-meanwhile/new.txt`)).toBe(true);
  });
});

describe('a root swapped for a link while the pass runs', () => {
  it.skipIf(cannotSymlink())('11. deletes nothing through it, and says so', async () => {
    const gone = shortIdOf('gone');
    put(`${gone}/t/old.txt`, 10, 9);
    age(gone, 9);
    // Elsewhere, an entry of the same name, which the swap would point the pass at.
    fs.mkdirSync(path.join(outside, gone, 't'), { recursive: true });
    fs.writeFileSync(path.join(outside, gone, 't', 'precious.txt'), 'keep me');
    const moved = `${root}-moved`;

    const result = await enforceTmpRetention(deps({
      // Asked for while the pass runs: the moment an agent could swap the folder.
      liveAgentIds: () => {
        if (!fs.existsSync(moved)) {
          fs.renameSync(root, moved);
          fs.symlinkSync(outside, root);
        }
        return [];
      },
    }));

    expect(fs.existsSync(path.join(outside, gone, 't', 'precious.txt'))).toBe(true);
    expect(result.removed).toEqual([]);
    expect(logs.join('\n')).toMatch(/link|moved|changed/);
  });
});

describe('what a live process uses (17 to 23)', () => {
  const W = () => shortIdOf('worker');
  const L = () => shortIdOf('lead');
  const real = (rel: string) => fs.realpathSync(path.join(root, rel));
  const using = (paths: string[], commands: string[] = []) => async () => ({ paths, commands });

  it('17. keeps a unit a live process runs, works in, holds open or names, by the day rule, and deletes the stale one beside it', async () => {
    for (const rel of ['codex-0170/bin/codex', 'workdir/notes.txt', 'held/log.txt', 'cli-tool/cli.js', 'stale/old.txt']) put(`${W()}/t/${rel}`, 10, 2);
    const inUse = using(
      [real(`${W()}/t/codex-0170/bin/codex`), real(`${W()}/t/workdir`), real(`${W()}/t/held/log.txt`)],
      [`node ${real(`${W()}/t/cli-tool/cli.js`)} --serve`],
    );

    const result = await enforceTmpRetention(deps({ liveAgentIds: () => ['worker'], inUse }));

    for (const kept of ['codex-0170', 'workdir', 'held', 'cli-tool']) expect(exists(`${W()}/t/${kept}`), kept).toBe(true);
    expect(exists(`${W()}/t/stale`)).toBe(false);
    expect(result.removed.map((r) => path.basename(r.path))).toEqual(['stale']);
    expect(logs.join('\n')).toMatch(/codex-0170[^\n]*in use/);
  });

  it('17. keeps it by the 7-day rule and by the cap as well', async () => {
    put(`${L()}/t/old-tool/bin/tool`, 10, 9);
    put(`${L()}/t/old-junk/a.bin`, 10, 9);
    put(`${L()}/t/used-tool/bin/tool`, 10, 3);
    put(`${L()}/t/junk/a.bin`, 10, 2);
    const inUse = using([real(`${L()}/t/old-tool/bin/tool`), real(`${L()}/t/used-tool`)]);

    await enforceTmpRetention(deps({ inUse, capBytes: 1 }));

    expect(exists(`${L()}/t/old-tool`)).toBe(true);
    expect(exists(`${L()}/t/old-junk`)).toBe(false);
    // Over the cap, the oldest first: the two in use stay, the one nothing uses goes.
    expect(exists(`${L()}/t/used-tool`)).toBe(true);
    expect(exists(`${L()}/t/junk`)).toBe(false);
  });

  it('18. deletes nothing when the processes cannot be read, and says so', async () => {
    put(`${W()}/t/stale/old.txt`, 10, 2);
    put(`${L()}/t/old/a.txt`, 10, 9);

    const result = await enforceTmpRetention(deps({ liveAgentIds: () => ['worker'], inUse: async () => undefined }));

    expect(result.removed).toEqual([]);
    expect(exists(`${W()}/t/stale/old.txt`) && exists(`${L()}/t/old/a.txt`)).toBe(true);
    expect(logs.join('\n')).toMatch(/processes could not be read/);
  });

  it.skipIf(cannotSymlink())('19. compares the unit as the root spells it and as it really is', async () => {
    // A root reached through a link above it, as macOS's /tmp is /private/tmp.
    const realParent = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-agent-tmp-real-'));
    const linkParent = `${realParent}-link`;
    fs.symlinkSync(realParent, linkParent);
    try {
      const linked = path.join(linkParent, 'tmp');
      const two = new Date(NOW - 2 * DAY);
      for (const name of ['by-real', 'by-link', 'stale']) {
        const file = path.join(linked, W(), 't', name, 'a.txt');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'x');
        for (const p of [file, path.dirname(file)]) fs.utimesSync(p, two, two);
      }
      const inUse = using(
        [path.join(fs.realpathSync(linked), W(), 't', 'by-real', 'a.txt')],
        [`tail -f ${path.join(linked, W(), 't', 'by-link', 'a.txt')}`],
      );

      await enforceTmpRetention(deps({ root: linked, liveAgentIds: () => ['worker'], inUse }));

      expect(fs.existsSync(path.join(linked, W(), 't', 'by-real'))).toBe(true);
      expect(fs.existsSync(path.join(linked, W(), 't', 'by-link'))).toBe(true);
      expect(fs.existsSync(path.join(linked, W(), 't', 'stale'))).toBe(false);
    } finally {
      fs.rmSync(linkParent, { force: true });
      fs.rmSync(realParent, { recursive: true, force: true });
    }
  });

  it('20. a prefix is not a folder, and a path outside the root keeps nothing', async () => {
    put(`${W()}/t/tool/bin/x`, 10, 2);
    put(`${W()}/t/tool-old/bin/x`, 10, 2);
    put(`${W()}/t/outside-twin/a.txt`, 10, 2);
    const inUse = using([real(`${W()}/t/tool`), path.join(outside, 'outside-twin')], [`ls ${real(`${W()}/t/tool`)}`]);

    await enforceTmpRetention(deps({ liveAgentIds: () => ['worker'], inUse }));

    expect(exists(`${W()}/t/tool`)).toBe(true);
    expect(exists(`${W()}/t/tool-old`)).toBe(false);
    expect(exists(`${W()}/t/outside-twin`)).toBe(false);
  });

  it.skipIf(!hasPosixModes())('21. keeps a tool run within the day, not a data file read within it', async () => {
    const tool = put(`${W()}/t/ran-tool/bin/tool`, 10, 2);
    const data = put(`${W()}/t/read-data/a.txt`, 10, 2);
    fs.chmodSync(tool, 0o755);
    const twoDays = new Date(NOW - 2 * DAY);
    const anHourAgo = new Date(NOW - 3_600_000);
    // The access time a run moved (or a read), the change time two days old.
    fs.utimesSync(tool, anHourAgo, twoDays);
    fs.utimesSync(data, anHourAgo, twoDays);

    await enforceTmpRetention(deps({ liveAgentIds: () => ['worker'], inUse: using([]) }));

    expect(exists(`${W()}/t/ran-tool/bin/tool`)).toBe(true);
    expect(exists(`${W()}/t/read-data`)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('22. on Windows, a unit a process has for its current folder is kept whole', async () => {
    put(`${L()}/t/cwd/a.txt`, 10, 9);
    put(`${L()}/t/cwd/b.txt`, 10, 9);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { cwd: path.join(root, L(), 't', 'cwd'), stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 500));
      await enforceTmpRetention(deps({ inUse: using([]) }));
      expect(exists(`${L()}/t/cwd/a.txt`) && exists(`${L()}/t/cwd/b.txt`)).toBe(true);
    } finally {
      child.kill();
    }
  });

  it('23. reads the processes only when a unit is about to go, once per pass', async () => {
    let asked = 0;
    const inUse = async () => { asked += 1; return { paths: [] as string[], commands: [] as string[] }; };
    put(`${W()}/t/young/a.txt`, 10, 0);
    await enforceTmpRetention(deps({ liveAgentIds: () => ['worker'], inUse }));
    expect(asked).toBe(0);

    put(`${W()}/t/stale-1/a.txt`, 10, 2);
    put(`${W()}/t/stale-2/a.txt`, 10, 2);
    await enforceTmpRetention(deps({ liveAgentIds: () => ['worker'], inUse }));
    expect(asked).toBe(1);
    expect(exists(`${W()}/t/stale-1`) || exists(`${W()}/t/stale-2`)).toBe(false);
  });

  // Sizes in whole 4 KB blocks, so a unit weighs what it holds on APFS and ext4 alike.
  it("24. the cap: the oldest unit in use kept, the idle one before 17 kept stays (the Audit's example)", async () => {
    put(`${L()}/t/a-tool/bin/tool`, 40960, 5);
    put(`${L()}/t/b-idle/a.bin`, 8192, 3);

    const result = await enforceTmpRetention(deps({ inUse: using([real(`${L()}/t/a-tool`)]), capBytes: 36864 }));

    // Before 17, A went and the total was under the cap: B stayed. A stays now, and B with it.
    expect(exists(`${L()}/t/a-tool`) && exists(`${L()}/t/b-idle`)).toBe(true);
    expect(result.removed).toEqual([]);
  });

  it('24. the cap goes on as it did, less what is used: what it deleted after a unit in use, and no more', async () => {
    put(`${L()}/t/a-used/bin/tool`, 4096, 6);
    put(`${L()}/t/b-idle/a.bin`, 8192, 5);
    put(`${L()}/t/c-idle/a.bin`, 8192, 2);

    await enforceTmpRetention(deps({ inUse: using([real(`${L()}/t/a-used`)]), capBytes: 8192 }));

    // Before 17: A, then B, and the total met the cap with C. Now: B alone.
    expect(exists(`${L()}/t/a-used`)).toBe(true);
    expect(exists(`${L()}/t/b-idle`)).toBe(false);
    expect(exists(`${L()}/t/c-idle`)).toBe(true);
  });

  it.skipIf(!hasPosixModes())('24. a tool run recently does not move the cap onto an idle unit kept before', async () => {
    const tool = put(`${L()}/t/a-ran/bin/tool`, 40960, 5);
    put(`${L()}/t/b-idle/a.bin`, 8192, 3);
    fs.chmodSync(tool, 0o755);
    fs.utimesSync(tool, new Date(NOW - 3_600_000), new Date(NOW - 5 * DAY));

    await enforceTmpRetention(deps({ inUse: using([]), capBytes: 36864 }));

    // Before 17: A, the oldest change, went, and B stayed under the cap. A was run an hour ago: it stays, and B too.
    expect(exists(`${L()}/t/a-ran`) && exists(`${L()}/t/b-idle`)).toBe(true);
  });

  it("24. a running agent's unit kept by the day rule for its use does not push an agent at rest's unit over the cap", async () => {
    put(`${W()}/t/used-tool/bin/tool`, 40960, 2);
    put(`${L()}/t/idle/a.bin`, 8192, 3);

    await enforceTmpRetention(deps({ liveAgentIds: () => ['worker'], inUse: using([real(`${W()}/t/used-tool`)]), capBytes: 36864 }));

    expect(exists(`${W()}/t/used-tool`)).toBe(true);
    expect(exists(`${L()}/t/idle`)).toBe(true);
    expect(logs.join('\n')).not.toMatch(/removed [^\n]*idle/);
  });
});
