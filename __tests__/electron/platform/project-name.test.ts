import { describe, it, expect } from 'vitest';

import { projectName } from '../../../electron/platform/project-name';

/**
 * The name a project goes by in the bots' agent lines: the last folder of its
 * path.
 *
 * Each site took `projectPath.split('/').pop()`. A Windows path has no `/`, so
 * Telegram, Slack and Discord named every project by its whole path
 * (`C:\Users\x\atlas`).
 *
 * How it can fail, written before the code (2026-09-25):
 * 1. win32: `\` is not a separator, or `/` stops being one (Windows takes
 *    both), and the whole path comes back.
 * 2. win32: a trailing separator gives an empty name instead of the folder's.
 * 3. win32: a drive root, a share root or `C:` alone comes back as a name
 *    (`C:`, `\`) instead of nothing, which each caller turns into its own
 *    fallback ('Unknown', the path).
 * 4. darwin/linux: anything changes from `split('/').pop()`, a trailing `/`
 *    included (it still gives ''). `\` is an ordinary character in a file
 *    name there, and must stay in the name.
 * 5. An empty path throws instead of giving nothing.
 */

describe('projectName', () => {
  it('1. win32: the last folder, with either separator', () => {
    expect(projectName('C:\\Users\\owner\\projects\\atlas', 'win32')).toBe('atlas');
    expect(projectName('C:/Users/owner/projects/atlas', 'win32')).toBe('atlas');
    expect(projectName('C:\\Users\\owner/projects\\o\'neil proj (x86)', 'win32')).toBe('o\'neil proj (x86)');
    expect(projectName('\\\\server\\share\\team\\atlas', 'win32')).toBe('atlas');
  });

  it('2. win32: a trailing separator is dropped', () => {
    expect(projectName('C:\\Users\\owner\\atlas\\', 'win32')).toBe('atlas');
    expect(projectName('C:\\Users\\owner\\atlas\\\\', 'win32')).toBe('atlas');
    expect(projectName('C:/Users/owner/atlas/', 'win32')).toBe('atlas');
  });

  it('3. win32: a root is no name', () => {
    for (const root of ['C:\\', 'C:/', 'C:', '\\', '\\\\server\\share\\']) expect(projectName(root, 'win32'), root).toBe('');
  });

  it('4. darwin/linux: the last `/` segment, as every caller had it, backslashes and trailing `/` alike', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(projectName('/Users/demo/Projects/tars', platform)).toBe('tars');
      expect(projectName('/Users/demo/a\\b', platform)).toBe('a\\b');
      expect(projectName('relative/name', platform)).toBe('name');
      expect(projectName('/', platform)).toBe('');
      for (const p of ['/Users/demo/atlas/', '/home/demo/atlas//', 'C:\\x\\atlas\\', '//', 'a//b']) {
        expect(projectName(p, platform), p).toBe(p.split('/').pop());
      }
    }
  });

  it('5. an empty path is no name', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) expect(projectName('', platform)).toBe('');
  });
});
