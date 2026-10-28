import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PRIVATE_DIR } from '../constants';
import { levelOf } from '../core/permission-ceiling';
import { shortIdOf, TMP_ROOT } from './agent-tmp';
import type { AgentStatus } from '../types';

/**
 * Tars answers yes itself, for an agent the owner set to bypass, when everything the call touches is inside that
 * agent's own folders (2.0.5, brief fix-permission-dialogs-2810.md, item 2). The owner's bypass is the decision: this
 * applies it to what Claude Code still asks, and to nothing more.
 *
 * Why: in bypass, Claude Code still asks about a command it cannot read whole (a heredoc, a compound command) and
 * about a path it does not know, and nobody answers at night. Three projects' agents stopped until morning on a
 * heredoc into their own scratchpad (parallel 27/10 19:48, 1212 27/10 01:58, kotsna 19/10 and 22/10, ours 28/10).
 *
 * What it reads, and nothing else:
 * - the file tools (Write, Edit, MultiEdit, NotebookEdit, Read): their path;
 * - Bash: a command made only of the programs below, joined by `&&`, `||`, `;`, `|` and new lines, with heredocs,
 *   quotes, redirections and variables it sets itself or knows ($HOME, $TMPDIR, $CLAUDE_CODE_TMPDIR, $PWD). Every
 *   word of a program that works on files is taken for a path, and every path must resolve, links followed, inside
 *   the agent's working folder (its worktree, or its project), its `t` or its `c` temporary folder
 *   (services/agent-tmp.ts), strictly inside, and never in its `.git`, `.claude` or `.mcp.json`. Never under
 *   ~/.tars-private, another agent's worktree or another agent's temporary folders.
 * Anything it cannot read whole (a substitution, a backtick, eval, a subshell, a group, `&`, a brace, an unknown
 * variable, a program not on the list or named by its path, `..`) is not answered here: it waits for the owner.
 *
 * Not a boundary: an agent in bypass runs anything Claude Code does not ask about, and Claude Code is the one that
 * asks. This only decides which of its questions Tars may answer for the owner. SECURITY.md says so.
 */

export type Places = {
  /** Where a relative path starts: the agent's working folder. */
  cwd: string;
  /** The agent's own folders, as given and as resolved. */
  own: string[];
  /** Folders inside which nothing is answered: the private folder, the other agents'. */
  never: string[];
  /** The variables a command may use without setting them. */
  vars: Record<string, string>;
  home: string;
};

export type Judgement = { allow: boolean; why: string };

/** Programs whose words are data, never paths. */
const DATA_ONLY = new Set(['echo', 'printf', 'true', 'false', ':', 'test', '[', 'basename', 'dirname', 'pwd', 'date']);
/** Programs that work on files: every word not a flag is a path. */
const ON_FILES = new Set([
  'mkdir', 'touch', 'cp', 'mv', 'rm', 'rmdir', 'ln', 'chmod', 'cat', 'head', 'tail', 'wc', 'ls', 'tee', 'mktemp',
  'diff', 'sort', 'uniq', 'cut', 'stat', 'du', 'file', 'realpath', 'readlink', 'grep', 'jq',
]);
/** Programs that may name the folder itself: only read it, or make it. */
const ROOT_OK = new Set(['cd', 'ls', 'mkdir', 'stat', 'du', 'realpath', 'readlink', 'file']);
const FILE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', Read: 'file_path', NotebookEdit: 'notebook_path' };
const COMMAND_MAX = 20_000;
/** What Claude Code itself keeps an agent's hands off: its hooks, its settings, its servers. */
const GUARDED = new Set(['.git', '.claude']);

/** A path, links followed as far as it exists, the rest as written. */
function realOf(p: string): string {
  let at = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(at), ...rest.reverse());
    } catch {
      const up = path.dirname(at);
      if (up === at) return p;
      rest.push(path.basename(at));
      at = up;
    }
  }
}

