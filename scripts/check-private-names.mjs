#!/usr/bin/env node
/**
 * No private name in a file the repository publishes.
 *
 * The repository is public, and some names must never appear in it: real first
 * names, e-mail addresses. They cannot be listed here, or this file would
 * publish them. They are read from a file outside the repository,
 * ~/.tars-private/private-names.txt (TARS_PRIVATE_NAMES names another), one
 * entry per line, `#` starting a comment. Without that file the check says so
 * and passes: CI and contributors have no list, and are not blocked by one.
 *
 * Every file git tracks or would add (`git ls-files --cached --others
 * --exclude-standard`) is read, from the disk as it stands, and so is its path,
 * which is published as much. A binary file is counted, not read: a picture
 * cannot be searched for a name, so look at it.
 *
 * How an entry is found, in any case:
 * - a single word (letters only) where it stands as a word: in prose, and in
 *   an identifier or a path, where camelCase, SCREAMING_CASE, snake_case, a
 *   dash, a plural `s` or an escape (`%5c`, `\n`) ends it. Inside another
 *   word it is that word: "atomic" does not hold "Tom", and a hash in
 *   package-lock.json holds no name;
 * - anything else (an e-mail address, two words) exactly as written.
 *
 * The report masks what it found, so it can be pasted where the name cannot go.
 *
 *   node scripts/check-private-names.mjs            list every offending line
 *   node scripts/check-private-names.mjs --quiet    exit code only
 *
 * Exit 1 when a name is found, 2 when nothing could be checked.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// A file URL's pathname is `/C:/...` on Windows and spells a space `%20`
// everywhere (check-dashes.mjs's bug): fileURLToPath gives the folder itself.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIST = process.env.TARS_PRIVATE_NAMES || join(homedir(), '.tars-private', 'private-names.txt');
const quiet = process.argv.includes('--quiet');

function stop(code, message) {
  if (!quiet) (code === 0 ? console.log : console.error)(message);
  process.exit(code);
}

let listed;
try {
  listed = readFileSync(LIST, 'utf8');
} catch (err) {
  if (err.code === 'ENOENT') stop(0, `No list of private names at ${LIST}: nothing checked.`);
  stop(2, `Could not read ${LIST} (${err.code || err.message}): nothing checked.`);
}

const entries = [...new Set(listed.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.toLowerCase()))];
if (entries.length === 0) stop(2, `${LIST} lists no name: nothing checked.`);

const isLetter = c => c !== undefined && /\p{L}/u.test(c);
const isUpper = c => isLetter(c) && c === c.toUpperCase() && c !== c.toLowerCase();
const isLower = c => isLetter(c) && c === c.toLowerCase() && c !== c.toUpperCase();
/** `\n`, `%5c`, `\u201c` or `\x5c` right before index i: its last letter ends the word before. */
const ESCAPE = /(?:\\[a-zA-Z]|%[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2})$/;

/** Does a word start at i? A gap, a lowercase-to-uppercase turn, the last capital of an acronym, or an escape. */
function startsWord(line, i) {
  const before = line[i - 1];
  if (!isLetter(before)) return true;
  if (isLower(before) && isUpper(line[i])) return true;
  if (isUpper(before) && isUpper(line[i]) && isLower(line[i + 1])) return true;
  return ESCAPE.test(line.slice(Math.max(0, i - 6), i));
}

/** Does a word end at j (exclusive)? The same turns, read from the other side. */
function endsWord(line, j) {
  const after = line[j];
  if (!isLetter(after)) return true;
  if (isLower(line[j - 1]) && isUpper(after)) return true;
  return isUpper(line[j - 1]) && isUpper(after) && isLower(line[j + 1]);
}

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Each entry, found in any case in the line as written, so that every position is the line's own. One made of letters
 * only is a word (its boundaries, below). One made of digits only is a number (standsAsNumber): never inside a longer
 * number, a run of hex digits, a colour behind `#`, a hex literal or code point, or a channel of an `rgb:` colour spec,
 * so that a colour repeating it never matches; and always where it stands alone or glued to a word (a sentence, an
 * agent's name, a URL path, a handle written without its dot). Anything else is a substring.
 */
const patterns = entries.map(entry => ({
  rx: new RegExp(escape(entry), 'giu'),
  word: /^\p{L}+$/u.test(entry),
  number: /^\d+$/.test(entry),
}));

/** An X11 colour spec, as a terminal's OSC 10/11 reply writes one: `rgb:` and three hex channels split by `/`. */
const RGB_SPEC = /rgba?:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}(?:\/[0-9a-f]{1,4})?/giu;
/** A UUID, any of whose groups may happen to be the number. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const ALNUM = /[0-9A-Za-z]/;

/**
 * Does the number at [i, j) stand as itself? A digit beside it makes it part of a longer number. Then its whole run of
 * letters and digits decides (the Audit's M1 on #670): a run of hex digits only (`ff`, `deadbeef` around it) or one
 * behind `#` is a colour or a hash, and so is a hex literal (`0x`) or a code point (`\u`, `\u{`, `U+`); a run with any
 * other letter is a word, and the number in it matches (a handle without its dot, a word ending on it). Last, it is no
 * decimal fraction's digits (`0.` before it), no channel of an `rgb:` colour spec and no group of a UUID.
 */
