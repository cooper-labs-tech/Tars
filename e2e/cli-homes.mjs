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
 * - opencode reads its own config from OPENCODE_CONFIG (a file) and OPENCODE_CONFIG_DIR (a folder), and Kilo, an
 *   opencode fork, from KILO_CONFIG and KILO_CONFIG_DIR.
 * - Both also take a whole home of their own, OPENCODE_TEST_HOME and KILO_TEST_HOME, and these files and folders:
 *   TEST_MANAGED_CONFIG_DIR, MODELS_PATH, PLUGIN_META_FILE and ZED_DB, and for Kilo, LANCEDB_PATH, TEST_DAEMON_LOG_DIR
 *   and TEST_DAEMON_STATE_DIR.
 * - These names were read from the published binaries (opencode 1.19.6 and Kilo 7.8.27, npm, 2026-11-20), never run:
 *   Kilo writes into whatever home it is given, even for --version.
 * - Goose keeps its config, data and state under GOOSE_PATH_ROOT when it is absolute (Goose 1.60.1, #618,
 *   goose-cli.ts), else under the XDG homes, and on Windows under APPDATA, which the fixture moves already.
 * - gemini, grok, codex and pi have homes of their own besides (the Audit's L4 on #638 and L1 on #643, each binary
 *   measured isolated on 2026-11-25): gemini 0.70.0 takes GEMINI_CLI_HOME before HOME as the folder its .gemini lies
 *   in; grok 1.0.92 takes GROK_HOME in place of ~/.grok; codex 0.163.0 keeps its state under CODEX_SQLITE_HOME; pi
 *   1.3.0 its packages under PI_PACKAGE_DIR and PI_MANAGED_INSTALL_ROOT (read from its published package, never run).
 *   XDG_BIN_HOME is where an installer run in the sandbox (uv's) puts what it installs.
 * A CLI's whole config or sign-in given as text (CLI_CONFIG_CONTENT: OPENCODE_ and KILO_ CONFIG_CONTENT and
 * AUTH_CONTENT) and git's own variables (GIT_OWN: GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_*..., which a run started from a
 * git hook carries) are dropped too, and never judged as folders. So are the whole families of gemini, grok, codex
 * and pi, and Google's and xAI's keys (CLI_FAMILIES), measured the same way:
 * - gemini's trust and system settings (GEMINI_CLI_TRUSTED_FOLDERS_PATH, GEMINI_CLI_SYSTEM_SETTINGS_PATH), its debug
 *   log, and Google's key, project and Vertex switch (GOOGLE_API_KEY, GOOGLE_APPLICATION_CREDENTIALS,
 *   GOOGLE_CLOUD_PROJECT, GCLOUD_PROJECT, GOOGLE_GENAI_USE_VERTEXAI and the rest its bundle reads), which would send a
 *   real gemini to Google on the runner's account;
 * - grok's overlays (GROK_CONFIG, and the file GROK_CONFIG_PATH names), its login (GROK_AUTH_PATH, GROK_AUTH), its log
 *   (GROK_LOG_FILE), and its key: XAI_API_KEY and GROK_CODE_XAI_API_KEY, which it sent to a loopback recorder as its
 *   key, and never GROK_API_KEY;
 * - codex's logins (CODEX_ACCESS_TOKEN, CODEX_AUTH, CODEX_API_KEY), its CA certificate and its endpoints;
 * - pi's session file, its TUI log and its spawn hook (PI_SESSION_FILE, PI_TUI_WRITE_LOG, PI_SPAWN_HOOK);
 * - and OpenTelemetry's exporter settings (OTEL_EXPORTER_OTLP_*: the endpoints, the headers, a client certificate and
 *   key), where grok 1.0.92 sends its telemetry: a runner's collector would receive a test's.
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

export const CLI_HOMES = /^(CODEX_HOME|CODEX_SQLITE_HOME|KIMI_CODE_HOME|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|PI_PACKAGE_DIR|PI_MANAGED_INSTALL_ROOT|GEMINI_CLI_HOME|GROK_HOME|XDG_(CONFIG|DATA|STATE|CACHE|BIN)_HOME|ZDOTDIR|CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR|(OPENCODE|KILO)_(CONFIG|CONFIG_DIR|TEST_HOME|TEST_MANAGED_CONFIG_DIR|MODELS_PATH|PLUGIN_META_FILE|ZED_DB)|KILO_(LANCEDB_PATH|TEST_DAEMON_LOG_DIR|TEST_DAEMON_STATE_DIR)|GOOSE_PATH_ROOT)$/;
export const CLI_CONFIG_CONTENT = /^(OPENCODE|KILO)_(CONFIG|AUTH)_CONTENT$/;
export const GIT_OWN = /^GIT_/;
/**
 * The whole families of gemini, grok, codex and pi, Google's and xAI's keys, and OpenTelemetry's exporter settings,
 * dropped and never judged: besides the homes above, files, logins, keys, switches and endpoints (e2e-cli-homes.test.ts,
 * cases 13 and 14).
 */
export const CLI_FAMILIES = /^(GEMINI|GROK|CODEX|PI|GOOGLE|XAI)_|^GCLOUD_PROJECT$|^OTEL_EXPORTER_OTLP_/;

/** Whether `name` is one of the four families: a CLI home, a CLI's config as text, git's own, or a CLI's own. */
export function cliEnvironment(name) {
  return CLI_HOMES.test(name) || CLI_CONFIG_CONTENT.test(name) || GIT_OWN.test(name) || CLI_FAMILIES.test(name);
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
 * The CLI homes of `env`, and the paths its CLIs' own families name (an absolute value of CLI_FAMILIES: GROK_LOG_FILE,
 * PI_SESSION_FILE, GEMINI_CLI_TRUSTED_FOLDERS_PATH...), that land outside `root`, as [name, value]. Judged on the value as given, never through
 * path.resolve, which drops `link/..` as text before the link is followed (#609's Audit, L1). A relative path is
 * outside, as a CLI resolves it against whatever folder it runs in. An empty value means none.
 */
export function homesOutside(env, root) {
  const at = landing(root);
  return Object.entries(env)
    .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
    // A CLI home always; and a variable of a CLI's own family whose value is a path, as a file one names (a log, a
    // login, a session) is written or read where it points (the Audit's I-1 on #643). Its keys, its switches, its
    // endpoints and its config as text are no path, and are never judged.
    .filter(([name, value]) => CLI_HOMES.test(name) || (CLI_FAMILIES.test(name) && path.isAbsolute(value)))
    .filter(([, value]) => {
      if (!path.isAbsolute(value)) return true;
      const where = landing(value);
      return !(where === at || where.startsWith(at + path.sep));
    });
}
