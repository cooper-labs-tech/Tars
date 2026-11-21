import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The point of the hub is that a source being down degrades that source only,
 * and that "reachable" means we actually spoke to it.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-memhub-'));
const fakeHome = path.join(tmp, 'home');

vi.mock('../../../electron/constants', () => ({ DATA_DIR: path.join(tmp, 'tars') }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => fakeHome }, homedir: () => fakeHome };
});

const hermesMock = {
  HERMES_MEMORY_FILES: ['MEMORY.md', 'USER.md'],
  fetchHermesMemoryFile: vi.fn(),
  fetchHermesMemoryFiles: vi.fn(),
  searchHermesSessions: vi.fn(),
  fetchHermesMemoryState: vi.fn(),
};
vi.mock('../../../electron/services/hermes-client', () => hermesMock);

const mcpMock = {
  probeMcpEndpoint: vi.fn(),
  callMcpTool: vi.fn(),
  listMcpTools: vi.fn(),
};
vi.mock('../../../electron/services/mcp-http-client', () => mcpMock);

const hub = await import('../../../electron/services/memory-hub');

const PROJECT = '/Users/someone/demo';
const memoryDir = path.join(fakeHome, '.claude', 'projects', PROJECT.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
const hermesConn = { mode: 'remote' as const, url: 'http://gateway.local:9119' };

beforeEach(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(path.join(tmp, 'tars'), { recursive: true, force: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Index\n\nThe deploy key lives in 1Password.\n\nThe API binds 31415.');

  hermesMock.fetchHermesMemoryFiles.mockResolvedValue({ success: true, files: [{ name: 'MEMORY.md', content: 'Gateway runs on the VPS.' }] });
  // The session-start block reads the two files one by one.
  hermesMock.fetchHermesMemoryFile.mockImplementation(async (_conn: unknown, name: string) =>
    ({ success: true, file: name === 'MEMORY.md' ? { name, content: 'Gateway runs on the VPS.' } : null }));
  hermesMock.searchHermesSessions.mockResolvedValue({ success: true, hits: [{ sessionId: 's1', title: 'deploy', snippet: 'rotated the deploy key' }] });
  hermesMock.fetchHermesMemoryState.mockResolvedValue({ success: true, state: { active: 'honcho' } });
  mcpMock.probeMcpEndpoint.mockResolvedValue({ reachable: true, tools: ['honcho_search'] });
  mcpMock.listMcpTools.mockResolvedValue([{ name: 'honcho_search', inputSchema: { properties: { query: {} } } }]);
  mcpMock.callMcpTool.mockResolvedValue('Honcho remembers the deploy key rotation.');
});

afterEach(() => {
  vi.clearAllMocks();
});

const settings = {
  memoryHonchoEnabled: true,
  memoryHonchoMcpUrl: 'https://mcp.honcho.dev',
  memoryHonchoApiKey: 'k',
};

describe('assembleDigest', () => {
  it('carries both the project memory and the gateway memory', async () => {
    const digest = await hub.assembleDigest({ projectPath: PROJECT, settings, hermes: hermesConn });

    expect(digest).toContain('The deploy key lives in 1Password.');
    expect(digest).toContain('Gateway runs on the VPS.');
    expect(digest).toContain('Honcho is connected');
  });

  it('still returns the local memory when the gateway is down', async () => {
    hermesMock.fetchHermesMemoryFile.mockRejectedValue(new Error('ECONNREFUSED'));

    const digest = await hub.assembleDigest({ projectPath: PROJECT, settings, hermes: hermesConn });

    expect(digest).toContain('The deploy key lives in 1Password.');
    expect(digest).not.toContain('Gateway runs on the VPS.');
  });
});

describe('searchMemory', () => {
  it('federates across project, Hermes and the MCP backends', async () => {
    const { hits } = await hub.searchMemory({ query: 'deploy key', projectPath: PROJECT, settings, hermes: hermesConn });

    expect(hits.map(h => h.source).sort()).toEqual(['honcho', 'hermes', 'project'].sort());
  });

  it('reports a failing backend without losing the others', async () => {
    mcpMock.listMcpTools.mockRejectedValue(new Error('401 unauthorised'));

    const { hits, errors } = await hub.searchMemory({ query: 'deploy key', projectPath: PROJECT, settings, hermes: hermesConn });

    expect(hits.some(h => h.source === 'project')).toBe(true);
    expect(errors).toEqual([{ source: 'honcho', error: '401 unauthorised' }]);
  });

  it('honours a source filter', async () => {
    const { hits } = await hub.searchMemory({
      query: 'deploy key', projectPath: PROJECT, settings, hermes: hermesConn, sources: ['project'],
    });

    expect(hits.every(h => h.source === 'project')).toBe(true);
    expect(mcpMock.listMcpTools).not.toHaveBeenCalled();
  });
});

describe('memoryStatus', () => {
  it('reports reachable only for sources it actually contacted', async () => {
    hermesMock.fetchHermesMemoryState.mockResolvedValue({ success: false, error: 'Sign in to Hermes' });

    const sources = await hub.memoryStatus({ settings, hermes: hermesConn, projectPath: PROJECT });
    const byId = Object.fromEntries(sources.map(s => [s.id, s]));

    expect(byId.project.reachable).toBe(true);
    expect(byId.hermes.reachable).toBe(false);
    expect(byId.hermes.detail).toBe('Sign in to Hermes');
    expect(byId.honcho.reachable).toBe(true);
    expect(byId.gbrain.configured).toBe(false);
  });
});

describe('writeProjectMemory', () => {
  it('appends rather than overwriting, and refuses a path escape', () => {
    hub.writeProjectMemory(PROJECT, 'Ports are pinned in constants.');

    expect(fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf-8')).toContain('Ports are pinned in constants.');
    expect(fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf-8')).toContain('The deploy key lives in 1Password.');
    expect(hub.writeProjectMemory(PROJECT, 'x', '../../escape.md').success).toBe(false);
  });
});

describe('needsPromptInjection', () => {
  it('is false for claude-binary providers and true for the others', () => {
    expect(hub.needsPromptInjection(path.join(fakeHome, '.claude'))).toBe(false);
    expect(hub.needsPromptInjection(path.join(fakeHome, '.codex'))).toBe(true);
    expect(hub.needsPromptInjection(path.join(fakeHome, '.gemini'))).toBe(true);
  });
});

// Found at review: on macOS and Linux the old
// `/`-only spelling of `..` is `..`, and projectMemoryDir took it when
// ~/.claude/memory existed, so /api/memory/write wrote outside the projects folder.
describe('writeProjectMemory for a path of dots', () => {
  const HOST = process.platform;
  afterEach(() => { Object.defineProperty(process, 'platform', { value: HOST, configurable: true }); });

  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform}: stays inside ~/.claude/projects`, () => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      const outside = path.join(fakeHome, '.claude', 'memory');
      fs.mkdirSync(outside, { recursive: true });
      const r = hub.writeProjectMemory('..', 'from a path of dots', 'dots.md');
      expect(fs.existsSync(path.join(outside, 'dots.md'))).toBe(false);
      expect(r.success && r.path?.startsWith(path.join(fakeHome, '.claude', 'projects') + path.sep)).toBe(true);
    });
  }
});
