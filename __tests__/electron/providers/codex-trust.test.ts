import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { realCliOptIn } from '../../setup/real-cli-opt-in';

/**
 * A codex agent's folder is trusted before its codex starts (2.0.4), as Claude Code's is (ensureProjectTrusted).
 *
 * Measured on codex-cli 0.163.0: started in a folder its config does not trust, codex first asks "Trust this
 * folder? Codex can read, edit, and run files here, subject to your permission settings", writes no session, and
 * does nothing until someone answers. Nobody does in an agent's terminal: a new codex agent in a new project never
 * started. With `[projects."<folder>"] trust_level = "trusted"` in its config.toml, the same launch ran its turn in
 * 5 s. codex records the folder by its real path (session_meta's cwd).
 *
 * The ways it fails:
 * 1. The folder not trusted, or trusted under another spelling of its path than the one codex reads (/tmp, not
 *    /private/tmp, on macOS): the question again.
 * 2. A choice the user made overwritten: a folder they marked untrusted, or trusted already, written again.
 * 3. A folder that would trust every folder below it (the home folder, /), as ensureProjectTrusted refuses.
 * 4. The rest of config.toml lost, or the file left one codex cannot read: codex then refuses to start at all.
 * 5. The table written again at every launch, until the file is full of copies.
 * 6. A config.toml that could not be read (a passing EMFILE, its rights, a folder in its place) taken for none: the
 *    user's whole config replaced by one table, their providers, MCP servers and profiles lost (the Audit's L1 on
 *    #465). Only its absence means none. And the file written in place, where a codex starting meanwhile reads half
 *    of it.
 * 7. The folder's table there already under another writing of its key, and a second one added. codex writes a key
 *    holding a backslash or a double quote as a literal string ('C:\Users\me\demo' on Windows, '/x/a "quoted"
 *    folder'), and a dotted key under [projects] says the same; Tars wrote a basic string. Two definitions of one
 *    table are invalid TOML: codex then refuses its whole config, and every codex session of the user, in Tars or
 *    outside it, stops starting (the Audit's L2 on #465). Nor is a table added to a `projects` written inline, nor
 *    anything to a file that is not TOML: Tars writes nothing codex could not read. Keys compare as TOML compares
 *    them, whole and exact, as codex looks a folder up; another case of a letter is another key, and Tars's own is
 *    added beside it.
 */

import { createRequire, syncBuiltinESMExports } from 'node:module';
import { parse as parseToml } from 'smol-toml';
import { ensureCodexProjectTrusted, trustTableFor } from '../../../electron/providers/codex-cli';
import { hasPosixModes } from '../../setup/platform-limits';

let codexHome: string;
let project: string;
const config = () => fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
// The installed codex, run on purpose to read the config with codex's own parser: only when TARS_TEST_REAL_CLIS names
// codex, as __tests__/setup/no-real-cli.ts lets it through then and refuses a real codex otherwise (the Audit's I-4
// on #616: a unit test runs no real CLI by default). Its home is this file's own folder.
const codexOnPath = (() => {
  const asked = realCliOptIn('codex');
  if (!asked) return '';
  if (asked !== 'any') return asked;
  try { return execFileSync('which', ['codex'], { encoding: 'utf8' }).trim(); } catch { return ''; }
})();
/** The MCP servers codex's own parser reads in this home's config.toml: it refuses the whole file when it cannot read it. */
const listedByCodex = () => (JSON.parse(execFileSync(codexOnPath, ['mcp', 'list', '--json'], {
  encoding: 'utf8', env: { PATH: process.env.PATH, HOME: path.dirname(codexHome), CODEX_HOME: codexHome }, stdio: ['ignore', 'pipe', 'pipe'],
})) as Array<{ name: string }>).map(server => server.name);
const nodeFs = createRequire(import.meta.url)('fs') as typeof fs;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-trust-'));
  codexHome = path.join(root, '.codex');
  project = path.join(root, 'projects', 'demo');
  fs.mkdirSync(project, { recursive: true });
});

describe("a codex agent's folder", () => {
  it('is trusted under its real path, the rest of the config kept', () => {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-6-luna"\n\n[mcp_servers.x]\ncommand = "node"\n');
    expect(ensureCodexProjectTrusted(project, codexHome)).toBe('written');
    const text = config();
    expect(text).toContain('model = "gpt-6-luna"');
    expect(text).toContain('[mcp_servers.x]');
    expect(text).toContain(`[projects.${JSON.stringify(fs.realpathSync(project))}]\ntrust_level = "trusted"`);
  });

  it('is written once, and a choice already made is left as it is', () => {
    expect(ensureCodexProjectTrusted(project, codexHome)).toBe('written');
    expect(ensureCodexProjectTrusted(project, codexHome)).toBe('already');
    expect(config().match(/\[projects\./g)).toHaveLength(1);

    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-untrusted-'));
    fs.appendFileSync(path.join(codexHome, 'config.toml'), `\n[projects.${JSON.stringify(fs.realpathSync(other))}]\ntrust_level = "untrusted"\n`);
    expect(ensureCodexProjectTrusted(other, codexHome)).toBe('already');
    expect(config()).toContain('trust_level = "untrusted"');
  });

  it('is never the home folder, nor /', () => {
    expect(ensureCodexProjectTrusted(os.homedir(), codexHome)).toBe('refused');
    expect(ensureCodexProjectTrusted('/', codexHome)).toBe('refused');
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(false);
  });

  it.skipIf(!codexOnPath)("leaves a config codex's own parser reads", () => {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[mcp_servers.probe]\ncommand = "node"\nargs = ["/x.js"]\n');
    const odd = path.join(path.dirname(project), 'a "quoted" folder');
    fs.mkdirSync(odd);
    ensureCodexProjectTrusted(project, codexHome);
    ensureCodexProjectTrusted(odd, codexHome);
    const listed = JSON.parse(execFileSync(codexOnPath, ['mcp', 'list', '--json'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: path.dirname(codexHome), CODEX_HOME: codexHome }, stdio: ['ignore', 'pipe', 'pipe'],
    })) as Array<{ name: string }>;
    expect(listed.map(s => s.name)).toEqual(['probe']);
  });
});

