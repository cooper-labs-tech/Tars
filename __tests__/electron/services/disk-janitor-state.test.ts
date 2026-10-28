import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createJanitor, type JanitorState } from '../../../electron/services/janitor-state';
import type { JanitorWorld, JanitorOps } from '../../../electron/services/janitor-rules';

/**
 * The disk janitor as the window reads it (2.0.5; the Frontend's contract on #539/#543, `Resources (2.0.5) · disk`
 * and `· disk · states` of #535; the orchestrator's additions of 28/10): window.electronAPI.diskJanitor's state,
 * scan, approve and onChanged.
 *
 * How it fails, written before the code (28/10):
 * S1. The window cannot follow a scan: it is not told it runs, what is being read, how much was found so far, nor
 *     when it ended; an item lacks its exact path, bytes, rule, why, or a worktree's details.
 * S2. An agent's scan shows it another project's items (Info 1 of the Audit's gate of #542), or the window does not
 *     know an agent asked (who, when), or an agent can ask again and again: one scan per agent in five minutes, the
 *     same answer meanwhile.
 * S3. The window cannot follow a deletion (item n of N, checking it again, deleted or kept), or the outcomes do not
 *     reach the items, or the log of what was freed is not read back (janitor.log and its .1, oldest first, each
 *     line's time, words and bytes).
 * S4. The never list is not said, in words.
 * S5. (L1 of the Audit's re-check of #542) The five-minute answer is kept by the agent's name: two agents of the same
 *     name in two projects get each other's items. It is kept by the agent's id.
 */

let dir: string;
let logFile: string;
let worlds: number;
let sent: JanitorState[];
const DAY = 86_400_000;

function world(): JanitorWorld {
  worlds++;
  const project = path.join(dir, 'proj');
  const other = path.join(dir, 'other');
  return {
    home: dir, dataDir: path.join(dir, '.tars'), privateDir: path.join(dir, '.tars-private'), now: Date.now(),
    projects: [project, other],
    fleet: [{ id: 'a', projectPath: project }, { id: 'b', projectPath: other }],
    processes: [],
    worktrees: async (p) => [{ path: path.join(p, '.worktrees', 'w'), branch: 'b/w', locked: false }],
    dirty: async () => false, merged: async () => false, ignored: async () => [], operation: async () => null,
    named: () => false, docker: { images: async () => [{ id: 'sha256:x', repo: 'x:1', sizeBytes: 5e8, used: false }], vm: false },
    sizeOf: async () => 2048,
  };
}

const ops = (): JanitorOps => ({
  rm: async (p) => { fs.rmSync(p, { recursive: true, force: true }); },
  removeWorktree: async () => undefined, dockerRm: async () => undefined, trim: async () => undefined,
  log: (line) => { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${new Date().toISOString()} [janitor] ${line}\n`); },
});

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-state-')));
  logFile = path.join(dir, '.tars', 'logs', 'janitor.log');
  worlds = 0;
  sent = [];
  for (const p of ['proj', 'other']) {
    const next = path.join(dir, p, '.worktrees', 'w', '.next');
    fs.mkdirSync(next, { recursive: true });
    fs.writeFileSync(path.join(next, 'f'), 'x');
    const t = new Date(Date.now() - 10 * DAY);
    for (const f of [path.join(next, 'f'), next]) fs.utimesSync(f, t, t);
  }
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const make = () => createJanitor({ world: async () => world(), ops: ops(), logFile, broadcast: (s) => { sent.push(JSON.parse(JSON.stringify(s))); } });

describe('the janitor as the window reads it', () => {
  it('S1, S4. a scan the window asked for: told as it runs, then its items, each whole', async () => {
    const j = make();
    expect(j.state().scan).toBeNull();
    expect(j.state().never.length).toBeGreaterThan(5);
    expect(j.state().never.join(' ')).toMatch(/Documents/);
    await j.scan(null);
    const s = j.state();
    expect(s.scan).toMatchObject({ askedBy: null, running: false, at: expect.any(Number) });
    expect(s.scan!.items.map(i => i.kind).sort()).toEqual(['docker-image', 'next-cache', 'next-cache']);
    const next = s.scan!.items.find(i => i.path === path.join(dir, 'proj', '.worktrees', 'w', '.next'))!;
    expect(next).toMatchObject({ bytes: 2048, rule: expect.any(String), why: expect.any(String), details: { branch: 'b/w', merged: false, clean: true } });
    expect(sent.some(x => x.scan?.running && x.scan.progress)).toBe(true);
    expect(sent.at(-1)!.scan!.running).toBe(false);
  });

  it('S2. an agent\'s scan: its project\'s items only, the window told who and when, and once in five minutes', async () => {
    const j = make();
    const mine = await j.scan({ id: 'a', name: 'Harbor Worker', project: path.join(dir, 'proj') });
    expect(mine.map(i => i.path)).toEqual([path.join(dir, 'proj', '.worktrees', 'w', '.next')]);
    expect(j.state().scan!.askedBy).toBe('Harbor Worker');
    expect(j.state().requests).toEqual([{ at: expect.any(Number), by: 'Harbor Worker', project: path.join(dir, 'proj'), items: 1 }]);
    expect(j.state().scan!.items).toHaveLength(3);
    const before = worlds;
    expect(await j.scan({ id: 'a', name: 'Harbor Worker', project: path.join(dir, 'proj') })).toEqual(mine);
    expect(worlds, 'scanned again within five minutes').toBe(before);
  });

  it('S3. an approval told as it goes, its outcomes on the items, and the log read back with its bytes', async () => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(`${logFile}.1`, '2026-10-20T08:00:00.000Z [janitor] npx-cache /x/.npm/_npx/old: freed 4096 bytes\n');
    const j = make();
    await j.scan(null);
    const items = j.state().scan!.items;
    sent.length = 0;
    await j.approve([items[0].id, 'ffffffffffffffff']);
    const s = j.state();
    expect(s.scan!.items.find(i => i.id === items[0].id)!.outcome).toMatchObject({ kind: 'deleted', bytes: items[0].bytes });
    expect(sent.some(x => x.deleting && x.deleting.total === 2 && x.deleting.current?.phase === 'checking')).toBe(true);
    expect(sent.some(x => x.deleting?.current?.phase === 'deleted')).toBe(true);
    expect(s.deleting).toBeNull();
    expect(s.log[0]).toEqual({ at: Date.parse('2026-10-20T08:00:00.000Z'), what: 'npx-cache /x/.npm/_npx/old: freed 4096 bytes', bytes: 4096 });
    expect(s.log.at(-1)).toMatchObject({ what: expect.stringMatching(/^kept /), bytes: null });
    expect(s.log.filter(l => l.bytes !== null)).toHaveLength(2);
  });

  it('S5. two agents of the same name in two projects each get their own project\'s items', async () => {
    const j = make();
    const mine = await j.scan({ id: 'a', name: 'QA Engineer', project: path.join(dir, 'proj') });
    const theirs = await j.scan({ id: 'b', name: 'QA Engineer', project: path.join(dir, 'other') });
    expect(mine.map(i => i.path)).toEqual([path.join(dir, 'proj', '.worktrees', 'w', '.next')]);
    expect(theirs.map(i => i.path)).toEqual([path.join(dir, 'other', '.worktrees', 'w', '.next')]);
  });
});

