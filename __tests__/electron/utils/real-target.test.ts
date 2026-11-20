import '../../setup/home-guard';
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';

import { realTarget, landsUnderSafeRoot, linkedFileAllowed } from '../../../electron/utils/real-target';
import { isUnderSafeRoot } from '../../../electron/utils/home-root';

/**
 * Where a read or a write of a path really lands, and whether that is under a root.
 *
 * fs:read-text-file, fs:write-text-file, fs:read-project-files, local-file://
 * and /api/local-file judged the path as SPELLED against their roots, then
 * readFileSync / writeFileSync / a read stream followed every link on the way.
 * ~/.tars is a root of the first two and every agent can write in it, so
 * `ln -s ~ ~/.tars/h` opened the whole home, ~/.ssh and ~/.tars-private
 * included, to read and to write; a symlink inside a cloned repository did the
 * same through the project that holds it. coversHome / isUnderSafeRoot look at
 * the ROOTS, never at where the target resolves.
 *
 * How it can fail, written before the code (2026-09-28):
 * 1. A folder link inside a root to the home, to ~/.ssh or to ~/.tars-private
 *    lets the target through: it is judged by its spelling.
 * 2. A symlinked FILE inside a root that points outside it lets it through.
 * 3. A link that stays inside its root, or leads into another allowed root,
 *    is refused: the check breaks legitimate links.
 * 4. A target that does not exist yet (a write that creates a file) is refused
 *    for having no real path, or let through although its nearest existing
 *    folder really lies outside every root.
 * 5. A dangling link in the target's place, or on the way to it, is let
 *    through: realpath fails, the folder above is inside, and the write follows
 *    the link and creates the file where it points.
 * 6. A root that is itself reached through a link (a project on a linked
 *    folder, a moved ~/.tars) refuses its own files: the real target is
 *    compared with the root's spelling, not its real location.
 * 7. A root that is the home or above it, which the real target is under by
 *    spelling, lets the real target through: the real check must skip those
 *    roots too.
 * 8. A path that cannot be resolved (a loop of links) throws instead of being
 *    refused.
 * 9. A root that neither the target nor its real path is under, by spelling,
 *    is looked at on the disk (a share nobody answers for blocks the call).
 *
 * The dotfiles exception, written before its code. ~/.claude/CLAUDE.md, or a
 * project's CLAUDE.md or AGENTS.md, is often a symlink to a file in a dotfiles
 * repository, outside every root; refusing it breaks the Brain page. The
 * exception is one FILE link, as the last name, to a markdown file in no
 * blocked place, and only where a caller asks for it.
 * 10. The exception refuses the dotfiles file: a markdown file outside every
 *     root, in no blocked place, in any case of its extension.
 * 11. It lets through a file in a blocked place (~/.ssh, ~/.tars-private,
 *     ~/.gnupg, ~/.aws, ~/.config, the Telegram guard's list).
 * 12. It lets through a file that is not markdown (~/.npmrc, a key, a name
 *     that only ends in `md`, like `run.cmd`), or a folder named like one.
 * 13. It lets through a FOLDER link on the way: the file's parent really lies
 *     outside every root (~/.tars/h linked to the home is the escape itself).
 * 14. It follows a chain of links only to the first one: a file link to a link
 *     into ~/.ssh is judged by the final file.
 * 15. It applies where it was not asked for. It is for the renderer's reads
 *     and writes of instruction files (fs:read-text-file, fs:write-text-file,
 *     fs:read-project-files); /api/local-file (no token) and local-file://
 *     stay strict, or a link planted under ~/.tars serves any note in the
 *     home.
 *
 * Folder links are made as junctions where the type is read (Windows, where
 * they need no privilege) and as symlinks elsewhere. A FILE symlink needs a
 * privilege Windows gives only in Developer Mode or to an administrator: where
 * it is refused, the cases that need one are skipped and say why, and 15 is
 * witnessed anyway by standing the link in through realpathSync.native.
 */

