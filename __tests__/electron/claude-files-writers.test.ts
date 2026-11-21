import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';

/**
 * Nothing in the product writes Claude's own files except through
 * updateSharedJsonSync.
 *
 * `~/.claude.json`, `~/.claude/settings.json` and `~/.claude/mcp.json` are read
 * by every claude binary as it starts, and Claude Code writes the first two
 * itself. Rewritten in place, a reader could get half a document, and every
 * writer read a file it could not parse as empty, so its next save replaced
 * the whole file with its own entry. The helper writes beside the file and
 * renames over it, keeps its mode, and never writes over a file that is not
 * JSON.
 *
 * The writers were first counted by family ("the providers"), and that count
 * missed the status line, the memory backends, the orchestrator setup and the
 * MCP settings page. So nothing here lists files or functions. Every write
 * call in `electron/` and the MCP servers (`writeFileSync`, `renameSync`,
 * `copyFileSync`, `appendFileSync`, `createWriteStream`...) is found in the
 * syntax tree, and the path it writes is worked out from the source: string
 * literals, `path.join` and `path.resolve`, `os.homedir()`, constants, imports
 * (dynamic ones included), `this.configDir`, and the return values of
 * functions, following a `switch` on an argument. A path that comes from a
 * parameter is followed to every call of the function, which is how a wrapper
 * such as writeAtomicSync is caught when handed one of these paths. A call
 * that can write one of the three files is a failure, reported with the chain
 * of calls that leads there. The helper's own writes are the only ones exempt.
 *
 * What it cannot see: a path that arrives at run time, such as the one
 * fs:write-text-file receives from the renderer. That handler refuses these
 * files, and shared-files-atomic.test.ts holds it to that.
 */

const HOME = '<home>';
const ANY = '<any>';
const CLAUDE_FILES: Record<string, string> = {
  [`${HOME}/.claude.json`]: '~/.claude.json',
  [`${HOME}/.claude/settings.json`]: '~/.claude/settings.json',
  [`${HOME}/.claude/mcp.json`]: '~/.claude/mcp.json',
};
const HELPER_FILE = path.join('electron', 'utils', 'shared-file.ts');
const HELPER = 'updateSharedJsonSync';

/** fs calls that write a path, and which argument that path is. */
const WRITE_CALLS: Record<string, number> = {
  writeFileSync: 0, writeFile: 0, appendFileSync: 0, appendFile: 0, createWriteStream: 0,
  truncateSync: 0, truncate: 0, openSync: 0, open: 0,
  renameSync: 1, rename: 1, copyFileSync: 1, copyFile: 1, cpSync: 1, cp: 1,
  symlinkSync: 1, symlink: 1, linkSync: 1, link: 1,
};
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'fs-extra', 'original-fs']);
const PATH_MODULES = new Set(['path', 'node:path']);
const OS_MODULES = new Set(['os', 'node:os']);
/** Past this many possible strings for one path, the scan says so instead of guessing. */
const MAX_STRINGS = 512;
const MAX_CALL_DEPTH = 6;

type Binding = { expr: ts.Expression } | { unknown: true; fallback?: ts.Expression };
type Env = ReadonlyMap<ts.ParameterDeclaration, Binding>;
type Value = { strings: Set<string>; unresolved: Set<ts.ParameterDeclaration> };
type Callable = ts.SignatureDeclaration & { body?: ts.Node };
type Context = { site?: ts.CallExpression; bindings: Map<ts.ParameterDeclaration, Binding> };

export type ScanResult = {
  /** A write call that can write one of the three files, with the calls that lead there. */
  violations: string[];
  /** The helper's calls on the three files: what the scan recognised, as a witness it reads paths at all. */
  helperWrites: Array<{ site: string; file: string }>;
  writeCalls: number;
};

const value = (...strings: string[]): Value => ({ strings: new Set(strings), unresolved: new Set() });

function union(...values: Value[]): Value {
  const out = value();
  for (const v of values) {
    v.strings.forEach(s => out.strings.add(s));
    v.unresolved.forEach(p => out.unresolved.add(p));
  }
  return out;
}

/** Every way of picking one string from each part, combined by `join`. */
function combine(parts: Value[], join: (picked: string[]) => string, where: ts.Node): Value {
  let combos: string[][] = [[]];
  for (const part of parts) {
    const next: string[][] = [];
    for (const combo of combos) for (const s of part.strings) next.push([...combo, s]);
    combos = next;
    if (combos.length > MAX_STRINGS) {
      const sf = where.getSourceFile();
      throw new Error(`too many possible paths at ${sf.fileName}:${sf.getLineAndCharacterOfPosition(where.getStart()).line + 1}`);
    }
  }
  const out = union(...parts);
  out.strings = new Set(combos.map(join));
  return out;
}

const joinPaths = (picked: string[]) => path.posix.normalize(picked.filter(Boolean).join('/'));

function resolvePaths(picked: string[]): string {
  let start = 0;
  picked.forEach((s, i) => { if (s.startsWith('/') || s.startsWith(HOME)) start = i; });
  return joinPaths(picked.slice(start));
}

