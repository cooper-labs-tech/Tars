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
 *    (opencode), GEMINI_CLI_HOME, GROK_HOME pointing at the real ones.
 * 6. Under the seam a getter still points at the app's resources (the registration would mix both), or without it one
 *    points anywhere else; the folder is set once at start, not read from the environment at each call.
 */

const vars = ['DOROTHY_E2E', 'DOROTHY_E2E_MCP_BUNDLES', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'GEMINI_CLI_HOME', 'GROK_HOME'] as const;

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0', on: vi.fn(), isPackaged: false },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));

/** The app's resources, as a packaged Tars has them (plain Node has no process.resourcesPath). */
const RESOURCES = '/opt/tars/Contents/Resources';
const resourcesBefore = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

let tree: string;
let sandbox: string;
const account = '/Users/someone';
beforeEach(() => {
  Object.defineProperty(process, 'resourcesPath', { value: RESOURCES, configurable: true, writable: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-mcp-seam-'));
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
const env = (extra: Partial<Record<(typeof vars)[number], string>> = {}): NodeJS.ProcessEnv => ({ DOROTHY_E2E: '1', DOROTHY_E2E_MCP_BUNDLES: tree, ...extra });

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
    for (const name of ['CODEX_HOME', 'XDG_CONFIG_HOME', 'GEMINI_CLI_HOME', 'GROK_HOME'] as const) {
      expect(e2eMcpBundlesDir(env({ [name]: path.join(account, '.somewhere') }), false, { home: sandbox, account }), name).toBeNull();
      expect(e2eMcpBundlesDir(env({ [name]: path.join(sandbox, '.somewhere') }), false, { home: sandbox, account }), name).toBe(tree);
    }
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