const linkDir = (to: string, at: string) => fs.symlinkSync(to, at, 'junction');
/** The callers' own test, by spelling, no I/O. */
const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-real-target-')));
afterAll(() => { fs.rmSync(box, { recursive: true, force: true }); });

/** Why a file symlink cannot be made here, or undefined when it can. */
function fileLinksRefused(): string | undefined {
  const probe = path.join(box, 'probe-link');
  try {
    fs.symlinkSync(path.join(box, 'probe-target'), probe, 'file');
    fs.unlinkSync(probe);
    return undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM') throw err;
    return `skipped: file symlinks are refused here (${code}), which Windows does without Developer Mode; they run on macOS, Linux and a Windows runner that has the privilege`;
  }
}
const NO_FILE_LINKS = fileLinksRefused();
if (NO_FILE_LINKS) console.warn(`real-target.test.ts: ${NO_FILE_LINKS}`);

const home = path.join(box, 'home');
const ssh = path.join(home, '.ssh');
const priv = path.join(home, '.tars-private');
const data = path.join(home, '.tars');
const atlas = path.join(home, 'projects', 'atlas');
const docs = path.join(atlas, 'docs');
const deps = { home };
const roots = [data, atlas];

fs.mkdirSync(ssh, { recursive: true });
fs.mkdirSync(priv, { recursive: true });
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(path.join(ssh, 'id_rsa'), 'key');
fs.writeFileSync(path.join(priv, 'hermes-webhook-secret'), 'secret');
fs.writeFileSync(path.join(home, '.bashrc'), 'profile');
fs.writeFileSync(path.join(docs, 'a.md'), 'doc');
fs.writeFileSync(path.join(atlas, 'CLAUDE.md'), 'project');
linkDir(home, path.join(data, 'h'));
linkDir(ssh, path.join(data, 's'));
linkDir(priv, path.join(data, 'p'));
linkDir(ssh, path.join(atlas, 'escape'));
linkDir(docs, path.join(atlas, 'docs-link'));
linkDir(data, path.join(atlas, 'to-data'));

const lands = (target: string, r: string[] = roots) => landsUnderSafeRoot(target, r, inside, deps);
/** With the dotfiles exception, as the renderer's text and project-file channels ask for it. */
const landsMd = (target: string, r: string[] = roots) => landsUnderSafeRoot(target, r, inside, { ...deps, linkedMarkdown: true });

describe('1. a folder link inside a root that leads out of every root', () => {
  it('is refused, although its spelling is under a root', () => {
    for (const target of [
      path.join(data, 'h', '.ssh', 'id_rsa'),
      path.join(data, 'h', '.bashrc'),
      path.join(data, 's', 'id_rsa'),
      path.join(data, 'p', 'hermes-webhook-secret'),
      path.join(atlas, 'escape', 'id_rsa'),
    ]) {
      // The witness: the spelled check alone lets every one of them through.
      expect(isUnderSafeRoot(target, roots, inside, deps), target).toBe(true);
      expect(lands(target), target).toBe(false);
      expect(landsMd(target), target).toBe(false);
    }
  });
});

describe('2. a symlinked file inside a root', () => {
  it.skipIf(NO_FILE_LINKS)('pointing outside it is refused, pointing inside it is allowed', () => {
    const out = path.join(atlas, 'KEY.md');
    const inn = path.join(atlas, 'README.link.md');
    fs.symlinkSync(path.join(ssh, 'id_rsa'), out, 'file');
    fs.symlinkSync(path.join(docs, 'a.md'), inn, 'file');
    expect(lands(out)).toBe(false);
    expect(landsMd(out)).toBe(false);
    expect(lands(inn)).toBe(true);
  });
});

describe('3. a legitimate link', () => {
  it('that stays inside its root is allowed', () => {
    expect(lands(path.join(atlas, 'docs-link', 'a.md'))).toBe(true);
    expect(lands(path.join(atlas, 'CLAUDE.md'))).toBe(true);
  });

  it('that leads into another allowed root is allowed', () => {
    fs.writeFileSync(path.join(data, 'note.md'), 'n');
    expect(lands(path.join(atlas, 'to-data', 'note.md'))).toBe(true);
  });
});

