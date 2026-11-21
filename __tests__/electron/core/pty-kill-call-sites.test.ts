import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import ts from 'typescript';

/**
 * Every terminal the main process ends goes through killPty.
 *
 * electron/core/pty-kill.ts ends a node-pty terminal without node-pty's
 * `AttachConsole failed` on Windows. This is the guard for every kill site,
 * today's and the next one: a `pty.kill()` written anywhere else brings the failure
 * back, on Windows only, where nobody writing it on a Mac would see it.
 *
 * How it can fail (2026-09-25; the E2E spec came first and was seen red on
 * the unwired build, this guard was then run red against the unwired tree):
 * 1. A node-pty terminal (an IPty, however it is reached: a map's get, an
 *    optional chain, a parameter) is ended with its own kill() anywhere in the
 *    main process but pty-kill.ts. Run against the unwired tree, this lists
 *    the 18 sites the lot wired; with one of them put back, it lists that one.
 * 2. A kill() whose receiver the type checker cannot name (`any`) is not
 *    looked at, so a terminal behind an untyped map slips through.
 * 3. The scan reads no file, or not the ones the app is built from, and finds
 *    nothing for that reason: it reads electron/tsconfig.json's own file list,
 *    and must see the ChildProcess kills of acp/client.ts, which stay.
 */

const repo = process.cwd();
const ALLOWED = path.join(repo, 'electron', 'core', 'pty-kill.ts');

function kills(): { ptyKills: string[]; untyped: string[]; others: string[] } {
  const configPath = path.join(repo, 'electron', 'tsconfig.json');
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); },
  });
  if (!config) throw new Error(`could not read ${configPath}`);
  const program = ts.createProgram({ rootNames: config.fileNames, options: { ...config.options, noEmit: true } });
  const checker = program.getTypeChecker();
  const found = { ptyKills: [] as string[], untyped: [] as string[], others: [] as string[] };
  const electronDir = path.join(repo, 'electron') + path.sep;

  for (const source of program.getSourceFiles()) {
    const file = path.resolve(source.fileName);
    if (source.isDeclarationFile || !file.startsWith(electronDir)) continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'kill') {
        const receiver = node.expression.expression;
        // `process.kill(pid)` is a signal to a pid, not a terminal.
        if (!(ts.isIdentifier(receiver) && receiver.text === 'process')) {
          const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
          const where = `${path.relative(repo, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${node.getText()}`;
          if (type.flags & ts.TypeFlags.Any) found.untyped.push(where);
          else if (isIPty(type)) {
            if (file !== ALLOWED) found.ptyKills.push(where);
          } else found.others.push(`${where} (${checker.typeToString(type)})`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/** node-pty's IPty, or a type made of it (a union with it, an intersection). */
function isIPty(type: ts.Type): boolean {
  if (type.isUnionOrIntersection()) return type.types.some(isIPty);
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  if (!symbol || symbol.getName() !== 'IPty') return false;
  return (symbol.getDeclarations() ?? []).some(d => /[\\/]node-pty[\\/]/.test(d.getSourceFile().fileName));
}

describe('the main process ends a terminal only through killPty', () => {
  it('1, 2, 3. no IPty.kill() outside pty-kill.ts, no kill() on an untyped receiver, and the scan saw the app', { timeout: 120_000 }, () => {
    const found = kills();

    expect(found.ptyKills, 'a terminal is ended with node-pty\'s own kill(): use killPty (electron/core/pty-kill.ts)').toEqual([]);
    expect(found.untyped, 'a kill() on a receiver of type any: type it, so this guard can tell a terminal from a child process').toEqual([]);
    // Not vacuous: the child processes of the ACP client are ended with their own kill(), and were seen.
    expect(found.others.some(k => k.startsWith(path.join('electron', 'services', 'acp', 'client.ts')) && k.includes('ChildProcess')), found.others.join('\n')).toBe(true);
  });
});
