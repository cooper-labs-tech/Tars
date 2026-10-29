import * as fs from 'fs';
import * as path from 'path';
import { renameReplacingSync } from '../platform/rename-replacing';

/** What updateSharedJsonSync did. */
export type SharedJsonOutcome =
  /** The file was replaced. */
  | 'written'
  /** The change was already there, or asked for nothing: no write. */
  | 'unchanged'
  /** The file exists and is not JSON: it is left exactly as it is. */
  | 'unreadable'
  /** The file changed under every attempt: left as the other writer made it. */
  | 'busy'
  /** What would be written does not parse, or did not once written: the previous file is left, or put back. */
  | 'refused';

const ATTEMPTS = 3;

/**
 * Changing a JSON file that other programs read and write while Tars runs:
 * `~/.claude.json`, which every live Claude Code reads and rewrites, Claude's
 * `settings.json`, and `~/.claude/mcp.json`, which every Claude session Tars
 * starts reads through `--mcp-config`.
 *
 * All three were rewritten in place. A reader that opened the file during the
 * write got a truncated JSON document, and Claude Code opens `~/.claude.json`
 * at every start. So the file is written whole beside itself and renamed over,
 * as writeAtomicSync does, with three things that helper does not do and these
 * files need:
 *
 * - the mode is kept. `~/.claude.json` is 0600 (measured here) and holds the
 *   account, while a new file is 0644: a plain temp-and-rename would have
 *   made it readable by every account on the machine;
 * - a link is followed, so a dotfile kept elsewhere stays linked;
 * - the temp name is Tars's own. Claude writes the same file through
 *   `.claude.json.tmp.<pid>.<hex>` names (four of them were left in this HOME),
 *   and a name shared with another writer would let one publish the other's
 *   half-written file.
 *
 * Atomicity only settles what a reader sees. It does nothing for an update
 * lost between reading the file and replacing it, while another program writes
 * it. That window is kept to the rename: the new contents are computed and
 * written to the temp file first, the file is read again, and if it changed in
 * the meantime the change is started over from what it holds now. What is left
 * is a write landing between that last read and the rename, which is a
 * single system call away.
 *
 * On Windows that rename fails while a reader holds the file open, and these
 * files are read all the time; it is retried for about a second
 * (platform/rename-replacing.ts).
 *
 * Every file written here ends with a newline, and is parsed again once
 * written: one that does not parse is replaced by what it held before (28/10:
 * ~/.codex/config.toml was left without its final newline, codex added its own
 * [tui] table on the last line, and refused its whole config).
 */
export function updateSharedJsonSync<T>(
  filePath: string,
  update: (current: T | undefined) => T | undefined,
  { createMode = 0o600 }: { createMode?: number } = {},
): SharedJsonOutcome {
  return replaceShared(filePath, before => {
    let current: T | undefined;
    if (before !== undefined && before.trim()) {
      try {
        current = JSON.parse(before) as T;
      } catch {
        return 'unreadable';
      }
    }

    // Serialized before the update runs, because it may change `current` in
    // place. Compared afterwards, a change made that way read as no change:
    // measured, a server added to `mcpServers` in place came back `unchanged`
    // and the file kept only the servers it had.
    const unchanged = current === undefined ? undefined : JSON.stringify(current, null, 2);
    const next = update(current);
    if (next === undefined) return 'unchanged';
    const contents = JSON.stringify(next, null, 2);
    return contents === unchanged ? 'unchanged' : { write: `${contents}\n` };
  }, createMode, parsesAsJson);
}

const parsesAsJson = (text: string) => { JSON.parse(text); };
const withNewline = (text: string) => (text === '' || text.endsWith('\n') ? text : `${text}\n`);

/**
 * updateSharedJsonSync for a file that is not JSON: codex's config.toml, which every codex reads at its start and
 * rewrites when its user trusts a folder (providers/codex-cli.ts), grok's. The same care, and `update` says what the
 * file becomes from what it holds (undefined: there is none), or undefined to leave it. A read that fails for any
 * reason but the file's absence throws, and nothing is written: a config that could not be read was never one to
 * replace. `parse` throws on what is not the file's language: a text that would not parse is never written
 * ('refused'), and the previous file stays.
 */
export function updateSharedTextSync(
  filePath: string,
  update: (current: string | undefined) => string | undefined,
  { createMode = 0o600, parse }: { createMode?: number; parse?: (text: string) => unknown } = {},
): Exclude<SharedJsonOutcome, 'unreadable'> {
  return replaceShared(filePath, before => {
    const next = update(before);
    if (next === undefined) return 'unchanged';
    const text = withNewline(next);
    if (text === before) return 'unchanged';
    if (parse) {
      try { parse(text); } catch { return 'refused'; }
    }
    return { write: text };
  }, createMode, parse) as Exclude<SharedJsonOutcome, 'unreadable'>;
}

/**
 * A CLI's JSON config written whole from what Tars computed (gemini's and amp's settings, the MCP page's files,
 * Qwen Code's per-agent settings): as updateSharedJsonSync writes, whatever the file held.
 */
export function writeSharedJsonSync(filePath: string, value: unknown, { createMode = 0o600 }: { createMode?: number } = {}): SharedJsonOutcome {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  return replaceShared(filePath, before => (before === text ? 'unchanged' : { write: text }), createMode, parsesAsJson);
}

/**
 * The loop both share. `next` reads the file's text (undefined: there is none) and says what to write, or that
 * nothing is to be; it runs again from the file as it is now if the file changed while the new one was written.
 */
function replaceShared(
  filePath: string,
  next: (before: string | undefined) => { write: string } | 'unchanged' | 'unreadable' | 'refused',
  createMode: number,
  parse?: (text: string) => unknown,
): SharedJsonOutcome {
  // The file a link points at, so the rename replaces it and not the link.
  const target = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const before = readIfPresent(target);
    const outcome = next(before);
    if (outcome === 'unchanged' || outcome === 'unreadable' || outcome === 'refused') return outcome;

    // The file's own mode, given at creation: the umask can only narrow it.
    const mode = before !== undefined ? fs.statSync(target).mode & 0o777 : createMode;
    const tmp = `${target}.tars-${process.pid}.tmp`;
    try {
      if (!fs.existsSync(path.dirname(target))) fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, outcome.write, { mode });

      if (readIfPresent(target) !== before) {
        // Written to while this was being prepared: start again from that.
        removeTemp(tmp);
        continue;
      }
      renameReplacingSync(tmp, target);
      // Read again and parsed: a file that does not parse once written is replaced by what it held before.
      if (parse && !parsesNow(target, parse)) {
        if (before === undefined) fs.rmSync(target, { force: true });
        else {
          fs.writeFileSync(tmp, before, { mode });
          renameReplacingSync(tmp, target);
        }
        return 'refused';
      }
      return 'written';
    } catch (err) {
      removeTemp(tmp);
      throw err;
    }
  }
  return 'busy';
}

function parsesNow(filePath: string, parse: (text: string) => unknown): boolean {
  try {
    parse(fs.readFileSync(filePath, 'utf-8'));
    return true;
  } catch {
    return false;
  }
}

/** Cleanup that can neither fail nor hide the error that made it necessary. */
function removeTemp(tmp: string): void {
  try {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  } catch {
    // The write's own error is the one worth reporting.
  }
}

function readIfPresent(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
