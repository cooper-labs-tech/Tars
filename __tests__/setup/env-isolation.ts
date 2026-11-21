import { afterAll } from 'vitest';
import { cliEnvironment } from '../../e2e/cli-homes.mjs';

/**
 * The ambient environment does not reach the suite.
 *
 * Twice in one night a test's verdict turned out to depend on who ran it.
 * `managed-cli-env` asserts that Tars does NOT put DISABLE_AUTOUPDATER on a
 * codex spawn; the spawn spreads `process.env`, which is right for a pty, so
 * "Tars did not add this" and "this is not present" are different statements
 * and only the first is the property. Tars has run its own agents with that
 * variable set since 1.7.0, so the suite was green in CI and red in every
 * terminal Tars had started - including the one an agent runs the suite in.
 * DISABLE_UPDATES was the same defect one variable over, and would have hit any
 * developer on an IT-managed laptop. `constants.test.ts` has the mirror image:
 * it asserts API_PORT is 31415, which `scripts/sandbox.sh` falsifies by
 * exporting DOROTHY_API_PORT=31499 into the shell you then run tests from.
 *
 * Two occurrences on one cause is a class, so this removes the cause instead of
 * the symptoms. Isolating a variable at a time was the alternative, and it only
 * works for the ones somebody has already been bitten by.
 *
 * This runs as a setupFile, which vitest loads BEFORE the test file's imports.
 * That ordering is the whole point and not an incidental: `constants.ts` reads
 * DOROTHY_API_PORT at module load, so a cleanup in a beforeEach would run after
 * the value had already been baked into an exported constant.
 *
 * A test that WANTS one of these sets it itself, and still can: nothing here
 * runs again after this point, so an assignment inside a test or a beforeEach
 * survives untouched.
 */

/**
 * The namespaces the product owns, by prefix rather than by name.
 *
 * A list of names is what drifted in the first place - four PATH key lists that
 * stopped agreeing, and a FOREIGN_BINARIES that lagged twice. Prefixes cover
 * the variable somebody adds next week without an edit here:
 *
 *  CLAUDE      CLAUDE_AGENT_ID, CLAUDE_PROJECT_PATH, CLAUDE_SKILLS,
 *              CLAUDE_PROVIDER, CLAUDE_MGR_API_URL, CLAUDE_CODE_*, CLAUDECODE
 *              (no underscore, hence the bare prefix)
 *  ANTHROPIC_  BASE_URL, API_KEY, AUTH_TOKEN, MODEL - injected per provider
 *  DOROTHY_    API_PORT, DEV_URL, E2E, AGENT_ID, PROJECT_PATH, SKILLS
 *  AMP_        AMP_API_KEY, AMP_SETTINGS_FILE
 *  OR_         OR_SITE_URL, OR_APP_NAME, OpenRouter's attribution headers
 *  DISABLE_    DISABLE_AUTOUPDATER, and DISABLE_UPDATES which Tars deliberately
 *              never sets and has a test saying so
 *  TARS_       TARS_CLAUDE_ACCOUNT, TARS_CHATS_READ, TARS_INSTANCE_ID: what Tars
 *              puts in its agents' terminals, where QA and every agent run the
 *              suite (acp-account-env.test.ts read TARS_CLAUDE_ACCOUNT=default
 *              there, 2026-10-19); the suite's own opt-ins are kept below
 */
const PRODUCT_PREFIXES = ['CLAUDE', 'ANTHROPIC_', 'DOROTHY_', 'AMP_', 'OR_', 'DISABLE_', 'TARS_'];

/**
 * Kept on purpose, with the reason, because each one breaks something real.
 *
 * These are not in the namespaces above, so nothing here would remove them
 * today. They are named anyway: the guard below asserts they survived, so a
 * future prefix that starts eating them fails loudly instead of producing a
 * suite that cannot spawn a shell.
 */
const KEPT: Record<string, string> = {
  // Every test that resolves a binary, and node itself finding its own modules.
  PATH: 'the suite spawns real hooks and real CLIs; without it nothing resolves',
  // home-isolation.ts points it at a throwaway directory for every file;
  // removing it outright leaves os.homedir() with nothing sane to answer.
  HOME: 'os.homedir() backs ~/.claude.json and ~/.tars paths under test',
  // The same on Windows, where os.homedir() reads USERPROFILE and Electron's
  // folders sit under APPDATA / LOCALAPPDATA: home-isolation.ts moves all of
  // them with HOME, and a sweep that removed one would send the product back
  // to the real profile.
  USERPROFILE: 'os.homedir() on Windows; home-isolation.ts points it at the throwaway home',
  HOMEDRIVE: 'with HOMEPATH, the home some Windows tools read; moved with HOME',
  HOMEPATH: 'with HOMEDRIVE, the home some Windows tools read; moved with HOME',
  APPDATA: 'Electron userData and appData on Windows; moved with HOME',
  LOCALAPPDATA: 'per-machine app data on Windows; moved with HOME',
  // buildFullPath and the pty env composition both read it.
  SHELL: 'the pty environment is composed from it, and hooks run under it',
  // electron/ reads this in four places, so it belongs on this list even
  // though no prefix above would catch it. Vitest sets it to 'test' and the
  // toolchain reads it; removing it would change what is under test rather
  // than isolate it.
  NODE_ENV: 'vitest owns it, and the product branches on it deliberately',
  // The suite's own opt-ins, set by whoever runs it, in the TARS_ namespace swept above.
  TARS_STRESS: 'the opt-in for the measurements on the real disk',
  TARS_REAL_CLAUDE: 'the opt-in, or the path, for the tests that start a real claude',
  TARS_HERMES_TREE: 'with TARS_HERMES_PYTHON, where the live Hermes kanban test finds a Hermes checkout',
  TARS_HERMES_PYTHON: 'with TARS_HERMES_TREE, the python the live Hermes kanban test runs it with',
};

const removed: Record<string, string> = {};
/** Which exceptions were actually set before the sweep, so the check below can fire. */
const keptWereSet = Object.keys(KEPT).filter(key => process.env[key] !== undefined);

for (const key of Object.keys(process.env)) {
  if (key in KEPT) continue;
  // A CLI home, a CLI's config as text or git's own variable of the runner's: the code under test reads a CLI home
  // before HOME, so home-isolation.ts moving HOME did not move codex's, opencode's or pi's folder (#609's re-audit,
  // M1). The list is the E2E fixture's own (e2e/cli-homes.mjs); without one, each CLI falls back under the throwaway
  // HOME.
  if (!PRODUCT_PREFIXES.some(prefix => key.startsWith(prefix)) && !cliEnvironment(key)) continue;
  removed[key] = process.env[key] as string;
  delete process.env[key];
}

// The `continue` above is the only thing protecting the exceptions, so this
// checks that it held rather than that it exists. Reachable on purpose: an edit
// that drops the KEPT check, or a prefix that starts matching one of these,
// fails here instead of producing a suite running against a machine it can no
// longer address - no PATH, no spawned hook, and a hundred confusing reds.
for (const key of keptWereSet) {
  if (process.env[key] === undefined) {
    throw new Error(`env-isolation removed ${key}, which is kept on purpose: ${KEPT[key]}`);
  }
}

afterAll(() => {
  // Put the process back as it was found. It exits straight after, so this is
  // hygiene rather than necessity - but a setup file that leaves the
  // environment altered is the same class of surprise it exists to remove.
  for (const [key, value] of Object.entries(removed)) process.env[key] = value;
});