describe('4. a target that does not exist yet', () => {
  it('is judged by its nearest existing folder: allowed inside', () => {
    expect(lands(path.join(atlas, 'new.md'))).toBe(true);
    expect(lands(path.join(atlas, 'docs-link', 'new.md'))).toBe(true);
    expect(lands(path.join(atlas, 'not-yet', 'deeper', 'new.md'))).toBe(true);
  });

  it('is refused when that folder really lies outside every root', () => {
    for (const target of [
      path.join(data, 's', 'authorized_keys'),
      path.join(data, 'h', 'new-profile'),
      path.join(data, 'p', 'new'),
      path.join(data, 's', 'not-yet', 'deeper', 'x'),
      path.join(atlas, 'escape', 'new'),
    ]) expect(lands(target), target).toBe(false);
  });

  it('realTarget names the real folder and keeps the missing tail', () => {
    expect(realTarget(path.join(atlas, 'docs-link', 'new.md'))).toBe(path.join(docs, 'new.md'));
    expect(realTarget(path.join(data, 's', 'x', 'y'))).toBe(path.join(ssh, 'x', 'y'));
  });
});

describe('5. a dangling link', () => {
  const gone = path.join(box, 'gone-dir');
  const dangling = path.join(atlas, 'dangling');
  fs.mkdirSync(gone, { recursive: true });
  linkDir(gone, dangling);
  fs.rmSync(gone, { recursive: true, force: true });

  it('in the target\'s place or on the way to it is refused', () => {
    expect(fs.existsSync(dangling)).toBe(false);
    expect(fs.lstatSync(dangling)).toBeTruthy();
    expect(realTarget(dangling)).toBeUndefined();
    expect(lands(dangling)).toBe(false);
    expect(lands(path.join(dangling, 'x.md'))).toBe(false);
  });

  it.skipIf(NO_FILE_LINKS)('a dangling file link is refused', () => {
    const file = path.join(atlas, 'dangling.md');
    fs.symlinkSync(path.join(home, '.new-profile'), file, 'file');
    expect(lands(file)).toBe(false);
    expect(landsMd(file)).toBe(false);
  });
});

describe('6. a root reached through a link', () => {
  it('allows its own files, existing and new, and still refuses a link out of it', () => {
    const realRoot = path.join(box, 'real-root');
    const linkedRoot = path.join(box, 'linked-root');
    fs.mkdirSync(realRoot, { recursive: true });
    fs.writeFileSync(path.join(realRoot, 'f.md'), 'f');
    linkDir(realRoot, linkedRoot);
    expect(lands(path.join(linkedRoot, 'f.md'), [linkedRoot])).toBe(true);
    expect(lands(path.join(linkedRoot, 'new.md'), [linkedRoot])).toBe(true);
    linkDir(ssh, path.join(realRoot, 'out'));
    expect(lands(path.join(linkedRoot, 'out', 'id_rsa'), [linkedRoot])).toBe(false);
  });
});

describe('7. a root that is the home or above it', () => {
  it('does not take the real target in', () => {
    // Spelled, the target is under atlas (safe) and the home (not): the
    // spelled check passes on atlas. Its real path is under the home only.
    const target = path.join(atlas, 'escape', 'id_rsa');
    expect(isUnderSafeRoot(target, [atlas, home], inside, deps)).toBe(true);
    expect(landsUnderSafeRoot(target, [atlas, home], inside, deps)).toBe(false);
  });
});

describe('8. a path that cannot be resolved', () => {
  it('is refused, and nothing throws', () => {
    const a = path.join(atlas, 'loop-a');
    const b = path.join(atlas, 'loop-b');
    fs.mkdirSync(b);
    linkDir(b, a);
    fs.rmdirSync(b);
    linkDir(a, b);
    expect(() => lands(path.join(a, 'x'))).not.toThrow();
    expect(lands(path.join(a, 'x'))).toBe(false);
    expect(lands(path.join(a, 'x', 'y'))).toBe(false);
  });
});

