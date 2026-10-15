import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Decoding a project folder's name back to its path probes the disk segment by
 * segment: 101 ms for JeanBrasse's 27 folders, paid again by every call of
 * fs:list-projects, memory:list-projects, fs:read-project-files and the project
 * scan of claude:getData. The index decodes each folder once.
 */

const decodes = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../electron/utils/decode-project-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/utils/decode-project-path')>();
  return {
    ...actual,
    decodeProjectPath: (name: string) => { decodes.count++; return actual.decodeProjectPath(name); },
  };
});

import { projectFolders, decodedProjectPath, resetProjectIndex, REDECODE_MS } from '../../../electron/services/project-index';
import { encodeClaudeProjectDir } from '../../../electron/platform';

let tmp: string;
let root: string;
// Claude Code's own folder name. `[/.]` left a Windows path's drive and backslashes in it.
const encode = encodeClaudeProjectDir;

beforeEach(() => {
  resetProjectIndex();
  decodes.count = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-project-index-')));
  root = path.join(tmp, 'projects');
  fs.mkdirSync(root);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the project index', () => {
  it('decodes each folder once, however many surfaces list the projects', async () => {
    const project = path.join(tmp, 'work', 'docs.site-v2');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(root, encode(project)));

    const first = await projectFolders(root);
    await projectFolders(root);
    await projectFolders(root);

    expect(first).toEqual([{ name: encode(project), dir: path.join(root, encode(project)), projectPath: project }]);
    expect(decodes.count).toBe(1);
  });

  it('decodes again a folder whose project appeared after it was read, once REDECODE_MS has passed', async () => {
    const project = path.join(tmp, 'late.repo');
    const name = encode(project);
    const t0 = Date.now();
    const before = await decodedProjectPath(name, t0);
    fs.mkdirSync(project);

    const soon = await decodedProjectPath(name, t0 + 1_000);
    const later = await decodedProjectPath(name, t0 + REDECODE_MS + 1);

    expect(before).not.toBe(project);
    expect(soon).toBe(before);
    expect(later).toBe(project);
    expect(decodes.count).toBe(2);
  });

  it('leaves a decoded path that still exists alone, and a deleted project costs one decode per REDECODE_MS', async () => {
    const project = path.join(tmp, 'gone');
    fs.mkdirSync(project);
    const t0 = Date.now();
    await decodedProjectPath(encode(project), t0);
    await decodedProjectPath(encode(project), t0 + 10 * REDECODE_MS);
    expect(decodes.count).toBe(1);

    fs.rmSync(project, { recursive: true });
    for (let i = 1; i <= 5; i++) await decodedProjectPath(encode(project), t0 + 10 * REDECODE_MS + i);
    expect(decodes.count).toBe(2);
  });

  it('lists folders and links to folders, not files, and nothing for a missing root', async () => {
    fs.mkdirSync(path.join(root, '-a'));
    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    // A junction: Windows lets any account make one, where a symlink needs a privilege; the type is ignored off Windows.
    fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(root, '-b'), 'junction');
    fs.writeFileSync(path.join(root, '.DS_Store'), '');

    expect((await projectFolders(root)).map(f => f.name).sort()).toEqual(['-a', '-b']);
    expect(await projectFolders(path.join(tmp, 'none'))).toEqual([]);
  });
});
