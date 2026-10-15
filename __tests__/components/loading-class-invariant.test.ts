import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * No page or panel waits on grey rows or on a line of text (1.7.4).
 *
 * JeanBrasse: "on several pages the loading screen was not the cube we had". The
 * ladder's middle stage defaulted to skeleton rows, and the same class lived
 * outside it: the Dashboard pane's history view drew its own grey bars, the
 * Hermes task detail said "Loading…", the custom MCP list was a row reading
 * "Loading servers…", and the agent window's Git chip read "loading...". Every
 * wait in the app is the mark now.
 *
 * This holds the class, not the sites. It lists no files: every .ts and .tsx
 * under src/ is parsed, and three shapes are looked for in the syntax tree.
 *
 * - skeleton: `SkeletonRows` anywhere, or a `variant` of 'skeleton'.
 * - grey rows: an element hidden from assistive tech (`aria-hidden`) holding
 *   two or more empty bars filled `bg-secondary` or `bg-muted`, a bar inside a
 *   `.map` counting as many. That is what a skeleton is: a shape with no words.
 * - text wait: a branch shown while something loads that says something and
 *   holds no mark (BrandSpinner, LoadingPanel, LoadingState, SlowOperation);
 *   and "loading", "Loading..." or "Loading…" standing alone as a value.
 *   "While something loads" is read from the condition: a name with `loading`
 *   in it (`detailLoading`, `isLoading`), the negation of one with `loaded`
 *   (`!workspacesLoaded`), a comparison with 'loading', and their &&, || and !.
 *   The branch is the element after `&&`, the side of a `?:` the condition
 *   selects, or what an `if` returns.
 *
 * What stays in words on purpose is not flagged, by shape rather than by name:
 * a label inside a button while its own action runs ("loading" on "load
 * older"), a placeholder attribute, and a string standing in for a value
 * inside a row ("looking…", "checking"), because only a JSX branch replaces
 * content. A wait conditioned on anything else (`!data`) is out of reach, and
 * so is a skeleton that is not hidden from assistive tech: the history of this
 * class had neither.
 *
 * Witnesses: planted sources below hold each shape and each exemption, the
 * real tree must yield loading branches with the mark (so an empty walk cannot
 * pass), and on the tree before #105 the scan finds by itself the six sites
 * that pull request fixed.
 */

export type Rule = 'skeleton' | 'grey-rows' | 'text-wait';
export interface Finding { rule: Rule; at: string; what: string }
export interface Scan { findings: Finding[]; files: number; loadingBranches: number; loadingBranchesWithMark: number }

const MARKS = new Set(['BrandSpinner', 'LoadingPanel', 'LoadingState', 'SlowOperation']);
const BUTTONS = new Set(['button', 'Button']);
const VISIBLE_PROPS = new Set(['label', 'title', 'what', 'description', 'message', 'body', 'text']);
const LOADING_VALUE = /^loading(\.\.\.|…)?$/i;
const BAR_FILLS = ['bg-secondary', 'bg-muted'];

type OpeningLike = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

const unwrap = (e: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
};

const tagOf = (el: OpeningLike) => el.tagName.getText();

function openingOf(n: ts.Node): OpeningLike | undefined {
  if (ts.isJsxElement(n)) return n.openingElement;
  if (ts.isJsxSelfClosingElement(n)) return n;
  return undefined;
}

const isJsx = (e: ts.Expression) => {
  const u = unwrap(e);
  return ts.isJsxElement(u) || ts.isJsxSelfClosingElement(u) || ts.isJsxFragment(u);
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** 1 while loading, -1 once loaded, 0 when the condition says nothing about it. */
function polarity(expr: ts.Expression): 1 | -1 | 0 {
  const e = unwrap(expr);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    return (-polarity(e.operand) || 0) as 1 | -1 | 0;
  }
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
    const name = ts.isIdentifier(e) ? e.text : e.name.text;
    if (/loaded$/i.test(name)) return -1;
    if (/loading/i.test(name)) return 1;
    return 0;
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    const a = polarity(e.left);
    const b = polarity(e.right);
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return a < 0 || b < 0 ? -1 : a > 0 || b > 0 ? 1 : 0;
    if (op === ts.SyntaxKind.BarBarToken) return a > 0 || b > 0 ? 1 : a < 0 && b < 0 ? -1 : 0;
    const equality = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken];
    const inequality = [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken];
    const literal = [unwrap(e.left), unwrap(e.right)].find(ts.isStringLiteral);
    if (literal && /^loading$/i.test(literal.text)) {
      if (equality.includes(op)) return 1;
      if (inequality.includes(op)) return -1;
    }
  }
  return 0;
}