function standsAsNumber(line, i, j) {
  if (/\d/.test(line[i - 1] ?? '') || /\d/.test(line[j] ?? '')) return false;
  if (line[i - 1] === '.' && /\d/.test(line[i - 2] ?? '')) return false;
  let a = i;
  while (a > 0 && ALNUM.test(line[a - 1])) a--;
  let b = j;
  while (b < line.length && ALNUM.test(line[b])) b++;
  const run = line.slice(a, b);
  const before = line.slice(Math.max(0, a - 3), a);
  if (before.endsWith('#')) return false;
  if (run !== line.slice(i, j) && /^[0-9a-f]+$/i.test(run)) return false;
  if (/^0x[0-9a-f]+$/i.test(run)) return false;
  if (/^u[0-9a-f]+$/i.test(run) && before.endsWith('\\')) return false;
  if (before.endsWith('\\u{') || before.toUpperCase().endsWith('U+')) return false;
  for (const rx of [RGB_SPEC, UUID]) {
    for (const m of line.matchAll(rx)) if (i >= m.index && j <= m.index + m[0].length) return false;
  }
  return true;
}

/** Every [start, end) span where an entry stands in the line. */
function spans(line) {
  const found = [];
  for (const { rx, word, number } of patterns) {
    for (const m of line.matchAll(rx)) {
      const i = m.index;
      const j = i + m[0].length;
      if (number && !standsAsNumber(line, i, j)) continue;
      if (word) {
        const plural = (line[j] === 's' || line[j] === 'S') && endsWord(line, j + 1);
        if (!startsWord(line, i) || !(endsWord(line, j) || plural)) continue;
      }
      found.push([i, j]);
    }
  }
  return found.sort((a, b) => a[0] - b[0]);
}

/** The text with every span found in it written as stars. */
function mask(text, found) {
  let masked = text;
  for (const [a, b] of found) masked = masked.slice(0, a) + '*'.repeat(b - a) + masked.slice(b);
  return masked;
}

let files;
try {
  files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\0').filter(Boolean);
} catch (err) {
  stop(2, `git could not list the files of ${ROOT} (${String(err.stderr || err.message).trim()}): nothing checked.`);
}

const anyEntry = new RegExp(entries.map(escape).join('|'), 'iu');
const offenders = [];
let read = 0;
let binary = 0;

for (const file of [...new Set(files)]) {
  const inPath = spans(file);
  const shown = mask(file, inPath).split('/').join(sep);
  if (inPath.length) offenders.push({ where: shown, count: inPath.length, excerpt: '(in its path)' });
  let bytes;
  try { bytes = readFileSync(join(ROOT, file)); } catch { continue; }
  if (bytes.subarray(0, 8000).includes(0)) { binary++; continue; }
  read++;
  const text = bytes.toString('utf8');
  if (!anyEntry.test(text)) continue;
  text.split('\n').forEach((raw, n) => {
    const line = raw.replace(/\r$/, '');
    const found = spans(line);
    if (!found.length) return;
    const masked = mask(line, found);
    const from = Math.max(0, found[0][0] - 60);
    const excerpt = `${from > 0 ? '...' : ''}${masked.slice(from, found[0][0] + 80).trim()}${found[0][0] + 80 < masked.length ? '...' : ''}`;
    offenders.push({ where: `${shown}:${n + 1}:${found[0][0] + 1}`, count: found.length, excerpt });
  });
}

if (read === 0) stop(2, `No file read under ${ROOT}: nothing checked.`);

const notRead = binary ? `, ${binary} binary ${binary === 1 ? 'file' : 'files'} not read (look at the pictures)` : '';
if (offenders.length === 0) stop(0, `No private name in ${read} files${notRead}. Clean.`);

if (!quiet) {
  const total = offenders.reduce((n, o) => n + o.count, 0);
  const inFiles = new Set(offenders.map(o => o.where.split(':')[0])).size;
  console.error(`${total} private ${total === 1 ? 'name' : 'names'} in ${inFiles} ${inFiles === 1 ? 'file' : 'files'} (the list: ${LIST}), masked below:\n`);
  for (const o of offenders) console.error(`  ${o.where}  ${o.excerpt}`);
  console.error(`\n${read} files read${notRead}.`);
  console.error('Write JeanBrasse or "the maintainer" in prose, a neutral home (/Users/demo) in a path, the user in what Tars says.');
}
process.exit(1);
