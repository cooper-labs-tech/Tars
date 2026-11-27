import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Where the start-up registration of the MCP servers takes the bundles it registers, and the E2E seam that names a
 * tree's own (DOROTHY_E2E_MCP_BUNDLES).
 *
 * Every bundle path is process.resourcesPath/<server>/dist/bundle.js. A packaged Tars has them there; a dev or E2E Tars
 * has Electron's own folder there, finds none, and registers nothing: which keeps a dev run off a real home's CLI configs
 * (the #201 incident), and leaves what a packaged Tars writes into each CLI's config covered by no spec. The seam lets
 * an E2E run register the tree's own bundles, into the sandbox's homes and nowhere else.
 *
 * How it fails, written before the code (2026-11-27):
 * 1. A packaged build reads the variable: a user's Tars registering bundles from some folder named in its environment.
 * 2. It is read without DOROTHY_E2E=1, in a dev run.
 * 3. A relative path, or a folder that holds no orchestrator bundle, is taken: every CLI given a server that is not there.
 * 4. It is taken while HOME is the account's own: a dev run's registration writing the tree's paths into the real home's
 *    CLI configs, the #201 incident again.
 * 5. It is taken while a CLI home the registration writes into lies outside HOME: CODEX_HOME, XDG_CONFIG_HOME
 *    (opencode), GEMINI_CLI_HOME, GROK_HOME, PI_CODING_AGENT_DIR pointing at the real ones.
 * 6. Under the seam a getter still points at the app's resources (the registration would mix both), or without it one
 *    points anywhere else; the folder is set once at start, not read from the environment at each call.
 *
 * Added after the Audit of #664 (2026-11-27), which measured three setups taken that reach the account's own home:
 * 7. HOME is above the account's home (HOME=/Users, or /), so the account's home is inside HOME, and a CLI home inside
 *    HOME is then inside the account's home too: CODEX_HOME=/Users/acct/.codex, XDG_CONFIG_HOME=/Users/acct/.config.
 *    Every listed CLI home is refused inside the account's home whatever HOME is, and HOME holding it is refused.
 * 8. A CLI home the registration reaches is left off the list: claude's own CLAUDE_CONFIG_DIR and
 *    CLAUDE_SECURESTORAGE_CONFIG_DIR, which `claude mcp remove -s user` inherits (execCliSync hands it no env of its own
 *    on macOS and Linux), pointing at the account's ~/.claude from a sandbox HOME.
 * 9. A path is compared as written, not as the system reaches it: HOME a link to the account's home or into it; a CLI
 *    home in the sandbox a link to the account's own folder, there already or not yet (a link leading nowhere yet: the
 *    CLI would make the folder at its end), or a folder below such a link, or '..' climbing from where a link leads;
 *    the account's home itself a link to its real folder; on a disk that ignores case, the account's home written in
 *    another case. And the other way: a sandbox reached through a link (/tmp is /private/tmp on macOS) refused.
 */

type Var = 'DOROTHY_E2E' | 'DOROTHY_E2E_MCP_BUNDLES' | 'CODEX_HOME' | 'XDG_CONFIG_HOME' | 'GEMINI_CLI_HOME' | 'GROK_HOME' | 'PI_CODING_AGENT_DIR'
  | 'CLAUDE_CONFIG_DIR' | 'CLAUDE_SECURESTORAGE_CONFIG_DIR';
/** Every CLI home the registration writes into, or hands a CLI it runs. */
const CLI_HOMES = ['CODEX_HOME', 'XDG_CONFIG_HOME', 'GEMINI_CLI_HOME', 'GROK_HOME', 'PI_CODING_AGENT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'] as const;

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0', on: vi.fn(), isPackaged: false },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));

/** The app's resources, as a packaged Tars has them (plain Node has no process.resourcesPath). */
const RESOURCES = '/opt/tars/Contents/Resources';
const resourcesBefore = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

let root: string;
let tree: string;
let sandbox: string;
const account = '/Users/someone';
beforeEach(() => {
  Object.defineProperty(process, 'resourcesPath', { value: RESOURCES, configurable: true, writable: true });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-mcp-seam-'));
  tree = path.join(root, 'tree');
  sandbox = path.join(root, 'home');
  for (const dir of ['mcp-orchestrator', 'mcp-memory']) fs.mkdirSync(path.join(tree, dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'mcp-orchestrator', 'dist', 'bundle.js'), '');
  fs.mkdirSync(sandbox, { recursive: true });
});
afterEach(() => {
  vi.resetModules();
  if (resourcesBefore) Object.defineProperty(process, 'resourcesPath', resourcesBefore);
  else delete (process as { resourcesPath?: string }).resourcesPath;
});

