import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The project rule under other names, on every system (QA, 2026-11-26, the Audit's I-p on #648).
 *
 * The Audit's M5 on #648 is macOS's Data volume: /System/Volumes/Data before the home names the same folders, and
 * realpath gives that spelling back as it was given. window-file-access.test.ts reads it on darwin only, so on the
 * Linux and Windows CI the identity walk (homeFolderOf, homeFolderIn, each place's own identity in the async form)
 * judged nothing that a name could not. Here the second name is a link to the home (a junction on Windows), and
 * realpath, stubbed, gives a path under it back as given, as the Data volume does. Nothing else is stubbed: every stat
 * goes through the link to the home's own folders, so each device and inode the rules compare is the real one.
 *
 * Every way it can fail, written before the test (QA writes none of the rules):
 *  N1. A folder of the home whose name starts with a dot (~/.azure), by the second name, is taken for a project by the
 *      sync rule or by the async one (the project list, Review), or the window reads or searches it.
 *  N2. A folder of credentials (~/.aws) or the home's application folder (~/Library), by the second name, is taken for
 *      a project by the async rule: the places compared by their names only.
 *  N3. Tars's own folders (~/.tars, ~/.tars-private), by the second name, are a project, or searched.
 *  N4. A folder of the home whose name starts with a dot, a CLI's (~/.claude) or Tars's own, by the second name, is
 *      taken for a vault.
 *  N5. A project named outside the home that really is a dot folder of it (a link to ~/.azure, a junction on Windows)
 *      is taken for a project by the async rule: the dot rule read on the spelled path alone.
 *  N6. A dot folder whose name only starts like a CLI folder's (~/.claude-old, ~/.codexkeys) is taken for a project.
 *  N7. Over-correction: a plain project, or a plain folder taken for a vault, by the second name or through a link, is
 *      refused.
 *  N8. The test proves nothing: the second name lies in the home by name, realpath does not keep it, or it does not
 *      reach the home's own folders. Each is checked before the rules are.
 */

import { mayBeProject, projectRefusalAsync, vaultRefusal, windowMayRead, windowMaySearch } from '../../../electron/utils/window-file-access';
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';

const home = () => os.homedir();
const at = (...p: string[]) => path.join(home(), ...p);
const put = (file: string, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const idOf = (p: string) => { const s = fs.statSync(p, { bigint: true }); return `${s.dev}:${s.ino}`; };

const realpathNative = fs.realpathSync.native;
const realpathAsync = fs.promises.realpath;
let base: string;
let second: string;
/** `p`, a path of the home, by the home's second name. */
const bySecond = (p: string) => path.join(second, path.relative(home(), p));
const kept = (p: unknown): p is string => typeof p === 'string' && (p === second || p.startsWith(second + path.sep));

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-other-names-'));
  second = path.join(base, 'home');
  // A junction where the type is read (Windows), a link elsewhere.
  fs.symlinkSync(home(), second, 'junction');
});

afterAll(() => {
  fs.unlinkSync(second);
  fs.rmdirSync(base);
});

beforeEach(() => {
  // realpath keeps the second name as given, as it keeps macOS's Data volume; a path that is not there still fails.
  vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike, options?: unknown) => {
    if (kept(p)) { fs.statSync(p); return p; }
    return realpathNative(p, options as never);
  }) as never);
  vi.spyOn(fs.promises, 'realpath').mockImplementation((async (p: fs.PathLike, options?: unknown) => {
    if (kept(p)) { await fs.promises.stat(p); return p; }
    return realpathAsync(p, options as never);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the second name, checked before the rules (N8)', () => {
  it('lies outside the home by name, keeps its spelling through realpath, and reaches the home\'s own folders', async () => {
    const azure = path.dirname(put(at('.azure', 'msal_token_cache.json'), 'a token'));
    for (const h of [home(), realpathNative(home())]) expect(path.relative(h, second).split(path.sep)[0], h).toBe('..');
    expect(fs.realpathSync.native(bySecond(azure))).toBe(bySecond(azure));
    expect(await fs.promises.realpath(bySecond(azure))).toBe(bySecond(azure));
    expect(idOf(second)).toBe(idOf(home()));
    expect(idOf(bySecond(azure))).toBe(idOf(azure));
    expect(fs.statSync(home(), { bigint: true }).ino).not.toBe(BigInt(0));
  });
});

describe('a home reached by a second name is the same home, on every system', () => {
  it('N1 to N3, N7: by the second name, no dot folder, folder of credentials, application folder or folder of Tars is a project, by either form, nor read nor searched', async () => {
    const azure = path.dirname(put(at('.azure', 'msal_token_cache.json'), 'a token'));
    const aws = path.dirname(put(at('.aws', 'notes.md'), 'a token'));
    const lib = path.dirname(put(at('Library', 'Application Support', 'SomeApp', 'notes.md'), 'a token'));
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(PRIVATE_DIR, { recursive: true });
    for (const dir of [azure, aws, lib, DATA_DIR, PRIVATE_DIR]) {
      const other = bySecond(dir);
      expect(mayBeProject(other), other).toBe(false);
      expect(await projectRefusalAsync(other), other).toBeDefined();
      expect(windowMaySearch(other, [other]), other).toBe(false);
    }
    expect(windowMayRead(path.join(bySecond(azure), 'msal_token_cache.json'), [bySecond(azure)])).toBe(false);
    // Still a project, by the second name too: one that is none of these.
    const shop = path.dirname(put(at('work', 'shop', 'README.md')));
    expect(mayBeProject(bySecond(shop))).toBe(true);
    expect(await projectRefusalAsync(bySecond(shop))).toBeUndefined();
  });

  it('N4, N7: by the second name, no folder of the home whose name starts with a dot is a vault, and a plain folder still is', () => {
    const azure = path.dirname(put(at('.azure', 'msal_token_cache.json'), 'a token'));
    fs.mkdirSync(at('.claude'), { recursive: true });
    fs.mkdirSync(PRIVATE_DIR, { recursive: true });
    for (const dir of [azure, at('.claude'), PRIVATE_DIR]) expect(vaultRefusal(bySecond(dir)), dir).toBeDefined();
    const notes = path.dirname(put(at('notes', 'a.md')));
    expect(vaultRefusal(bySecond(notes))).toBeUndefined();
  });
});

describe('the dot rule under other names', () => {
  it('N5, N7: a project named outside the home that really is a dot folder of it is no project, by either form; one that really is a plain folder still is', async () => {
    const azure = path.dirname(put(at('.azure', 'msal_token_cache.json'), 'a token'));
    const shop = path.dirname(put(at('work', 'shop', 'README.md')));
    const toAzure = path.join(base, 'azure-link');
    const toShop = path.join(base, 'shop-link');
    // A junction where the type is read (Windows), a link elsewhere.
    fs.symlinkSync(azure, toAzure, 'junction');
    fs.symlinkSync(shop, toShop, 'junction');
    try {
      expect(mayBeProject(toAzure)).toBe(false);
      expect(await projectRefusalAsync(toAzure)).toBeDefined();
      expect(windowMaySearch(toAzure, [toAzure])).toBe(false);
      expect(mayBeProject(toShop)).toBe(true);
      expect(await projectRefusalAsync(toShop)).toBeUndefined();
    } finally {
      fs.unlinkSync(toAzure);
      fs.unlinkSync(toShop);
    }
  });

  it('N6: a dot folder whose name only starts like a CLI folder\'s is no project, by either form', async () => {
    for (const name of ['.claude-old', '.codexkeys', '.gemini.bak', '.grok2']) {
      const dir = path.dirname(put(at(name, 'notes.md'), 'a token'));
      expect(mayBeProject(dir), dir).toBe(false);
      expect(await projectRefusalAsync(dir), dir).toBeDefined();
    }
  });
});
