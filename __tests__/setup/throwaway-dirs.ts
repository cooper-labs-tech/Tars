import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Called by a test file before it writes or removes anything under DATA_DIR or PRIVATE_DIR (the Audit's I-4 on #596).
 * Under the repo's setupFiles both are in a throwaway home inside the file's temporary folder (home-isolation.ts makes
 * it in os.tmpdir(), which tmpdir-isolation.ts has moved to the file's own folder). Run without them, as on 20/11,
 * they are the owner's ~/.tars and ~/.tars-private, and an afterEach would remove the real trace store, install file
 * and keys. This throws first then, naming the folder, and nothing after it runs.
 *
 * Each folder and the temporary folder are compared as the system resolves them, links included, from the nearest
 * part that exists (a folder not made yet is judged by its parent). A sibling named like the temporary folder, or a
 * path that climbs out with `..`, is outside.
 */
export function assertThrowaway(dirs: Record<string, string>, tmp: string = os.tmpdir()): void {
  const root = resolved(tmp);
  for (const [name, dir] of Object.entries(dirs)) {
    const at = resolved(dir);
    const rel = path.relative(root, at);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`${name} is ${dir}, outside the throwaway temporary folder ${root}: this test writes and removes files there, `
        + 'and would touch the real ones. Run it through the repo\'s vitest config, whose setupFiles move HOME.');
    }
  }
}

/** The path as the system resolves it: the nearest part that exists, through its links, then the rest. */
function resolved(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(p);
      tail.push(path.basename(head));
      head = parent;
    }
  }
}
