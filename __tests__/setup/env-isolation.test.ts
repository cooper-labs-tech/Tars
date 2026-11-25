import './home-guard';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

/**
 * What Tars hands its agents never reaches the code under test, and the
 * suite's own opt-ins still do.
 *
 * How it can fail, written on 2026-10-19 before the fix:
 * 1. A variable Tars puts in an agent's terminal outside the product's
 *    prefixes (TARS_CLAUDE_ACCOUNT, TARS_CHATS_READ, TARS_INSTANCE_ID) is still
 *    set when a test file starts, since the suite was run from that terminal:
 *    QA and every agent run it there. acp-account-env.test.ts read
 *    TARS_CLAUDE_ACCOUNT=default and failed under every Tars agent, and passed
 *    in a plain shell.
 * 2. The suite's own opt-ins, named TARS_ too (TARS_STRESS, TARS_REAL_CLAUDE,
 *    TARS_HERMES_TREE, TARS_HERMES_PYTHON), go with them, and the tests they
 *    enable are skipped without a word.
 *
 * Added on 2026-11-20 from #609's re-audit (M1), before the fix:
 * 3. A CLI home the runner's shell exports (CODEX_HOME, KIMI_CODE_HOME,
 *    PI_CODING_AGENT_DIR and _SESSION_DIR, the XDG homes, ZDOTDIR, opencode's
 *    and Kilo's config) reaches the code under test, which reads it before
 *    HOME: codex-provider.test.ts, under npm test, wrote the runner's codex
 *    config.toml. Nor do a CLI's config given as text, or git's own
 *    variables, which a run started from a git hook carries. Each is dropped,
 *    the list shared with the E2E fixture (e2e/cli-homes.mjs), and a decoy of
 *    each comes out byte for byte.
 *
 * Added on 2026-11-25 from the Audit's L4 on #638 and L1 on #643, before the
 * fix (e2e-cli-homes.test.ts, case 13, says what each binary was measured to
 * read):
 * 4. The rest of gemini's, grok's, codex's and pi's own variables, Google's and
 *    xAI's keys, and XDG_BIN_HOME, still reach the code under test: GEMINI_CLI_HOME,
 *    GROK_HOME, CODEX_SQLITE_HOME, PI_PACKAGE_DIR and the others. Each family is
 *    dropped whole, and a decoy of each folder comes out byte for byte. So do
 *    OpenTelemetry's exporter settings (OTEL_EXPORTER_OTLP_*), where grok sends
 *    its telemetry (e2e-cli-homes.test.ts, case 14).
 */

const FIXTURES = '__tests__/setup/fixtures/tmpdir-guard';
const VITEST = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

