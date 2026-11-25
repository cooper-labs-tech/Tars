import './setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CLI_HOMES, homesOutside, inheritable, launchSandboxed } from '../e2e/fixture.mjs';

/**
 * The folders of the CLIs Tars drives, as the environment names them, and an E2E sandbox.
 *
 * launchSandboxed moves HOME, and a CLI's home that a variable names does not follow it.
 * Tars reads CODEX_HOME (codex-cli.ts: codex's config.toml, sessions and login), KIMI_CODE_HOME
 * (kimi-cli.ts, #601), PI_CODING_AGENT_DIR (pi-provider.ts: pi's mcp.json), XDG_CONFIG_HOME
 * (opencode-provider.ts: opencode.json; git, through safe-git) and CLAUDE_CONFIG_DIR (an account's
 * Claude Code folder). With one of them exported in the runner, a sandboxed Tars wrote into
 * the owner's real folder, and the CLIs it started ran on the owner's login (#608's Audit, L2).
 * On 20/11 a test that reached the real ~/.codex the same way deleted the owner's config.toml.
 *
 * How it can fail, written on 2026-11-20 before the code:
 * 1. The caller's CODEX_HOME reaches the app.
 * 2. The caller's KIMI_CODE_HOME, PI_CODING_AGENT_DIR or PI_CODING_AGENT_SESSION_DIR, an XDG
 *    home (config, data, state, cache: the CLIs' configs, sessions and logs), or ZDOTDIR reaches
 *    the app. ZDOTDIR makes the login shells of the agents' terminals, and the one Tars asks for
 *    codex's CODEX_HOME, read the owner's rc files, and whatever they export.
 * 3. A spec hands the app one of those folders outside its sandbox, and the app starts on it.
 *    CLAUDE_CONFIG_DIR is in the family too, even though the CLAUDE prefix already keeps the
 *    caller's out.
 * 4. A value reads as inside the sandbox but is not: `<sandbox>/../..`, or a relative path,
 *    which a CLI resolves against whatever folder it runs in.
 * 5. A link inside the sandbox leads outside it.
 * 6. Too much is refused:
 *    - the empty value a spec uses to say "none" (codex-launch-reads.spec.ts: CODEX_HOME '');
 *    - a folder of the sandbox that does not exist yet;
 *    - on macOS, the same folder named through /var or through /private/var;
 *    - a variable outside the family, such as PATH or LANG.
 * 7. The refusal comes after the app has started, so a CLI has already run in the wrong
 *    home, or the error does not say which variable is wrong and where it points.
 *
 * Added on 2026-11-20 from #609's Audit (reports/audit-609.md), before the fixes:
 * 5b. (L1) A `..` after a link inside the sandbox reads as inside, though the kernel lands
 *     outside: `<sandbox>/link/..` resolves `link` first, then `..` from where it leads.
 * 8.  (L2) opencode's own config, exported in the runner, reaches the app's opencode: OPENCODE_CONFIG
 *     (a file), OPENCODE_CONFIG_DIR (a folder), OPENCODE_CONFIG_CONTENT (the config itself), and
 *     Kilo's, an opencode fork (KILO_CONFIG_CONTENT measured, harnesses-measured.md;
 *     KILO_CONFIG and KILO_CONFIG_DIR by the fork's naming). A content variable is never judged
 *     as a path: a spec that hands one in must not be refused for it.
 * 9.  (L3) git's own variables reach the app: GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
 *     GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY, GIT_CONFIG_GLOBAL and the rest, which git sets for a
 *     run started from a hook. A CLI or a stand-in that runs git in an agent's terminal would then
 *     act on the owner's repository.
 * 10. The other homes of opencode and Kilo reach the app. Read from their published binaries
 *     (opencode 1.19.6, Kilo 7.8.27, npm, 20/11; never run: Kilo writes into whatever home it is
 *     given, even for --version):
 *     - each one's whole home, OPENCODE_TEST_HOME and KILO_TEST_HOME;
 *     - TEST_MANAGED_CONFIG_DIR, MODELS_PATH, PLUGIN_META_FILE and ZED_DB, on both;
 *     - Kilo's LANCEDB_PATH, TEST_DAEMON_LOG_DIR and TEST_DAEMON_STATE_DIR;
 *     - their sign-in, OPENCODE_AUTH_CONTENT and KILO_AUTH_CONTENT. These are contents, as in 8:
 *       a runner's would hand the sandboxed app's CLI the runner's account.
 * 11. Goose's whole home reaches the app: GOOSE_PATH_ROOT. With it absolute, Goose keeps its config, data and state
 *     under it (#618, goose-cli.ts, Goose 1.60.1 measured); else the XDG homes of 2, and on Windows APPDATA, which
 *     the fixture already moves into the sandbox.
 *
 * Added on 2026-11-22 from #609's Audit (I-5), before the fix:
 * 12. Goose's keyring is the system's keychain, outside every home a sandbox can move: a real goose started by a
 *     sandboxed app writes its keys into the owner's keychain. The conformance sets GOOSE_DISABLE_KEYRING=1, and
 *     launchSandboxed does not, so a future spec that starts a real goose would reach it. The launch must hand
 *     GOOSE_DISABLE_KEYRING=1 down by default, whatever the caller's own value, and a spec may still name another.
 *
 * Added on 2026-11-25 from the Audit's L4 on #638 and L1 on #643, before the fix, each binary measured isolated:
 * 13. gemini's, grok's, codex's and pi's own variables reach the app beyond the homes above, and so do Google's and
 *     xAI's keys:
 *     - gemini 0.70.0 takes GEMINI_CLI_HOME before HOME for the folder its .gemini lies in, its trust and system
 *       settings from GEMINI_CLI_TRUSTED_FOLDERS_PATH and GEMINI_CLI_SYSTEM_SETTINGS_PATH, and Google's key, project
 *       and Vertex switch from GOOGLE_API_KEY, GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT, GCLOUD_PROJECT
 *       and GOOGLE_GENAI_USE_VERTEXAI, which would send a real gemini to Google on the runner's account;
 *     - grok 1.0.92 takes GROK_HOME in place of ~/.grok, lays GROK_CONFIG or the file GROK_CONFIG_PATH names over
 *       its config, signs in with GROK_AUTH_PATH's file, and sends XAI_API_KEY as its key (GROK_API_KEY it never
 *       reads);
 *     - codex 0.163.0 keeps its state under CODEX_SQLITE_HOME, signs in with CODEX_ACCESS_TOKEN, CODEX_AUTH or
 *       CODEX_API_KEY, and trusts CODEX_CA_CERTIFICATE;
 *     - pi 1.3.0 keeps its packages under PI_PACKAGE_DIR and PI_MANAGED_INSTALL_ROOT, and writes PI_SESSION_FILE and
 *       PI_TUI_WRITE_LOG;
 *     - and XDG_BIN_HOME, where an installer run in the sandbox (uv's) puts what it installs.
 *     Each family must be left out whole, and the folders among them judged as homes: a spec may name one only
 *     inside its sandbox. A key or a config given as text is never judged as a path.
 * 14. (the orchestrator's word of 25/11, before the fix) grok 1.0.92 also sends its telemetry where OpenTelemetry's
 *     own variables say: OTEL_EXPORTER_OTLP_ENDPOINT and the logs', metrics' and traces' endpoints, with
 *     OTEL_EXPORTER_OTLP_HEADERS and a client certificate and key (OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE,
 *     OTEL_EXPORTER_OTLP_CLIENT_KEY). A runner's collector would receive a test's grok telemetry. Left out whole, never
 *     judged; the product keeps handing the user's own environment to the agents.
 * 15. (the Audit's I-1 on #643 at 839589f31, before the fix) a family's file goes unjudged: a spec naming GROK_AUTH_PATH,
 *     GROK_LOG_FILE, GEMINI_CLI_TRUSTED_FOLDERS_PATH, GEMINI_DEBUG_LOG_FILE, PI_SESSION_FILE or PI_TUI_WRITE_LOG outside
 *     its sandbox is not refused, and the CLI reads or writes there. A family value that is an absolute path is judged
 *     as a home is; a key, a switch, an endpoint or a config as text never.
 */

