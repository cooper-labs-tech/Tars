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
 * Written before the fix of the Audit's L5 on #591 (18/11):
 * 3. The keys drift and nothing says so. A plist that lost allow-jit signs, notarizes, staples and passes every check
 *    of a quarantined copy, and the app it ships aborts at launch for every user (V8 cannot reserve its code range,
 *    exit 133, measured on the first signed build). One that gains a key back (disable-library-validation,
 *    allow-unsigned-executable-memory, allow-dyld-environment-variables) undoes a protection measured unneeded. The
 *    set is exactly what was measured; a change comes with its measurement (OPERATIONS.md, "The first signed build").
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

  it('grants allow-jit and nothing else, the set measured on the first signed build (3)', () => {
    const text = readFileSync(PLIST, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const body = text.match(/<dict>([\s\S]*)<\/dict>/)?.[1] ?? '';
    const entries = [...body.matchAll(/<key>([^<]*)<\/key>\s*<([a-z]+)\s*\/>/g)].map(m => [m[1], m[2]]);
    // Every key is followed by a boolean: a key with any other value would not be counted above.
    expect((body.match(/<key>/g) ?? []).length).toBe(entries.length);
    expect(Object.fromEntries(entries)).toEqual({ 'com.apple.security.cs.allow-jit': 'true' });
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
