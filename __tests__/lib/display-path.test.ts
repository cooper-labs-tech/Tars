import { describe, it, expect } from 'vitest';

import { comparablePath, isAbsolutePath, joinPath, lastPathPart, pathName, pathsNest, pathTail, splitPath, tildePath, toSlashes } from '../../src/lib/display-path';

/**
 * How the renderer names and shortens a path it shows.
 *
 * Every site took `path.split('/').pop()` for a project's name and
 * `/^\/(Users|home)\/[^/]+/` for the `~`. A Windows path has no `/`, so the
 * Agents page, the Kanban cards, the chat rooms, the logs, the review page and
 * the pickers named every project by its whole `C:\Users\...` path, and none
 * was ever shortened to `~`.
 *
 * How it can fail, written before the code (2026-09-25):
 * 1. darwin/linux: anything changes. Every posix path gives what the old
 *    expression gave at its site, byte for byte, `\` in a file name and a
 *    trailing `/` included: pathName where the site took the last part that
 *    is not empty, lastPathPart where it took `split('/').pop()`.
 * 2. win32: a trailing separator gives an empty name instead of the folder's,
 *    as the main process's projectName (electron/platform/project-name.ts)
 *    already decided for the bots and the chat room titles.
 * 3. win32: `\` is not a separator, or `/` stops being one, and the whole path
 *    comes back as the name; a drive or share root comes back as a name.
 * 4. win32: the home is never shortened to `~`, or something else is: another
 *    drive's folder, the Users folder itself, or the home without the bare
 *    home option the chat head uses.
 * 5. win32: a tail of the path (the Projects page, the Super Agent sidebar)
 *    comes back whole, or joined with a separator the path does not use.
 * 6. win32: a file under a project gets a mixed `C:\p/src/x.ts` path in the
 *    Code panel, which is what it copies to the clipboard.
 * 7. A Windows absolute path is refused as a template folder on Windows, or
 *    accepted on macOS and Linux, where it names nothing.
 * 8. Comparing two paths (the Projects page's agents of a project, its
 *    duplicate check): a Windows path is not matched to its own spelling
 *    with the other separator, case or a trailing separator; or a drive
 *    root, once its trailing separator is stripped, reads `c:` and claims
 *    every path on the drive (`c:/work`.startsWith(`c:` + `/`)), the phantom
 *    card the page's comment describes for `/`.
 */