const accountHome = os.userInfo().homedir;
const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cli-homes-'));
const FAMILY = [
  'CODEX_HOME', 'KIMI_CODE_HOME', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'ZDOTDIR', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'KILO_CONFIG', 'KILO_CONFIG_DIR',
  // 10.
  'OPENCODE_TEST_HOME', 'OPENCODE_TEST_MANAGED_CONFIG_DIR', 'OPENCODE_MODELS_PATH', 'OPENCODE_PLUGIN_META_FILE', 'OPENCODE_ZED_DB',
  'KILO_TEST_HOME', 'KILO_TEST_MANAGED_CONFIG_DIR', 'KILO_MODELS_PATH', 'KILO_PLUGIN_META_FILE', 'KILO_ZED_DB',
  'KILO_LANCEDB_PATH', 'KILO_TEST_DAEMON_LOG_DIR', 'KILO_TEST_DAEMON_STATE_DIR',
  // 11.
  'GOOSE_PATH_ROOT',
];
const CONTENTS = ['OPENCODE_CONFIG_CONTENT', 'KILO_CONFIG_CONTENT', 'OPENCODE_AUTH_CONTENT', 'KILO_AUTH_CONTENT'];
const GIT = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'];
const theOwners = (name: string) => path.join(accountHome, `.${name.toLowerCase()}`);

