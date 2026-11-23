import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cannotSymlink } from './setup/symlink-privilege';
// @ts-expect-error: the fixture is plain JavaScript, with no declarations
import { copyFromRealHome } from '../e2e/fixture.mjs';

/**
 * copyFromRealHome (e2e/fixture.mjs): what a spec copies from the real home into its sandbox (a CLI's credentials or
 * settings, the owner's transcripts) is recorded, and removeHome, or the worker's exit, deletes it whatever the outcome.
 * A folder is cloned on macOS (`cp -c -R`) and copied with fs.cpSync elsewhere; `clone` chooses, so both ways run here.
 *
 * How it can fail, written before the fixes (the Audit's I-3 and I-4 on #628, 23/11):
 * 1. I-3: a relative link inside a copied folder is rewritten as an absolute path into the real tree (fs.cpSync without
 *    verbatimSymlinks resolves it): whatever the app then writes through it lands in the owner's real home.
 * 2. Over-correction: the clone (`cp -c -R`, macOS) changes or breaks such a link: the copy is no longer the original.
 * 3. I-4: a copy that throws halfway (a full disk, a file it cannot read) is never recorded, so the partial copy outlives
 *    the worker, and a red run's kept home keeps it.
 * 4. Over-correction: nothing was there to copy (`from` absent), yet `to` is recorded, and what the spec put there
 *    itself is deleted with the copies.
 *
 * Every folder a case writes lies in its own mkdtemp; a stand-in plays the real home.
 */

let base: string;
beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-copy-real-home-'))); });
afterEach(() => {
  for (const d of fs.readdirSync(base, { recursive: true }) as string[]) {
    try { fs.chmodSync(path.join(base, d), 0o700); } catch { /* a link, or gone */ }
  }
  fs.rmSync(base, { recursive: true, force: true });
});

const FIXTURE = pathToFileURL(path.join(__dirname, '..', 'e2e', 'fixture.mjs')).href;
/** A node of its own that copies with copyFromRealHome, swallows what it throws, and exits: its exit runs the fixture's. */
const copyInAChild = (from: string, to: string, clone: boolean) => execFileSync(process.execPath, ['--input-type=module', '-e',
  `import { copyFromRealHome } from ${JSON.stringify(FIXTURE)}; try { copyFromRealHome(${JSON.stringify(from)}, ${JSON.stringify(to)}, { clone: ${clone} }); } catch { process.stdout.write('threw'); }`],
{ encoding: 'utf8', env: process.env });

const ways = [{ clone: false, name: 'fs.cpSync (Linux, Windows)' }, ...(process.platform === 'darwin' ? [{ clone: true, name: 'cp -c -R (macOS)' }] : [])];

describe('copyFromRealHome', () => {
  for (const way of ways) {
    it.skipIf(cannotSymlink())(`1, 2. keeps a relative link of a copied folder relative and inside the copy: ${way.name}`, () => {
      const real = path.join(base, 'real-home', '.claude', 'projects');
      fs.mkdirSync(path.join(real, 'inner'), { recursive: true });
      fs.writeFileSync(path.join(real, 'inner', 'session.jsonl'), 'the real transcript\n');
      fs.symlinkSync(path.join('inner', 'session.jsonl'), path.join(real, 'latest.jsonl'));
      const copy = path.join(base, 'sandbox', '.claude', 'projects');
      expect(copyFromRealHome(real, copy, { clone: way.clone })).toBe(true);
      expect(fs.readlinkSync(path.join(copy, 'latest.jsonl')), 'the link as written').toBe(path.join('inner', 'session.jsonl'));
      fs.writeFileSync(path.join(copy, 'latest.jsonl'), 'written in the sandbox\n');
      expect(fs.readFileSync(path.join(real, 'inner', 'session.jsonl'), 'utf8'), 'the real transcript, untouched').toBe('the real transcript\n');
      expect(fs.readFileSync(path.join(copy, 'inner', 'session.jsonl'), 'utf8')).toBe('written in the sandbox\n');
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(`3. deletes a copy that threw halfway when the worker exits: ${way.name}`, () => {
      const real = path.join(base, 'real-home', '.claude', 'projects');
      fs.mkdirSync(path.join(real, 'a-readable'), { recursive: true });
      fs.writeFileSync(path.join(real, 'a-readable', 'one.jsonl'), 'one\n');
      // A file it cannot read, as a full disk stops a copy: what came before it is copied, then the copy throws.
      fs.writeFileSync(path.join(real, 'z-unreadable.jsonl'), 'two\n');
      fs.chmodSync(path.join(real, 'z-unreadable.jsonl'), 0o000);
      const copy = path.join(base, 'sandbox', '.claude', 'projects');
      expect(copyInAChild(real, copy, way.clone), 'the copy threw').toBe('threw');
      expect(fs.existsSync(copy), 'the partial copy, after the worker exits').toBe(false);
    });
  }

  it('4. records nothing when there is nothing to copy, and leaves what the spec put there', () => {
    const copy = path.join(base, 'sandbox', '.claude', 'projects');
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, 'the-spec-s-own.jsonl'), 'its own\n');
    expect(copyInAChild(path.join(base, 'real-home', 'absent'), copy, false)).toBe('');
    expect(fs.readFileSync(path.join(copy, 'the-spec-s-own.jsonl'), 'utf8')).toBe('its own\n');
  });
});
