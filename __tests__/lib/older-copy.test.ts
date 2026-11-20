import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { olderCopyFolder } from '../../src/lib/older-copy';

/**
 * The folder a project's memory row names when an older Tars kept that
 * memory elsewhere (ProjectMemory.olderCopy, #375): the path of the older
 * memory folder, `<projects>/<folder>/memory`, which the row shortens to
 * `<folder>`. Frame: `Brain · Projects · a row with an older copy · states`.
 * Written before the code. How it can fail:
 * 1. the row names `memory`, the last segment, which every such path ends
 *    with, instead of the project's folder;
 * 2. a trailing separator leaves an empty name;
 * 3. a Windows path (backslashes) is named whole, or by its drive;
 * 4. a path that does not end in `memory` loses its own last segment;
 * 5. no older copy (absent, empty, blank) still draws a line.
 */

describe('olderCopyFolder', () => {
  it('names the project folder, not memory (1)', () => {
    expect(olderCopyFolder('/Users/me/.claude/projects/-Users-me-my_proj/memory')).toBe('-Users-me-my_proj');
  });

  it('reads past a trailing separator (2)', () => {
    expect(olderCopyFolder('/Users/me/.claude/projects/-Users-me-my_proj/memory/')).toBe('-Users-me-my_proj');
  });

  it('reads a Windows path (3)', () => {
    expect(olderCopyFolder('C:\\Users\\me\\.claude\\projects\\C--Users-me-my_proj\\memory')).toBe('C--Users-me-my_proj');
  });

  it('keeps the last segment of a path that does not end in memory (4)', () => {
    expect(olderCopyFolder('/Users/me/.claude/projects/-Users-me-a b')).toBe('-Users-me-a b');
  });

  it('names nothing when there is no older copy (5)', () => {
    expect(olderCopyFolder(undefined)).toBeNull();
    expect(olderCopyFolder('')).toBeNull();
    expect(olderCopyFolder('   ')).toBeNull();
  });
});