describe('the CLI homes an E2E sandbox hands the app', () => {
  it('1, 2. leaves out every CLI home the caller has, and keeps the rest', () => {
    const env = inheritable({ PATH: '/usr/bin', LANG: 'C.UTF-8', ...Object.fromEntries(FAMILY.map(name => [name, theOwners(name)])) });

    expect(env).toEqual({ PATH: '/usr/bin', LANG: 'C.UTF-8' });
  });

  it('3. names each CLI home a spec points outside the sandbox, with where it points', () => {
    const home = sandbox();
    for (const name of FAMILY) {
      expect(CLI_HOMES.test(name), `${name} is not in the family`).toBe(true);
      expect(homesOutside({ [name]: theOwners(name) }, home)).toEqual([[name, theOwners(name)]]);
    }
  });

  it('4. reads a path where it lands: `..` out of the sandbox, and a relative path, are outside', () => {
    const home = sandbox();
    // Written out, not path.join'd: join would resolve the `..` itself.
    const climbing = [home, '..', '..', '.codex'].join(path.sep);
    expect(homesOutside({ CODEX_HOME: climbing, KIMI_CODE_HOME: 'kimi-home' }, home)).toEqual([
      ['CODEX_HOME', climbing],
      ['KIMI_CODE_HOME', 'kimi-home'],
    ]);
  });

  it.skipIf(process.platform === 'win32')('5. follows a link in the sandbox to where it leads', () => {
    const home = sandbox();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-homes-elsewhere-'));
    fs.symlinkSync(elsewhere, path.join(home, '.codex'));
    expect(homesOutside({ CODEX_HOME: path.join(home, '.codex') }, home)).toEqual([['CODEX_HOME', path.join(home, '.codex')]]);
  });

  it.skipIf(process.platform === 'win32')('5b. reads a `..` after a link from where the link leads, as the kernel does', () => {
    const home = sandbox();
    const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-homes-owner-'));
    fs.mkdirSync(path.join(owner, '.codex', 'sub'), { recursive: true });
    fs.symlinkSync(path.join(owner, '.codex', 'sub'), path.join(home, 'link'));
    // Written out: path.join would drop `link/..` as text, which is the fault itself.
    const up = [home, 'link', '..'].join(path.sep);
    const upAndOn = [home, 'link', '..', 'x'].join(path.sep);
    expect(homesOutside({ CODEX_HOME: up, KIMI_CODE_HOME: upAndOn }, home)).toEqual([['CODEX_HOME', up], ['KIMI_CODE_HOME', upAndOn]]);
  });

  it('8. leaves out opencode\'s and Kilo\'s config, judges their files and folders, and never their content', () => {
    const home = sandbox();
    const content = JSON.stringify({ provider: { tars: { options: { baseURL: 'http://127.0.0.1:9/v1' } } } });
    expect(inheritable({ PATH: '/usr/bin', ...Object.fromEntries(CONTENTS.map(name => [name, content])), OPENCODE_CONFIG: theOwners('opencode/opencode.json') })).toEqual({ PATH: '/usr/bin' });
    expect(homesOutside(Object.fromEntries(CONTENTS.map(name => [name, content])), home)).toEqual([]);
    expect(homesOutside({ OPENCODE_CONFIG: path.join(home, '.config', 'opencode', 'opencode.json') }, home)).toEqual([]);
  });

  it('9. leaves out git\'s own variables', () => {
    expect(inheritable({ PATH: '/usr/bin', ...Object.fromEntries(GIT.map(name => [name, path.join(accountHome, 'repo', '.git')])) })).toEqual({ PATH: '/usr/bin' });
  });

  it('6. takes an empty value, a folder still to be made in the sandbox, and leaves other variables alone', () => {
    const home = sandbox();
    expect(homesOutside({
      CODEX_HOME: '', KIMI_CODE_HOME: '  ', PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'),
      XDG_CONFIG_HOME: path.join(home, '.config'), PATH: '/usr/bin', LANG: 'C.UTF-8', TMPDIR: os.tmpdir(),
    }, home)).toEqual([]);
  });

  it.skipIf(process.platform !== 'darwin')('6. takes the sandbox named through /var and through /private/var alike', () => {
    const real = fs.realpathSync(sandbox());
    const linked = real.startsWith('/private/') ? real.slice('/private'.length) : real;
    expect(homesOutside({ CODEX_HOME: path.join(linked, '.codex'), XDG_CONFIG_HOME: path.join(real, '.config') }, linked)).toEqual([]);
    expect(homesOutside({ CODEX_HOME: path.join(linked, '.codex'), XDG_CONFIG_HOME: path.join(real, '.config') }, real)).toEqual([]);
  });

  it('7. refuses the launch before the app starts, naming the variable and where it points', async () => {
    const home = sandbox();
    let launched = 0;
    const electron = { launch: async () => { launched++; throw new Error('the app was started'); } };

    const refusal = await launchSandboxed(electron, home, { env: { CODEX_HOME: theOwners('CODEX_HOME') } }).then(() => null, (error: Error) => error);

    expect(launched).toBe(0);
    expect(refusal?.message).toContain(`CODEX_HOME: ${theOwners('CODEX_HOME')}`);
  });
});

