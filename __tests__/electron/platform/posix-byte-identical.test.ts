import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * darwin and linux after the Windows paths lot: the decoder and the transcript
 * lookup give what they gave before, on any host. posix-golden.json was
 * captured from the code before this change, with POSIX path semantics and
 * the disk laid out as posix-corpus.ts says. Here the
 * process says it is darwin, then linux, and `path` is POSIX's, so the run is
 * the same on a Mac, on Linux and on Windows.
 *
 * How it can fail:
 * 1. a folder name decodes to anything else than before (the Windows decoder
 *    answering for a POSIX name, or a host separator creeping in);
 * 2. a transcript is not found under Claude Code's own name (every character
 *    that is not an ASCII letter or digit to `-`, since 2026-10-13: the old
 *    `[/.]` spelling missed the conversation of a path with any other one).
 */

const disk = vi.hoisted(() => ({ existing: new Set<string>() }));
vi.mock('path', async () => {
  const p = await vi.importActual<typeof import('path')>('path');
  return { ...p.posix, default: p.posix, posix: p.posix, win32: p.win32 };
});
vi.mock('fs', async () => {
  const f = await vi.importActual<typeof import('fs')>('fs');
  return { ...f, existsSync: (p: string) => disk.existing.has(String(p)) };
});

import { decodeProjectPath } from '../../../electron/utils/decode-project-path';
import { transcriptPath } from '../../../electron/utils/resume-session';
import { encodeClaudeProjectDir } from '../../../electron/platform/claude-project-dir';
import { POSIX_CORPUS } from './posix-corpus';
import golden from './posix-golden.json';

const HOST = process.platform;
afterEach(() => { Object.defineProperty(process, 'platform', { value: HOST, configurable: true }); });
const as = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true });

function lay(paths: string[]) {
  disk.existing = new Set(['/']);
  for (const full of paths) {
    let cur = '';
    for (const part of full.split('/').filter(Boolean)) {
      cur = `${cur}/${part}`;
      disk.existing.add(cur);
    }
  }
}

describe.each(['darwin', 'linux'] as const)('%s, to the byte', (platform) => {
  it('1. every folder name in the corpus decodes as before', () => {
    as(platform);
    lay(POSIX_CORPUS.layout);
    for (const [name, before] of Object.entries(golden.decode)) expect(decodeProjectPath(name), name).toBe(before);
  });

  it('2. a transcript under Claude\'s own name is the one found', () => {
    as(platform);
    const home = '/Users/demo';
    const id = '11111111-2222-4333-8444-555555555555';
    for (const project of POSIX_CORPUS.layout) {
      const claude = `${home}/.claude/projects/${encodeClaudeProjectDir(project)}/${id}.jsonl`;
      disk.existing = new Set([claude]);
      expect(transcriptPath(project, id, home), project).toBe(claude);
    }
  });
});
