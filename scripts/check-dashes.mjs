#!/usr/bin/env node
/**
 * No em dashes, anywhere a person or an agent reads.
 *
 * JeanBrasse has asked for this twice. It kept coming back because the check itself
 * was unreliable: `grep` on this machine is ugrep, where `\|` is a literal
 * rather than alternation, and BSD `/usr/bin/grep` has no `-P` at all. Both
 * silently report CLEAN on a file full of dashes, so three separate sweeps
 * "passed" over text that still had 29 of them. This script does the check in
 * one place, in a language that cannot be aliased out from under it.
 *
 *   node scripts/check-dashes.mjs            list every offending line
 *   node scripts/check-dashes.mjs --quiet    exit code only
 *
 * Exit 1 when anything is found, so it can gate a release.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// A file URL's pathname is `/C:/...` on Windows and spells a space `%20`
// everywhere: no directory had that name, every walk failed, and the check
// said Clean over dashes it never read.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Everything shipped, plus the docs. Build output is generated, so skipped. */
const ROOTS = [
  'src', 'landing/src', 'electron',
  'mcp-memory/src', 'mcp-orchestrator/src', 'mcp-kanban/src',
  'mcp-vault/src', 'mcp-telegram/src', 'mcp-x/src', 'mcp-socialdata/src', 'mcp-shared/src',
];
const FILES = ['README.md', 'DESIGN.md', 'SPECS.md', 'OPERATIONS.md', 'ETHOS.md', 'design/UI-INVENTORY.md'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'out', 'release', '.git']);
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.md', '.json'];

/**
 * Lines that are allowed to contain the characters, because they are *about*
 * them. Kept to exact matches rather than a loose pattern, so a real dash
 * cannot hide behind a vague exemption.
 */
const ALLOWED = [
  // The code that strips gateway-supplied dashes has to name them.
  /replace\(\/[^/]*[–—][^/]*\/[gimsuy]*,/,
  // This file.
  /check-dashes/,
];

const DASH = /[–—]/;
const offenders = [];
let scanned = 0;

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) walk(full);
    else if (EXTENSIONS.some(e => entry.endsWith(e))) scan(full);
  }
}

function scan(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return; }
  scanned++;
  if (!DASH.test(text)) return;
  text.split('\n').forEach((line, i) => {
    if (!DASH.test(line)) return;
    if (ALLOWED.some(rule => rule.test(line))) return;
    offenders.push({ file: relative(ROOT, file), line: i + 1, text: line.trim() });
  });
}

for (const r of ROOTS) walk(join(ROOT, r));
for (const f of FILES) scan(join(ROOT, f));

const quiet = process.argv.includes('--quiet');

// Nothing read is not clean: it is a root this script got wrong.
if (scanned === 0) {
  console.error(`No file read under ${ROOT}: nothing was checked.`);
  process.exit(2);
}

if (offenders.length === 0) {
  if (!quiet) console.log(`No em dashes or en dashes in ${scanned} files. Clean.`);
  process.exit(0);
}

if (!quiet) {
  console.error(`${offenders.length} em dash or en dash to remove:\n`);
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}`);
    console.error(`    ${o.text.slice(0, 140)}`);
  }
  console.error('\nRewrite the sentence: a colon, a comma, parentheses, or two sentences.');
  console.error('Do not substitute " - " every time; that is the same tell in a new shape.');
}
process.exit(1);