async function seam() {
  return import('../../../electron/services/mcp-orchestrator');
}
const env = (extra: Partial<Record<Var, string>> = {}): NodeJS.ProcessEnv => ({ DOROTHY_E2E: '1', DOROTHY_E2E_MCP_BUNDLES: tree, ...extra });

describe('the E2E seam naming a tree\'s own bundles', () => {
  it('takes the tree under DOROTHY_E2E, in a build that is not packaged, with every home inside the sandbox', async () => {
    const { e2eMcpBundlesDir } = await seam();
    expect(e2eMcpBundlesDir(env({ CODEX_HOME: path.join(sandbox, '.codex') }), false, { home: sandbox, account })).toBe(tree);
  });

  it('1, 2. never in a packaged build, never without DOROTHY_E2E=1', async () => {
    const { e2eMcpBundlesDir } = await seam();
    expect(e2eMcpBundlesDir(env(), true, { home: sandbox, account })).toBeNull();
    expect(e2eMcpBundlesDir({ ...env(), DOROTHY_E2E: '' }, false, { home: sandbox, account })).toBeNull();
    expect(e2eMcpBundlesDir({ DOROTHY_E2E_MCP_BUNDLES: tree }, false, { home: sandbox, account })).toBeNull();
  });

  it('3. never a relative path, nor a folder without the orchestrator\'s bundle', async () => {
    const { e2eMcpBundlesDir } = await seam();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(e2eMcpBundlesDir(env({ DOROTHY_E2E_MCP_BUNDLES: 'tree' }), false, { home: sandbox, account })).toBeNull();
    expect(e2eMcpBundlesDir(env({ DOROTHY_E2E_MCP_BUNDLES: path.join(tree, 'mcp-memory') }), false, { home: sandbox, account })).toBeNull();
    warn.mockRestore();
  });

  it('4. never while HOME is the account\'s own home, or inside it', async () => {
    const { e2eMcpBundlesDir } = await seam();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(e2eMcpBundlesDir(env(), false, { home: account, account })).toBeNull();
    expect(e2eMcpBundlesDir(env(), false, { home: path.join(account, 'sandbox'), account })).toBeNull();
    warn.mockRestore();
  });

  it('5. never while a CLI home the registration writes into lies outside the sandbox\'s HOME', async () => {
    const { e2eMcpBundlesDir } = await seam();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const name of CLI_HOMES) {
      expect(e2eMcpBundlesDir(env({ [name]: path.join(account, '.somewhere') }), false, { home: sandbox, account }), name).toBeNull();
      expect(e2eMcpBundlesDir(env({ [name]: path.join(sandbox, '.somewhere') }), false, { home: sandbox, account }), name).toBe(tree);
    }
    warn.mockRestore();
  });

  it('7. never while HOME holds the account\'s home, nor while a CLI home lies inside the account\'s home, whatever HOME is', async () => {
    const { e2eMcpBundlesDir } = await seam();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const acct = '/Users/acct';
    // The Audit's first two setups: HOME above the account's home, a CLI home inside both.
    expect(e2eMcpBundlesDir(env({ CODEX_HOME: '/Users/acct/.codex' }), false, { home: '/Users', account: acct })).toBeNull();
    expect(e2eMcpBundlesDir(env({ XDG_CONFIG_HOME: '/Users/acct/.config' }), false, { home: '/', account: acct })).toBeNull();
    // HOME above the account's home with no CLI home set: the registration's defaults are HOME's, which holds the account's.
    expect(e2eMcpBundlesDir(env(), false, { home: '/Users', account: acct })).toBeNull();
    expect(e2eMcpBundlesDir(env(), false, { home: '/', account: acct })).toBeNull();
    // Every listed CLI home inside the account's home is refused, from a sandbox HOME as from any other.
    for (const name of CLI_HOMES) {
      expect(e2eMcpBundlesDir(env({ [name]: path.join(acct, '.somewhere') }), false, { home: sandbox, account: acct }), name).toBeNull();
    }
    warn.mockRestore();
  });

  it('8. never while claude\'s own config folders point at the account\'s ~/.claude from a sandbox HOME', async () => {
    const { e2eMcpBundlesDir } = await seam();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const acct = '/Users/acct';
    // The Audit's third setup, and its keychain twin.
    expect(e2eMcpBundlesDir(env({ CLAUDE_CONFIG_DIR: '/Users/acct/.claude' }), false, { home: sandbox, account: acct })).toBeNull();
    expect(e2eMcpBundlesDir(env({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '/Users/acct/.claude' }), false, { home: sandbox, account: acct })).toBeNull();
    // Inside the sandbox they are taken.
    expect(e2eMcpBundlesDir(env({ CLAUDE_CONFIG_DIR: path.join(sandbox, '.claude') }), false, { home: sandbox, account: acct })).toBe(tree);
    warn.mockRestore();
  });

  it('9. a link is the folder it leads to: HOME, a CLI home or the account\'s home through a link', async () => {
    const { e2eMcpBundlesDir } = await seam();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const acct = path.join(root, 'acct');
    fs.mkdirSync(path.join(acct, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(acct, 'inside'));
    // A directory link: a junction on Windows, which needs no privilege; the type is ignored elsewhere.
    const link = (at: string, to: string) => { fs.symlinkSync(to, at, 'junction'); return at; };
    // HOME a link to the account's home, or into it.
    expect.soft(e2eMcpBundlesDir(env(), false, { home: link(path.join(root, 'home-is-acct'), acct), account: acct }), 'HOME links to it').toBeNull();
    expect.soft(e2eMcpBundlesDir(env(), false, { home: link(path.join(root, 'home-in-acct'), path.join(acct, 'inside')), account: acct }), 'HOME links into it').toBeNull();
    // CODEX_HOME in the sandbox, a link to the account's own folder: there already, or not yet.
    const codex = link(path.join(sandbox, '.codex'), path.join(acct, '.codex'));
    const later = link(path.join(sandbox, '.codex-later'), path.join(acct, '.codex-later'));
    const sandboxed = (value: string) => e2eMcpBundlesDir(env({ CODEX_HOME: value }), false, { home: sandbox, account: acct });
    expect.soft(sandboxed(codex), 'CODEX_HOME links to the real one').toBeNull();
    expect.soft(sandboxed(later), 'CODEX_HOME links to one not made yet').toBeNull();
    expect.soft(sandboxed(path.join(codex, 'deeper')), 'a folder not made yet below the link').toBeNull();
    expect.soft(sandboxed(`${codex}${path.sep}..${path.sep}elsewhere`), '\'..\' climbs from where the link leads').toBeNull();
    // The account's home itself a link to its real folder: HOME in that real folder is still the account's.
    const realAcct = path.join(root, 'real-acct');
    fs.mkdirSync(path.join(realAcct, 'sandbox'), { recursive: true });
    const acctLink = link(path.join(root, 'acct-link'), realAcct);
    expect.soft(e2eMcpBundlesDir(env(), false, { home: path.join(realAcct, 'sandbox'), account: acctLink }), 'the account\'s home is a link').toBeNull();
    // A sandbox reached through a link is still the sandbox, whichever way each path is written.
    const sandboxLink = link(path.join(root, 'sandbox-link'), sandbox);
    fs.mkdirSync(path.join(sandbox, 'own-codex'));
    expect.soft(e2eMcpBundlesDir(env({ CODEX_HOME: path.join(sandbox, 'own-codex') }), false, { home: sandboxLink, account: acct }), 'HOME by its link').toBe(tree);
    expect.soft(e2eMcpBundlesDir(env({ CODEX_HOME: path.join(sandboxLink, 'own-codex') }), false, { home: sandbox, account: acct }), 'CODEX_HOME by the link').toBe(tree);
    warn.mockRestore();
  });

  it('9. on a disk that ignores case, the account\'s home written in another case is the account\'s home', async (ctx) => {
    const acct = path.join(root, 'acct');
    fs.mkdirSync(acct);
    const otherCase = acct.toUpperCase();
    if (otherCase === acct || !fs.existsSync(otherCase)) ctx.skip();
    const { e2eMcpBundlesDir } = await seam();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect.soft(e2eMcpBundlesDir(env(), false, { home: otherCase, account: acct })).toBeNull();
    warn.mockRestore();
  });

  it('6. under the seam every bundle path is the tree\'s, without it the app\'s resources, set once', async () => {
    const orchestrator = await seam();
    const getters = [
      orchestrator.getMcpOrchestratorPath, orchestrator.getMcpMemoryPath, orchestrator.getMcpKanbanPath, orchestrator.getMcpVaultPath,
      orchestrator.getMcpSocialDataPath, orchestrator.getMcpXPath, orchestrator.getMcpTelegramPath,
    ];
    const resources = RESOURCES;
    for (const get of getters) expect(get().startsWith(path.join(resources, 'mcp-')), get.name).toBe(true);
    orchestrator.useTestMcpBundles(tree);
    process.env.DOROTHY_E2E_MCP_BUNDLES = path.join(sandbox, 'elsewhere');
    for (const get of getters) expect(get(), get.name).toMatch(new RegExp(`^${tree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/mcp-[a-z]+/dist/bundle\\.js$`));
    delete process.env.DOROTHY_E2E_MCP_BUNDLES;
    orchestrator.useTestMcpBundles(null);
    for (const get of getters) expect(get().startsWith(path.join(resources, 'mcp-')), get.name).toBe(true);
  });
});