function insideButton(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n; p; p = p.parent) {
    const opening = openingOf(p);
    if (opening && BUTTONS.has(tagOf(opening))) return true;
    if (ts.isFunctionLike(p)) return false;
  }
  return false;
}

function stringsOf(expr: ts.Expression, out: string[]): void {
  const e = unwrap(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) out.push(e.text);
  else if (ts.isTemplateExpression(e)) out.push([e.head.text, ...e.templateSpans.map(s => s.literal.text)].join(' '));
  else if (ts.isConditionalExpression(e)) { stringsOf(e.whenTrue, out); stringsOf(e.whenFalse, out); }
  else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) stringsOf(e.right, out);
  else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) { stringsOf(e.left, out); stringsOf(e.right, out); }
}

/** The words a JSX branch puts on screen, leaving out what sits inside a button. */
function wordsOf(branch: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    const opening = openingOf(n);
    if (opening && BUTTONS.has(tagOf(opening))) return;
    if (ts.isJsxText(n)) {
      const t = n.text.trim();
      if (/\p{L}/u.test(t)) out.push(t);
      return;
    }
    if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      stringsOf(n.expression, out);
    }
    if (ts.isJsxAttribute(n) && n.initializer && VISIBLE_PROPS.has(n.name.getText())) {
      const owner = n.parent.parent as OpeningLike;
      if (/^[A-Z]/.test(tagOf(owner))) {
        if (ts.isStringLiteral(n.initializer)) out.push(n.initializer.text);
        else if (ts.isJsxExpression(n.initializer) && n.initializer.expression) stringsOf(n.initializer.expression, out);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(branch);
  return out.filter(w => /\p{L}/u.test(w));
}

function holdsMark(branch: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    const opening = ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n) ? n : undefined;
    if (opening && MARKS.has(tagOf(opening))) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(branch);
  return found;
}

function classTokens(el: OpeningLike): string[] {
  const attr = el.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === 'className',
  );
  if (!attr?.initializer) return [];
  const texts: string[] = [];
  if (ts.isStringLiteral(attr.initializer)) texts.push(attr.initializer.text);
  else if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
    const e = unwrap(attr.initializer.expression);
    if (ts.isCallExpression(e)) e.arguments.forEach(arg => stringsOf(arg, texts));
    else stringsOf(e, texts);
  }
  return texts.join(' ').split(/\s+/).filter(Boolean);
}

function isAriaHidden(el: OpeningLike): boolean {
  const attr = el.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === 'aria-hidden',
  );
  if (!attr) return false;
  if (!attr.initializer) return true;
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text !== 'false';
  const e = ts.isJsxExpression(attr.initializer) && attr.initializer.expression ? unwrap(attr.initializer.expression) : undefined;
  return !(e && e.kind === ts.SyntaxKind.FalseKeyword);
}

function isEmptyBar(n: ts.Node): boolean {
  const opening = openingOf(n);
  if (!opening) return false;
  if (ts.isJsxElement(n) && n.children.some(c => !(ts.isJsxText(c) && c.text.trim() === ''))) return false;
  const tokens = classTokens(opening);
  return BAR_FILLS.some(fill => tokens.includes(fill));
}

/** Empty bars under a node, a bar drawn inside `.map` or `Array.from` counting as many. */
function barsUnder(root: ts.Node): number {
  let count = 0;
  const visit = (n: ts.Node, repeated: boolean): void => {
    if (n !== root && isEmptyBar(n)) count += repeated ? 2 : 1;
    const repeats = ts.isCallExpression(n) && (
      (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'map')
      || n.expression.getText() === 'Array.from'
    );
    ts.forEachChild(n, c => visit(c, repeated || repeats));
  };
  visit(root, false);
  return count;
}

