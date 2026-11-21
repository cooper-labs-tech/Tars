import '../setup/home-guard';
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import type { Terminal } from 'xterm';
import { passWheelToProgram, stopWheelTyping, suppressMouseTracking } from '@/lib/terminal';

/**
 * The wheel over a terminal typed arrow keys into the program running in it.
 *
 * xterm 5.3 converts wheel travel over a buffer with no history into `ESC [ A`
 * and `ESC [ B`, through onData like a keystroke, and at Claude Code's prompt
 * those arrows walked back through the messages already sent.
 * `stopWheelTyping` stops the wheel on the terminal's element before xterm's
 * own listener sees it.
 *
 * A terminal that hosts a full-screen CLI goes one step further with
 * `passWheelToProgram`: Claude Code keeps its conversation itself on the
 * alternate screen and scrolls it on wheel reports, so the wheel it asked for is
 * sent to it as SGR reports, and nothing else of the mouse is.
 *
 * That the arrows really stop, that the reports really arrive, and that the keys
 * and the history still work, is proven in the app by e2e/terminal-wheel.spec.ts
 * and e2e/terminal-wheel-reports.spec.ts: xterm's own conversion needs a
 * measured row height, so a test with no layout sees no arrows with or without
 * the guard. What is held here is what can be held without a document: the
 * conditions the guards apply, and that every terminal in src applies the right
 * one.
 */

type WheelListener = (event: WheelEvent) => void;

function stubTerminal({ buffer = 'normal', scrollback }: { buffer?: 'normal' | 'alternate'; scrollback?: number } = {}) {
  const added: Array<{ type: string; listener: WheelListener; options: unknown }> = [];
  const term = {
    element: {
      addEventListener: (type: string, listener: WheelListener, options: unknown) => { added.push({ type, listener, options }); },
    },
    buffer: { active: { type: buffer } },
    options: scrollback === undefined ? {} : { scrollback },
  };
  const wheel = () => {
    const event = { preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), stopPropagation: vi.fn() };
    for (const entry of added) if (entry.type === 'wheel') entry.listener(event as unknown as WheelEvent);
    return event;
  };
  return { term: term as unknown as Terminal, added, wheel };
}

