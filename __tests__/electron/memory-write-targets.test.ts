import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * An agent could read five memories and write to one.
 *
 * `memory_write` went straight to the project's own notes whatever it was asked
 * for, so an agent told "remember this in Hermes" wrote it into the project file
 * and reported success. These tests pin the dispatch: each target is attempted
 * on its own, each answers for itself, and a target that is not set up says so
 * rather than silently falling back to the project.
 *
 * The remote backends are MCP servers Tars does not own, so the write tool is
 * discovered from what the server advertises. Discovery there is deliberately
 * stricter than on the search side: a wrong guess when searching returns an odd
 * result, a wrong guess when writing puts data somewhere it does not belong.
 */

const hoisted = vi.hoisted(() => ({
  appendHermesMemory: vi.fn(),
  listMcpTools: vi.fn(),
  callMcpTool: vi.fn(),
  probeMcpEndpoint: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ isDirectory: () => false })),
}));

vi.mock('fs', () => ({
  ...hoisted,
  default: hoisted,
}));

vi.mock('../../electron/constants', () => ({
  DATA_DIR: '/tmp/tars-test-data',
  DATA_DIR_SHELL: '/tmp/tars-test-data',
}));

vi.mock('../../electron/services/mcp-http-client', () => ({
  listMcpTools: hoisted.listMcpTools,
  callMcpTool: hoisted.callMcpTool,
  probeMcpEndpoint: hoisted.probeMcpEndpoint,
}));

vi.mock('../../electron/services/hermes-client', () => ({
  appendHermesMemory: hoisted.appendHermesMemory,
  fetchHermesMemoryFiles: vi.fn(),
  searchHermesSessions: vi.fn(),
  fetchHermesMemoryState: vi.fn(),
}));

const { writeMemory } = await import('../../electron/services/memory-hub');

const HERMES = { mode: 'remote', url: 'http://gateway.test:9119' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.existsSync.mockReturnValue(false);
  hoisted.appendHermesMemory.mockResolvedValue({ success: true, path: '/root/.hermes/memories/MEMORY.md' });
});

const base = {
  content: 'The gateway rejects a relative path with 400 "Path must be absolute".',
  projectPath: '/Users/you/tars',
  settings: {},
  hermes: HERMES,
};

describe('writeMemory dispatch', () => {
  it('writes only to the project when no target is named', async () => {
    const results = await writeMemory({ ...base, targets: [] });

    expect(results.map(r => r.target)).toEqual(['project']);
    expect(hoisted.appendHermesMemory).not.toHaveBeenCalled();
  });

  it('reaches the Hermes gateway when asked for it, and not otherwise', async () => {
    const results = await writeMemory({ ...base, targets: ['hermes'] });

    expect(hoisted.appendHermesMemory).toHaveBeenCalledOnce();
    expect(results).toEqual([
      { target: 'hermes', success: true, path: '/root/.hermes/memories/MEMORY.md' },
    ]);
    // The project file must NOT have been touched as a side effect.
    expect(hoisted.writeFileSync).not.toHaveBeenCalled();
  });

  it('attempts every named target and reports each on its own', async () => {
    const results = await writeMemory({ ...base, targets: ['project', 'hermes', 'gbrain'] });

    expect(results.map(r => r.target).sort()).toEqual(['gbrain', 'hermes', 'project']);
    // Two of three succeeded, which is an outcome rather than a failure.
    expect(results.find(r => r.target === 'hermes')?.success).toBe(true);
    expect(results.find(r => r.target === 'gbrain')?.success).toBe(false);
  });

  it('says a backend is not set up rather than writing somewhere else', async () => {
    const results = await writeMemory({ ...base, targets: ['gbrain', 'honcho'] });

    for (const r of results) {
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/not set up in Settings/i);
    }
    expect(hoisted.writeFileSync).not.toHaveBeenCalled();
    expect(hoisted.appendHermesMemory).not.toHaveBeenCalled();
  });

  it('says there is no gateway rather than pretending the write landed', async () => {
    const results = await writeMemory({ ...base, hermes: null, targets: ['hermes'] });

    expect(results[0]).toMatchObject({ target: 'hermes', success: false });
    expect(results[0].error).toMatch(/no hermes gateway/i);
  });

  it('passes a gateway failure through instead of swallowing it', async () => {
    hoisted.appendHermesMemory.mockResolvedValue({
      success: false,
      error: 'Path must be absolute',
    });

    const results = await writeMemory({ ...base, targets: ['hermes'] });

    expect(results[0]).toEqual({
      target: 'hermes',
      success: false,
      error: 'Path must be absolute',
    });
  });

  it('refuses an empty note everywhere, without calling anything', async () => {
    const results = await writeMemory({ ...base, content: '   \n  ', targets: ['project', 'hermes'] });

    expect(results.every(r => !r.success)).toBe(true);
    expect(results.every(r => /nothing to write/i.test(r.error ?? ''))).toBe(true);
    expect(hoisted.appendHermesMemory).not.toHaveBeenCalled();
  });

  it('deduplicates a target named twice, so one note is not written twice', async () => {
    const results = await writeMemory({ ...base, targets: ['hermes', 'hermes'] });

    expect(results).toHaveLength(1);
    expect(hoisted.appendHermesMemory).toHaveBeenCalledOnce();
  });
});

describe('writeMemory against an MCP backend', () => {
  const withGbrain = {
    ...base,
    settings: { memoryGbrainEnabled: true, memoryGbrainMcpUrl: 'http://gbrain.test/sse' },
  };

  it('uses the tool the server advertises, and the argument its schema names', async () => {
    hoisted.listMcpTools.mockResolvedValue([
      { name: 'unrelated_thing' },
      { name: 'memory_write', inputSchema: { properties: { fact: {}, tags: {} } } },
    ]);
    hoisted.callMcpTool.mockResolvedValue('stored');

    const results = await writeMemory({ ...withGbrain, targets: ['gbrain'] });

    expect(hoisted.callMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://gbrain.test/sse' }),
      'memory_write',
      { fact: base.content },
    );
    expect(results[0].success).toBe(true);
  });

  it('refuses rather than guessing when nothing advertised looks like a write', async () => {
    // A search tool is not a write tool. Picking it would send the note into a
    // query, which is exactly the wrong-place failure this guards against.
    hoisted.listMcpTools.mockResolvedValue([
      { name: 'memory_search' }, { name: 'list_things' }, { name: 'ping' },
    ]);

    const results = await writeMemory({ ...withGbrain, targets: ['gbrain'] });

    expect(hoisted.callMcpTool).not.toHaveBeenCalled();
    expect(results[0].success).toBe(false);
    // The message names what the server DOES offer, so it is actionable.
    expect(results[0].error).toContain('memory_search');
  });

  it('reports a backend that throws instead of failing the whole write', async () => {
    hoisted.listMcpTools.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const results = await writeMemory({ ...withGbrain, targets: ['project', 'gbrain'] });

    expect(results.find(r => r.target === 'gbrain')?.error).toMatch(/ECONNREFUSED/);
    // The project write still happened: one dead backend does not lose the note.
    expect(results.find(r => r.target === 'project')).toBeDefined();
  });
});