describe('9. a root neither the target nor its real path is under', () => {
  const OFFLINE = path.join(path.parse(box).root, 'net', 'tars-offline-nas.invalid', 'proj');
  const nodeFs = createRequire(import.meta.url)('node:fs') as Record<string, unknown> & { realpathSync: { native: unknown } };

  it('is never looked at on the disk', () => {
    const names = ['statSync', 'lstatSync', 'existsSync', 'accessSync', 'readdirSync', 'realpathSync'];
    const saved = new Map(names.map(n => [n, nodeFs[n]]));
    const savedNative = nodeFs.realpathSync.native as (...args: unknown[]) => unknown;
    const touched: string[] = [];
    const record = (name: string, original: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      if (String(args[0]).startsWith(OFFLINE)) touched.push(`${name} ${String(args[0])}`);
      return original(...args);
    };
    for (const name of names) nodeFs[name] = Object.assign(record(name, saved.get(name) as (...args: unknown[]) => unknown), saved.get(name));
    (nodeFs.realpathSync as { native: unknown }).native = record('realpathSync.native', savedNative);
    syncBuiltinESMExports();
    try {
      expect(lands(path.join(atlas, 'CLAUDE.md'), [OFFLINE, atlas])).toBe(true);
      expect(lands(path.join(atlas, 'escape', 'id_rsa'), [OFFLINE, atlas])).toBe(false);
      expect(lands(path.join(atlas, 'new.md'), [OFFLINE, atlas])).toBe(true);
    } finally {
      for (const [name, original] of saved) nodeFs[name] = original;
      (nodeFs.realpathSync as { native: unknown }).native = savedNative;
      syncBuiltinESMExports();
    }
    expect(touched).toEqual([]);
  });
});

