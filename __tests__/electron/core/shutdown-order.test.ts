import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { runShutdownSteps } from '../../../electron/core/shutdown';

/**
 * What Tars does on its way out, and in what order.
 *
 * Two of the eight steps are the only chance the app has to put something on
 * disk: `saveAgents()` and `flushBus()`. The bus journal writes once per turn
 * of the event loop rather than once per row, so at the moment of the quit it
 * holds a turn's worth of the Chat in memory and nowhere else. `flushBus()`
 * was the fifth statement of a plain sequence: whether it ran at all was
 * decided by four calls that had no reason to throw, which is not the same as
 * cannot, and nothing in the app would have said so if one started to.
 *
 * Two assertions, because either alone can be satisfied while the defect
 * stands: the steps are each caught, and the two that write go first. The
 * second is read off main.ts's syntax tree, since a `before-quit` handler
 * cannot be called from here without an Electron app around it.
 */

const MAIN = path.join(process.cwd(), 'electron', 'main.ts');
/** The steps that write, in the order they must run. */
const WRITERS = ['flushBus', 'saveAgents'];

describe('a shutdown step that throws', () => {
  it('does not take the steps after it with it', () => {
    const ran: string[] = [];

    runShutdownSteps([
      ['first', () => { ran.push('first'); }],
      ['throws', () => { throw new Error('boom'); }],
      ['flushBus', () => { ran.push('flushBus'); }],
      ['killAllPty', () => { ran.push('killAllPty'); }],
    ]);

    expect(ran).toEqual(['first', 'flushBus', 'killAllPty']);
  });

  it('does not throw out of the handler, which would leave the quit half done', () => {
    expect(() => runShutdownSteps([['throws', () => { throw new Error('boom'); }]])).not.toThrow();
  });

  it('runs every step even when all of them throw', () => {
    let attempts = 0;
    const blow = () => { attempts += 1; throw new Error('boom'); };

    runShutdownSteps([['a', blow], ['b', blow], ['c', blow]]);

    expect(attempts).toBe(3);
  });
});

describe("the app's own before-quit handler", () => {
  /** The array literal main.ts hands runShutdownSteps, as a list of step names. */
  function shutdownStepNames(): string[] {
    const source = ts.createSourceFile(MAIN, fs.readFileSync(MAIN, 'utf-8'), ts.ScriptTarget.ES2022, true);
    let names: string[] | null = null;

    // The first list: the quit's first pass, where the writes are. The second
    // pass closes what the terminals no longer need.
    const visit = (node: ts.Node): void => {
      if (names) return;
      if (ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && node.expression.text === 'runShutdownSteps'
          && node.arguments.length === 1
          && ts.isArrayLiteralExpression(node.arguments[0])) {
        names = node.arguments[0].elements.map((element) => {
          if (!ts.isArrayLiteralExpression(element) || element.elements.length !== 2) return '<not a step>';
          const [label] = element.elements;
          return ts.isStringLiteral(label) ? label.text : '<not a literal>';
        });
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(names, 'main.ts no longer hands runShutdownSteps a literal list of steps').not.toBeNull();
    return names!;
  }

  it('writes to disk before it does anything else', () => {
    const steps = shutdownStepNames();

    // The witness that the list was read rather than imagined: the steps that
    // do not write are in it too, after the two that do.
    expect(steps.length, JSON.stringify(steps)).toBeGreaterThan(WRITERS.length);
    expect(steps.slice(0, WRITERS.length)).toEqual(WRITERS);
    // The terminals are ended after these steps, by endAllTerminals, which
    // waits for their exits and so is not a step (quit-ends-terminals.test.ts).
    expect(steps).toContain('endAcpRunsOnQuit');
    expect(steps).not.toContain('<not a literal>');
  });

  it('stops the stall watch in its first pass, before the terminals it reads are ended (#283)', () => {
    // Its check reads each agent's process tree and posts to an orchestrator:
    // run against a fleet whose trees are being ended, every agent reads
    // stalled, or its notice lands in a terminal that is going away.
    expect(shutdownStepNames()).toContain('stopStallWatch');
  });

  it('silences status notifications in its first pass, before the terminals\' exits come in', () => {
    // An announcement pending from before the quit would notify (or reach
    // Telegram) while the quit waits for the terminals, up to 5 s more on
    // Windows. The exits themselves come after this synchronous pass, once
    // the event loop turns. See quit-status-notifications.test.ts.
    expect(shutdownStepNames()).toContain('stopStatusNotifications');
  });

  it('does its work through the guarded runner and not as bare statements', () => {
    const source = fs.readFileSync(MAIN, 'utf-8');
    const handler = source.slice(source.indexOf("app.on('before-quit'"));
    const body = handler.slice(0, handler.indexOf('\n});') + 4);

    expect(body).toContain('runShutdownSteps(');
    // Every step is inside the array, so none of the eight is called on its own
    // line where a throw would skip the rest.
    for (const step of [...WRITERS, 'endAcpRunsOnQuit', 'closeVaultDb', 'destroyTray']) {
      expect(body, `${step}() is called outside runShutdownSteps`).not.toMatch(new RegExp(`^\\s*${step}\\(\\);`, 'm'));
    }
  });
});