describe('stopWheelTyping', () => {
  it('listens on the terminal element in the capture phase, ahead of xterm, and may cancel', () => {
    const { term, added } = stubTerminal();
    stopWheelTyping(term);

    expect(added).toHaveLength(1);
    expect(added[0].type).toBe('wheel');
    expect(added[0].options).toMatchObject({ capture: true, passive: false });
  });

  it('stops the wheel over the alternate screen, where xterm would turn it into arrows', () => {
    const { term, wheel } = stubTerminal({ buffer: 'alternate', scrollback: 10000 });
    stopWheelTyping(term);

    const event = wheel();
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
    // And the page does not scroll in its place.
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('stops it over a main buffer that keeps no history, which xterm converts the same way', () => {
    const { term, wheel } = stubTerminal({ buffer: 'normal', scrollback: 0 });
    stopWheelTyping(term);

    expect(wheel().stopImmediatePropagation).toHaveBeenCalled();
  });

  it('leaves it to xterm over a main buffer with history, where the wheel scrolls it', () => {
    for (const scrollback of [1, 10000, undefined]) {
      const { term, wheel } = stubTerminal({ buffer: 'normal', scrollback });
      stopWheelTyping(term);

      const event = wheel();
      expect(event.stopImmediatePropagation, `scrollback ${scrollback}`).not.toHaveBeenCalled();
      expect(event.stopPropagation, `scrollback ${scrollback}`).not.toHaveBeenCalled();
      expect(event.preventDefault, `scrollback ${scrollback}`).not.toHaveBeenCalled();
    }
  });

  it('reads the buffer when the wheel turns, not when the terminal opened', () => {
    // A CLI takes the alternate screen after the terminal exists, and leaves it.
    const { term, wheel } = stubTerminal({ buffer: 'normal', scrollback: 1000 });
    stopWheelTyping(term);

    (term.buffer.active as { type: string }).type = 'alternate';
    expect(wheel().stopImmediatePropagation).toHaveBeenCalled();
    (term.buffer.active as { type: string }).type = 'normal';
    expect(wheel().stopImmediatePropagation).not.toHaveBeenCalled();
  });
});

/** A terminal for passWheelToProgram: a parser to print requests into, a screen to point at, a wheel to turn. */
function cliTerminal({ buffer = 'alternate', scrollback = 1000 }: { buffer?: 'normal' | 'alternate'; scrollback?: number } = {}) {
  type CsiParams = (number | number[])[];
  const csi: Array<{ final: string; handler: (params: CsiParams) => boolean }> = [];
  const esc: Array<{ final: string; handler: () => boolean }> = [];
  const wheelListeners: WheelListener[] = [];
  const options: unknown[] = [];
  // 100 columns of 8px and 24 rows of 20px, 10px from the left and 20px from the top.
  const screen = { left: 10, top: 20, width: 800, height: 480 };
  const term = {
    parser: {
      registerCsiHandler: (id: { final: string }, handler: (params: CsiParams) => boolean) => {
        csi.push({ final: id.final, handler });
        return { dispose: () => {} };
      },
      registerEscHandler: (id: { final: string }, handler: () => boolean) => {
        esc.push({ final: id.final, handler });
        return { dispose: () => {} };
      },
    },
    element: {
      addEventListener: (type: string, listener: WheelListener, opts: unknown) => {
        if (type === 'wheel') { wheelListeners.push(listener); options.push(opts); }
      },
      querySelector: (selector: string) => (selector === '.xterm-screen' ? { getBoundingClientRect: () => screen } : null),
    },
    rows: 24,
    cols: 100,
    modes: { mouseTrackingMode: 'none' },
    buffer: { active: { type: buffer } },
    options: { scrollback },
  };
  // What the program prints, dispatched the way xterm dispatches it: the newest
  // handler first, and none after one that returns true.
  const dispatch = <H extends { final: string }>(list: H[], final: string, call: (h: H) => boolean) => {
    for (const h of [...list].reverse()) if (h.final === final && call(h)) return;
  };
  const print = {
    set: (...params: number[]) => dispatch(csi, 'h', h => h.handler(params)),
    reset: (...params: number[]) => dispatch(csi, 'l', h => h.handler(params)),
    ris: () => dispatch(esc, 'c', h => h.handler()),
  };
  /** The pointer over a cell, 1-based as the reports count it. */
  const at = (col: number, row: number) => ({ clientX: screen.left + (col - 1) * 8 + 4, clientY: screen.top + (row - 1) * 20 + 10 });
  const wheel = (init: Partial<{ deltaY: number; deltaMode: number; clientX: number; clientY: number; altKey: boolean; ctrlKey: boolean; shiftKey: boolean }>) => {
    const event = {
      deltaY: 0, deltaMode: 0, ...at(1, 1), altKey: false, ctrlKey: false, shiftKey: false,
      ...init,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    for (const listener of wheelListeners) listener(event as unknown as WheelEvent);
    return event;
  };
  const sent: string[] = [];
  const send = (data: string) => { sent.push(data); };
  /** The four sets Claude Code prints as it starts, on every resize and when input reaches it. */
  const askAsClaudeCode = () => { print.set(1000); print.set(1002); print.set(1003); print.set(1006); };
  return { term: term as unknown as Terminal, raw: term, print, at, wheel, sent, send, options, askAsClaudeCode };
}

/** Wheel reports as xterm encodes them in SGR, one per line. */
const reports = (button: number, col: number, row: number, count: number) => `\x1b[<${button};${col};${row}M`.repeat(count);

describe('passWheelToProgram', () => {
  function forwarding(init?: Parameters<typeof cliTerminal>[0]) {
    const t = cliTerminal(init);
    suppressMouseTracking(t.term);
    passWheelToProgram(t.term, t.send);
    return t;
  }

  it('listens on the terminal element in the capture phase, ahead of xterm, and may cancel', () => {
    const t = forwarding();
    expect(t.options).toEqual([{ capture: true, passive: false }]);
  });

  it('does what stopWheelTyping does while the program has asked for nothing', () => {
    const alternate = forwarding({ buffer: 'alternate' });
    const stopped = alternate.wheel({ deltaMode: 1, deltaY: -3 });
    expect(stopped.stopImmediatePropagation).toHaveBeenCalled();
    expect(stopped.preventDefault).toHaveBeenCalled();
    expect(alternate.sent).toEqual([]);

    const history = forwarding({ buffer: 'normal', scrollback: 1000 });
    const scrolled = history.wheel({ deltaMode: 1, deltaY: -3 });
    expect(scrolled.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(scrolled.preventDefault).not.toHaveBeenCalled();
    expect(history.sent).toEqual([]);
  });

  it('sends one SGR report per line of travel, at the cell under the pointer, once the program asks as Claude Code does', () => {
    const t = forwarding();
    // Read when the wheel turns: before the request, nothing goes.
    t.wheel({ deltaMode: 1, deltaY: -3, ...t.at(42, 10) });
    expect(t.sent).toEqual([]);

    t.askAsClaudeCode();
    const event = t.wheel({ deltaMode: 1, deltaY: -3, ...t.at(42, 10) });

    expect(t.sent).toEqual([reports(64, 42, 10, 3)]);
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('sends 65 for down, and adds Alt and Ctrl as xterm adds them', () => {
    const t = forwarding();
    t.askAsClaudeCode();
    const where = t.at(7, 3);

    t.wheel({ deltaMode: 1, deltaY: 2, ...where });
    t.wheel({ deltaMode: 1, deltaY: 1, ...where, altKey: true });
    t.wheel({ deltaMode: 1, deltaY: 1, ...where, ctrlKey: true });
    t.wheel({ deltaMode: 1, deltaY: -1, ...where, altKey: true, ctrlKey: true });

    expect(t.sent).toEqual([reports(65, 7, 3, 2), reports(73, 7, 3, 1), reports(81, 7, 3, 1), reports(88, 7, 3, 1)]);
  });

  it('adds pixels up into whole rows across events, and carries the rest to the next', () => {
    const t = forwarding();
    t.askAsClaudeCode();
    const where = t.at(1, 1);

    // Rows are 20px: -12 is not a row, -12 more is one with -4 left over,
    // -18 makes a second with -2 left, and +30 is one row down.
    const quiet = t.wheel({ deltaMode: 0, deltaY: -12, ...where });
    expect(t.sent).toEqual([]);
    // Still kept from xterm, which would have added it up into an arrow.
    expect(quiet.stopImmediatePropagation).toHaveBeenCalled();
    t.wheel({ deltaMode: 0, deltaY: -12, ...where });
    t.wheel({ deltaMode: 0, deltaY: -18, ...where });
    t.wheel({ deltaMode: 0, deltaY: 30, ...where });
    expect(t.sent).toEqual([reports(64, 1, 1, 1), reports(64, 1, 1, 1), reports(65, 1, 1, 1)]);

    const page = forwarding();
    page.askAsClaudeCode();
    page.wheel({ deltaMode: 2, deltaY: -1, ...page.at(1, 1) });
    expect(page.sent).toEqual([reports(64, 1, 1, 24)]);
  });

  it('sends nothing for a horizontal or shifted wheel, and still keeps it from xterm', () => {
    const t = forwarding();
    t.askAsClaudeCode();

    for (const event of [t.wheel({ deltaMode: 1, deltaY: 0 }), t.wheel({ deltaMode: 1, deltaY: -3, shiftKey: true })]) {
      expect(event.stopImmediatePropagation).toHaveBeenCalled();
    }
    expect(t.sent).toEqual([]);
  });

  it('keeps the cell on the screen when the pointer is past its edge', () => {
    const t = forwarding();
    t.askAsClaudeCode();

    t.wheel({ deltaMode: 1, deltaY: -1, clientX: 5000, clientY: -50 });
    expect(t.sent).toEqual([reports(64, 100, 1, 1)]);
  });

  it('stops forwarding when the program resets tracking or the encoding, or the terminal is reset', () => {
    const withdrawals: Array<[string, (t: ReturnType<typeof cliTerminal>) => void]> = [
      ['?1003l', t => t.print.reset(1003)],
      ['?1000l', t => t.print.reset(1000)],
      ['?1006l', t => t.print.reset(1006)],
      ['RIS', t => t.print.ris()],
    ];
    for (const [how, withdraw] of withdrawals) {
      const t = forwarding();
      t.askAsClaudeCode();
      withdraw(t);

      const event = t.wheel({ deltaMode: 1, deltaY: -3 });
      expect(t.sent, how).toEqual([]);
      // Back to stopWheelTyping's rule: stopped here, over the alternate screen.
      expect(event.stopImmediatePropagation, how).toHaveBeenCalled();

      // And asked again, it forwards again.
      t.askAsClaudeCode();
      t.wheel({ deltaMode: 1, deltaY: -1, ...t.at(1, 1) });
      expect(t.sent, how).toEqual([reports(64, 1, 1, 1)]);
    }
  });

  it('forwards nothing for the X10 protocol, or without the SGR encoding', () => {
    const requests: Array<[string, number[]]> = [
      ['X10 with SGR', [9, 1006]],
      ['tracking with SGR-pixels', [1003, 1016]],
      ['tracking with the default encoding', [1000, 1002, 1003]],
      ['SGR with no tracking', [1006]],
    ];
    for (const [what, modes] of requests) {
      const t = forwarding();
      for (const mode of modes) t.print.set(mode);
      t.wheel({ deltaMode: 1, deltaY: -3 });
      expect(t.sent, what).toEqual([]);
    }
  });

  it('forwards nothing while xterm tracks the mouse itself, which would report the wheel twice', () => {
    const t = forwarding();
    t.askAsClaudeCode();
    t.raw.modes.mouseTrackingMode = 'any';

    t.wheel({ deltaMode: 1, deltaY: -3 });
    expect(t.sent).toEqual([]);
  });

  it('does not take a mixed mode set, which xterm applies itself, for a request', () => {
    const t = forwarding();
    t.print.set(1002, 25);
    t.print.set(1006);

    t.wheel({ deltaMode: 1, deltaY: -3 });
    expect(t.sent).toEqual([]);
  });

  it('never forwards on a request another terminal received', () => {
    const asked = forwarding();
    const other = forwarding();
    asked.askAsClaudeCode();

    other.wheel({ deltaMode: 1, deltaY: -3 });
    expect(other.sent).toEqual([]);
  });

  it('forwards nothing on a terminal whose requests nobody records', () => {
    // passWheelToProgram without suppressMouseTracking: the request is never
    // read, so the class check below insists on both.
    const t = cliTerminal();
    passWheelToProgram(t.term, t.send);
    t.askAsClaudeCode();

    t.wheel({ deltaMode: 1, deltaY: -3 });
    expect(t.sent).toEqual([]);
  });
});

/**
 * The class, found in the sources rather than listed.
 *
 * The replies filter was once guarded by a list of four files while nine
 * terminals forwarded input; the fifth site was simply not on it. So the
 * terminals are found here from the sources, parsed rather than grepped: a
 * comment in terminal-theme.ts and another in Terminal.tsx carry `new
 * Terminal(` and `term.open()`, and a pattern would count them.
 *
 * A terminal is a `new` of xterm's `Terminal`, however it was imported. Each
 * one must be opened in the function that makes it, and a wheel guard from
 * `@/lib/terminal` must be called on that same terminal after the open, since
 * the element it listens on only exists from `open()` on: `stopWheelTyping`, or
 * `passWheelToProgram` for a terminal that hosts a full-screen CLI.
 *
 * Which terminals host one is read from the code rather than listed: those that
 * keep the mouse from xterm with `suppressMouseTracking`, which is also what
 * records the request `passWheelToProgram` reads. The two go together. A
 * terminal that records the request but only stops the wheel leaves the CLI
 * unable to scroll, and one that forwards without recording forwards nothing.
 * What it forwards goes to that terminal's own program, never broadcast.
 */
describe('every terminal in src guards its wheel, and every CLI terminal passes it on', () => {
  const ROOT = process.cwd();
  const SRC = path.join(ROOT, 'src');
  const XTERM = new Set(['xterm', '@xterm/xterm']);

  /** Bytes in, string out: a file with a NUL byte in it is read like any other. */
  const readText = (file: string) => fs.readFileSync(file).toString('utf-8');

  function sources(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) out.push(full);
      }
    };
    walk(root);
    return out.sort();
  }

  interface Site {
    file: string;
    line: number;
    terminal: string;
    guard: 'stop' | 'pass' | null;
    hostsCli: boolean;
    problem: string | null;
  }

  const isXtermImport = (node: ts.Node) =>
    ts.isCallExpression(node)
    && node.expression.kind === ts.SyntaxKind.ImportKeyword
    && node.arguments.length === 1
    && ts.isStringLiteral(node.arguments[0])
    && XTERM.has(node.arguments[0].text);

  const contains = (node: ts.Node, test: (n: ts.Node) => boolean): boolean =>
    test(node) || (ts.forEachChild(node, child => (contains(child, test) ? true : undefined)) ?? false);

  function descendants(node: ts.Node): ts.Node[] {
    const out: ts.Node[] = [];
    const visit = (n: ts.Node) => { out.push(n); ts.forEachChild(n, visit); };
    ts.forEachChild(node, visit);
    return out;
  }

  /** The name a call is made through: `f(...)`, or the last part of `a.b.f(...)`. */
  const calleeName = (call: ts.CallExpression) => (ts.isIdentifier(call.expression) ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '');

  const HELPERS = ['stopWheelTyping', 'passWheelToProgram', 'suppressMouseTracking'] as const;
  type Helper = typeof HELPERS[number];

  /** Every xterm terminal constructed in one source, and what is wrong with each, if anything. */
  function sitesIn(file: string, text: string): Site[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const all = descendants(source);
    const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    // Local names for xterm's Terminal: a static import, aliased or not, or a
    // name destructured out of a dynamic import of the module.
    const constructors = new Set<string>();
    // Local names for the helpers, and only when they come from @/lib/terminal.
    const local = Object.fromEntries(HELPERS.map(h => [h, new Set<string>()])) as Record<Helper, Set<string>>;
    for (const node of all) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause && !node.importClause.isTypeOnly) {
        const from = node.moduleSpecifier.text;
        const named = node.importClause.namedBindings;
        if (!named || !ts.isNamedImports(named)) continue;
        for (const element of named.elements) {
          if (element.isTypeOnly) continue;
          const imported = (element.propertyName ?? element.name).text;
          if (XTERM.has(from) && imported === 'Terminal') constructors.add(element.name.text);
          if (/(^@\/lib|\/lib)\/terminal$/.test(from) && (HELPERS as readonly string[]).includes(imported)) {
            local[imported as Helper].add(element.name.text);
          }
        }
      }
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name)
        && (node.propertyName && ts.isIdentifier(node.propertyName) ? node.propertyName.text : node.name.text) === 'Terminal') {
        let declaration: ts.Node = node;
        while (declaration && !ts.isVariableDeclaration(declaration)) declaration = declaration.parent;
        if (declaration && (declaration as ts.VariableDeclaration).initializer && contains((declaration as ts.VariableDeclaration).initializer!, isXtermImport)) {
          constructors.add(node.name.text);
        }
      }
    }

    const sites: Site[] = [];
    for (const node of all) {
      if (!ts.isNewExpression(node)) continue;
      const callee = node.expression;
      const isTerminal = (ts.isIdentifier(callee) && constructors.has(callee.text))
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'Terminal');
      if (!isTerminal) continue;

      let holder: ts.Node = node.parent;
      while (ts.isParenthesizedExpression(holder) || ts.isAsExpression(holder) || ts.isNonNullExpression(holder)) holder = holder.parent;
      if (!ts.isVariableDeclaration(holder) || !ts.isIdentifier(holder.name)) {
        sites.push({ file, line: lineOf(node), terminal: '?', guard: null, hostsCli: false, problem: 'the terminal is not held in a variable this test can follow' });
        continue;
      }
      const terminal = holder.name.text;

      let scope: ts.Node = node.parent;
      while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      const calls = descendants(scope).filter(ts.isCallExpression);
      const on = (names: Set<string>, arity: number) => calls.filter(call => ts.isIdentifier(call.expression)
        && names.has(call.expression.text)
        && call.arguments.length === arity
        && ts.isIdentifier(call.arguments[0])
        && call.arguments[0].text === terminal);
      const opens = calls.filter(call => ts.isPropertyAccessExpression(call.expression)
        && call.expression.name.text === 'open'
        && ts.isIdentifier(call.expression.expression)
        && call.expression.expression.text === terminal);
      const afterOpen = (call: ts.CallExpression) => opens.length > 0 && call.getStart(source) > opens[0].getEnd();
      const stops = on(local.stopWheelTyping, 1).filter(afterOpen);
      const passes = on(local.passWheelToProgram, 2).filter(afterOpen);
      const hostsCli = on(local.suppressMouseTracking, 1).length > 0;
      const guard = passes.length > 0 ? 'pass' : stops.length > 0 ? 'stop' : null;

      let problem: string | null = null;
      if (opens.length === 0) problem = `${terminal}.open() is not called where ${terminal} is made`;
      else if (local.stopWheelTyping.size === 0 && local.passWheelToProgram.size === 0) problem = 'no wheel guard is imported from @/lib/terminal';
      else if (!guard) problem = `no wheel guard on ${terminal} follows ${terminal}.open()`;
      else if (hostsCli && guard !== 'pass') problem = `${terminal} keeps the mouse from xterm for a CLI, and only stops its wheel: the CLI cannot scroll`;
      else if (guard === 'pass' && !hostsCli) problem = `passWheelToProgram(${terminal}) forwards nothing without suppressMouseTracking(${terminal}) recording what the program asks`;
      else if (guard === 'pass') {
        const send = passes[0].arguments[1];
        if (!ts.isArrowFunction(send) && !ts.isFunctionExpression(send)) {
          problem = `the wheel of ${terminal} is sent through something this test cannot read`;
        } else if (descendants(send).some(n => ts.isIdentifier(n) && /broadcast/i.test(n.text))) {
          problem = `the wheel of ${terminal} can be broadcast`;
        } else if (!descendants(send).some(n => ts.isCallExpression(n) && /^(sendInput|write)$/.test(calleeName(n)))) {
          problem = `the wheel of ${terminal} is sent nowhere`;
        }
      }
      sites.push({ file, line: lineOf(node), terminal, guard, hostsCli, problem });
    }
    return sites;
  }

  const scan = (root: string) => sources(root).flatMap(file => sitesIn(path.relative(ROOT, file), readText(file)));

  const SITES = scan(SRC);

  it('finds the terminals by reading src, and among them the ones that host a CLI', () => {
    // No list of which: a terminal added tomorrow is found the same way and
    // held to the same rules below.
    const where = SITES.map(s => `${s.file}:${s.line} ${s.guard}${s.hostsCli ? ' (CLI)' : ''}`).join('\n');
    expect(SITES.length, where).toBeGreaterThan(0);
    expect(SITES.filter(s => s.hostsCli).length, where).toBeGreaterThan(0);
    expect(SITES.filter(s => !s.hostsCli).length, where).toBeGreaterThan(0);
  });

  it.each(SITES)('$file:$line guards the wheel of $terminal after opening it, as its kind requires', (site: Site) => {
    expect(site.problem).toBeNull();
  });

  /**
   * The controls for the scan, the only part of this that could pass by seeing
   * nothing. Each real site with its guard taken out must be caught, and so
   * must the shapes a careless check would let through.
   */
  describe('the scan itself', () => {
    /** The statement that calls a guard on a site's terminal, found in its real source. */
    function guardStatement(site: Site, text: string): ts.ExpressionStatement {
      const source = ts.createSourceFile(site.file, text, ts.ScriptTarget.Latest, true, site.file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const found = descendants(source).filter((n): n is ts.ExpressionStatement => ts.isExpressionStatement(n)
        && ts.isCallExpression(n.expression)
        && ts.isIdentifier(n.expression.expression)
        && /^(stopWheelTyping|passWheelToProgram)$/.test(n.expression.expression.text)
        && n.expression.arguments.length > 0
        && ts.isIdentifier(n.expression.arguments[0])
        && n.expression.arguments[0].text === site.terminal);
      expect(found, `${site.file}: the guard statement on ${site.terminal}`).toHaveLength(1);
      return found[0];
    }

    it.each(SITES)('catches $file:$line with its wheel guard taken out', (site: Site) => {
      const text = readText(path.join(ROOT, site.file));
      const statement = guardStatement(site, text);
      // Blanked rather than cut, so every line keeps its number.
      const without = text.slice(0, statement.getStart()) + text.slice(statement.getStart(), statement.getEnd()).replace(/[^\n]/g, ' ') + text.slice(statement.getEnd());

      const again = sitesIn(site.file, without).find(s => s.line === site.line);
      expect(again?.problem).toBe(`no wheel guard on ${site.terminal} follows ${site.terminal}.open()`);
    });

    it.each(SITES.filter(s => s.hostsCli))('catches $file:$line when its CLI terminal only stops the wheel', (site: Site) => {
      const text = readText(path.join(ROOT, site.file));
      const statement = guardStatement(site, text);
      const stopped = (text.slice(0, statement.getStart()) + `stopWheelTyping(${site.terminal});` + text.slice(statement.getEnd()))
        .replace(/(import \{[^}]*)\bpassWheelToProgram\b/, '$1passWheelToProgram, stopWheelTyping');

      const again = sitesIn(site.file, stopped).find(s => s.terminal === site.terminal);
      expect(again?.problem).toBe(`${site.terminal} keeps the mouse from xterm for a CLI, and only stops its wheel: the CLI cannot scroll`);
    });

    const IMPORTS = "import { Terminal } from 'xterm';\nimport { passWheelToProgram, stopWheelTyping, suppressMouseTracking } from '@/lib/terminal';\n";
    const planted = (body: string, imports = IMPORTS) =>
      sitesIn('Planted.tsx', `${imports}\nexport async function mount(el: HTMLElement, id: string) {\n${body}\n}\n`);

    it('passes a shell that stops its wheel, and a CLI terminal that sends it to its own program', () => {
      expect(planted('const term = new Terminal({});\nterm.open(el);\nstopWheelTyping(term);')).toEqual([
        expect.objectContaining({ terminal: 'term', guard: 'stop', hostsCli: false, problem: null }),
      ]);
      expect(planted('const term = new Terminal({});\nsuppressMouseTracking(term);\nterm.open(el);\npassWheelToProgram(term, input => { window.electronAPI.agent.sendInput({ id, input }); });')).toEqual([
        expect.objectContaining({ terminal: 'term', guard: 'pass', hostsCli: true, problem: null }),
      ]);
    });

    it('catches a guard called before the open, when the element does not exist yet', () => {
      expect(planted('const term = new Terminal({});\nstopWheelTyping(term);\nterm.open(el);')[0].problem)
        .toBe('no wheel guard on term follows term.open()');
      expect(planted('const term = new Terminal({});\nsuppressMouseTracking(term);\npassWheelToProgram(term, d => pty.write(d));\nterm.open(el);')[0].problem)
        .toBe('no wheel guard on term follows term.open()');
    });

    it('catches the second of two terminals when only the first is guarded', () => {
      const sites = planted('const a = new Terminal({});\nconst b = new Terminal({});\na.open(el);\nb.open(el);\nstopWheelTyping(a);');
      expect(sites.map(s => [s.terminal, s.problem])).toEqual([
        ['a', null],
        ['b', 'no wheel guard on b follows b.open()'],
      ]);
    });

    it('catches a CLI terminal that forwards without recording, broadcasts, or sends nowhere', () => {
      expect(planted('const term = new Terminal({});\nterm.open(el);\npassWheelToProgram(term, d => pty.write(d));')[0].problem)
        .toBe('passWheelToProgram(term) forwards nothing without suppressMouseTracking(term) recording what the program asks');
      expect(planted('const term = new Terminal({});\nsuppressMouseTracking(term);\nterm.open(el);\npassWheelToProgram(term, input => sendOrBroadcast(input));')[0].problem)
        .toBe('the wheel of term can be broadcast');
      expect(planted('const term = new Terminal({});\nsuppressMouseTracking(term);\nterm.open(el);\npassWheelToProgram(term, input => { if (broadcastModeRef.current) return; window.electronAPI.agent.sendInput({ id, input }); });')[0].problem)
        .toBe('the wheel of term can be broadcast');
      expect(planted('const term = new Terminal({});\nsuppressMouseTracking(term);\nterm.open(el);\npassWheelToProgram(term, () => {});')[0].problem)
        .toBe('the wheel of term is sent nowhere');
      expect(planted('const term = new Terminal({});\nsuppressMouseTracking(term);\nterm.open(el);\npassWheelToProgram(term, forward);')[0].problem)
        .toBe('the wheel of term is sent through something this test cannot read');
    });

    it('catches guards of the same name that are not the ones from @/lib/terminal', () => {
      const sites = planted(
        'const term = new Terminal({});\nterm.open(el);\nstopWheelTyping(term);',
        "import { Terminal } from 'xterm';\nconst stopWheelTyping = (t: unknown) => t;\n",
      );
      expect(sites[0].problem).toBe('no wheel guard is imported from @/lib/terminal');
    });

    it('finds a terminal made from an aliased import, a dynamic import, or a module object', () => {
      const aliased = planted('const x = new XTerm({});\nx.open(el);', "import { Terminal as XTerm } from 'xterm';\nimport { stopWheelTyping } from '@/lib/terminal';\n");
      const dynamic = planted("const { Terminal: T } = await import('xterm');\nconst y = new T({});\ny.open(el);");
      const members = planted('const z = new modules.Terminal({});\nz.open(el);');
      for (const sites of [aliased, dynamic, members]) {
        expect(sites).toHaveLength(1);
        expect(sites[0].problem).toMatch(/^no wheel guard on . follows .\.open\(\)$/);
      }
    });

    it('does not count a terminal named in a comment or a type', () => {
      const sites = planted(
        '// const term = new Terminal({}); term.open(el);\nlet later: Terminal | null = null;\nreturn later;',
        "import type { Terminal } from 'xterm';\n",
      );
      expect(sites).toEqual([]);
    });

    it('reads a source with NUL bytes in it rather than stepping over it', () => {
      // PluginsTab.tsx held raw NUL bytes, and every grep in use here took it
      // for a binary and skipped it without a word.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-terminal-'));
      try {
        fs.writeFileSync(
          path.join(dir, 'Planted.tsx'),
          `import { Terminal } from 'xterm';\nconst marker = '${String.fromCharCode(0)}';\nexport function mount(el: HTMLElement) {\n  const term = new Terminal({});\n  term.open(el);\n}\n`,
        );
        expect(fs.readFileSync(path.join(dir, 'Planted.tsx')).includes(0x00)).toBe(true);

        const found = scan(dir);
        expect(found).toHaveLength(1);
        expect(found[0].problem).toBe('no wheel guard is imported from @/lib/terminal');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