describe('the keychain an E2E sandbox keeps the app\'s CLIs out of', () => {
  /** The environment launchSandboxed hands Electron, read at the launch, which then stops. */
  const handed = async (specEnv: Record<string, string>, callerEnv: Record<string, string> = {}) => {
    let env: Record<string, string> | undefined;
    const electron = { launch: async (options: { env: Record<string, string> }) => { env = options.env; throw new Error('stopped at the launch'); } };
    const was = Object.fromEntries(Object.keys(callerEnv).map((name) => [name, process.env[name]]));
    Object.assign(process.env, callerEnv);
    try {
      await launchSandboxed(electron, sandbox(), { env: specEnv }).catch(() => {});
    } finally {
      for (const [name, value] of Object.entries(was)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    return env;
  };

  it('12. hands GOOSE_DISABLE_KEYRING=1 down by default, so a real goose never writes the owner\'s keychain', async () => {
    expect((await handed({}))?.GOOSE_DISABLE_KEYRING).toBe('1');
  });

  it('12. keeps it whatever the caller exported, and lets a spec name its own', async () => {
    expect((await handed({}, { GOOSE_DISABLE_KEYRING: '0' }))?.GOOSE_DISABLE_KEYRING).toBe('1');
    expect((await handed({ GOOSE_DISABLE_KEYRING: '0' }))?.GOOSE_DISABLE_KEYRING).toBe('0');
  });
});

describe('the whole families of the CLIs Tars drives, and their keys (13)', () => {
  /** Folders: judged as homes. */
  const HOMES = ['GEMINI_CLI_HOME', 'GROK_HOME', 'CODEX_SQLITE_HOME', 'PI_PACKAGE_DIR', 'PI_MANAGED_INSTALL_ROOT', 'XDG_BIN_HOME'];
  /** Files, keys, switches and config as text: left out, never judged. */
  const REST = [
    'GEMINI_CLI_TRUSTED_FOLDERS_PATH', 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', 'GEMINI_DEBUG_LOG_FILE', 'GEMINI_API_KEY',
    'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_GENAI_USE_VERTEXAI', 'GCLOUD_PROJECT',
    'GROK_CONFIG', 'GROK_CONFIG_PATH', 'GROK_AUTH_PATH', 'GROK_LOG_FILE', 'XAI_API_KEY',
    'CODEX_ACCESS_TOKEN', 'CODEX_AUTH', 'CODEX_API_KEY', 'CODEX_CA_CERTIFICATE',
    'PI_SESSION_FILE', 'PI_TUI_WRITE_LOG',
  ];

  it('13. leaves out every one of them the caller has, and keeps the rest', () => {
    const env = inheritable({ PATH: '/usr/bin', LANG: 'C.UTF-8', ...Object.fromEntries([...HOMES, ...REST].map(name => [name, theOwners(name)])) });

    expect(env).toEqual({ PATH: '/usr/bin', LANG: 'C.UTF-8' });
  });

  it('13. judges the folders among them as homes, and a key or a config as text never', () => {
    const home = sandbox();
    for (const name of HOMES) {
      expect(CLI_HOMES.test(name), `${name} is not judged as a home`).toBe(true);
      expect(homesOutside({ [name]: theOwners(name) }, home)).toEqual([[name, theOwners(name)]]);
      expect(homesOutside({ [name]: path.join(home, `.${name.toLowerCase()}`) }, home)).toEqual([]);
    }
    expect(homesOutside({ GEMINI_API_KEY: 'AIza-not-a-folder', XAI_API_KEY: 'xai-not-a-folder', CODEX_AUTH: '{"token":"x"}', GROK_CONFIG: '{"models":{}}' }, home)).toEqual([]);
  });

  it('14. leaves out the caller\'s OpenTelemetry exporter settings, and never judges an endpoint or a header', () => {
    const OTLP = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE', 'OTEL_EXPORTER_OTLP_CLIENT_KEY', 'OTEL_EXPORTER_OTLP_PROTOCOL'];
    expect(inheritable({ PATH: '/usr/bin', ...Object.fromEntries(OTLP.map(name => [name, 'http://127.0.0.1:4318'])) })).toEqual({ PATH: '/usr/bin' });
    // An endpoint, a header and a protocol are no path; a certificate or a key file is one, judged as case 15 says.
    expect(homesOutside({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_HEADERS: 'authorization=x', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }, sandbox())).toEqual([]);
  });

  it('15. judges a family\'s file as a home: refused outside the sandbox, taken inside, and a value that is no path never', () => {
    const FILES = ['GROK_AUTH_PATH', 'GROK_LOG_FILE', 'GEMINI_CLI_TRUSTED_FOLDERS_PATH', 'GEMINI_DEBUG_LOG_FILE', 'PI_SESSION_FILE', 'PI_TUI_WRITE_LOG'];
    const home = sandbox();
    for (const name of FILES) {
      expect(homesOutside({ [name]: theOwners(name) }, home), `${name} outside`).toEqual([[name, theOwners(name)]]);
      expect(homesOutside({ [name]: path.join(home, `${name.toLowerCase()}.file`) }, home), `${name} inside`).toEqual([]);
    }
    expect(homesOutside({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', XAI_API_KEY: 'xai-not-a-path', GROK_CONFIG: '{"a":1}', GEMINI_CLI_IDE_SERVER_PORT: '3000' }, home)).toEqual([]);
  });

  it('15. refuses the launch on a spec\'s grok log outside the sandbox, before the app starts', async () => {
    const home = sandbox();
    let launched = 0;
    const electron = { launch: async () => { launched++; throw new Error('the app was started'); } };

    const refusal = await launchSandboxed(electron, home, { env: { GROK_LOG_FILE: theOwners('GROK_LOG_FILE') } }).then(() => null, (error: Error) => error);

    expect(launched).toBe(0);
    expect(refusal?.message).toContain(`GROK_LOG_FILE: ${theOwners('GROK_LOG_FILE')}`);
  });

  it('13. refuses the launch on a spec\'s gemini or grok home outside the sandbox, before the app starts', async () => {
    const home = sandbox();
    let launched = 0;
    const electron = { launch: async () => { launched++; throw new Error('the app was started'); } };

    const refusal = await launchSandboxed(electron, home, { env: { GROK_HOME: theOwners('GROK_HOME') } }).then(() => null, (error: Error) => error);

    expect(launched).toBe(0);
    expect(refusal?.message).toContain(`GROK_HOME: ${theOwners('GROK_HOME')}`);
  });
});