describe('the environment a test file starts in', () => {
  it('1, 2. holds none of what Tars hands its agents, and every opt-in of the suite\'s own', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'child-run-'));
    // The child is a run of its own, not a worker of this one, started from an agent's terminal.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')));
    const child = spawnSync(process.execPath, [VITEST, 'run', '--config', `${FIXTURES}/vitest.config.mts`, '--reporter=default', 'env-from-tars'], {
      cwd: process.cwd(),
      env: {
        ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
        TARS_CLAUDE_ACCOUNT: 'default', TARS_CHATS_READ: '1', TARS_INSTANCE_ID: 'an-agent-s-tars',
        TARS_STRESS: 'kept', TARS_REAL_CLAUDE: 'kept', TARS_HERMES_TREE: 'kept', TARS_HERMES_PYTHON: 'kept',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const output = stripVTControlCharacters(`${child.stdout}${child.stderr}`);

    expect(output).toMatch(/Test Files {2}1 passed \(1\)/);
    expect(child.status, output).toBe(0);
  }, 90_000);

  it('3. holds no CLI home, CLI config or git variable of the runner\'s, and the code under test leaves their decoys as they were', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'child-run-'));
    const decoys = fs.mkdtempSync(path.join(os.tmpdir(), 'decoy-homes-'));
    const exported: Record<string, string> = {};
    for (const name of ['CODEX_HOME', 'KIMI_CODE_HOME', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
      'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'ZDOTDIR', 'OPENCODE_CONFIG_DIR', 'KILO_CONFIG_DIR', 'GIT_DIR']) {
      const dir = path.join(decoys, name.toLowerCase());
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'config.toml'), `# ${name}, a decoy\n[mcp_servers.owners-own]\ncommand = "owners"\n`);
      exported[name] = dir;
    }
    for (const name of ['OPENCODE_CONFIG', 'KILO_CONFIG', 'GIT_INDEX_FILE', 'GIT_CONFIG_GLOBAL']) {
      exported[name] = path.join(decoys, `${name.toLowerCase()}.file`);
      fs.writeFileSync(exported[name], `${name}, a decoy\n`);
    }
    exported.OPENCODE_CONFIG_CONTENT = '{"decoy":true}';
    exported.KILO_CONFIG_CONTENT = '{"decoy":true}';
    const snapshot = () => Object.fromEntries((fs.readdirSync(decoys, { recursive: true }) as string[]).sort()
      .map(entry => [entry, fs.statSync(path.join(decoys, entry)).isFile() ? fs.readFileSync(path.join(decoys, entry), 'utf8') : 'folder']));
    const before = snapshot();
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')));
    const child = spawnSync(process.execPath, [VITEST, 'run', '--config', `${FIXTURES}/vitest.config.mts`, '--reporter=default', 'cli-homes'], {
      cwd: process.cwd(),
      env: { ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, ...exported },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const output = stripVTControlCharacters(`${child.stdout}${child.stderr}`);

    expect(snapshot(), 'a decoy the code under test wrote').toEqual(before);
    expect(output).toMatch(/Test Files {2}1 passed \(1\)/);
    expect(child.status, output).toBe(0);
  }, 90_000);

  it('4. holds none of gemini\'s, grok\'s, codex\'s and pi\'s own variables, Google\'s or xAI\'s keys or XDG_BIN_HOME, and leaves their decoys as they were', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'child-run-'));
    const decoys = fs.mkdtempSync(path.join(os.tmpdir(), 'decoy-families-'));
    const exported: Record<string, string> = {};
    for (const name of ['GEMINI_CLI_HOME', 'GROK_HOME', 'CODEX_SQLITE_HOME', 'PI_PACKAGE_DIR', 'PI_MANAGED_INSTALL_ROOT', 'XDG_BIN_HOME']) {
      const dir = path.join(decoys, name.toLowerCase());
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'config.toml'), `# ${name}, a decoy\n`);
      exported[name] = dir;
    }
    for (const name of ['GROK_CONFIG_PATH', 'GEMINI_CLI_TRUSTED_FOLDERS_PATH', 'CODEX_CA_CERTIFICATE', 'PI_SESSION_FILE']) {
      exported[name] = path.join(decoys, `${name.toLowerCase()}.file`);
      fs.writeFileSync(exported[name], `${name}, a decoy\n`);
    }
    Object.assign(exported, {
      GEMINI_API_KEY: 'decoy', GOOGLE_API_KEY: 'decoy', GOOGLE_GENAI_USE_VERTEXAI: 'true', GCLOUD_PROJECT: 'decoy',
      XAI_API_KEY: 'decoy', CODEX_AUTH: 'decoy', GROK_CONFIG: '{"decoy":true}',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9', OTEL_EXPORTER_OTLP_HEADERS: 'authorization=decoy',
    });
    const snapshot = () => Object.fromEntries((fs.readdirSync(decoys, { recursive: true }) as string[]).sort()
      .map(entry => [entry, fs.statSync(path.join(decoys, entry)).isFile() ? fs.readFileSync(path.join(decoys, entry), 'utf8') : 'folder']));
    const before = snapshot();
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')));
    const child = spawnSync(process.execPath, [VITEST, 'run', '--config', `${FIXTURES}/vitest.config.mts`, '--reporter=default', 'cli-families'], {
      cwd: process.cwd(),
      env: { ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, ...exported },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const output = stripVTControlCharacters(`${child.stdout}${child.stderr}`);

    expect(snapshot(), 'a decoy the code under test wrote').toEqual(before);
    expect(output).toMatch(/Test Files {2}1 passed \(1\)/);
    expect(child.status, output).toBe(0);
  }, 90_000);
});
