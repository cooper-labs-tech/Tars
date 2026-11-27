import { afterAll } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { guardPath } from './path-guard';

/**
 * No CLI installed in a home is on the PATH a test runs with.
 *
 * Measured on 2026-11-27: twice in one day a unit test started the owner's real Hermes, found on PATH in
 * ~/.local/bin, in the throwaway home; home-isolation.ts refused its unlink into ~/.hermes/tools both times and
 * nothing in the install changed. The 20/11 incident, the owner's ~/.codex/config.toml, was the same class, and so is
 * every other launcher of a CLI by its bare name: the chat's line in a real terminal, the version probe, codex's
 * probes. A guard in each launcher is a rule each one has to remember. So the cause goes, for every file, before its
 * imports (a module that reads PATH at load sees the guarded one): every PATH folder under the account's home
 * (os.userInfo().homedir, which no variable moves), under the HOME the run started with, and on Windows under the
 * profile, leaves. That is ~/.local/bin, ~/bin, ~/.cargo/bin, ~/.bun/bin, every ~/.nvm/versions/node/<v>/bin, and the
 * repository's own node_modules/.bin, which lies under the home too.
 *
 * The suite's own tools come back by their resolved paths, first: on macOS and Linux a folder of links in the file's
 * temporary folder holds node (the one running vitest, so no other node answers to the name), the npm and npx beside
 * it, and git when only a home held it. Never node's whole folder: `npm i -g` puts codex or claude there.
 * A test that opts into a real claude (TARS_REAL_CLAUDE=1, or its path) gets that one claude back, nothing else of
 * its folder. Everything outside the homes stays, in its order.
 *
 * What it cannot do: a CLI installed for the whole system (/opt/homebrew/bin/codex) stays reachable, and a test that
 * names a file in a home by its full path (real-claude-bypass.test.ts's ~/.local/bin/claude) is not a PATH lookup. On
 * Windows a link needs a privilege the suite does not ask for, so node's own folder comes back whole, first, and with
 * it whatever was installed globally beside that node.
 *
 * The cases, written before this file, are path-isolation.test.ts's.
 */

/** A container can run a uid with no passwd entry, and then there is no account home to name. */
function accountHome(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return '';
  }
}

const homes = [
  accountHome(),
  // home-isolation.ts, after this file, moves HOME, and puts it back when the file ends: this is the one the run started with.
  process.env.HOME ?? '',
  ...(process.platform === 'win32' ? [process.env.USERPROFILE ?? '', process.env.APPDATA ?? '', process.env.LOCALAPPDATA ?? ''] : []),
].filter(home => home !== '');

const guarded = guardPath(process.env, {
  homes,
  cwd: process.cwd(),
  // tmpdir-isolation.ts runs first: this is the file's own temporary folder, removed with it.
  binDir: path.join(os.tmpdir(), 'tars-vitest-bin'),
  execPath: process.execPath,
});

// Read by path-isolation.test.ts.
(globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for('tars.test.pathGuard')] = {
  homes,
  removed: guarded.removed,
  linked: guarded.linked,
};

afterAll(() => {
  guarded.restore();
});
