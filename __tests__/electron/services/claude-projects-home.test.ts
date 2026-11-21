import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodeClaudeProjectDir } from '../../../electron/platform';
import { resetProjectIndex } from '../../../electron/services/project-index';
import { getClaudeProjects } from '../../../electron/services/claude-service';

/**
 * The Projects page (getClaudeProjects) never offers the home as a project
 * (found at review, 2026-09-25).
 *
 * It skipped the home with `decodedPath === os.homedir()`. Claude Code names
 * its folder from the cwd as typed, and a cwd typed with a lowercase drive (a
 * VS Code terminal gives `c:\Users\x`) makes `c--Users-x`, which the decoder
 * rebuilds as `c:\Users\x`: not equal, so the home was a project card.
 *
 * How it can fail, written before the fix:
 * 1. win32: Claude's folder for the home with a lowercase drive lists the home.
 * 2. The home check drops an ordinary project.
 * (A project listed twice from `C--x` and `c--x` cannot happen here: NTFS
 * holds one folder for both names, so Claude writes both into it.)
 */

const projectsDir = path.join(os.homedir(), '.claude', 'projects');
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), 'claude-home-')));
const project = path.join(work, 'atlas');
fs.mkdirSync(project, { recursive: true });
const lowerDrive = (p: string) => p.replace(/^[A-Z]:/, d => d.toLowerCase());

function claudeSaw(dir: string) {
  const folder = path.join(projectsDir, encodeClaudeProjectDir(dir));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '11111111-2222-4333-8444-555555555555.jsonl'), '{}\n');
  return path.basename(folder);
}

beforeEach(() => {
  fs.rmSync(projectsDir, { recursive: true, force: true });
  resetProjectIndex();
});

afterAll(() => {
  fs.rmSync(projectsDir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe.runIf(process.platform === 'win32')('getClaudeProjects on Windows', () => {
  it('1, 2. does not list the home from a lowercase-drive folder (c--Users-x), and lists the project', async () => {
    expect(claudeSaw(lowerDrive(os.homedir()))).toMatch(/^[a-z]--/);
    claudeSaw(project);

    const listed = (await getClaudeProjects()).map(p => p.path);

    expect(listed.filter(p => p.toLowerCase() === os.homedir().toLowerCase())).toEqual([]);
    expect(listed).toContain(project);
  });
});
