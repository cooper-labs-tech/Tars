import * as fs from 'fs';
import * as path from 'path';
import { hookRunnerFirstWord } from './hook-launcher';

/**
 * How Tars's hooks are started by the CLIs that run them, and how their
 * entries are kept in the CLIs' settings files.
 *
 * Every hook is the one Node runner,
 * `<launcher> "<abs>/hooks/tars-hook.mjs" <event>` (and `statusline.mjs` for
 * the status line), on every platform since 2.0.4: the launcher Tars writes at
 * each start (hook-launcher.ts), or `node` when it has none. Until then
 * darwin and linux ran the .sh scripts, which need bash, jq and curl; on win32
 * they cannot run at all (bash eats the backslashes of their unquoted path, jq
 * is not installed, and Git Bash's curl cannot read the `-H @<(...)` process
 * substitution that carries the token).
 *
 * The one place that decides.
 */

/**
 * The shell-form command a CLI runs for a Node hook:
 * `<launcher> "<script>" <args>`, or `node "<script>" <args>`.
 *
 * Shell form, not Claude Code's exec form (`command` + `args`): an older
 * claude that predates `args` would run bare `node` and feed it the hook's
 * JSON as a program. Shell form runs everywhere, and it is read by two
 * shells: Git Bash (Claude Code on Windows when Git is installed) and Windows
 * PowerShell (Claude Code without Git Bash, and Gemini CLI always, through
 * `powershell.exe -NoProfile -Command`). So:
 *  - forward slashes: bash would eat the backslashes of an unquoted path, and
 *    turns `\\server` into `\server` even inside double quotes; Node takes
 *    `C:/...` and `//server/share/...` as they are;
 *  - double quotes, which both shells read the same way unless the path holds
 *    `$` or a backtick (expanded by both, escaped differently by each) or a
 *    typographic double quote, U+201C to U+201E, where PowerShell ends a
 *    double-quoted string as it does at `"`; then single quotes, which both
 *    read literally unless the path holds a `'` or a typographic single quote,
 *    U+2018 to U+201B, which PowerShell takes for one;
 *  - a path that neither form carries is refused, loudly, rather than wired
 *    to fail.
 * The arguments are Tars's own event names, never user input.
 */