describe('a config.toml Tars could not read', () => {
  it('6. one a read failed on for any reason but its absence is left as it is', () => {
    fs.mkdirSync(codexHome, { recursive: true });
    const file = path.join(codexHome, 'config.toml');
    const users = 'model = "gpt-6.1-sol"\n\n[model_providers.mine]\nbase_url = "https://example.invalid"\n';
    fs.writeFileSync(file, users);
    const real = fs.realpathSync(file);
    const original = nodeFs.readFileSync;
    nodeFs.readFileSync = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof p === 'string' && fs.realpathSync(p) === real) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      return (original as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    let outcome: string;
    try {
      outcome = ensureCodexProjectTrusted(project, codexHome);
    } finally {
      nodeFs.readFileSync = original;
      syncBuiltinESMExports();
    }
    expect(outcome).toBe('failed');
    expect(config()).toBe(users);
  });

  it.skipIf(!hasPosixModes() || process.getuid?.() === 0)('6. so is one its user may write but not read', () => {
    fs.mkdirSync(codexHome, { recursive: true });
    const file = path.join(codexHome, 'config.toml');
    const users = 'model = "gpt-6.1-sol"\n';
    fs.writeFileSync(file, users);
    fs.chmodSync(file, 0o200);
    let outcome: string;
    try {
      outcome = ensureCodexProjectTrusted(project, codexHome);
    } finally {
      fs.chmodSync(file, 0o600);
    }
    expect(outcome).toBe('failed');
    expect(config()).toBe(users);
  });

  it('6. a folder where config.toml should be is left, and nothing written', () => {
    fs.mkdirSync(path.join(codexHome, 'config.toml'), { recursive: true });
    expect(ensureCodexProjectTrusted(project, codexHome)).toBe('failed');
    expect(fs.statSync(path.join(codexHome, 'config.toml')).isDirectory()).toBe(true);
  });
});

describe("the folder's table under another writing", () => {
  it("7. codex's own writing of a key with a double quote, a literal string, is the folder's table: nothing added", () => {
    fs.mkdirSync(codexHome, { recursive: true });
    const odd = path.join(path.dirname(project), 'a "quoted" folder');
    fs.mkdirSync(odd);
    const written = `[mcp_servers.probe]\ncommand = "node"\nargs = ["/x.js"]\n\n[projects.'${fs.realpathSync(odd)}']\ntrust_level = "trusted"\n`;
    fs.writeFileSync(path.join(codexHome, 'config.toml'), written);
    expect(ensureCodexProjectTrusted(odd, codexHome)).toBe('already');
    expect(config()).toBe(written);
    if (codexOnPath) expect(listedByCodex()).toEqual(['probe']);
  });

  it('7. so is a dotted key under [projects], whatever it says', () => {
    fs.mkdirSync(codexHome, { recursive: true });
    const written = `[projects]\n${JSON.stringify(fs.realpathSync(project))}.trust_level = "untrusted"\n`;
    fs.writeFileSync(path.join(codexHome, 'config.toml'), written);
    expect(ensureCodexProjectTrusted(project, codexHome)).toBe('already');
    expect(config()).toBe(written);
  });

  it("7. a Windows folder's key, in codex's writing or Tars's, is one key; another case of a letter is another", () => {
    const folder = 'C:\\Users\\me\\demo';
    expect(trustTableFor(`[projects.'${folder}']\ntrust_level = "trusted"\n`, folder)).toBe('already');
    expect(trustTableFor(`[projects.${JSON.stringify(folder)}]\ntrust_level = "trusted"\n`, folder)).toBe('already');
    const other = trustTableFor(`[projects.'c:\\users\\me\\demo']\ntrust_level = "trusted"\n`, folder);
    expect(typeof other).toBe('object');
    const parsed = parseToml((other as { next: string }).next) as { projects: Record<string, { trust_level: string }> };
    expect(parsed.projects[folder]).toEqual({ trust_level: 'trusted' });
    expect(Object.keys(parsed.projects)).toHaveLength(2);
  });

  it('7. a projects table written inline, or a file that is not TOML, gets nothing added', () => {
    fs.mkdirSync(codexHome, { recursive: true });
    for (const written of ['projects = { "/elsewhere" = { trust_level = "trusted" } }\n', 'model = "never closed\n']) {
      fs.writeFileSync(path.join(codexHome, 'config.toml'), written);
      expect(ensureCodexProjectTrusted(project, codexHome), written).toBe('failed');
      expect(config()).toBe(written);
    }
  });
});
