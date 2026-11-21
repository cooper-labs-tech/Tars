import '../../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodeClaudeProjectDir } from '../../../electron/platform';
import { resetProjectIndex } from '../../../electron/services/project-index';
import { getClaudeProjects } from '../../../electron/services/claude-service';
import { listProjectMemories, createMemoryFile } from '../../../electron/services/memory-service';
import { writeProjectMemory } from '../../../electron/services/memory-hub';

/**
 * The surfaces that read `~/.claude/projects` on Windows, each driven through
 * its real function against folders named the
 * way Claude Code names them on Windows (C--Users-...).
 *
 * How they fail, written before the fix:
 * 1. a project Claude has opened is not listed (Projects, claude:getData),
 *    because its folder decodes to `\C\Users\...`, which does not exist;
 * 2. its worktree is listed as a project of its own: `/\/\.?worktrees\//`
 *    never matches `\`;
 * 3. Memory lists it under a path that is not the project's;
 * 4. a Tars project Claude never opened gets a memory folder Claude will not
 *    read (`C:\...` pasted into ~/.claude/projects), and creating its
 *    MEMORY.md fails;
 * 5. a memory file named with a backslash creates a subdirectory;
 * 6. the Brain's writer puts a note where Claude does not look;
 * 7. a drive root is listed as a project.
 */
describe.runIf(process.platform === 'win32')('Claude\'s project folders on Windows', () => {
  let work: string;
  let project: string;
  let fresh: string;
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  beforeAll(() => {
    resetProjectIndex();
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-claude-projects-')));
    project = path.join(work, 'Claude Project', 'my_app.v2');
    fresh = path.join(work, 'New Project');
    const worktree = path.join(project, '.worktrees', 'feat-x');
    for (const dir of [project, worktree, fresh]) fs.mkdirSync(dir, { recursive: true });
    for (const dir of [project, worktree]) {
      const folder = path.join(projectsDir, encodeClaudeProjectDir(dir));
      fs.mkdirSync(path.join(folder, 'memory'), { recursive: true });
      fs.writeFileSync(path.join(folder, '11111111-2222-4333-8444-555555555555.jsonl'), '{}\n');
    }
    fs.writeFileSync(path.join(projectsDir, encodeClaudeProjectDir(project), 'memory', 'MEMORY.md'), '# notes\n');
  });

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  it('1, 2. lists the project under its own path, and not its worktree', async () => {
    const listed = (await getClaudeProjects()).map(p => p.path);
    expect(listed).toContain(project);
    expect(listed.filter(p => p.includes('.worktrees'))).toEqual([]);
  });

  // Found at review: '/' was skipped by string, and Claude's folder for a
  // session run at a drive's root (C--) listed C:\ as a project.
  it('7. does not list a drive root as a project', async () => {
    fs.mkdirSync(path.join(projectsDir, 'C--'), { recursive: true });
    resetProjectIndex();
    const listed = (await getClaudeProjects()).map(p => p.path);
    expect(listed.filter(p => /^[A-Za-z]:\\?$/.test(p))).toEqual([]);
    expect(listed).toContain(project);
  });

  it('3. Memory shows its MEMORY.md under the project\'s path', async () => {
    const memories = await listProjectMemories();
    const mine = memories.find(m => m.projectPath === project);
    expect(mine?.hasMemory).toBe(true);
    expect(mine?.files.map(f => f.name)).toEqual(['MEMORY.md']);
  });

  it('4, 5. a project Claude never opened gets the folder Claude will read, and its MEMORY.md is created there', async () => {
    const memories = await listProjectMemories([fresh]);
    const entry = memories.find(m => m.projectPath === fresh)!;
    expect(entry.memoryDir).toBe(path.join(projectsDir, encodeClaudeProjectDir(fresh), 'memory'));
    const made = createMemoryFile(entry.memoryDir, 'MEMORY.md', '# fresh\n');
    expect(made.success, made.error).toBe(true);
    expect(fs.readFileSync(path.join(projectsDir, encodeClaudeProjectDir(fresh), 'memory', 'MEMORY.md'), 'utf8')).toBe('# fresh\n');
    // A folder that exists, so only the guard can stop the write going into it.
    fs.mkdirSync(path.join(entry.memoryDir, 'sub'));
    expect(createMemoryFile(entry.memoryDir, 'sub\\notes.md').success).toBe(false);
    expect(fs.existsSync(path.join(entry.memoryDir, 'sub', 'notes.md'))).toBe(false);
  });

  it('6. the Brain writes its note where Claude reads memory', () => {
    const r = writeProjectMemory(fresh, 'from the Brain', 'brain.md');
    expect(r.success, r.error).toBe(true);
    expect(r.path).toBe(path.join(projectsDir, encodeClaudeProjectDir(fresh), 'memory', 'brain.md'));
  });
});
