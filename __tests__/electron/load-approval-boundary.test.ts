import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Only the owner's click in Tars's window approves a load window or writes a load grant (trace feature C3, 27/11).
 *
 * How it fails, written before the code:
 *  B1. An API route reaches the approval or the grants: a route file imports the load window or the grants, or
 *      answers under /api/load.
 *  B2. An MCP tool reaches them: an MCP server's source names the approval or grant channel, a load route, or the
 *      grants or approvals file.
 *  B3. Another part of the main process holds the load window's runtime or writes a grant, so that a message, a
 *      bot or an agent's tool could call it: anything but the window's handlers imports load-window.ts or writeGrant.
 *  B4. The handlers take a call that is not the main window's: another web contents (a webview, a second window), or
 *      a subframe of the main window, which shares its web contents (the Audit's I-1 at fdd82ca3d), approves, grants,
 *      sets a pool aside or stops a window.
 *  B5. The grants or the approvals are kept where agents are handed (~/.tars), not in the private folder.
 */

const ROOT = path.resolve(__dirname, '../..');
const source = (dir: string): Array<{ file: string; text: string }> => {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mts|js|mjs)$/.test(e.name)) out.push({ file: path.relative(ROOT, p), text: fs.readFileSync(p, 'utf8') });
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
};

describe('nothing but the window reaches the approval or the grants', () => {
  it('B1: no API route', () => {
    const routes = [...source(path.join(ROOT, 'electron/services/api-routes')), ...source(path.join(ROOT, 'electron/services')).filter(f => f.file.endsWith('api-server.ts'))];
    expect(routes.length).toBeGreaterThan(5);
    for (const f of routes) {
      expect(f.text, f.file).not.toMatch(/load-window|load-grants|load-run-record|\/api\/load/);
    }
  });

  it('B2: no MCP tool', () => {
    const servers = fs.readdirSync(ROOT).filter(d => d.startsWith('mcp-')).flatMap(d => source(path.join(ROOT, d, 'src')));
    expect(servers.length).toBeGreaterThan(5);
    for (const f of servers) expect(f.text, f.file).not.toMatch(/load:approve|load:grant|\/api\/load|load-grants|load-approved/);
  });

  it('B3: the window\'s handlers alone hold the runtime and write a grant', () => {
    const main = source(path.join(ROOT, 'electron'));
    const holders = main.filter(f => /from ['"][./]+(?:services\/)?load-window['"]/.test(f.text)).map(f => f.file);
    expect(holders).toEqual([path.join('electron', 'handlers', 'load-handlers.ts')]);
    const writers = main.filter(f => /\bwriteGrant\b/.test(f.text)).map(f => f.file).sort();
    expect(writers).toEqual([path.join('electron', 'handlers', 'load-handlers.ts'), path.join('electron', 'services', 'load-grants.ts')].sort());
    const channels = main.filter(f => /['"]load:(approve|grant|stop|notNow)['"]/.test(f.text)).map(f => f.file).sort();
    expect(channels).toEqual([path.join('electron', 'handlers', 'load-handlers.ts'), path.join('electron', 'preload.ts')].sort());
  });
});

// B4 and B5: the handlers themselves, with Electron's ipcMain stood in for.
const handlers = new Map<string, (e: { sender: unknown }, ...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => unknown) => { handlers.set(channel, fn); },
    removeHandler: (channel: string) => { handlers.delete(channel); },
  },
}));

describe('the handlers take the main window\'s calls only', () => {
  let dir: string;
  let dispose: () => void;
  const W = { send: vi.fn(), mainFrame: { url: 'app://-/index.html' } };
  const project = '/work/atlas';
  const endpoint = { id: 'ep-00b001', name: 'Host', baseUrl: 'http://127.0.0.1:9/v1', approved: true, approvedBaseUrl: 'http://127.0.0.1:9/v1', models: ['m'] };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-boundary-'));
    const { registerLoadHandlers } = await import('../../electron/handlers/load-handlers');
    dispose = registerLoadHandlers({
      getAppSettings: () => ({ inferenceEndpoints: [endpoint], traces: { projects: [project] } }) as never,
      agents: new Map(),
      getMainWindow: () => ({ webContents: W, isDestroyed: () => false }) as never,
      projects: () => [project],
      dirs: {
        pools: path.join(dir, 'pools'), runs: path.join(dir, 'runs'), grants: path.join(dir, 'private', 'load-grants.json'),
        approved: path.join(dir, 'private', 'load-approved.json'), setAside: path.join(dir, 'private', 'load-set-aside.json'),
      },
    }).dispose;
  });
  afterEach(() => { dispose(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('B4: another web contents is refused on every channel that changes anything', async () => {
    const other = { sender: { send: vi.fn() } };
    // A subframe of the main window shares its web contents, not its main frame (the Audit's I-1 at fdd82ca3d).
    const subframe = { sender: W, senderFrame: { url: 'about:blank' } };
    const grant = { path: project, enabled: true, allowedByName: false, endpointId: 'ep-00b001', model: 'm', harnesses: ['codex'] };
    for (const [channel, arg] of [['load:approve', { pool: 'p', sha256: 'x', proposalId: 'y', window: {} }], ['load:grant', grant], ['load:notNow', { pool: 'p', sha256: 'x' }], ['load:stop', 'r']] as const) {
      expect(await handlers.get(channel)!(other, arg), channel).toMatchObject({ ok: false, error: expect.stringContaining('click') });
      expect(await handlers.get(channel)!(subframe, arg), `${channel} from a subframe`).toMatchObject({ ok: false, error: expect.stringContaining('click') });
    }
    expect(fs.existsSync(path.join(dir, 'private', 'load-grants.json'))).toBe(false);
    // The main window's own call reaches them: the settings kept, the switch off (/work/atlas is no git work tree),
    // and the project as the Projects view shows it.
    const main = { sender: W, senderFrame: W.mainFrame };
    expect(await handlers.get('load:grant')!(main, grant)).toMatchObject({ ok: true, project: { path: project, allowed: false, state: 'no_repo' } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'private', 'load-grants.json'), 'utf8')).projects).toEqual([{ ...grant, enabled: false }]);
    expect(await handlers.get('load:approve')!(main, { pool: 'none', sha256: 'x', proposalId: 'y', window: {} })).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('B5: the grants and the approvals live in the private folder', async () => {
    const { LOAD_GRANTS_FILE } = await import('../../electron/services/load-grants');
    const { PRIVATE_DIR } = await import('../../electron/constants');
    expect(path.dirname(LOAD_GRANTS_FILE)).toBe(PRIVATE_DIR);
    const handlersText = fs.readFileSync(path.join(ROOT, 'electron/handlers/load-handlers.ts'), 'utf8');
    expect(handlersText).toMatch(/approved: privatePath\('load-approved\.json'\)/);
  });
});