export function scanLoadingWaits(srcRoot: string): Scan {
  const findings: Finding[] = [];
  let loadingBranches = 0;
  let loadingBranchesWithMark = 0;
  const files = sourceFiles(srcRoot);

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    // The file spelled with `/` on every platform, so a finding reads the same everywhere.
    const at = (n: ts.Node) => `${path.relative(srcRoot, file).split(path.sep).join('/')}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const flag = (rule: Rule, n: ts.Node, what: string) => findings.push({ rule, at: at(n), what });

    const branch = (b: ts.Expression | ts.Statement | undefined, site: ts.Node) => {
      if (!b) return;
      let body: ts.Node | undefined = b;
      if (ts.isBlock(b)) body = b.statements.find(ts.isReturnStatement)?.expression;
      else if (ts.isReturnStatement(b)) body = b.expression;
      if (!body || !ts.isExpression(body as ts.Node) || !isJsx(body as ts.Expression)) return;
      loadingBranches++;
      if (holdsMark(body)) { loadingBranchesWithMark++; return; }
      if (insideButton(site)) return;
      const words = wordsOf(body);
      if (words.length) flag('text-wait', body, words.join(' | '));
    };

    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === 'SkeletonRows') flag('skeleton', n, 'SkeletonRows');
      if (ts.isStringLiteral(n) && n.text === 'skeleton') {
        const p = n.parent;
        const named = (id: ts.Node | undefined) => id?.getText() === 'variant';
        if ((ts.isJsxAttribute(p) && named(p.name)) || (ts.isBindingElement(p) && named(p.name))
          || (ts.isParameter(p) && named(p.name)) || (ts.isBinaryExpression(p) && named(p.left))) {
          flag('skeleton', n, "variant 'skeleton'");
        }
      }

      const opening = ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n) ? n : undefined;
      if (opening && isAriaHidden(opening)) {
        const element = ts.isJsxOpeningElement(opening) ? opening.parent : opening;
        const bars = barsUnder(element);
        if (bars >= 2) flag('grey-rows', element, `${tagOf(opening)} aria-hidden over ${bars}+ empty bars`);
      }

      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        && isJsx(n.right) && polarity(n.left) > 0) {
        branch(n.right, n);
      }
      if (ts.isConditionalExpression(n)) {
        const p = polarity(n.condition);
        if (p > 0) branch(n.whenTrue, n);
        if (p < 0) branch(n.whenFalse, n);
      }
      if (ts.isIfStatement(n) && polarity(n.expression) > 0) branch(n.thenStatement, n);

      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && LOADING_VALUE.test(n.text.trim())) {
        const container = n.parent;
        let expr: ts.Node = n;
        while (expr.parent && (ts.isParenthesizedExpression(expr.parent) || ts.isConditionalExpression(expr.parent)
          || (ts.isBinaryExpression(expr.parent) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(expr.parent.operatorToken.kind)))) {
          expr = expr.parent;
        }
        const child = expr.parent && ts.isJsxExpression(expr.parent) && (ts.isJsxElement(expr.parent.parent) || ts.isJsxFragment(expr.parent.parent));
        if (child && !insideButton(container)) flag('text-wait', n, n.text);
      }
      if (ts.isJsxText(n) && LOADING_VALUE.test(n.text.trim()) && !insideButton(n)) flag('text-wait', n, n.text.trim());

      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  const unique = new Map(findings.map(f => [`${f.rule} ${f.at}`, f]));
  return { findings: [...unique.values()], files: files.length, loadingBranches, loadingBranchesWithMark };
}

const REPO = path.resolve(__dirname, '..', '..');
const planted: string[] = [];

function plant(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loading-class-'));
  planted.push(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

afterAll(() => {
  for (const dir of planted) fs.rmSync(dir, { recursive: true, force: true });
});

const describeFindings = (s: Scan) => s.findings.map(f => `${f.rule} ${f.at} ${f.what}`).join('\n');

// Each case below parses all of src/ with the TypeScript compiler: measured on
// 2026-09-28 over 28 runs of the full suite on a loaded machine, 0.4 s to 16 s
// a case, and past vitest's 5 s default in 15 of 56, which failed a gate half
// the time with nothing wrong in the tree.
describe('no page or panel waits on grey rows or on a line of text', { timeout: 60_000 }, () => {
  it('holds on the real tree', () => {
    const scan = scanLoadingWaits(path.join(REPO, 'src'));
    expect(scan.findings, describeFindings(scan)).toEqual([]);
  });

  it('reads the real tree, and finds its waits drawn with the mark', () => {
    const scan = scanLoadingWaits(path.join(REPO, 'src'));
    expect(scan.files).toBeGreaterThan(200);
    expect(scan.loadingBranches).toBeGreaterThanOrEqual(15);
    expect(scan.loadingBranchesWithMark).toBeGreaterThanOrEqual(15);
  });
});

describe('the scan, on planted sources', () => {
  const rules = (dir: string) => scanLoadingWaits(dir).findings.map(f => `${f.rule} ${f.at}`);

  it('finds the skeleton component and a skeleton variant', () => {
    const dir = plant({
      'ui/Loading.tsx': [
        "export function SkeletonRows() { return null; }",
        "export function LoadingState({ variant = 'skeleton' }: { variant?: string }) { return null; }",
      ].join('\n'),
      'page.tsx': "export const P = () => <LoadingState loading variant=\"skeleton\" what=\"x\" />;",
    });
    expect(rules(dir)).toEqual(['skeleton page.tsx:1', 'skeleton ui/Loading.tsx:1', 'skeleton ui/Loading.tsx:2']);
  });

  it('finds grey rows hidden from assistive tech, drawn in a map or one by one', () => {
    const dir = plant({
      'History.tsx': [
        'export function Skeleton() {',
        '  return (',
        '    <div aria-hidden>',
        "      {['62%', '84%'].map(w => (",
        '        <div key={w}><span className="h-2 w-8 bg-secondary" /><span className="h-2 bg-secondary" style={{ width: w }} /></div>',
        '      ))}',
        '    </div>',
        '  );',
        '}',
        'export const Two = () => <div aria-hidden="true"><div className="h-2 bg-muted" /><div className="h-1.5 bg-muted"></div></div>;',
        'export const Rows = () => <div aria-hidden>{[1, 2, 3].map(i => <div key={i} className="h-3 bg-secondary" />)}</div>;',
      ].join('\n'),
    });
    expect(rules(dir)).toEqual(['grey-rows History.tsx:3', 'grey-rows History.tsx:10', 'grey-rows History.tsx:11']);
  });

  it('leaves a single decorative bar, a filled meter and an aria-hidden glyph alone', () => {
    const dir = plant({
      'Meter.tsx': [
        'export const Glyph = () => <span aria-hidden>···</span>;',
        'export const Track = () => <div aria-hidden className="h-1.5 bg-secondary"><div className="h-full bg-primary" /></div>;',
        'export const One = () => <div aria-hidden><div className="h-2 bg-secondary" /></div>;',
        'export const Hover = () => <div aria-hidden><i className="hover:bg-secondary" /><i className="hover:bg-secondary" /></div>;',
      ].join('\n'),
    });
    expect(rules(dir)).toEqual([]);
  });

  it('finds a wait that is only words, whatever shape its condition takes', () => {
    const dir = plant({
      'Waits.tsx': [
        'export function A({ detailLoading }: { detailLoading: boolean }) {',
        '  return <div>{detailLoading && <p className="text-xs">Loading…</p>}</div>;',
        '}',
        'export function B({ loading, servers }: { loading: boolean; servers: string[] }) {',
        '  return <div>{loading && servers.length === 0 && <SettingsRow label="Reading servers" />}</div>;',
        '}',
        'export function C({ fleetLoaded }: { fleetLoaded: boolean }) {',
        '  return <div>{fleetLoaded ? <List /> : <p>Still reading your agents</p>}</div>;',
        '}',
        'export function D({ isLoading }: { isLoading: boolean }) {',
        '  if (isLoading) return <p>Fetching the board</p>;',
        '  return <List />;',
        '}',
        "export function E({ state }: { state: string }) {",
        "  return <div>{state === 'loading' ? <span>Please wait</span> : <List />}</div>;",
        '}',
        'export const F = ({ branch }: { branch?: string }) => <span className="chip">{branch || \'loading...\'}</span>;',
      ].join('\n'),
    });
    expect(rules(dir)).toEqual([
      'text-wait Waits.tsx:2',
      'text-wait Waits.tsx:5',
      'text-wait Waits.tsx:8',
      'text-wait Waits.tsx:11',
      'text-wait Waits.tsx:15',
      'text-wait Waits.tsx:17',
    ]);
  });

  it('leaves the mark, button labels, placeholders and values standing in a row alone', () => {
    const dir = plant({
      'Fine.tsx': [
        'export function A({ loading }: { loading: boolean }) {',
        '  return <div>{loading && <div><BrandSpinner size={30} label="Loading projects" /><p>Loading projects</p></div>}</div>;',
        '}',
        'export function B({ loading }: { loading: boolean }) {',
        '  return <div>{loading && <SettingsRow label="Reading your MCP servers" control={<BrandSpinner size={26} />} />}</div>;',
        '}',
        'export function C({ loadingOlder }: { loadingOlder: boolean }) {',
        "  return <button type=\"button\">{loadingOlder ? 'loading' : 'load older'}</button>;",
        '}',
        'export function D({ loadingMore }: { loadingMore: boolean }) {',
        '  return <Button>{loadingMore ? (<><BrandSpinner size={14} />Loading</>) : \'Load more\'}</Button>;',
        '}',
        "export const E = ({ loading }: { loading: boolean }) => <input placeholder={loading ? 'loading…' : 'default'} />;",
        "export const F = ({ loadingModels }: { loadingModels: boolean }) => <span>{loadingModels ? 'looking…' : 'none detected'}</span>;",
        'export function G({ loading }: { loading: boolean }) {',
        '  return <div>{!loading && <p>No agent has a working tree yet.</p>}</div>;',
        '}',
        'export const H = ({ loading }: { loading: boolean }) => <LoadingState loading={loading} what="Still reading the working tree" />;',
      ].join('\n'),
    });
    expect(rules(dir)).toEqual([]);
  });
});
