/**
 * How home-guard.test.ts reads a test file: the writes it makes under the home, and whether the
 * home guard is its first import. The reading is by text, so it is a net, not a proof:
 * - It sees a write (fs's write, make, remove, rename, copy and link calls) whose path argument
 *   names the home: os.homedir(), a bare homedir(), process.env.HOME, or a name made from one of
 *   those, however many hops away.
 * - It does not see a write the code under test makes on its own.
 * Strings and comments are blanked first, so the home's name in a file name or a note raises no
 * alarm. A template string keeps its `${...}` parts.
 */

const HOME = /os\.homedir\(\)|\bhomedir\(\)|process\.env\.HOME\b/;
const WRITE = /\b(writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdir|mkdtempSync|mkdtemp|rmSync|rm|rmdirSync|rmdir|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile|cpSync|cp|symlinkSync|symlink|linkSync|link|truncateSync|truncate|createWriteStream|chmodSync|chmod|utimesSync|utimes)\s*\(/g;

/** The source with comments dropped: `code` with every string blanked too (a template keeps its `${...}`), `text` with strings kept. */
function scan(source: string): { code: string; text: string } {
  const src = source.replace(/process\.env\[(['"])HOME\1\]/g, 'process.env.HOME');
  let code = '';
  let text = '';
  let i = 0;
  const quoted = (quote: string) => {
    let j = i + 1;
    while (j < src.length && src[j] !== quote && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
    text += src.slice(i, j + 1);
    code += quote + quote;
    i = j + 1;
  };
  const template = () => {
    code += '`';
    text += '`';
    i++;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { text += src.slice(i, i + 2); i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        code += '${';
        text += '${';
        i += 2;
        expression('}');
        code += '}';
        text += '}';
        i++;
        continue;
      }
      text += src[i];
      i++;
    }
    code += '`';
    text += '`';
    i++;
  };
  // Code up to the `close` that ends it at depth 0 (the end of a template's `${...}`), or the end of the source.
  const expression = (close?: string) => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (close && depth === 0 && c === close) return;
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
      if (c === "'" || c === '"') { quoted(c); continue; }
      if (c === '`') { template(); continue; }
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
      code += c;
      text += c;
      i++;
    }
  };
  expression();
  return { code, text };
}

/** The text from `at` to the first `,` or closing bracket at depth 0: a call's first argument. */
function argument(code: string, at: number): string {
  let depth = 0;
  for (let i = at; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return code.slice(at, i); depth--; }
    else if (c === ',' && depth === 0) return code.slice(at, i);
  }
  return code.slice(at);
}

/** The value assigned from `at`: up to the `;`, or the line's end, at depth 0. */
function value(code: string, at: number): string {
  let depth = 0;
  for (let i = at; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if ((c === ';' || c === '\n') && depth <= 0) return code.slice(at, i);
  }
  return code.slice(at);
}

const word = (name: string) => new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}\\b`);

/** The names made from the home: assigned from it, or from another such name, or a function that returns one. */
function homeNames(code: string): RegExp[] {
  const defs: Array<[string, string]> = [];
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=(?!=)/g)) defs.push([m[1], value(code, m.index + m[0].length)]);
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const open = code.indexOf('{', m.index + m[0].length);
    if (open >= 0) defs.push([m[1], argument(code, open + 1)]);
  }
  const names = new Map<string, RegExp>();
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, assigned] of defs) {
      if (names.has(name)) continue;
      if (HOME.test(assigned) || [...names.values()].some(re => re.test(assigned))) {
        names.set(name, word(name));
        grew = true;
      }
    }
  }
  return [...names.values()];
}

function writesIn(code: string, names: RegExp[]): string[] {
  const hits: string[] = [];
  for (const m of code.matchAll(WRITE)) {
    const arg = argument(code, m.index + m[0].length);
    if (HOME.test(arg) || names.some(re => re.test(arg))) hits.push(`${m[1]}(${arg.trim().replace(/\s+/g, ' ').slice(0, 80)})`);
  }
  return hits;
}

/** The writes of `source` whose path names the home, as `call(first argument)`. */
export function homeWrites(source: string): string[] {
  const { code } = scan(source);
  return writesIn(code, homeNames(code));
}

/** The writes under the home made inside vi.hoisted(...), which runs before every import, the guard's included. */
export function hoistedHomeWrites(source: string): string[] {
  const { code } = scan(source);
  const names = homeNames(code);
  return [...code.matchAll(/\bvi\.hoisted\s*\(/g)].flatMap(m => writesIn(argument(code, m.index + m[0].length), names));
}

/** Whether the first import of `source` is the home guard's. */
export function guardedFirst(source: string): boolean {
  const { text } = scan(source);
  const first = /(?:^|\n)[ \t]*import(?=[\s{*'"])/.exec(text);
  if (!first) return false;
  return /^\s*import\s*['"][^'"]*\/home-guard(?:\.ts)?['"]/.test(text.slice(first.index));
}