describe('10-15. the dotfiles exception: one file link out of every root', () => {
  const dotfiles = path.join(home, 'dotfiles');
  fs.mkdirSync(path.join(dotfiles, 'folder.md'), { recursive: true });
  fs.writeFileSync(path.join(dotfiles, 'CLAUDE.md'), 'global instructions');
  fs.writeFileSync(path.join(dotfiles, 'notes.MD'), 'n');
  fs.writeFileSync(path.join(dotfiles, 'run.cmd'), 'n');
  fs.writeFileSync(path.join(home, '.npmrc'), '//registry.npmjs.org/:_authToken=x');
  fs.writeFileSync(path.join(ssh, 'id_ed25519'), 'key');
  fs.writeFileSync(path.join(ssh, 'notes.md'), 'n');
  fs.writeFileSync(path.join(priv, 'talk.md'), 'n');
  const blocked = [
    path.join(ssh, 'notes.md'), path.join(priv, 'talk.md'), path.join(data, 'x.md'),
    path.join(home, '.gnupg', 'x.md'), path.join(home, '.aws', 'x.md'), path.join(home, '.config', 'gh', 'hosts.md'),
    path.join(home, '.kube', 'x.md'), path.join(home, '.docker', 'x.md'), path.join(home, '.env', 'x.md'),
  ];
  for (const file of blocked) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, 'n');
  }

  it('10. allows a markdown file outside every root, any case of .md', () => {
    expect(linkedFileAllowed(path.join(dotfiles, 'CLAUDE.md'), deps)).toBe(true);
    expect(linkedFileAllowed(path.join(dotfiles, 'notes.MD'), deps)).toBe(true);
  });

  it('11. refuses a markdown file in a blocked place, and one reached there under another name', () => {
    for (const file of blocked) expect(linkedFileAllowed(file, deps), file).toBe(false);
    linkDir(ssh, path.join(dotfiles, 'ssh-link'));
    expect(linkedFileAllowed(path.join(dotfiles, 'ssh-link', 'notes.md'), deps)).toBe(false);
  });

  it('12. refuses what is not markdown, a folder named like it, and nothing', () => {
    expect(linkedFileAllowed(path.join(home, '.npmrc'), deps)).toBe(false);
    expect(linkedFileAllowed(path.join(ssh, 'id_ed25519'), deps)).toBe(false);
    expect(linkedFileAllowed(path.join(dotfiles, 'run.cmd'), deps)).toBe(false);
    expect(linkedFileAllowed(path.join(dotfiles, 'folder.md'), deps)).toBe(false);
    expect(linkedFileAllowed(path.join(dotfiles, 'missing.md'), deps)).toBe(false);
  });

  it('13. a folder link on the way is still refused, to the dotfiles file itself', () => {
    expect(landsMd(path.join(data, 'h', 'dotfiles', 'CLAUDE.md'))).toBe(false);
    expect(landsMd(path.join(data, 'h', 'dotfiles', 'new.md'))).toBe(false);
  });

  // The link stood in for by realpathSync.native reporting the file elsewhere,
  // as it does for a link: this keeps 15 witnessed where no file link can be
  // made. The real links below run wherever they can.
  it('15. simulated file link: the exception only where it is asked for', () => {
    const at = path.join(atlas, 'SIMULATED.md');
    fs.writeFileSync(at, 'the link itself, never read');
    const to = path.join(dotfiles, 'CLAUDE.md');
    const nodeFs = createRequire(import.meta.url)('node:fs') as { realpathSync: { native: (p: string, ...rest: unknown[]) => string } };
    const native = nodeFs.realpathSync.native;
    nodeFs.realpathSync.native = (p: string, ...rest: unknown[]) => (p === at ? to : native(p, ...rest));
    try {
      expect(realTarget(at)).toBe(to);
      expect(landsMd(at)).toBe(true);
      expect(lands(at)).toBe(false);
      expect(landsUnderSafeRoot(at, roots, inside, { ...deps, linkedMarkdown: false })).toBe(false);
    } finally {
      nodeFs.realpathSync.native = native;
    }
  });

  describe.skipIf(NO_FILE_LINKS)('through a real file link', () => {
    const link = (to: string, at: string) => { if (!fs.existsSync(at)) fs.symlinkSync(to, at, 'file'); };

    it('10. a file link from a root to the dotfiles file is allowed', () => {
      link(path.join(dotfiles, 'CLAUDE.md'), path.join(atlas, 'SHARED.md'));
      expect(landsMd(path.join(atlas, 'SHARED.md'))).toBe(true);
    });

    it('15. the same link is refused where the exception was not asked for', () => {
      link(path.join(dotfiles, 'CLAUDE.md'), path.join(atlas, 'SHARED.md'));
      expect(lands(path.join(atlas, 'SHARED.md'))).toBe(false);
    });

    it('11, 12. a file link to a key, a private file or ~/.npmrc is refused', () => {
      link(path.join(ssh, 'id_ed25519'), path.join(atlas, 'key.md'));
      link(path.join(priv, 'talk.md'), path.join(atlas, 'talk.md'));
      link(path.join(home, '.npmrc'), path.join(atlas, 'npmrc.md'));
      for (const name of ['key.md', 'talk.md', 'npmrc.md']) expect(landsMd(path.join(atlas, name)), name).toBe(false);
    });

    it('13. a file link reached through a folder link is refused', () => {
      link(path.join(dotfiles, 'CLAUDE.md'), path.join(dotfiles, 'via.md'));
      expect(landsMd(path.join(data, 'h', 'dotfiles', 'via.md'))).toBe(false);
    });

    it('14. a file link to a link into ~/.ssh is judged by the final file', () => {
      link(path.join(ssh, 'notes.md'), path.join(dotfiles, 'fwd.md'));
      link(path.join(dotfiles, 'fwd.md'), path.join(atlas, 'fwd.md'));
      expect(landsMd(path.join(atlas, 'fwd.md'))).toBe(false);
    });
  });
});