class WriterScan {
  private readonly sources = new Map<string, ts.SourceFile>();
  private readonly callSites = new Map<ts.Node, ts.CallExpression[]>();
  private readonly escaping = new Set<ts.Node>();
  private readonly evaluating = new Set<ts.Node>();

  constructor(private readonly root: string, files: Map<string, string>) {
    for (const [file, text] of files) {
      const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
      this.sources.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind));
    }
    this.indexCalls();
  }

  run(): ScanResult {
    const violations = new Set<string>();
    const helperWrites: ScanResult['helperWrites'] = [];
    let writeCalls = 0;
    for (const sf of this.sources.values()) {
      const isHelper = path.relative(this.root, sf.fileName) === HELPER_FILE;
      this.walk(sf, node => {
        if (!ts.isCallExpression(node)) return;
        const target = this.writeTarget(node);
        if (target) {
          writeCalls++;
          if (isHelper) return;
          for (const leaf of this.explore(target, new Map(), [node], 0)) {
            for (const s of leaf.strings) {
              const file = CLAUDE_FILES[path.posix.normalize(s)];
              if (file) violations.add(`${this.chain(leaf.chain)} writes ${file}`);
            }
          }
        } else if (this.isHelperCall(node) && node.arguments[0]) {
          for (const leaf of this.explore(node.arguments[0], new Map(), [node], 0)) {
            for (const s of leaf.strings) {
              const file = CLAUDE_FILES[path.posix.normalize(s)];
              if (file) helperWrites.push({ site: this.chain(leaf.chain), file });
            }
          }
        }
      });
    }
    return { violations: [...violations].sort(), helperWrites, writeCalls };
  }

  // ── What a call writes ────────────────────────────────────────────────────

  /** The path argument of an fs call that writes one, or undefined. */
  private writeTarget(call: ts.CallExpression): ts.Expression | undefined {
    const api = this.fsFunction(call.expression);
    if (!api || !(api in WRITE_CALLS)) return undefined;
    if (api === 'open' || api === 'openSync') {
      const flags = call.arguments[1];
      if (!flags || (ts.isStringLiteral(flags) && !/[wax+]/.test(flags.text))) return undefined;
    }
    const target = call.arguments[WRITE_CALLS[api]];
    return target && !ts.isSpreadElement(target) ? target : undefined;
  }

  /** `fs.x`, `fs.promises.x`, or a function imported from fs by name: its name. */
  private fsFunction(callee: ts.Expression): string | undefined {
    if (ts.isPropertyAccessExpression(callee)) {
      let owner = callee.expression;
      if (ts.isPropertyAccessExpression(owner) && owner.name.text === 'promises') owner = owner.expression;
      return ts.isIdentifier(owner) && this.moduleNamespace(owner, FS_MODULES) ? callee.name.text : undefined;
    }
    if (ts.isIdentifier(callee)) {
      const imported = this.importedFrom(callee);
      return imported && FS_MODULES.has(imported.module) ? imported.name : undefined;
    }
    return undefined;
  }

  private isHelperCall(call: ts.CallExpression): boolean {
    const fn = this.callableOf(call.expression);
    return !!fn && ts.isFunctionDeclaration(fn) && fn.name?.text === HELPER
      && path.relative(this.root, fn.getSourceFile().fileName) === HELPER_FILE;
  }

  // ── Following parameters to their callers ─────────────────────────────────

  private explore(target: ts.Expression, env: Env, chain: ts.Node[], depth: number): Array<{ chain: ts.Node[]; strings: Set<string> }> {
    const v = this.evaluate(target, env);
    const param = [...v.unresolved][0];
    if (!param || depth >= MAX_CALL_DEPTH) return [{ chain, strings: v.strings }];
    const fn = param.parent as Callable;
    const leaves: Array<{ chain: ts.Node[]; strings: Set<string> }> = [];
    for (const context of this.contextsOf(fn)) {
      const next = new Map(env);
      context.bindings.forEach((b, p) => next.set(p, b));
      leaves.push(...this.explore(target, next, [...chain, context.site ?? fn], depth + 1));
    }
    return leaves;
  }

  private contextsOf(fn: Callable): Context[] {
    const contexts: Context[] = (this.callSites.get(fn) ?? []).map(site => {
      const bindings = new Map<ts.ParameterDeclaration, Binding>();
      fn.parameters.forEach((p, i) => {
        const arg = site.arguments[i];
        if (p.dotDotDotToken || (arg && ts.isSpreadElement(arg))) bindings.set(p, { unknown: true });
        else if (arg && !(ts.isIdentifier(arg) && arg.text === 'undefined')) bindings.set(p, { expr: arg });
        else if (p.initializer) bindings.set(p, { expr: p.initializer });
        else bindings.set(p, { unknown: true });
      });
      return { site, bindings };
    });
    if (this.hasUnknownCallers(fn)) {
      contexts.push({ bindings: new Map(fn.parameters.map(p => [p, { unknown: true, fallback: p.initializer }] as const)) });
    }
    return contexts;
  }

  /** Callers the index cannot list: a method, a callback, an export, or a function passed around. */
  private hasUnknownCallers(fn: Callable): boolean {
    if (ts.isFunctionDeclaration(fn)) return this.isExported(fn) || this.escaping.has(fn);
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent)) {
      return this.isExported(fn.parent.parent.parent) || this.escaping.has(fn);
    }
    return true;
  }

  private isExported(node: ts.Node): boolean {
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
    const name = ts.isFunctionDeclaration(node) ? node.name?.text
      : ts.isVariableStatement(node) ? node.declarationList.declarations.map(d => (ts.isIdentifier(d.name) ? d.name.text : '')).join(' ') : undefined;
    if (!name) return false;
    return node.getSourceFile().statements.some(st => ts.isExportDeclaration(st) && !st.moduleSpecifier
      && !!st.exportClause && ts.isNamedExports(st.exportClause)
      && st.exportClause.elements.some(el => name.split(' ').includes((el.propertyName ?? el.name).text)));
  }

  private indexCalls(): void {
    const callableNames = new Set<string>();
    for (const sf of this.sources.values()) {
      this.walk(sf, node => {
        if (ts.isFunctionDeclaration(node) && node.name) callableNames.add(node.name.text);
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
          && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) callableNames.add(node.name.text);
      });
    }
    for (const sf of this.sources.values()) {
      this.walk(sf, node => {
        if (ts.isCallExpression(node)) {
          const fn = this.callableOf(node.expression);
          if (fn) this.callSites.set(fn, [...(this.callSites.get(fn) ?? []), node]);
        } else if (ts.isIdentifier(node) && callableNames.has(node.text)) {
          const parent = node.parent;
          const isCallee = ts.isCallExpression(parent) && parent.expression === node;
          const isDeclarationName = (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) && parent.name === node;
          const isImportOrExport = ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)
            || ts.isBindingElement(parent);
          const isOtherName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
            || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node)
            || ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent);
          if (isCallee || isDeclarationName || isImportOrExport || isOtherName) return;
          const fn = this.callableOf(node);
          if (fn) this.escaping.add(fn);
        }
      });
    }
  }

  // ── Values ────────────────────────────────────────────────────────────────

  private evaluate(node: ts.Expression, env: Env): Value {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return value(node.text);
    if (ts.isTemplateExpression(node)) {
      const parts: Value[] = [value(node.head.text)];
      for (const span of node.templateSpans) parts.push(this.evaluate(span.expression, env), value(span.literal.text));
      return combine(parts, picked => picked.join(''), node);
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isAwaitExpression(node)) {
      return this.evaluate(node.expression, env);
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) return combine([this.evaluate(node.left, env), this.evaluate(node.right, env)], p => p.join(''), node);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return union(this.evaluate(node.left, env), this.evaluate(node.right, env));
      if (op === ts.SyntaxKind.EqualsToken) return this.evaluate(node.right, env);
      return value(ANY);
    }
    if (ts.isConditionalExpression(node)) return union(this.evaluate(node.whenTrue, env), this.evaluate(node.whenFalse, env));
    if (ts.isIdentifier(node)) return this.identifierValue(node, env);
    if (ts.isPropertyAccessExpression(node)) return this.propertyValue(node, env);
    if (ts.isCallExpression(node)) return this.callValue(node, env);
    return value(ANY);
  }

  private identifierValue(id: ts.Identifier, env: Env): Value {
    const decl = this.declarationOf(id.text, id);
    if (!decl) return value(ANY);
    if (ts.isParameter(decl)) {
      const binding = env.get(decl);
      if (!binding) {
        const out = value(ANY);
        out.unresolved.add(decl);
        return decl.initializer ? union(out, this.guarded(decl, () => this.evaluate(decl.initializer!, env))) : out;
      }
      if ('expr' in binding) return this.guarded(decl, () => this.evaluate(binding.expr, env));
      return binding.fallback ? union(value(ANY), this.guarded(decl, () => this.evaluate(binding.fallback!, env))) : value(ANY);
    }
    return this.declarationValue(decl, env);
  }

  private declarationValue(decl: ts.Node, env: Env): Value {
    const resolved = this.resolveImport(decl);
    if (!resolved) return value(ANY);
    if (ts.isVariableDeclaration(resolved) && resolved.initializer) {
      const init = resolved.initializer;
      const assignments = this.guarded(resolved, () => {
        const out = [this.evaluate(init, env)];
        if (!(resolved.parent.flags & ts.NodeFlags.Const) && ts.isIdentifier(resolved.name)) {
          const name = resolved.name.text;
          this.walk(this.scopeOf(resolved), n => {
            if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)
              && n.left.text === name && this.declarationOf(name, n.left) === resolved) out.push(this.evaluate(n.right, env));
          });
        }
        return union(...out);
      });
      return assignments;
    }
    return value(ANY);
  }

  private propertyValue(access: ts.PropertyAccessExpression, env: Env): Value {
    const owner = access.expression;
    const name = access.name.text;
    if (name === 'HOME' && ts.isPropertyAccessExpression(owner) && owner.name.text === 'env'
      && ts.isIdentifier(owner.expression) && owner.expression.text === 'process') return value(HOME);
    if (owner.kind === ts.SyntaxKind.ThisKeyword) return this.memberValue(access, name, env);
    if (ts.isIdentifier(owner)) {
      const decl = this.declarationOf(owner.text, owner);
      if (decl && ts.isNamespaceImport(decl)) {
        const sourceModule = this.moduleOf(decl.parent.parent);
        const exported = sourceModule && this.exportNamed(sourceModule, name);
        return exported ? this.declarationValue(exported, env) : value(ANY);
      }
      const resolved = decl && this.resolveImport(decl);
      if (resolved && ts.isVariableDeclaration(resolved) && resolved.initializer && ts.isObjectLiteralExpression(resolved.initializer)) {
        const prop = resolved.initializer.properties.find(p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name);
        if (prop && ts.isPropertyAssignment(prop)) return this.evaluate(prop.initializer, env);
      }
    }
    return value(ANY);
  }

  /** `this.name`: the class field's initializer, getter, and every `this.name = ...` in the class. */
  private memberValue(at: ts.Node, name: string, env: Env): Value {
    let cls: ts.Node | undefined = at.parent;
    while (cls && !ts.isClassDeclaration(cls) && !ts.isClassExpression(cls)) cls = cls.parent;
    if (!cls) return value(ANY);
    const found: Value[] = [];
    for (const member of (cls as ts.ClassLikeDeclaration).members) {
      if (!member.name || !ts.isIdentifier(member.name) || member.name.text !== name) continue;
      if (ts.isPropertyDeclaration(member) && member.initializer) found.push(this.guarded(member, () => this.evaluate(member.initializer!, env)));
      if (ts.isGetAccessorDeclaration(member)) found.push(this.returnsOf(member, env));
    }
    this.walk(cls, n => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)
        && n.left.expression.kind === ts.SyntaxKind.ThisKeyword && n.left.name.text === name) found.push(this.evaluate(n.right, env));
    });
    return found.length ? union(...found) : value(ANY);
  }

  private callValue(call: ts.CallExpression, env: Env): Value {
    const callee = call.expression;
    const args = () => call.arguments.map(a => (ts.isSpreadElement(a) ? value(ANY) : this.evaluate(a, env)));
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      const owner = callee.expression;
      if (ts.isIdentifier(owner) && this.moduleNamespace(owner, PATH_MODULES)) {
        if (method === 'join' || method === 'normalize') return combine(args(), joinPaths, call);
        if (method === 'resolve') return combine(args(), resolvePaths, call);
        if (method === 'dirname') return combine(args().slice(0, 1), p => path.posix.dirname(p[0]), call);
        return value(ANY);
      }
      if (method === 'homedir' && ts.isIdentifier(owner) && this.moduleNamespace(owner, OS_MODULES)) return value(HOME);
      if (method === 'getPath' && call.arguments[0] && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === 'home') return value(HOME);
      if (method === 'toString' || method === 'trim' || method === 'normalize') return this.evaluate(owner, env);
      if (method === 'replace' && call.arguments[0] && ts.isRegularExpressionLiteral(call.arguments[0])) {
        const literal = call.arguments[0].text;
        const regex = new RegExp(literal.slice(1, literal.lastIndexOf('/')), literal.slice(literal.lastIndexOf('/') + 1));
        return combine([this.evaluate(owner, env), args()[1] ?? value('')], ([s, r]) => s.replace(regex, r), call);
      }
    }
    if (ts.isIdentifier(callee)) {
      const imported = this.importedFrom(callee);
      if (imported && PATH_MODULES.has(imported.module)) {
        if (imported.name === 'join' || imported.name === 'normalize') return combine(args(), joinPaths, call);
        if (imported.name === 'resolve') return combine(args(), resolvePaths, call);
      }
      if (imported && OS_MODULES.has(imported.module) && imported.name === 'homedir') return value(HOME);
      if (callee.text === 'String' && !this.declarationOf('String', callee)) return args()[0] ?? value('');
    }
    const fn = this.callableOf(callee);
    if (!fn) return value(ANY);
    // Parameters are unique nodes, so the callee's bindings sit beside the
    // caller's, and an argument is evaluated where it is written.
    const bindings = new Map(env);
    fn.parameters.forEach((p, i) => {
      const arg = call.arguments[i];
      if (p.dotDotDotToken || (arg && ts.isSpreadElement(arg))) bindings.set(p, { unknown: true });
      else if (arg && !(ts.isIdentifier(arg) && arg.text === 'undefined')) bindings.set(p, { expr: arg });
      else if (p.initializer) bindings.set(p, { expr: p.initializer });
      else bindings.set(p, { unknown: true });
    });
    return this.guarded(fn, () => this.returnsOf(fn, bindings));
  }

  /** What `fn` can return under `env`, skipping the arms of a `switch` its arguments rule out. */
  private returnsOf(fn: Callable, env: Env): Value {
    if (!fn.body) return value(ANY);
    if (!ts.isBlock(fn.body)) return this.evaluate(fn.body as ts.Expression, env);
    const found: Value[] = [];
    // Which arms are taken can itself depend on a parameter not yet known, and
    // then the caller has to be asked, as it would be for the value itself.
    const dependsOn = new Set<ts.ParameterDeclaration>();
    const visit = (n: ts.Node) => {
      if (n !== fn.body && ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n)) {
        if (n.expression && this.reachable(n, fn, env, dependsOn)) found.push(this.evaluate(n.expression, env));
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
    const out = found.length ? union(...found) : value(ANY);
    dependsOn.forEach(p => out.unresolved.add(p));
    return out;
  }

  private reachable(ret: ts.ReturnStatement, fn: Callable, env: Env, dependsOn: Set<ts.ParameterDeclaration>): boolean {
    for (let n: ts.Node = ret; n !== fn.body; n = n.parent) {
      if (!(ts.isCaseClause(n) || ts.isDefaultClause(n))) continue;
      const sw = n.parent.parent;
      if (!ts.isSwitchStatement(sw) || !ts.isIdentifier(sw.expression)) continue;
      const decl = this.declarationOf(sw.expression.text, sw.expression);
      if (!decl || !ts.isParameter(decl) || !fn.parameters.includes(decl)) continue;
      const v = this.evaluate(sw.expression, env);
      v.unresolved.forEach(p => dependsOn.add(p));
      const known = [...v.strings];
      if (!known.length || v.unresolved.size || known.some(s => s.includes(ANY))) continue;
      const clauses = sw.caseBlock.clauses;
      const labels = (c: ts.CaseOrDefaultClause) => (ts.isCaseClause(c) && ts.isStringLiteral(c.expression) ? c.expression.text : undefined);
      if (clauses.some(c => ts.isCaseClause(c) && labels(c) === undefined)) continue;
      const allLabels = new Set(clauses.map(labels).filter((l): l is string => l !== undefined));
      let reaches = false;
      for (let i = clauses.indexOf(n); i >= 0; i--) {
        const c = clauses[i];
        if (c !== n && c.statements.length > 0) break;
        if (ts.isDefaultClause(c)) reaches ||= known.some(s => !allLabels.has(s));
        else reaches ||= known.includes(labels(c)!);
      }
      if (!reaches) return false;
    }
    return true;
  }

  // ── Names ─────────────────────────────────────────────────────────────────

  /** The declaration `name` refers to at `node`, by lexical scope. */
  private declarationOf(name: string, node: ts.Node): ts.Node | undefined {
    for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
      const statements = (scope as { statements?: ts.NodeArray<ts.Statement> }).statements;
      if (statements) {
        for (const st of statements) {
          const found = this.declaredIn(st, name);
          if (found) return found;
        }
      }
      if (ts.isFunctionLike(scope)) {
        for (const p of scope.parameters) if (ts.isIdentifier(p.name) && p.name.text === name) return p;
      }
      if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope))
        && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
        for (const d of scope.initializer.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d;
      }
    }
    return undefined;
  }

  private declaredIn(st: ts.Statement, name: string): ts.Node | undefined {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) return d;
        if (ts.isObjectBindingPattern(d.name)) {
          for (const el of d.name.elements) if (ts.isIdentifier(el.name) && el.name.text === name) return el;
        }
      }
    }
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === name) return st;
    if (ts.isImportDeclaration(st) && st.importClause && !st.importClause.isTypeOnly) {
      const clause = st.importClause;
      if (clause.name?.text === name) return clause;
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named) && named.name.text === name) return named;
      if (named && ts.isNamedImports(named)) for (const el of named.elements) if (el.name.text === name) return el;
    }
    return undefined;
  }

  /** An import, static or `const { x } = await import('...')`, followed to what it names in this scan. */
  private resolveImport(decl: ts.Node, seen = new Set<ts.Node>()): ts.Node | undefined {
    if (seen.has(decl)) return undefined;
    seen.add(decl);
    if (ts.isImportSpecifier(decl)) {
      const sourceModule = this.moduleOf(decl.parent.parent.parent);
      const exported = sourceModule && this.exportNamed(sourceModule, (decl.propertyName ?? decl.name).text);
      return exported ? this.resolveImport(exported, seen) : undefined;
    }
    if (ts.isBindingElement(decl)) {
      const declaration = decl.parent.parent;
      if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
      let init: ts.Expression = declaration.initializer;
      if (ts.isAwaitExpression(init)) init = init.expression;
      if (!ts.isCallExpression(init) || init.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined;
      const spec = init.arguments[0];
      if (!spec || !ts.isStringLiteral(spec)) return undefined;
      const sourceModule = this.resolveModule(decl.getSourceFile().fileName, spec.text);
      const exported = sourceModule && this.exportNamed(sourceModule, ((decl.propertyName as ts.Identifier | undefined) ?? (decl.name as ts.Identifier)).text);
      return exported ? this.resolveImport(exported, seen) : undefined;
    }
    return decl;
  }

  private exportNamed(sf: ts.SourceFile, name: string, seen = new Set<ts.SourceFile>()): ts.Node | undefined {
    if (seen.has(sf)) return undefined;
    seen.add(sf);
    for (const st of sf.statements) {
      const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      if (exported) {
        const found = this.declaredIn(st, name);
        if (found) return found;
      }
      if (ts.isExportDeclaration(st)) {
        const target = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
          ? this.resolveModule(sf.fileName, st.moduleSpecifier.text) : undefined;
        if (!st.exportClause && target) {
          const found = this.exportNamed(target, name, seen);
          if (found) return found;
        } else if (st.exportClause && ts.isNamedExports(st.exportClause)) {
          const el = st.exportClause.elements.find(e => e.name.text === name);
          if (!el) continue;
          const local = (el.propertyName ?? el.name).text;
          if (target) return this.exportNamed(target, local, seen);
          for (const other of sf.statements) {
            const found = this.declaredIn(other, local);
            if (found) return found;
          }
        }
      }
    }
    return undefined;
  }

  private moduleOf(importDeclaration: ts.Node): ts.SourceFile | undefined {
    if (!ts.isImportDeclaration(importDeclaration) || !ts.isStringLiteral(importDeclaration.moduleSpecifier)) return undefined;
    return this.resolveModule(importDeclaration.getSourceFile().fileName, importDeclaration.moduleSpecifier.text);
  }

  private resolveModule(from: string, spec: string): ts.SourceFile | undefined {
    if (!spec.startsWith('.')) return undefined;
    const base = path.resolve(path.dirname(from), spec);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, 'index.ts')]) {
      const sf = this.sources.get(candidate);
      if (sf) return sf;
    }
    return undefined;
  }

  /** The module an identifier's import names, and the name imported, for a module outside the scan. */
  private importedFrom(id: ts.Identifier): { module: string; name: string } | undefined {
    const decl = this.declarationOf(id.text, id);
    if (!decl) return undefined;
    if (ts.isImportSpecifier(decl) && ts.isStringLiteral(decl.parent.parent.parent.moduleSpecifier)) {
      return { module: decl.parent.parent.parent.moduleSpecifier.text, name: (decl.propertyName ?? decl.name).text };
    }
    return undefined;
  }

  /** Whether an identifier is `import * as x from '<one of modules>'`, a default import of one, or its require. */
  private moduleNamespace(id: ts.Identifier, modules: Set<string>): boolean {
    const decl = this.declarationOf(id.text, id);
    if (!decl) return false;
    if (ts.isNamespaceImport(decl) || ts.isImportClause(decl)) {
      const importDeclaration = ts.isNamespaceImport(decl) ? decl.parent.parent : decl.parent;
      return ts.isStringLiteral(importDeclaration.moduleSpecifier) && modules.has(importDeclaration.moduleSpecifier.text);
    }
    if (ts.isVariableDeclaration(decl) && decl.initializer && ts.isCallExpression(decl.initializer)
      && ts.isIdentifier(decl.initializer.expression) && decl.initializer.expression.text === 'require') {
      const spec = decl.initializer.arguments[0];
      return !!spec && ts.isStringLiteral(spec) && modules.has(spec.text);
    }
    return false;
  }

  /** The function a callee names in this scan: a declaration, a const function, `this.method`, or `ns.export`. */
  private callableOf(callee: ts.Expression): Callable | undefined {
    if (ts.isIdentifier(callee)) {
      const decl = this.declarationOf(callee.text, callee);
      const resolved = decl && this.resolveImport(decl);
      if (!resolved) return undefined;
      if (ts.isFunctionDeclaration(resolved)) return resolved;
      if (ts.isVariableDeclaration(resolved) && resolved.initializer
        && (ts.isArrowFunction(resolved.initializer) || ts.isFunctionExpression(resolved.initializer))) return resolved.initializer;
      return undefined;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const name = callee.name.text;
      if (callee.expression.kind === ts.SyntaxKind.ThisKeyword) {
        let cls: ts.Node | undefined = callee.parent;
        while (cls && !ts.isClassDeclaration(cls) && !ts.isClassExpression(cls)) cls = cls.parent;
        const member = cls && (cls as ts.ClassLikeDeclaration).members.find(m => m.name && ts.isIdentifier(m.name) && m.name.text === name);
        return member && ts.isMethodDeclaration(member) ? member : undefined;
      }
      if (ts.isIdentifier(callee.expression)) {
        const decl = this.declarationOf(callee.expression.text, callee.expression);
        if (decl && ts.isNamespaceImport(decl)) {
          const sourceModule = this.moduleOf(decl.parent.parent);
          const exported = sourceModule && this.exportNamed(sourceModule, name);
          if (exported && ts.isFunctionDeclaration(exported)) return exported;
        }
      }
    }
    return undefined;
  }

  private scopeOf(node: ts.Node): ts.Node {
    let scope: ts.Node = node.parent;
    while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    return scope;
  }

  /** Evaluation that meets itself again (a recursive function, `x = x + 1`) knows nothing more. */
  private guarded(key: ts.Node, run: () => Value): Value {
    if (this.evaluating.has(key)) return value(ANY);
    this.evaluating.add(key);
    try {
      return run();
    } finally {
      this.evaluating.delete(key);
    }
  }

  private walk(node: ts.Node, visit: (n: ts.Node) => void): void {
    visit(node);
    ts.forEachChild(node, child => this.walk(child, visit));
  }

  private chain(nodes: ts.Node[]): string {
    return nodes.map(n => {
      const sf = n.getSourceFile();
      const where = `${path.relative(this.root, sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
      return ts.isCallExpression(n) ? where : `${where} (called from outside the scan)`;
    }).join(' via ');
  }
}

/** Every source file of the product under `root`: the main process and the MCP servers. */
function productSources(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'dist' && entry.name !== 'node_modules') walk(full);
      } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.set(full, fs.readFileSync(full, 'utf-8'));
      }
    }
  };
  walk(path.join(root, 'electron'));
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('mcp-') && fs.existsSync(path.join(root, entry.name, 'src'))) {
      walk(path.join(root, entry.name, 'src'));
    }
  }
  return files;
}

export function scanClaudeFileWriters(root: string, files = productSources(root)): ScanResult {
  return new WriterScan(root, files).run();
}

/** Shell hooks run inside Claude's own sessions and cannot use the helper: none may write these files. */
function hookWrites(dir: string): string[] {
  const found: string[] = [];
  const names = /\.claude\.json|\.claude\/settings\.json|\.claude\/mcp\.json/;
  const writes = /(^|[^0-9&])>>?\s*["']?[^\s"'|;&]*(\.claude\.json|\.claude\/settings\.json|\.claude\/mcp\.json)|\b(tee|mv|cp|ln|install|truncate|dd)\b|\b(sed|perl)\s+(-\w*\s+)*-\w*i/;
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else fs.readFileSync(full, 'utf-8').split('\n').forEach((line, i) => {
        if (names.test(line) && writes.test(line)) found.push(`${path.relative(dir, full)}:${i + 1}`);
      });
    }
  };
  walk(dir);
  return found;
}

const ROOT = process.cwd();

describe("Claude's own files, written only through updateSharedJsonSync", () => {
  const real = scanClaudeFileWriters(ROOT);

  it('no write call in the main process or the MCP servers can write one of them', () => {
    expect(real.violations, `written directly:\n${real.violations.join('\n')}`).toEqual([]);
  });

  it('while the scan does read the paths the product writes', () => {
    // The witness for the check above, on the real tree: an empty list from a
    // scan that resolved no path would look exactly like a clean one. It found
    // the helper's calls on each of the three files, from the files that make
    // them, and at least the helper's own write calls among all the others.
    const byFile = (file: string) => new Set(real.helperWrites.filter(w => w.file === file).map(w => w.site.split(':')[0]));
    expect([...byFile('~/.claude.json')].sort()).toEqual(expect.arrayContaining([
      path.join('electron', 'core', 'agent-manager.ts'),
      path.join('electron', 'services', 'mcp-orchestrator.ts'),
    ]));
    expect([...byFile('~/.claude/settings.json')].sort()).toEqual(expect.arrayContaining([
      path.join('electron', 'handlers', 'ipc-handlers.ts'),
      path.join('electron', 'providers', 'claude-provider.ts'),
      path.join('electron', 'utils', 'statusline.ts'),
    ]));
    const mcpCallers = new Set(real.helperWrites.filter(w => w.file === '~/.claude/mcp.json')
      .flatMap(w => w.site.split(' via ').slice(1).map(s => s.split(':')[0])));
    const providersWritingMcp = [...mcpCallers].filter(f => f.startsWith(path.join('electron', 'providers')));
    // Claude and the thirteen providers that run its binary, each reached
    // through `this.configDir` at its own call.
    expect(providersWritingMcp.length).toBeGreaterThanOrEqual(14);
    expect([...mcpCallers]).toEqual(expect.arrayContaining([
      path.join('electron', 'handlers', 'mcp-config-handlers.ts'),
      path.join('electron', 'services', 'mcp-orchestrator.ts'),
    ]));
    expect(real.writeCalls).toBeGreaterThan(50);
  });

  it('no hook script writes one of them', () => {
    expect(hookWrites(path.join(ROOT, 'hooks'))).toEqual([]);
  });
});

describe('the scan, on planted sources', () => {
  // Resolved, so it names a drive on Windows as every file the imports resolve to does.
  const root = path.resolve('/planted');
  // The sites spelled with `/`, as below, whatever the platform's separator.
  const posix = (site: string) => site.split(path.sep).join('/');
  const scan = (files: Record<string, string>) => {
    const found = scanClaudeFileWriters(root, new Map(Object.entries(files).map(([f, text]) => [path.join(root, f), text])));
    return {
      ...found,
      violations: found.violations.map(posix),
      helperWrites: found.helperWrites.map(w => ({ ...w, site: posix(w.site) })),
    };
  };
  const header = "import * as fs from 'fs';\nimport * as os from 'os';\nimport * as path from 'path';\n";

  it('catches a direct write, a rename onto the file, and a write through fs.promises', () => {
    const { violations } = scan({
      'electron/a.ts': `${header}
export function a() { fs.writeFileSync(path.join(os.homedir(), '.claude', 'settings.json'), '{}'); }
export async function b() { await fs.promises.writeFile(\`\${os.homedir()}/.claude/mcp.json\`, '{}'); }
const CONFIG = path.join(os.homedir(), '.claude.json');
export function c() { fs.renameSync('/tmp/next', CONFIG); }
export function notThese() {
  fs.writeFileSync(path.join(os.homedir(), '.claude', 'settings.local.json'), '{}');
  fs.writeFileSync(path.join(os.homedir(), '.claude.json.backup'), '{}');
  fs.writeFileSync('/work/project/.claude/settings.json', '{}');
  fs.renameSync(CONFIG, '/tmp/elsewhere');
}
`,
    });
    expect(violations).toEqual([
      'electron/a.ts:5 writes ~/.claude/settings.json',
      'electron/a.ts:6 writes ~/.claude/mcp.json',
      'electron/a.ts:8 writes ~/.claude.json',
    ]);
  });

  it('follows constants across modules, named imports of fs, and this.configDir', () => {
    const { violations } = scan({
      'electron/constants.ts': "import * as os from 'os';\nimport * as path from 'path';\nexport const CLAUDE_DIR = path.join(os.homedir(), '.claude');\n",
      'electron/provider.ts': `import { writeFileSync } from 'node:fs';
import * as path from 'path';
import { CLAUDE_DIR } from './constants';
export class Provider {
  readonly configDir = CLAUDE_DIR;
  register() { const file = path.join(this.configDir, 'mcp.json'); writeFileSync(file, '{}'); }
}
`,
    });
    expect(violations).toEqual(['electron/provider.ts:6 writes ~/.claude/mcp.json']);
  });

  it('follows a switch on an argument, and only into the arms the argument reaches', () => {
    const { violations } = scan({
      'electron/handlers.ts': `${header}
function configPath(provider: string): string {
  switch (provider) {
    case 'claude':
    case 'minimax': return path.join(os.homedir(), '.claude', 'mcp.json');
    case 'gemini': return path.join(os.homedir(), '.gemini', 'settings.json');
    default: throw new Error(provider);
  }
}
function writeToml(provider: string = 'codex') { fs.writeFileSync(configPath(provider), 'x'); }
function writeGemini() { fs.writeFileSync(configPath('gemini'), '{}'); }
function writeMinimax() { fs.writeFileSync(configPath('minimax'), '{}'); }
export function run() { writeToml(); writeToml('grok'); writeGemini(); writeMinimax(); }
`,
    });
    expect(violations).toEqual(['electron/handlers.ts:15 writes ~/.claude/mcp.json']);
  });

  it('follows a path handed to a wrapper, to the call that hands it, through a dynamic import', () => {
    const { violations } = scan({
      'electron/utils/atomic.ts': `${header}
export function writeAtomic(file: string, text: string) { fs.writeFileSync(\`\${file}.tmp\`, text); fs.renameSync(\`\${file}.tmp\`, file); }
`,
      'electron/feature.ts': `${header}
export async function save() {
  const { writeAtomic } = await import('./utils/atomic');
  writeAtomic(path.join(os.homedir(), '.claude', 'settings.json'), '{}');
  writeAtomic(path.join(os.homedir(), '.tars', 'settings.json'), '{}');
}
`,
    });
    expect(violations).toEqual(['electron/utils/atomic.ts:5 via electron/feature.ts:7 writes ~/.claude/settings.json']);
  });

  it('exempts the helper, and nothing else', () => {
    const { violations, helperWrites } = scan({
      'electron/utils/shared-file.ts': `${header}
export function updateSharedJsonSync(filePath: string) { fs.writeFileSync(\`\${filePath}.tars.tmp\`, '{}'); fs.renameSync(\`\${filePath}.tars.tmp\`, filePath); }
`,
      'electron/utils/statusline.ts': `${header}
import { updateSharedJsonSync } from './shared-file';
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
export function enable() { updateSharedJsonSync(SETTINGS); }
export function enableTheOldWay() { fs.writeFileSync(SETTINGS, '{}'); }
`,
    });
    expect(violations).toEqual(['electron/utils/statusline.ts:8 writes ~/.claude/settings.json']);
    expect(helperWrites).toEqual([{ site: 'electron/utils/statusline.ts:7', file: '~/.claude/settings.json' }]);
  });

  it('catches a hook that writes one of them, and not one that reads it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hook-scan-'));
    try {
      fs.writeFileSync(path.join(dir, 'reads.sh'), 'jq -r .model "$HOME/.claude/settings.json" 2>/dev/null\n');
      fs.writeFileSync(path.join(dir, 'writes.sh'), '#!/bin/bash\njq \'.x = 1\' "$HOME/.claude/settings.json" > "$HOME/.claude/settings.json"\nmv /tmp/x ~/.claude.json\n');
      expect(hookWrites(dir)).toEqual(['writes.sh:2', 'writes.sh:3']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
