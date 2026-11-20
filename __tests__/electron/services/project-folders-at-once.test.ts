import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { projectFolders, resetProjectIndex, REDECODE_MS } from '../../../electron/services/project-index';
import { getClaudeProjects } from '../../../electron/services/claude-service';

/**
 * The project folders, decoded a few at a time.
 *
 * getClaudeProjects (claude:getData) and projectFolders (fs:list-projects, the
 * Memory page) waited on each folder's path in turn. Past REDECODE_MS a kept
 * path is checked on disk, and each check waited for a turn of the main loop of
 * its own: measured on 24 folders on 2026-09-28, 7 ms on an idle loop and 200 ms
 * on a loop busy in 8 ms slices, the transcript scan's breathing; 8 ms when the
 * checks run together.
 *
 * How it can fail, written before the code:
 * 1. the checks still run one after another;
 * 2. more than a small bound run at once, on a machine with hundreds of folders;
 * 3. the folders come back in another order, or one is lost or doubled;
 * 4. getClaudeProjects answers otherwise than before: the same projects, with
 *    their paths, names, sessions and order.
 */

const BOUND = 8;
let tmp: string;
let now: number;
// Claude Code's folder name for a project. On Windows every character that is
// not an ASCII letter or digit becomes `-` (C:\Users\me is C--Users-me), the
// rule e2e/fixture.mjs writes too; elsewhere `/` and `.`.
const encode = (p: string) => process.platform === 'win32' ? p.replace(/[^a-zA-Z0-9]/g, '-') : p.replace(/[/.]/g, '-');

/**
 * Every check on disk held a few ms, counted while it is under way. With
 * `laterFirst`, each check is held less than the one before it, so the last to
 * start end first: a list built in the order the checks end comes out shuffled.
 */
function slowChecks({ laterFirst = false } = {}) {
  const real = fs.promises.access.bind(fs.promises);
  const seen = { checks: 0, inFlight: 0, most: 0 };
  vi.spyOn(fs.promises, 'access').mockImplementation(async (target, mode) => {
    const nth = seen.checks++;
    seen.inFlight++;
    seen.most = Math.max(seen.most, seen.inFlight);
    await new Promise(resolve => setTimeout(resolve, laterFirst ? Math.max(1, 60 - 2 * nth) : 5));
    seen.inFlight--;
    return real(target, mode);
  });
  return seen;
}

/** Folders under `root` whose names decode to projects that exist. */
function seedFolders(root: string, count: number, under: string): string[] {
  fs.mkdirSync(root, { recursive: true });
  const projects: string[] = [];
  for (let i = 0; i < count; i++) {
    const project = path.join(under, `proj${String(i).padStart(2, '0')}`);
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(root, encode(project)));
    projects.push(project);
  }
  return projects;
}

beforeEach(() => {
  resetProjectIndex();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-folders-at-once-')));
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('projectFolders, past REDECODE_MS', () => {
  it('1, 2. checks the kept paths together, and never more than a few at once', async () => {
    const root = path.join(tmp, 'projects');
    seedFolders(root, 40, path.join(tmp, 'work'));
    await projectFolders(root);

    now += REDECODE_MS + 1;
    const seen = slowChecks();
    await projectFolders(root);

    expect(seen.checks).toBe(40);
    expect(seen.most).toBeGreaterThan(1);
    expect(seen.most).toBeLessThanOrEqual(BOUND);
  });

  it('3. lists every folder once, in the order the directory gives them', async () => {
    const root = path.join(tmp, 'projects');
    const projects = seedFolders(root, 20, path.join(tmp, 'work'));
    const order = fs.readdirSync(root);
    await projectFolders(root);

    now += REDECODE_MS + 1;
    slowChecks({ laterFirst: true });
    const folders = await projectFolders(root);

    expect(folders.map(f => f.name)).toEqual(order);
    expect(folders.map(f => f.projectPath).sort()).toEqual([...projects].sort());
    expect(folders.every(f => f.dir === path.join(root, f.name))).toBe(true);
    // Each folder with its own path, not with the one whose check ended in its place.
    expect(folders.filter(f => encode(f.projectPath) !== f.name).map(f => f.name)).toEqual([]);
  });
});

describe('getClaudeProjects, past REDECODE_MS', () => {
  let claudeProjects: string;
  beforeEach(() => {
    claudeProjects = path.join(os.homedir(), '.claude', 'projects');
  });
  afterEach(() => {
    fs.rmSync(path.join(os.homedir(), '.claude'), { recursive: true, force: true });
  });

  it('1, 2. checks the kept paths together, and never more than a few at once', async () => {
    seedFolders(claudeProjects, 24, path.join(tmp, 'work'));
    expect(await getClaudeProjects()).toHaveLength(24);

    now += REDECODE_MS + 1;
    const seen = slowChecks();
    expect(await getClaudeProjects()).toHaveLength(24);

    expect(seen.most).toBeGreaterThan(1);
    expect(seen.most).toBeLessThanOrEqual(BOUND);
  });

  it('4. answers as before: the projects, their paths, names, sessions and order', async () => {
    const [older, newer] = seedFolders(claudeProjects, 2, path.join(tmp, 'work'));
    const at = (s: number) => new Date(Date.parse('2026-09-28T01:00:00Z') + s * 1000);
    for (const [project, sessions, folderTime] of [[older, ['s-a', 's-b'], 10], [newer, ['s-c'], 20]] as const) {
      const folder = path.join(claudeProjects, encode(project));
      sessions.forEach((id, i) => {
        const file = path.join(folder, `${id}.jsonl`);
        fs.writeFileSync(file, '');
        fs.utimesSync(file, at(i), at(i));
      });
      fs.writeFileSync(path.join(folder, 'notes.txt'), '');
      fs.utimesSync(folder, at(folderTime), at(folderTime));
    }
    await getClaudeProjects();

    now += REDECODE_MS + 1;
    slowChecks({ laterFirst: true });
    const projects = await getClaudeProjects();

    expect(projects).toEqual([
      { id: encode(newer), path: newer, name: 'proj01', sessions: [{ id: 's-c', timestamp: at(0).getTime() }], lastAccessed: at(20).getTime() },
      { id: encode(older), path: older, name: 'proj00', sessions: [{ id: 's-b', timestamp: at(1).getTime() }, { id: 's-a', timestamp: at(0).getTime() }], lastAccessed: at(10).getTime() },
    ]);
  });
});
