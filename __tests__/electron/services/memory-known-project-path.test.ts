import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Brain lists a Tars project whose memory Claude's folder holds once, under
 * the project's own path, on Windows (found at review). macOS and Linux list
 * it as they always have.
 *
 * MEMORY.md for `/Users/demo/My Project` is in Claude's folder,
 * `-Users-demo-My-Project`. A decoder that cannot rebuild the space reads that
 * folder back as `/Users/demo/My/Project` (on Windows the disk cannot tell
 * `a b` from `a-b` when both exist): Brain showed a "Project" entry holding the
 * memory, and an empty "My Project" beside it.
 *
 * How it can fail, written before the fix:
 * 1. win32: the memory is listed under the decoder's guess instead of the known path;
 * 2. win32: the known project is listed a second time, empty;
 * 3. a folder no known path names is no longer listed, or listed differently;
 * 4. darwin/linux: anything changes: the folder stays under the decoder's guess,
 *    and the known project is listed beside it, empty, its memory folder named
 *    by `/` and `.` to `-` as Memory always named it there.
 *    Replaced on 2026-10-13 (the transcript folder bug): that was the bug on
 *    macOS and Linux too. Claude names `/Users/demo/My Project` the same there,
 *    so the known project is listed once, under its own path, as on win32.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-mem-known-')));
const fakeHome = path.join(tmp, 'home');
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => fakeHome }, homedir: () => fakeHome };
});
// What a decoder that cannot rebuild the space makes of these names. The same
// names on every platform the process says it is, so the run is the same on any host.
vi.mock('../../../electron/utils/decode-project-path', () => ({
  decodeProjectPath: (name: string) => ({
    '-Users-demo-My-Project': '/Users/demo/My/Project',
    '-Users-demo-other': '/Users/demo/other',
  } as Record<string, string>)[name] ?? `/${name}`,
}));

const HOST = process.platform;
afterEach(() => { Object.defineProperty(process, 'platform', { value: HOST, configurable: true }); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function listAs(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.resetModules();
  const projects = path.join(fakeHome, '.claude', 'projects');
  fs.rmSync(projects, { recursive: true, force: true });
  for (const folder of ['-Users-demo-My-Project', '-Users-demo-other']) {
    fs.mkdirSync(path.join(projects, folder, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(projects, folder, 'memory', 'MEMORY.md'), `# ${folder}\n`);
  }
  const { listProjectMemories } = await import('../../../electron/services/memory-service');
  return (await listProjectMemories(['/Users/demo/My Project']))
    .filter(p => p.provider === 'claude' || p.id.startsWith('tars:'))
    .map(p => ({ projectPath: p.projectPath, name: p.projectName, hasMemory: p.hasMemory, folder: path.basename(path.dirname(p.memoryDir)) }));
}

describe.each(['win32', 'darwin', 'linux'] as const)('Brain on %s', (platform) => {
  it('1, 2, 3, 4. lists the known project once, under its own path, with its memory', async () => {
    const listed = await listAs(platform);
    expect(listed).toEqual(expect.arrayContaining([
      { projectPath: '/Users/demo/My Project', name: 'My Project', hasMemory: true, folder: '-Users-demo-My-Project' },
      { projectPath: '/Users/demo/other', name: 'other', hasMemory: true, folder: '-Users-demo-other' },
    ]));
    expect(listed).toHaveLength(2);
  });
});
