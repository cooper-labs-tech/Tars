import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, type Mount } from './hook-runtime';
import { useMemory } from '../../src/hooks/useMemory';
import type { ProjectMemory } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));
// useSyncExternalStore is not served by the hook runtime: the bridge is there, as in the app.
vi.mock('../../src/hooks/useDesktopApi', () => ({ useDesktopApi: () => true }));

/**
 * A MEMORY.md saved from the Memory page brings its guard with it (2.0.6, option c; the Audit's M1 on #560). The guard
 * is main's, computed when the projects are listed (PR 558), so only a reread of the projects follows the file.
 *
 * How it can fail, written before the change:
 * 1. a save that succeeds reads no project again: the row and the open file keep saying "cut" over a file now short;
 * 2. the open project is not the one read again, so its notice stays while the row's moved;
 * 3. a save that fails reads the projects again anyway, for nothing;
 * 4. the reread shows the page's loading state, so the list blinks out on every save.
 */

const CUT = 'MEMORY.md is 29.6 KB in 150 lines. Claude Code reads only its first 24.4 KB: 27 of its 150 lines, from line 124, never reach an agent (5.3 KB).';
const FILE = '/home/me/.claude/projects/-home-me-harbor/memory/MEMORY.md';

function project(guard: ProjectMemory['guard'], content: string): ProjectMemory {
  return {
    id: 'harbor', projectName: 'harbor', projectPath: '/home/me/harbor', memoryDir: '/home/me/.claude/projects/-home-me-harbor/memory',
    files: [{ name: 'MEMORY.md', path: FILE, content, size: content.length, lastModified: '2026-10-29T10:00:00.000Z', isEntrypoint: true }],
    totalSize: content.length, lastModified: '2026-10-29T10:00:00.000Z', hasMemory: true, provider: 'claude', guard,
  } as ProjectMemory;
}

const cut = project({ state: 'cut', size: 30_300, lines: 150, limit: { size: 25_000, lines: 200 }, cut: { by: 'size', lines: 27, fromLine: 124, size: 5_400 }, notice: CUT }, 'long');
const ok = project({ state: 'ok', size: 16, lines: 1, limit: { size: 25_000, lines: 200 }, cut: null, notice: null }, '- one short line');

const g = globalThis as unknown as { window?: unknown };

describe('a MEMORY.md saved from the page brings its guard with it', () => {
  let listed: ProjectMemory[];
  let listProjects: ReturnType<typeof vi.fn>;
  let writeFile: ReturnType<typeof vi.fn>;
  let hook: Mount<ReturnType<typeof useMemory>>;
  let loadingSeen: boolean[];

  beforeEach(async () => {
    listed = [cut];
    listProjects = vi.fn(async () => ({ projects: listed, error: null }));
    writeFile = vi.fn(async () => ({ success: true }));
    g.window = {
      electronAPI: {
        agent: { list: async () => [] },
        fs: { listProjects: async () => [] },
        memory: { listProjects, writeFile },
      },
    };
    loadingSeen = [];
    hook = mount(() => { const m = useMemory(); loadingSeen.push(m.loading); return m; });
    await settle();
    hook.result.selectProject(hook.result.projects[0]);
    hook.result.selectFile(hook.result.projects[0].files[0]);
    expect(hook.result.selectedProject?.guard?.state).toBe('cut');
  });

  afterEach(() => {
    hook.unmount();
    delete g.window;
  });

  it('reads the projects again once the save succeeded, the row and the open project with it (1, 2)', async () => {
    const before = listProjects.mock.calls.length;
    listed = [ok];
    expect(await hook.result.saveFile(FILE, '- one short line')).toBe(true);
    await settle();
    expect(listProjects.mock.calls.length).toBe(before + 1);
    expect(hook.result.projects[0].guard?.state).toBe('ok');
    expect(hook.result.selectedProject?.guard?.notice).toBeNull();
    expect(hook.result.selectedFile?.content).toBe('- one short line');
  });

  it('reads nothing again when the save failed (3)', async () => {
    writeFile.mockResolvedValueOnce({ success: false, error: 'read-only' });
    const before = listProjects.mock.calls.length;
    expect(await hook.result.saveFile(FILE, '- one short line')).toBe(false);
    await settle();
    expect(listProjects.mock.calls.length).toBe(before);
  });

  it('rereads without the loading state (4)', async () => {
    listed = [ok];
    loadingSeen = [];
    await hook.result.saveFile(FILE, '- one short line');
    await settle();
    expect(loadingSeen).not.toContain(true);
  });
});
