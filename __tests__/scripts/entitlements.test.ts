import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * build/entitlements.mac.plist, the entitlements every Mach-O of a signed mac release is signed with
 * (package.json build.mac entitlements and entitlementsInherit).
 *
 * How it fails, written before the fix (18/11, the first signed build of #591):
 * 1. A comment holds "--" (here "--dangerously-skip-permissions", in the file since 2.0.x): XML 1.0 forbids it in a
 *    comment, plutil -lint accepts the file anyway, and codesign's parser does not: "Failed to parse entitlements:
 *    AMFIUnserializeXML: syntax error near line 56", so every signed build stops at its first codesign. It never showed
 *    while every build was ad hoc, since nothing signed with the file.
 * 2. Anything else codesign cannot parse (macOS only: the parser is codesign's own): the same stop, found only after
 *    the renderer, the main process and the MCP bundles are built.
 */

const PLIST = resolve(__dirname, '../../build/entitlements.mac.plist');

describe('build/entitlements.mac.plist', () => {
  it('holds no "--" inside a comment, which codesign refuses (1)', () => {
    const text = readFileSync(PLIST, 'utf8');
    const comments = [...text.matchAll(/<!--([\s\S]*?)-->/g)].map(m => m[1]);
    expect(comments.length).toBeGreaterThan(0);
    const bad = comments.filter(c => c.includes('--') || c.endsWith('-'));
    expect(bad.map(c => c.trim().slice(0, 60))).toEqual([]);
  });

  it.runIf(process.platform === 'darwin')('is accepted by codesign, signing a copy of /usr/bin/true ad hoc with it (2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tars-entitlements-'));
    try {
      const bin = join(dir, 'true');
      copyFileSync('/usr/bin/true', bin);
      const r = spawnSync('codesign', ['--force', '--sign', '-', '--entitlements', PLIST, bin], { encoding: 'utf8' });
      expect(r.status, r.stderr.trim()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