/** What ends or expands a double-quoted string in Git Bash or PowerShell. */
const BREAKS_DOUBLE_QUOTES = /[$`"\u201C-\u201E]/;
/** What ends a single-quoted string in Git Bash or PowerShell. */
const BREAKS_SINGLE_QUOTES = /['\u2018-\u201B]/;

export function nodeHookCommand(script: string, ...args: string[]): string {
  const p = script.replace(/\\/g, '/');
  let quoted: string;
  if (!BREAKS_DOUBLE_QUOTES.test(p)) quoted = `"${p}"`;
  else if (!BREAKS_SINGLE_QUOTES.test(p)) quoted = `'${p}'`;
  else throw new Error(`The hooks path ${script} cannot be quoted for both Git Bash and PowerShell: it holds a single quote and a $, a backtick or a double quote.`);
  for (const arg of args) {
    if (!/^[A-Za-z0-9/_.-]+$/.test(arg)) throw new Error(`Not a hook event name: ${arg}`);
  }
  return [hookRunnerFirstWord(), quoted, ...args].join(' ');
}

/**
 * Whether `file`, an absolute path, is `<hooks>/<rel>` in a hooks folder of
 * Tars's, and nothing else.
 *
 * The name alone proves nothing: `on-stop.sh`, `notification.sh` or
 * `statusline.mjs` is what a user calls their own script too, and what other
 * apps ship (the installed Dorothy keeps its own in `.../Programs/Dorothy/
 * resources/app.asar.unpacked/hooks/`). A false match repoints a user's hook
 * at the runner and deletes its copies, or removes their status line, and
 * Tars never touches another app's or a user's scripts. So a file is Tars's
 * only
 *  - in `hooksDir`, this app's own hooks folder, the one the runner is
 *    resolved from (this install or this dev checkout),
 *  - or in a hooks folder that holds Tars's own `tars-hook.sh` or
 *    `tars-hook.mjs` beside it (an older Tars, installed or checked out;
 *    every Tars since 1.8 ships tars-hook.sh),
 * and never under the CLI's config folder (`cliConfigDir`, or any `.claude`
 * or `.gemini` folder), whatever it holds: that is where users keep theirs.
 */
export function isTarsHooksFile(file: string, rel: string, cliConfigDir: string, hooksDir: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const raw = file.trim();
  if (!path.win32.isAbsolute(raw) && !path.posix.isAbsolute(raw)) return false;
  const normalized = norm(raw);
  if (!normalized.toLowerCase().endsWith(`/hooks/${rel}`.toLowerCase())) return false;
  const hooksRoot = normalized.slice(0, normalized.length - rel.length - 1);
  // First: this app's own hooks folder is never the CLI's config folder,
  // even when a dev worktree puts it under <repo>/.claude/worktrees/.
  if (hooksRoot.toLowerCase() === norm(path.resolve(hooksDir)).toLowerCase()) return true;
  const lower = normalized.toLowerCase();
  const configRoot = norm(path.resolve(cliConfigDir)).toLowerCase();
  if (lower.startsWith(`${configRoot}/`) || /\/\.(claude|gemini)\//.test(lower)) return false;
  return ['tars-hook.sh', 'tars-hook.mjs'].some(name => fs.existsSync(path.join(hooksRoot, name)));
}

/** A matcher for the .sh command a previous Tars wrote: the bare absolute path of a Tars hooks file (isTarsHooksFile). */
export function legacyShCommand(rel: string, cliConfigDir: string, hooksDir: string): (command: string) => boolean {
  return command => isTarsHooksFile(command, rel, cliConfigDir, hooksDir);
}

/**
 * A Node hook command Tars wrote, from any checkout: which script it runs and
 * with what event. Its first word is `node`, or a hook launcher of any Tars
 * (`tars-hook`, `tars-hook.cmd`), quoted or bare.
 */
export function parseNodeHookCommand(command: unknown): { script: string; event?: string } | undefined {
  if (typeof command !== 'string') return undefined;
  const m = /^(?:(["'])(.+?)\1|(\S+))\s+(["'])(.+?)\4(?:\s+(\S+))?\s*$/.exec(command.trim());
  if (!m) return undefined;
  const first = m[2] ?? m[3];
  if (first !== 'node' && !/(^|[\\/])tars-hook(\.cmd)?$/i.test(first)) return undefined;
  return { script: m[5], event: m[6] };
}

type Hook = { type?: string; command?: string; timeout?: number; [key: string]: unknown };
type Entry = { matcher?: string; hooks?: Hook[]; [key: string]: unknown };
export type HookTable = Record<string, Entry[] | undefined>;

export type NodeHookSpec = {
  /** The CLI's event name, the key in `hooks`. */
  type: string;
  /** The runner's event argument, the .sh path under hooks/ without `.sh`. */
  event: string;
  matcher?: string;
  /** Is this command one Tars wrote for this event in the .sh era? */
  isLegacy: (command: string) => boolean;
  /** Other keys where Tars once wired this script, to be cleared (Gemini's UserPromptSubmit). */
  formerTypes?: string[];
};

/**
 * Put one Node-runner entry per event into a CLI's `hooks` table.
 *
 * A hook is Tars's when its command runs tars-hook.mjs with this event (from
 * this checkout or another) or is the .sh a previous Tars wrote for it. The
 * first such hook keeps its place, its matcher and its timeout, and gets the
 * command of this checkout; every other one is removed (the .sh copies
 * Gemini's .sh wiring appended at each start on Windows, where it looked for
 * `gemini/<file>` in a backslash path), with its entry when it held nothing
 * else. Hooks that are not Tars's are never touched. Returns
 * whether anything changed, so a second run writes nothing.
 */
export function mergeNodeHooks(hooks: HookTable, specs: NodeHookSpec[], hooksDir: string, timeout: number): boolean {
  const runner = path.join(hooksDir, 'tars-hook.mjs');
  if (!fs.existsSync(runner)) return false;
  let changed = false;

  const isOurs = (spec: NodeHookSpec, hook: Hook | undefined): boolean => {
    const command = hook?.command;
    if (typeof command !== 'string') return false;
    const parsed = parseNodeHookCommand(command);
    if (parsed && /(^|\/)tars-hook\.mjs$/.test(parsed.script.replace(/\\/g, '/')) && parsed.event === spec.event) return true;
    return spec.isLegacy(command);
  };

  /** Remove Tars's hooks for this spec from one key, keeping the first when asked. Returns the kept one. */
  const sweep = (type: string, spec: NodeHookSpec, keepFirst: boolean): Hook | undefined => {
    const entries = hooks[type];
    if (!Array.isArray(entries)) return undefined;
    let kept: Hook | undefined;
    const next: Entry[] = [];
    for (const entry of entries) {
      if (!Array.isArray(entry?.hooks)) { next.push(entry); continue; }
      const remaining = entry.hooks.filter(hook => {
        if (!isOurs(spec, hook)) return true;
        if (keepFirst && !kept) { kept = hook; return true; }
        changed = true;
        return false;
      });
      if (remaining.length === entry.hooks.length) next.push(entry);
      else if (remaining.length > 0) next.push({ ...entry, hooks: remaining });
    }
    if (next.length !== entries.length || next.some((e, i) => e !== entries[i])) {
      if (next.length === 0) delete hooks[type];
      else hooks[type] = next;
    }
    return kept;
  };

  for (const spec of specs) {
    const command = nodeHookCommand(runner, spec.event);
    const kept = sweep(spec.type, spec, true);
    if (kept) {
      if (kept.command !== command) {
        kept.command = command;
        changed = true;
      }
    } else {
      const entry: Entry = { hooks: [{ type: 'command', command, timeout }] };
      if (spec.matcher) entry.matcher = spec.matcher;
      hooks[spec.type] = [...(hooks[spec.type] ?? []), entry];
      changed = true;
    }
    for (const former of spec.formerTypes ?? []) sweep(former, spec, false);
  }
  return changed;
}
