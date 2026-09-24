#!/usr/bin/env node
/**
 * D3's first part is a comment diet (REFACTOR-MAP.md), so its contract is the
 * code itself: for each file of electron/services it may touch, what
 * TypeScript emits once every comment is removed. Recorded on main before a
 * comment moves (refacto-rules: the first commit records the contract, the
 * last proves it unchanged).
 *
 *   node __tests__/electron/services/contracts/d3-compiled.contract.mjs            check
 *   node __tests__/electron/services/contracts/d3-compiled.contract.mjs --record   record
 *   node __tests__/electron/services/contracts/d3-compiled.contract.mjs --diff=<ref>
 *        print, for each file that differs, its emit at <ref> against the working tree's
 *
 * Checked while writing it:
 * - Stripping every comment from 28 of D3's 31 files with TypeScript's scanner
 *   leaves the emit byte for byte the same. The other three hold `//` inside a
 *   regex, where a plain scanner cannot tell a comment from code.
 * - A one-character code edit changes the hash.
 * The emit keeps some layout (an object literal brought onto one line shows),
 * which is intended: the diet moves comments, nothing else.
 *
 * A script, not a vitest file: it pins code, so in the suite it would fail on
 * every later change to these files, and on a TypeScript upgrade. Not in it:
 * discord-bot.ts, which an open PR touches (#200).
 */
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const RECORDING = path.join(HERE, 'd3-compiled.contract.json');
const ts = createRequire(path.join(ROOT, 'package.json'))('typescript');

const FILES = [
  'agent-events', 'agent-transcript', 'agent-truth', 'agent-watch', 'bot-core', 'bus-delivery', 'bus-files',
  'bus-store', 'claude-service', 'cli-updater', 'git-review', 'hooks-manager', 'kanban-automation', 'kanban-board',
  'log-search', 'mcp-http-client', 'mcp-orchestrator', 'memory-service', 'model-catalog', 'obsidian-service',
  'project-index', 'skills-marketplace', 'tasmania-client', 'transcript-usage', 'update-checker', 'usage-ledger',
  'vault-db', 'acp/client', 'acp/delegate', 'acp/registry',
].map(name => `electron/services/${name}.ts`);

/** What the electron build emits for a source, every comment removed (its tsconfig's target and module). */
const emit = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, removeComments: true },
}).outputText;
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const args = process.argv.slice(2);
const now = Object.fromEntries(FILES.map(file => [file, hash(emit(read(file)))]));

if (args.includes('--record')) {
  fs.writeFileSync(RECORDING, `${JSON.stringify({ typescript: ts.version, files: now }, null, 2)}\n`);
  console.log(`recorded ${FILES.length} files, typescript ${ts.version}`);
  process.exit(0);
}

const recorded = JSON.parse(fs.readFileSync(RECORDING, 'utf8'));
if (recorded.typescript !== ts.version) {
  console.error(`recorded with typescript ${recorded.typescript}, running ${ts.version}: the emit itself may differ`);
}
const changed = FILES.filter(file => recorded.files[file] !== now[file]);
if (!changed.length) {
  console.log(`identical: ${FILES.length} files emit the same code, comments aside`);
  process.exit(0);
}
console.error(`DIFFERENT: ${changed.join(', ')}`);
const ref = args.find(a => a.startsWith('--diff='))?.slice(7);
if (ref) {
  for (const file of changed) {
    const then = emit(execFileSync('git', ['show', `${ref}:${file}`], { cwd: ROOT, encoding: 'utf8' })).split('\n');
    const here = emit(read(file)).split('\n');
    for (let i = 0; i < Math.max(then.length, here.length); i++) {
      if (then[i] !== here[i]) {
        console.error(`${file}:${i + 1}\n  ${ref}: ${then[i]}\n  here: ${here[i]}`);
        break;
      }
    }
  }
}
process.exit(1);
