import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AppSettings } from '../types';
import { updateSharedJsonSync } from '../utils/shared-file';
import { accountsRoot, readAccountsSettings } from '../services/claude-accounts/registry';

/**
 * What Tars before 2.0.4 left of a key provider's key, and its cleaning (the Audit's M2 on #458).
 *
 * Every launch on a key provider showed Claude Code's question, "Detected a custom API key in your environment",
 * which prints the key's last 20 characters under its own masking, `sk-ant-...<20>` whatever the key's real
 * beginning (measured on 2.1.302, its bytes in key-fragments-on-load.test.ts). An agent's terminal output is kept in
 * agents.json and agents.backup.json, which every agent is handed (--add-dir). After a No, Claude Code keeps the same
 * 20 characters, `key.trim().slice(-20)`, in `customApiKeyResponses.rejected` of the .claude.json of the folder it
 * ran on, ~/.claude.json or an account folder's, and in its own copies of that file (copiesOf). Since 2.0.4 the key
 * goes as the auth token, which is never asked about: nothing new is written, and this cleans, once, what is there
 * (agent-manager.ts, loadAgents).
 */

/** What a masked fragment becomes: the rest of the output, and the screen around it, stay as they were. */
export const REMOVED = '[removed by Tars]';

/** The question's own masking, then up to the 20 characters it shows of the key. */
const MASKED_KEY = /sk-ant-\.\.\.([A-Za-z0-9_-]{1,20})/g;

/**
 * The secrets a key provider of Tars's hands Claude Code (each provider's getPtyEnvVars), and Tars's own token, which
 * the bridge of Venice and of a custom OpenAI endpoint is handed as its key. Not Ollama's `ollama-local`, a word.
 */
export function keysHandedToClaude(settings: Partial<AppSettings>, tarsToken?: string): string[] {
  const keys = [settings.deepSeekApiKey, settings.openRouterApiKey, settings.moonshotApiKey, settings.zhipuApiKey,
    settings.minimaxApiKey, settings.ollamaCloudApiKey, tarsToken];
  return [...new Set(keys.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).map(k => k.trim()))];
}

/** The fragment Claude Code keeps of a key: its last 20 characters. */
export function keyTail(key: string): string {
  return key.trim().slice(-20);
}

/**
 * The output with every fragment masked: the question's masked key, and each key named, whole or its tail, wherever
 * it shows. Read across the chunks, so a fragment the PTY cut between two is masked in both; the chunks stay as many,
 * each one what it was but for what is masked.
 */
export function maskKeyFragments(chunks: string[], keys: string[]): { chunks: string[]; masked: number } {
  const joined = chunks.join('');
  const ranges: Array<[number, number]> = [];
  for (const m of joined.matchAll(MASKED_KEY)) {
    const at = (m.index ?? 0) + m[0].length - m[1].length;
    ranges.push([at, at + m[1].length]);
  }
  for (const needle of new Set(keys.flatMap(k => [k, keyTail(k)]).filter(n => n.length >= 8))) {
    for (let at = joined.indexOf(needle); at >= 0; at = joined.indexOf(needle, at + needle.length)) ranges.push([at, at + needle.length]);
  }
  if (ranges.length === 0) return { chunks, masked: 0 };
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: string[] = [];
  let start = 0;
  let r = 0;
  for (const chunk of chunks) {
    const end = start + chunk.length;
    let piece = '';
    let i = start;
    while (i < end) {
      while (r < merged.length && merged[r][1] <= i) r++;
      const range = merged[r];
      if (!range || range[0] >= end) { piece += joined.slice(i, end); break; }
      if (range[0] > i) { piece += joined.slice(i, range[0]); i = range[0]; }
      if (i === range[0]) piece += REMOVED;
      i = Math.min(range[1], end);
    }
    out.push(piece);
    start = end;
  }
  return { chunks: out, masked: merged.length };
}

/** A .claude.json without the rejected tails of the keys named; undefined when it has none of them. */
export function withoutRejectedTails<T>(config: T | undefined, keys: string[]): T | undefined {
  const responses = (config as { customApiKeyResponses?: { rejected?: unknown } } | undefined)?.customApiKeyResponses;
  const rejected = responses?.rejected;
  if (!Array.isArray(rejected)) return undefined;
  const tails = new Set(keys.map(keyTail));
  const kept = rejected.filter(entry => !(typeof entry === 'string' && tails.has(entry)));
  if (kept.length === rejected.length) return undefined;
  return { ...config, customApiKeyResponses: { ...responses, rejected: kept } } as T;
}

/** Beside a .claude.json: the single backup Claude Code still restores from, and a write of its own it never finished. */
const BESIDE = /^\.claude\.json\.(?:backup|tmp\.\d+\.[0-9a-f]+)$/;
/** In the `backups/` folder of its config home: one backup a minute at most, the last five kept. */
const BACKED_UP = /^\.claude\.json\.backup\.\d+$/;

/**
 * Claude Code's own copies of a .claude.json, each with the same list (its names read in 2.1.302, the backups and the
 * leftovers found in a real home): `.claude.json.backup.<ms>` in `<config home>/backups/`, `.claude.json.backup` and
 * `.claude.json.tmp.<pid>.<hex>` beside the file.
 */
function copiesOf(file: string, configHome: string): string[] {
  const matching = (dir: string, pattern: RegExp) => {
    try { return fs.readdirSync(dir).filter(name => pattern.test(name)).map(name => path.join(dir, name)); } catch { return []; }
  };
  return [...matching(path.dirname(file), BESIDE), ...matching(path.join(configHome, 'backups'), BACKED_UP)];
}

/**
 * The .claude.json of each Claude account folder Tars runs agents on, each followed by Claude Code's copies of it:
 * ~/.claude.json, whose config home is ~/.claude, then each account's, whose config home is its folder.
 */
export function claudeConfigFiles(home: string = os.homedir()): string[] {
  const dirs = new Set<string>();
  try {
    for (const account of readAccountsSettings().accounts) if (account.configDir) dirs.add(account.configDir);
  } catch { /* the registry unreadable: the folders on disk below */ }
  try {
    const root = accountsRoot(home);
    for (const name of fs.readdirSync(root)) if (/^acct-[0-9a-f]{6}$/.test(name)) dirs.add(path.join(root, name));
  } catch { /* no account folder */ }
  const withCopies = (file: string, configHome: string) => [file, ...copiesOf(file, configHome)];
  return [...new Set([
    ...withCopies(path.join(home, '.claude.json'), path.join(home, '.claude')),
    ...[...dirs].flatMap(dir => withCopies(path.join(dir, '.claude.json'), dir)),
  ])];
}

/**
 * The rejected tails of these keys taken out of every .claude.json, through updateSharedJsonSync as the trust Tars
 * writes there: a Claude Code may be writing the same file, which is never written in place, nor at all when nothing
 * goes, and keeps its mode. Returns how many files lost entries.
 */
export function dropRejectedTails(keys: string[], files: string[] = claudeConfigFiles()): number {
  let cleaned = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const outcome = updateSharedJsonSync<Record<string, unknown>>(file, config => withoutRejectedTails(config, keys));
      if (outcome === 'written') cleaned++;
      else if (outcome === 'busy' || outcome === 'unreadable') console.warn(`[key-fragments] ${file} left as it is: ${outcome}`);
    } catch (err) {
      console.warn(`[key-fragments] ${file} could not be cleaned: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return cleaned;
}
