import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { execFileSync } from 'node:child_process';
import { TMP_ROOT, agentTmpEnv, enforceTmpRetention, shortIdOf } from '../../../electron/services/agent-tmp';
import { DATA_DIR } from '../../../electron/constants';
import { hasPosixModes } from '../../setup/platform-limits';
import { cannotSymlink } from '../../setup/symlink-privilege';

/**
 * A durable temporary folder per agent (RD-REDEMARRAGE.md, 2.1; JeanBrasse's yes of 2026-10-05): macOS empties /private/tmp
 * and the app's /var/folders/.../T at every boot, and with them every agent's scratchpad and the output of its
 * background tasks (about 45 GB on the night of 2026-10-01). Each agent gets ~/.dorothy/tmp/<short id>/: `t/` as the
 * TMPDIR of its commands, `c/` as Claude Code's CLAUDE_CODE_TMPDIR. Kept 7 days and 20 GB in all, or the disk fills up
 * again as it did that night.
 *
 * How it can fail, written before the code:
 *  1. A CLI gets a folder the boot wipes: no TMPDIR or no CLAUDE_CODE_TMPDIR, or one outside ~/.dorothy/tmp.
 *  2. Two agents share a folder, or one agent gets another folder at its next launch (its scratchpad lost to it); the
 *     path is long enough to break a Unix socket under it.
 *  3. The folder is not there when the CLI starts, is readable by other accounts, or is a link someone planted to send
 *     the agent's files elsewhere, and the link is followed.
 *  4. The retention deletes something younger than 7 days (dated by the newest change in it, a file or a folder, not
 *     by its top folder alone), or anything of an agent whose CLI is running.
 *  5. It keeps more than the cap while older things could go, or deletes the newest first.
 *  6. With under 30 GB free on the disk, the cap stays at 20 GB instead of 10 GB.
 *  7. A deleted agent's folder stays for ever.
 *  8. It follows a link out of ~/.dorothy/tmp, and measures or deletes what the link points at; or it deletes anything
 *     outside the root, or the root itself when it is a link.
 *  9. A deletion is not logged.
 * 10. Something it cannot read or delete stops the pass.
 * 11. (the Audit's gate of #306) The root is checked once, then a long pass deletes by path: an agent that swaps
 *     ~/.dorothy/tmp for a link while the pass runs makes Tars delete an entry of the same name elsewhere.
 * Measured on 2026-10-13 (~/.dorothy/tmp: 22 GB, 1.24 million files, 21 agents), and written before the code:
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
  it('1, 2. TMPDIR and CLAUDE_CODE_TMPDIR under ~/.dorothy/tmp, one folder per agent, the same at every launch, short', () => {
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