function within(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The folders the agent owns and those it must not touch; undefined when the agent is not in bypass, which Tars
 * never answers for.
 */
export function placesOf(
  agent: AgentStatus,
  fleet: Iterable<AgentStatus>,
  at: { home: string; privateDir: string; tmpRoot: string } = { home: os.homedir(), privateDir: PRIVATE_DIR, tmpRoot: TMP_ROOT },
): Places | undefined {
  if (levelOf(agent) !== 'bypass') return undefined;
  const work = agent.worktreePath || agent.projectPath;
  const mine = path.join(at.tmpRoot, shortIdOf(agent.id));
  const own = [work, path.join(mine, 't'), path.join(mine, 'c')];
  const others = [...fleet].filter(o => o.id !== agent.id)
    .flatMap(o => [o.worktreePath, path.join(at.tmpRoot, shortIdOf(o.id))])
    .filter((d): d is string => !!d);
  // A worktree two agents share is each one's own: it is not kept from either.
  const never = [at.privateDir, ...others].filter(n => !own.some(o => within(o, n)));
  return { cwd: work, own, never, vars: { HOME: at.home, TMPDIR: own[1], CLAUDE_CODE_TMPDIR: own[2], PWD: work }, home: at.home };
}

/** Why this path is not the agent's own to touch, or undefined when it is. */
function judgePath(word: string, cwd: string, places: Places, rootOk: boolean): string | undefined {
  if (word === '/dev/null') return undefined;
  if (!word) return 'an empty path';
  if (word.split(/[\\/]/).includes('..')) return `${word} climbs out with ..`;
  const real = realOf(path.resolve(cwd, word));
  const root = places.own.map(realOf).find(o => within(real, o));
  if (!root) return `${word} is outside its own folders`;
  if (places.never.map(realOf).some(n => within(real, n))) return `${word} is in a folder Tars keeps from it`;
  if (real === root && !rootOk) return `${word} is its folder itself`;
  const parts = path.relative(root, real).split(path.sep);
  if (parts.some(p => GUARDED.has(p)) || parts.at(-1) === '.mcp.json') return `${word} is its own .git, .claude or .mcp.json, which Claude Code asks about on purpose`;
  return undefined;
}

/** A glob in the last part only, matched here against the folder; each match judged where it leads. */
function judgeGlob(word: string, cwd: string, places: Places, rootOk: boolean): string | undefined {
  const dir = path.dirname(word);
  const pattern = path.basename(word);
  if (/[*?[]/.test(dir)) return `${word} globs in a folder's name`;
  const why = judgePath(dir, cwd, places, true);
  if (why) return why;
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  let names: string[] = [];
  try { names = fs.readdirSync(path.resolve(cwd, dir)); } catch { return undefined; }
  for (const name of names) {
    if (name.startsWith('.') && !pattern.startsWith('.')) continue;
    if (!re.test(name)) continue;
    const each = judgePath(path.join(dir, name), cwd, places, rootOk);
    if (each) return `${word} matches ${each}`;
  }
  return undefined;
}

type Segment = { text: string; quoted: boolean } | { variable: string; quoted: boolean };
type Word = { segments: Segment[]; glob: boolean };
type Redirect = { op: string; target?: Word };
type Simple = { words: Word[]; redirects: Redirect[] };
class Unread extends Error {}

/** The command in simple commands, or Unread with why it cannot be read whole. */
function parse(command: string): Simple[] {
  const out: Simple[] = [];
  let current: Simple = { words: [], redirects: [] };
  let word: Word | undefined;
  let pendingRedirect: Redirect | undefined;
  const heredocs: Array<{ delimiter: string; quoted: boolean; strip: boolean }> = [];
  const flushWord = () => {
    if (!word) return;
    if (pendingRedirect) { pendingRedirect.target = word; current.redirects.push(pendingRedirect); pendingRedirect = undefined; }
    else current.words.push(word);
    word = undefined;
  };
  const endCommand = () => {
    flushWord();
    if (pendingRedirect) throw new Unread(`a redirection with no target`);
    if (current.words.length || current.redirects.length) out.push(current);
    current = { words: [], redirects: [] };
  };
  const add = (seg: Segment) => {
    word ??= { segments: [], glob: false };
    const last = word.segments.at(-1);
    if (last && 'text' in last && 'text' in seg && last.quoted === seg.quoted) last.text += seg.text;
    else word.segments.push({ ...seg });
  };
  const variableAt = (i: number, quoted: boolean): number => {
    const braced = command[i + 1] === '{';
    const m = (braced ? /^\{([A-Za-z_][A-Za-z0-9_]*)\}/ : /^([A-Za-z_][A-Za-z0-9_]*)/).exec(command.slice(i + 1));
    if (!m) throw new Unread(`a ${command.slice(i, i + 2)} it cannot read`);
    add({ variable: m[1], quoted });
    return i + 1 + m[0].length;
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === '\n') {
      endCommand();
      i++;
      // The bodies of the heredocs this line opened: data, up to each delimiter's line.
      for (const h of heredocs.splice(0)) {
        for (;;) {
          if (i >= command.length) throw new Unread(`a heredoc with no ${h.delimiter} line`);
          const end = command.indexOf('\n', i);
          const line = command.slice(i, end < 0 ? command.length : end);
          i = end < 0 ? command.length : end + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delimiter) break;
          if (!h.quoted && /\$\(|`/.test(line)) throw new Unread('an unquoted heredoc whose body the shell would run');
        }
      }
      continue;
    }
    if (ch === ' ' || ch === '\t') { flushWord(); i++; continue; }
    if (ch === '#' && !word) { while (i < command.length && command[i] !== '\n') i++; continue; }
    if (ch === '\\') {
      if (command[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 >= command.length) throw new Unread('a trailing backslash');
      add({ text: command[i + 1], quoted: true });
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) throw new Unread('an unclosed quote');
      add({ text: command.slice(i + 1, end), quoted: true });
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      let text = '';
      for (;;) {
        if (i >= command.length) throw new Unread('an unclosed quote');
        const c = command[i];
        if (c === '"') { i++; break; }
        if (c === '`') throw new Unread('a backtick');
        if (c === '\\' && '"$`\\\n'.includes(command[i + 1] ?? '')) { text += command[i + 1] === '\n' ? '' : command[i + 1]; i += 2; continue; }
        if (c === '$') {
          if (command[i + 1] === '(') throw new Unread('a command substitution');
          if (text) { add({ text, quoted: true }); text = ''; }
          i = variableAt(i, true);
          continue;
        }
        text += c;
        i++;
      }
      add({ text, quoted: true });
      continue;
    }
    if (ch === '`') throw new Unread('a backtick');
    if (ch === '$') {
      if (command[i + 1] === '(' || command[i + 1] === "'") throw new Unread(command[i + 1] === '(' ? 'a command substitution' : "a $'...' string");
      i = variableAt(i, false);
      continue;
    }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') throw new Unread(ch === '{' || ch === '}' ? 'a group or a brace' : 'a subshell');
    if (ch === ';' || ch === '|' || ch === '&') {
      const two = command.slice(i, i + 2);
      if (two === '&&' || two === '||') { endCommand(); i += 2; continue; }
      if (two === '|&' || two === '&>') {
        if (two === '&>') { flushWord(); pendingRedirect = { op: '&>' }; i += command[i + 2] === '>' ? 3 : 2; continue; }
        throw new Unread('|&');
      }
      if (ch === '&') throw new Unread('a command sent to the background');
      endCommand();
      i++;
      continue;
    }
    if (ch === '<' || ch === '>' || (/[0-9]/.test(ch) && !word && /^[0-9]+[<>]/.test(command.slice(i)))) {
      flushWord();
      const m = /^([0-9]*)(<<<|<<-|<<|>>|>\||>&|<&|<|>)/.exec(command.slice(i));
      if (!m) throw new Unread('a redirection it cannot read');
      i += m[0].length;
      const op = m[2];
      if (op === '>&' || op === '<&') {
        const fd = /^\s*([0-9]+|-)/.exec(command.slice(i));
        if (!fd) throw new Unread('a redirection to a file descriptor it cannot read');
        i += fd[0].length;
        continue;
      }
      if (op === '<<' || op === '<<-') {
        while (command[i] === ' ' || command[i] === '\t') i++;
        const d = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(command.slice(i));
        if (!d) throw new Unread('a heredoc delimiter it cannot read');
        heredocs.push({ delimiter: d[2], quoted: !!d[1], strip: op === '<<-' });
        i += d[0].length;
        continue;
      }
      if (op === '<<<') {
        // A here-string is the command's input: data, read as a word only to refuse what the shell would run.
        pendingRedirect = { op: '<<<' };
        continue;
      }
      pendingRedirect = { op };
      continue;
    }
    if ((ch === '*' || ch === '?' || ch === '[')) {
      add({ text: ch, quoted: false });
      word!.glob = true;
      i++;
      continue;
    }
    if (ch === '~' && !word) {
      const next = command[i + 1];
      if (next !== undefined && next !== '/' && next !== ' ' && next !== '\n' && next !== '\t') throw new Unread("another user's ~");
      add({ variable: 'HOME', quoted: true });
      i++;
      continue;
    }
    add({ text: ch, quoted: false });
    i++;
  }
  endCommand();
  if (heredocs.length) throw new Unread('a heredoc with no body');
  return out;
}

function expand(word: Word, vars: Record<string, string>): string {
  return word.segments.map(s => {
    if ('text' in s) return s.text;
    const value = vars[s.variable];
    if (value === undefined) throw new Unread(`$${s.variable}, which it does not know`);
    if (!s.quoted && /[\s*?[]/.test(value)) throw new Unread(`$${s.variable} unquoted, which the shell would split`);
    return value;
  }).join('');
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** A word that sets a variable: its name, written unquoted before the `=`. */
function assigns(word: Word): boolean {
  const first = word.segments[0];
  return !!first && 'text' in first && !first.quoted && ASSIGNMENT.test(first.text);
}

function judgeBash(command: string, places: Places): Judgement {
  if (!command.trim()) return { allow: false, why: 'an empty command' };
  if (command.length > COMMAND_MAX) return { allow: false, why: `a command past ${COMMAND_MAX} characters` };
  let commands: Simple[];
  try {
    commands = parse(command);
  } catch (err) {
    return { allow: false, why: err instanceof Unread ? `it cannot read ${err.message}` : String(err) };
  }
  const vars = { ...places.vars };
  let cwd = places.cwd;
  try {
    for (const c of commands) {
      const words = [...c.words];
      // Assignments: alone they set a variable for what follows; before a program, for it (kept: simpler, and safe).
      while (words.length && assigns(words[0])) {
        const all = expand(words.shift()!, vars);
        const m = ASSIGNMENT.exec(all)!;
        vars[m[1]] = all.slice(m[0].length);
      }
      if (words.length && expand(words[0], vars) === 'export') {
        words.shift();
        for (const w of words) {
          const all = expand(w, vars);
          const m = ASSIGNMENT.exec(all);
          if (!m) throw new Unread(`export of ${all}`);
          vars[m[1]] = all.slice(m[0].length);
        }
        words.length = 0;
      }
      for (const r of c.redirects) {
        if (r.op === '<<<') { if (r.target) expand(r.target, vars); continue; }
        const target = r.target ? expand(r.target, vars) : '';
        if (r.target?.glob) throw new Unread(`a glob in a redirection`);
        const why = judgePath(target, cwd, places, false);
        if (why) return { allow: false, why };
      }
      if (words.length === 0) continue;
      const program = expand(words[0], vars);
      if (words[0].glob || program.includes('/')) throw new Unread(`${program}, a program named by its path`);
      if (DATA_ONLY.has(program)) { words.slice(1).forEach(w => expand(w, vars)); continue; }
      if (program !== 'cd' && !ON_FILES.has(program)) return { allow: false, why: `${program} is not a program Tars answers for` };
      const rootOk = ROOT_OK.has(program);
      let flags = true;
      const args: string[] = [];
      for (const w of words.slice(1)) {
        const text = expand(w, vars);
        if (flags && text === '--') { flags = false; continue; }
        if (flags && text.startsWith('-') && text.length > 1) {
          const eq = text.indexOf('=');
          if (eq > 0) {
            const why = judgePath(text.slice(eq + 1), cwd, places, rootOk);
            if (why) return { allow: false, why };
          }
          continue;
        }
        const why = w.glob ? judgeGlob(text, cwd, places, rootOk) : judgePath(text, cwd, places, rootOk);
        if (why) return { allow: false, why };
        args.push(text);
      }
      if (program === 'cd') {
        if (args.length !== 1) return { allow: false, why: 'cd with no folder, or more than one' };
        cwd = path.resolve(cwd, args[0]);
      }
    }
  } catch (err) {
    if (err instanceof Unread) return { allow: false, why: `it cannot read ${err.message}` };
    throw err;
  }
  return { allow: true, why: 'every path it touches is inside its own folders' };
}

/** Whether Tars answers this call itself: yes only when every path it touches is the agent's own. */
export function judgeCall(tool: string, fields: Record<string, string>, places: Places): Judgement {
  if (tool === 'Bash') return judgeBash(fields.command ?? '', places);
  const field = FILE_TOOLS[tool];
  if (!field) return { allow: false, why: `${tool} is not a tool Tars answers for` };
  const file = fields[field];
  if (!file || !path.isAbsolute(file)) return { allow: false, why: `${tool} names no absolute path` };
  const why = judgePath(file, places.cwd, places, false);
  return why ? { allow: false, why } : { allow: true, why: `${file} is inside its own folders` };
}