// The expressions the call sites used, kept here as the oracle for 1.
const old = {
  pop: (p: string) => p.split('/').pop(),
  lastNonEmpty: (p: string) => p.split('/').filter(Boolean).pop(),
  tilde: (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+\//, '~/'),
  chatTilde: (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~'),
  tail2: (p: string) => p.split('/').slice(-2).join('/'),
  join: (base: string, rel: string) => `${base}/${rel}`,
  absolute: (p: string) => p.startsWith('/'),
  // The Projects page's normalizePath and pathsMatch, and its duplicate check.
  comparable: (p: string) => {
    const trimmed = p.replace(/\/+$/, '').toLowerCase();
    return trimmed === '' ? '/' : trimmed;
  },
  nest: (x: string, y: string) => {
    const a = old.comparable(x);
    const b = old.comparable(y);
    if (a === b) return true;
    return a.startsWith(b + '/') || b.startsWith(a + '/');
  },
  duplicate: (x: string, y: string) => x.replace(/\/+$/, '').toLowerCase() === y.replace(/\/+$/, '').toLowerCase(),
};

const POSIX = [
  '/Users/demo/Projects/tars',
  '/home/demo/tars',
  '/Users/demo',
  '/Users/demo/',
  '/Users/demo/atlas/',
  '/home/demo/atlas//',
  '/Users/Shared/tars',
  '/Users/demo/a\\b',
  '/Users/demo/C:\\x',
  "/Users/demo/o'neil proj (x86)/app",
  '/Users/demo/.claude/CLAUDE.md',
  '/opt/work/tars',
  '//server/share/tars',
  '/a//b',
  '/',
  '',
  'relative/name',
  'name',
];

describe('display-path on darwin and linux paths (1, 2)', () => {
  it('names a path as filter(Boolean).pop() did (pathName) and as split(/).pop() did (lastPathPart)', () => {
    for (const p of POSIX) {
      expect(pathName(p), p).toBe(old.lastNonEmpty(p) ?? '');
      expect(lastPathPart(p), p).toBe(old.pop(p));
    }
  });

  it('shortens the home to ~ exactly as both old expressions did', () => {
    for (const p of POSIX) {
      expect(tildePath(p), p).toBe(old.tilde(p));
      expect(tildePath(p, { bareHome: true }), p).toBe(old.chatTilde(p));
    }
  });

  it('splits, tails, joins and slashes a path as the old code did', () => {
    for (const p of POSIX) {
      expect(splitPath(p), p).toEqual({ parts: p.split('/'), sep: '/' });
      expect(pathTail(p, 2), p).toBe(old.tail2(p));
      expect(joinPath(p, 'src/app/x.ts'), p).toBe(old.join(p, 'src/app/x.ts'));
      expect(toSlashes(p), p).toBe(p);
    }
  });

  it('compares two paths as the Projects page did, for every pair (8)', () => {
    for (const x of POSIX) {
      for (const y of POSIX) {
        expect(pathsNest(x, y), `${x} ~ ${y}`).toBe(old.nest(x, y));
        expect(comparablePath(x) === comparablePath(y), `${x} = ${y}`).toBe(old.duplicate(x, y));
      }
    }
  });

  it('calls absolute what starts with / and nothing else, Windows paths included (7)', () => {
    for (const platform of ['darwin', 'linux']) {
      for (const p of [...POSIX, 'C:\\Users\\you\\vault', 'C:/vault', '\\\\srv\\share', '~/x', ' /x']) {
        expect(isAbsolutePath(p, platform), `${platform} ${p}`).toBe(old.absolute(p));
      }
    }
  });
});

describe('display-path on Windows paths', () => {
  it('3. names the last folder, with either separator', () => {
    expect(pathName('C:\\Users\\you\\projects\\tars')).toBe('tars');
    expect(pathName('C:/Users/you/projects/tars')).toBe('tars');
    expect(pathName("C:\\Users\\you/projects\\o'neil proj (x86)")).toBe("o'neil proj (x86)");
    expect(pathName('\\\\server\\share\\team\\atlas')).toBe('atlas');
    expect(pathName('D:\\work\\src\\app\\page.tsx')).toBe('page.tsx');
  });

  it('2. drops a trailing separator', () => {
    expect(pathName('C:\\Users\\you\\atlas\\')).toBe('atlas');
    expect(pathName('C:\\Users\\you\\atlas\\\\')).toBe('atlas');
    expect(pathName('C:/Users/you/atlas/')).toBe('atlas');
  });

  it('3. names no root', () => {
    for (const root of ['C:\\', 'C:/', 'C:', '\\', '\\\\server\\share\\', '\\\\server\\share']) expect(pathName(root), root).toBe('');
  });

  it('2, 3. names a Windows path the same through lastPathPart', () => {
    for (const p of ['C:\\Users\\you\\projects\\tars', 'C:/Users/you/atlas/', 'C:\\Users\\you\\atlas\\', '\\\\server\\share\\team\\atlas', 'C:\\', '\\\\server\\share']) {
      expect(lastPathPart(p), p).toBe(pathName(p));
    }
    expect(lastPathPart('C:\\Users\\you\\atlas\\')).toBe('atlas');
  });

  it('4. shortens the home under a drive\'s Users folder to ~, keeping the separator written', () => {
    expect(tildePath('C:\\Users\\you\\projects\\tars')).toBe('~\\projects\\tars');
    expect(tildePath('c:\\users\\you\\projects\\tars')).toBe('~\\projects\\tars');
    expect(tildePath('D:/Users/you/work')).toBe('~/work');
    expect(tildePath('C:\\Users\\you\\')).toBe('~\\');
  });

  it('4. leaves the rest alone, and the bare home to the chat head', () => {
    for (const p of ['C:\\Users\\you', 'C:\\Users', 'C:\\Users\\', 'D:\\work\\tars', 'C:\\Program Files\\Users\\x\\y', '\\\\srv\\Users\\x\\y']) {
      expect(tildePath(p), p).toBe(p);
    }
    expect(tildePath('C:\\Users\\you', { bareHome: true })).toBe('~');
    expect(tildePath('C:\\Users\\you\\atlas', { bareHome: true })).toBe('~\\atlas');
  });

  it('5. splits on both separators and joins a tail with the one the path uses', () => {
    expect(splitPath('C:\\Users\\you\\projects\\tars')).toEqual({ parts: ['C:', 'Users', 'you', 'projects', 'tars'], sep: '\\' });
    expect(splitPath('C:/a/b').parts).toHaveLength(3);
    expect(pathTail('C:\\Users\\you\\projects\\tars', 2)).toBe('projects\\tars');
    expect(pathTail('C:/Users/you/projects/tars', 2)).toBe('projects/tars');
  });

  it('6. joins a /-separated relative path under a project with the project\'s separator', () => {
    expect(joinPath('C:\\Users\\you\\tars', 'src/app/x.ts')).toBe('C:\\Users\\you\\tars\\src\\app\\x.ts');
    expect(joinPath('C:/Users/you/tars', 'src/app/x.ts')).toBe('C:/Users/you/tars/src/app/x.ts');
  });

  it('turns a Windows path\'s backslashes into slashes, and nothing else', () => {
    expect(toSlashes('C:\\p\\.claude\\CLAUDE.md')).toBe('C:/p/.claude/CLAUDE.md');
    expect(toSlashes('\\\\srv\\share\\x')).toBe('//srv/share/x');
  });

  it('8. matches a path to itself however its separators, case and trailing separator are written', () => {
    expect(comparablePath('C:\\Work\\Tars\\')).toBe(comparablePath('c:/work/tars'));
    expect(pathsNest('C:\\work\\tars', 'c:/work/tars/')).toBe(true);
    expect(pathsNest('C:\\work\\tars\\.worktrees\\feat', 'C:\\work\\tars')).toBe(true);
    expect(pathsNest('C:\\work\\tars2', 'C:\\work\\tars')).toBe(false);
  });

  it('8. keeps a drive root a root: it claims no path on the drive', () => {
    for (const root of ['C:\\', 'C:/', 'c:\\\\']) {
      expect(comparablePath(root), root).toBe('c:/');
      expect(pathsNest(root, 'C:\\work\\tars'), root).toBe(false);
      expect(pathsNest('C:\\work\\tars', root), root).toBe(false);
      expect(pathsNest(root, 'c:/'), root).toBe(true);
    }
  });

  it('7. calls absolute on win32 what Windows does: a drive, a share, a rooted path', () => {
    for (const p of ['C:\\Users\\you\\vault', 'C:/vault', 'c:\\x', '\\\\srv\\share\\x', '/Users/demo/vault', '\\x']) {
      expect(isAbsolutePath(p, 'win32'), p).toBe(true);
    }
    for (const p of ['C:x', 'C:', 'vault\\x', '~\\vault', '~/vault', '', ' C:\\x', './x']) {
      expect(isAbsolutePath(p, 'win32'), p).toBe(false);
    }
  });
});
