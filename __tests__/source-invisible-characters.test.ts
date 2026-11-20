import './setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Trojan Source: no invisible direction or zero-width character in the source.
 *
 * A bidi control reorders what an editor shows without changing what runs, so
 * a line can read one way and execute another (CVE-2021-42574). A zero-width
 * character makes two names or two strings that look the same differ. The
 * Backend found real bidi controls in a regex of electron/utils/waiting-on.ts
 * and in a test (#172), since written as escapes. A test or a sanitiser that
 * needs one of these characters writes its escape, `\u202E`, which is not the
 * character.
 *
 * Every file is read as bytes and decoded here, never through grep: grep takes
 * a file holding a NUL byte for binary and skips it without a word, which has
 * already hidden files from two counts in this repo.
 *
 * Two uses are not hidden text, and pass: a byte-order mark as a file's very
 * first character, and a zero width joiner inside an emoji, between two
 * pictographs (the astronaut and the pirate of the bots' character faces).
 *
 * How this fails:
 * 1. a raw bidi control or zero-width character enters a source file, and
 *    nothing says where;
 * 2. the scan stops reading a directory, or a kind of file, and passes because
 *    it read nothing;
 * 3. an emoji or a byte-order mark is flagged, where it is harmless.
 */

const ROOT = path.resolve(__dirname, '..');

/** Each character, by code point, with its Unicode name. */
const FORBIDDEN = new Map<number, string>([
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x061c, 'ARABIC LETTER MARK'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x2060, 'WORD JOINER'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE'],
]);

const PICTOGRAPH = /\p{Extended_Pictographic}/u;
/** What may stand before a joiner inside an emoji: a pictograph, its variation selector, or a skin tone. */
const emojiPart = (ch: string | undefined) => !!ch && (PICTOGRAPH.test(ch) || ch === '\uFE0F' || /[\u{1F3FB}-\u{1F3FF}]/u.test(ch));

/** The source: code, tests, scripts, hooks and docs, not what is built or recorded. */
const SOURCE_DIRS = ['electron', 'src', 'hooks', 'scripts', 'e2e', '__tests__', 'landing/src', 'design'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.next', 'out', '__screenshots__', 'test-results', 'report', 'release']);
const TEXT_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|json|md|sh|css|html|yml|yaml|py|txt)$/;

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : walk(full);
    return entry.isFile() && TEXT_FILE.test(entry.name) ? [full] : [];
  });
}

function sourceFiles(): string[] {
  const mcp = fs.readdirSync(ROOT).filter(name => name.startsWith('mcp-')).map(name => path.join(name, 'src'));
  const rootFiles = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isFile() && TEXT_FILE.test(e.name))
    .map(e => path.join(ROOT, e.name));
  return [...rootFiles, ...[...SOURCE_DIRS, ...mcp].flatMap(dir => walk(path.join(ROOT, dir)))];
}

/** Any of them, written as escapes: the test holds none of the characters themselves. */
const ANY_FORBIDDEN = new RegExp(`[${[...FORBIDDEN.keys()].map(code => `\\u{${code.toString(16)}}`).join('')}]`, 'u');

/** Every forbidden character in these files, as `file:line:column U+XXXX NAME`, the column counted in characters. */
function invisibleCharacters(files: string[], base = ROOT): string[] {
  const found: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file).toString('utf8');
    // One pass of a regex says whether a file holds any; only one that does is
    // walked character by character. Walking every file took the whole-source
    // scan past the 5 s default under load (QA, 2026-10-13).
    if (!ANY_FORBIDDEN.test(text)) continue;
    const chars = Array.from(text);
    let line = 1;
    let column = 0;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === '\n') { line += 1; column = 0; continue; }
      column += 1;
      const code = ch.codePointAt(0)!;
      const name = FORBIDDEN.get(code);
      if (!name) continue;
      if (code === 0xfeff && i === 0) continue;
      if (code === 0x200d && emojiPart(chars[i - 1]) && PICTOGRAPH.test(chars[i + 1] ?? '')) continue;
      found.push(`${path.relative(base, file)}:${line}:${column} U+${code.toString(16).toUpperCase().padStart(4, '0')} ${name}`);
    }
  }
  return found;
}

describe('the source holds no invisible direction or zero-width character', () => {
  it('finds each one, where it is, in a file grep would skip too, and lets an emoji and a first byte-order mark be', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-trojan-source-'));
    try {
      fs.writeFileSync(path.join(dir, 'regex.ts'), `const re = /a${'\u202E'}b/;\n`);
      // A NUL byte first: grep calls this file binary and says nothing about it.
      fs.writeFileSync(path.join(dir, 'binary.ts'), Buffer.concat([Buffer.from('x\u0000y\n'), Buffer.from(`const s = '${'\u2066'}';\n`)]));
      fs.writeFileSync(path.join(dir, 'bom-first.ts'), `${'\uFEFF'}export const ok = 1;\n`);
      fs.writeFileSync(path.join(dir, 'bom-later.ts'), `export const a = 1;${'\uFEFF'}\nconst b = 'x${'\u200B'}y';\n`);
      // A joiner inside an emoji (the astronaut) passes; one between two letters does not.
      fs.writeFileSync(path.join(dir, 'joiner.ts'), `const face = '${String.fromCodePoint(0x1f468, 0x200d, 0x1f680)}';\nconst id = 'a${'\u200D'}b';\n`);
      const files = ['regex.ts', 'binary.ts', 'bom-first.ts', 'bom-later.ts', 'joiner.ts'].map(f => path.join(dir, f));

      expect(invisibleCharacters(files, dir)).toEqual([
        'regex.ts:1:14 U+202E RIGHT-TO-LEFT OVERRIDE',
        'binary.ts:2:12 U+2066 LEFT-TO-RIGHT ISOLATE',
        'bom-later.ts:1:20 U+FEFF ZERO WIDTH NO-BREAK SPACE',
        'bom-later.ts:2:13 U+200B ZERO WIDTH SPACE',
        'joiner.ts:2:14 U+200D ZERO WIDTH JOINER',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the whole source, and finds none there', () => {
    const files = sourceFiles();
    // Spelled with `/` whatever the platform's separator, as the names below are.
    const rel = new Set(files.map(f => path.relative(ROOT, f).split(path.sep).join('/')));
    // A scan that reads nothing passes: the file where they were found must be in it, and the tree must be all there.
    for (const known of ['electron/utils/waiting-on.ts', 'src/app/chat/page.tsx', 'hooks/session-start.sh', 'e2e/surfaces.mjs', '__tests__/source-invisible-characters.test.ts', 'CLAUDE.md']) {
      expect(rel.has(known), `${known} was not read`).toBe(true);
    }
    expect(files.length).toBeGreaterThan(500);
    expect(invisibleCharacters(files)).toEqual([]);
  });
});
