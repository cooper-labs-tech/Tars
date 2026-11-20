/**
 * The environment a CLI Tars drives reads its own folders and config from, which HOME moves none of. One list for the
 * two places that must keep a runner's from the code they run:
 * - e2e/fixture.mjs drops them from what a sandboxed Tars is handed, and refuses a spec's outside its sandbox;
 * - __tests__/setup/env-isolation.ts drops them from every test file, and __tests__/setup/home-guard.ts refuses one
 *   still outside the run's folder.
 *
 * The folders (CLI_HOMES):
 * - Tars reads CODEX_HOME (codex-cli.ts), KIMI_CODE_HOME (kimi-cli.ts), PI_CODING_AGENT_DIR (pi-provider.ts),
 *   XDG_CONFIG_HOME (opencode-provider.ts, and git through safe-git) and CLAUDE_CONFIG_DIR (a Claude account's folder).
 * - The CLIs it starts read the rest: pi's sessions, and the other XDG homes, where opencode and others keep their
 *   data, state and caches.
 * - ZDOTDIR makes the login shells of the agents' terminals, and the one Tars asks for codex's CODEX_HOME, read the rc
 *   files it names, and whatever they export.
 * - opencode reads its own config from OPENCODE_CONFIG (a file) and OPENCODE_CONFIG_DIR (a folder). Kilo, an opencode
 *   fork, does the same from KILO_CONFIG and KILO_CONFIG_DIR: only KILO_CONFIG_CONTENT was measured
 *   (reports/harnesses-measured.md), and the other two follow the fork's naming.
 * A CLI's whole config given as text (CLI_CONFIG_CONTENT) and git's own variables (GIT_OWN: GIT_DIR, GIT_INDEX_FILE,
 * GIT_CONFIG_*..., which a run started from a git hook carries) are dropped too, and never judged as folders.
 *
 * With one of them exported, a sandboxed Tars wrote into the owner's real folder (#608's Audit, L2), and so did the
 * code under npm test (#609's re-audit, M1: codex-provider.test.ts wrote the runner's codex config.toml). On
 * 2026-11-20 a test run without the setup files deleted the owner's ~/.codex/config.toml.
 *
 * Node's own modules are taken through process.getBuiltinModule, never imported: a test file's vi.mock('fs') or
 * vi.mock('os') does not reach them, and home-guard.ts judges with this module while such a file loads.
 * Tests: __tests__/e2e-cli-homes.test.ts, __tests__/setup/env-isolation.test.ts, __tests__/setup/home-guard.test.ts.
 */
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');

export const CLI_HOMES = /^(CODEX_HOME|KIMI_CODE_HOME|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|XDG_(CONFIG|DATA|STATE|CACHE)_HOME|ZDOTDIR|CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR|OPENCODE_CONFIG|OPENCODE_CONFIG_DIR|KILO_CONFIG|KILO_CONFIG_DIR)$/;
export const CLI_CONFIG_CONTENT = /^(OPENCODE|KILO)_CONFIG_CONTENT$/;
export const GIT_OWN = /^GIT_/;

/** Whether `name` is one of the three families: a CLI home, a CLI's config as text, or git's own. */
export function cliEnvironment(name) {
  return CLI_HOMES.test(name) || CLI_CONFIG_CONTENT.test(name) || GIT_OWN.test(name);
}

/**
 * Where a path lands, its links and its `..` resolved as the kernel does: for one that does not exist yet, where its
 * nearest existing parent lands, and the rest of the path.
 */
export function landing(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (error) {
    const parent = path.dirname(p);
    if (error.code !== 'ENOENT' || parent === p) throw error;
    return path.join(landing(parent), path.basename(p));
  }
}

/**
 * The CLI homes of `env` that land outside `root`, as [name, value]. Judged on the value as given, never through
 * path.resolve, which drops `link/..` as text before the link is followed (#609's Audit, L1). A relative path is
 * outside, as a CLI resolves it against whatever folder it runs in. An empty value means none.
 */
export function homesOutside(env, root) {
  const at = landing(root);
  return Object.entries(env)
    .filter(([name, value]) => CLI_HOMES.test(name) && typeof value === 'string' && value.trim() !== '')
    .filter(([, value]) => {
      if (!path.isAbsolute(value)) return true;
      const where = landing(value);
      return !(where === at || where.startsWith(at + path.sep));
    });
}
