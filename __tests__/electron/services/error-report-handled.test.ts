import '../../setup/home-guard';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LAUNCH_WINDOW_MS, apiAnswerReports, cliLaunchExit, isHandlerRefusal, reportAgentToolError, reportHandledError,
  routeName, setReportSinks, watchLoggedErrors, withoutWords,
} from '../../../electron/services/error-reports/handled';

/**
 * Where the errors Tars handles are met, and which of them become reports (F1 and F3 of the maintainer's go of
 * 2026-10-18, from the QA's diagnosis sentry-pipeline-1810). This file decides what is reported; the report itself is
 * built and gated as any other (error-report-coverage.test.ts).
 *
 * How it fails, written before the code (2026-10-19):
 * 1. An Error that main logs at error level is not reported, or the same Error object, logged twice, is reported twice.
 * 2. A line with no Error in it is reported: its words would leave, and a log line names agents, tasks and folders.
 * 3. A handler's own refusal is reported: a plain Error thrown from electron/handlers/ is how a handler answers the
 *    window ("There is no such account.", "Invalid model name: <what was typed>"). Or, over-corrected, a fault met in a
 *    handler is not: a TypeError thrown there, an Error from deeper code, a system error passed through.
 * 4. Electron's line for an IPC handler that threw loses the channel; or it carries a channel Tars did not register.
 * 5. The log line no longer prints, or prints differently; a report that throws breaks the line; a report that itself
 *    logs an error loops.
 * 6. The hook cannot be taken off.
 * 7. An API route is named with what the request carried (an id, a query) rather than the route.
 * 8. A route that answers 500 without throwing is not reported; one that threw is reported twice (its log line is
 *    reported already); a 4xx answer is taken for Tars's fault.
 * 9. An agent's MCP call answered 400 or more is not an agent tool error; or one is made for a caller that is no
 *    agent (the shared token, the window), for what is not the MCP server's (a hook), or under 400; a tool named in the
 *    header that is not one of Tars's own is carried (it is `unknown`); the CLI is not the calling agent's provider;
 *    the code is not the status with the code Tars's answer carries (`403 worker_may_not_order`), or carries
 *    something else from the answer than one of Tars's own codes.
 * 10. An agent's CLI that exits with a failure code within 30 s of its launch is not reported; one that exits 0, that
 *     was ended by a signal, that the user interrupted (130) or that ran longer is.
 * 11. A report with no sink set, or a sink that throws, breaks the code that met the error.
 * And from the Audit's gate of #474 (M1, written red on 106e1f41, 2026-10-19):
 * 12. A handled error leaves with its message, or its cause's: the world's words (a command line, a path, a file's
 *     start, a URL, a prompt). What it is sent as is a copy: its type, its closed facts (an errno code and its
 *     syscall, an exit status, a signal, one of Tars's own codes), its frames, and its causes the same way; Tars's own
 *     fixed sentences are kept. A 500's message is its route and status, never the route's error.
 * 13. The copy breaks on what is not an Error, or on a cause that loops.
 * And from the Audit's re-check of #474 (L2, written red on f087392f, 2026-10-19):
 * 14. Lines of the message that look like frames are kept as frames: a child process's stderr is in its error's
 *     message, so in its stack, and a script that died with a stack trace puts its own `at` lines there, with a
 *     client's folder and its function names (the Audit's probe PB). Only the frames after the message are the
 *     error's; a stack that does not begin with its message gives none.
 */

afterEach(() => setReportSinks(null));

const fromHandler = (message: string) => {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at /Applications/Tars.app/Contents/Resources/app.asar/electron/dist/handlers/claude-accounts-handlers.js:269:13\n    at async Session.<anonymous> (node:electron/js2c/browser_init:2:107021)`;
  return error;
};
const fromService = (message: string) => {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at saveAgents (/Applications/Tars.app/Contents/Resources/app.asar/electron/dist/core/agent-manager.js:42:7)\n    at /Applications/Tars.app/Contents/Resources/app.asar/electron/dist/handlers/ipc-handlers.js:551:5`;
  return error;
};

function logger() {
  const printed: unknown[][] = [];
  const target = { error: (...args: unknown[]) => { printed.push(args); } };
  return { target, printed };
}

describe('what main logs at error level (F1)', () => {
  it('1, 5. an Error among the arguments is reported, once per object, and the line prints as before', () => {
    const { target, printed } = logger();
    const reported: Error[] = [];
    watchLoggedErrors(target, e => reported.push(e), new Set());
    const error = fromService('could not write agents.json');
    target.error('[agents] save failed:', error);
    target.error('[agents] still failing:', error);
    expect(reported).toEqual([error]);
    expect(printed).toEqual([['[agents] save failed:', error], ['[agents] still failing:', error]]);
  });

  it('2. a line with no Error in it is never reported', () => {
    const { target } = logger();
    const reported: Error[] = [];
    watchLoggedErrors(target, e => reported.push(e), new Set());
    target.error('[agent] Zephyrine has been running for 90s without starting a turn');
    target.error('API error:', { message: 'not an Error' });
    expect(reported).toEqual([]);
  });

  it("3. a handler's own refusal is not reported; a fault met in a handler is", () => {
    expect(isHandlerRefusal(fromHandler('There is no such account.'))).toBe(true);
    const typeError = new TypeError("Cannot read properties of undefined (reading 'trim')");
    typeError.stack = `TypeError: x\n    at /x/electron/dist/handlers/ipc-handlers.js:12:3`;
    expect(isHandlerRefusal(typeError)).toBe(false);
    expect(isHandlerRefusal(fromService('could not write agents.json'))).toBe(false);
    const system = Object.assign(fromHandler('ENOENT: no such file or directory'), { code: 'ENOENT' });
    expect(isHandlerRefusal(system)).toBe(false);
    // Windows paths and the TypeScript sources a development run may name.
    const windows = new Error('There is no such agent.');
    windows.stack = 'Error: There is no such agent.\n    at C:\\Users\\x\\AppData\\Local\\Programs\\Tars\\resources\\app.asar\\electron\\dist\\handlers\\ipc-handlers.js:553:22';
    expect(isHandlerRefusal(windows)).toBe(true);
    expect(isHandlerRefusal('There is no such agent.')).toBe(false);

    const { target } = logger();
    const reported: Error[] = [];
    watchLoggedErrors(target, e => reported.push(e), new Set(['claude-accounts:add']));
    target.error("Error occurred in handler for 'claude-accounts:add':", fromHandler('Invalid model name: my secret project'));
    expect(reported).toEqual([]);
  });

  it("4. Electron's line for a handler that threw names its channel, when Tars registered it", () => {
    const { target } = logger();
    const reported: Error[] = [];
    watchLoggedErrors(target, e => reported.push(e), new Set(['agent:start']));
    const fault = fromService('posix_spawnp failed.');
    target.error("Error occurred in handler for 'agent:start':", fault);
    expect(reported).toHaveLength(1);
    expect(reported[0].name).toBe('IpcHandlerError');
    expect(reported[0].message).toBe('agent:start');
    expect(reported[0].cause).toBe(fault);

    const other = fromService('boom');
    target.error("Error occurred in handler for 'not-registered:/Users/x/acme':", other);
    expect(reported[1]).toBe(other);
  });

  it('5. a report that throws or logs never breaks the line, nor loops', () => {
    const { target, printed } = logger();
    watchLoggedErrors(target, () => { throw new Error('sink down'); }, new Set());
    expect(() => target.error('x failed:', fromService('a'))).not.toThrow();
    expect(printed).toHaveLength(1);

    const second = logger();
    let calls = 0;
    watchLoggedErrors(second.target, (e) => { calls++; second.target.error('[error-reports] could not report:', e); }, new Set());
    second.target.error('y failed:', fromService('b'));
    expect(calls).toBe(1);
    expect(second.printed).toHaveLength(2);
  });

  it('6. the hook can be taken off', () => {
    const { target, printed } = logger();
    const reported: Error[] = [];
    const undo = watchLoggedErrors(target, e => reported.push(e), new Set());
    undo();
    target.error('z failed:', fromService('c'));
    expect(reported).toEqual([]);
    expect(printed).toHaveLength(1);
  });
});

describe("the API's answers (F1, F3)", () => {
  const TOOLS = new Set(['delegate_task', 'send_message']);
  const base = { method: 'POST', route: /^\/api\/agents\/([^/]+)\/message$/, status: 200, threw: false, fromMcp: false, tools: TOOLS };

  it('7. a route is named by its pattern, never by what the request carried', () => {
    expect(routeName(/^\/api\/agents\/([^/]+)\/message$/)).toBe('/api/agents/:id/message');
    expect(routeName(/^\/api\/tasks\/([^/]+)$/)).toBe('/api/tasks/:id');
    expect(routeName('/api/agents')).toBe('/api/agents');
    expect(routeName(undefined)).toBe('(no route)');
  });

  it('8, 12. a 500 answered without a throw is a handled error, named by its route and status only; a throw is reported by its log line; a 4xx is not Tars\'s fault', () => {
    const answered = apiAnswerReports({ ...base, status: 500 });
    expect(answered.handled?.name).toBe('ApiRouteError');
    expect(answered.handled?.message).toBe('POST /api/agents/:id/message answered 500');
    expect(apiAnswerReports({ ...base, status: 503, bodyCode: 'agent_busy' }).handled?.message).toBe('POST /api/agents/:id/message answered 503 agent_busy');
    expect(apiAnswerReports({ ...base, status: 500, bodyCode: 'Zephyrine said no' }).handled?.message).toBe('POST /api/agents/:id/message answered 500');
    expect(apiAnswerReports({ ...base, status: 500, threw: true }).handled).toBeUndefined();
    expect(apiAnswerReports({ ...base, status: 409 }).handled).toBeUndefined();
  });

  it("9. an agent's MCP call answered 400 or more is an agent tool error: the status, Tars's tool, the agent's CLI", () => {
    const agent = { provider: 'codex' };
    expect(apiAnswerReports({ ...base, status: 409, agent, fromMcp: true, tool: 'send_message' }).agentTool)
      .toEqual({ code: '409', tool: 'send_message', cli: 'codex' });
    // With the code Tars's answer carries, when it carries one of its own: never a word of the request.
    expect(apiAnswerReports({ ...base, status: 403, bodyCode: 'worker_may_not_order', agent, fromMcp: true, tool: 'delegate_task' }).agentTool)
      .toEqual({ code: '403 worker_may_not_order', tool: 'delegate_task', cli: 'codex' });
    expect(apiAnswerReports({ ...base, status: 403, bodyCode: 'Zephyrine said no', agent, fromMcp: true, tool: 'delegate_task' }).agentTool?.code).toBe('403');
    expect(apiAnswerReports({ ...base, status: 403, bodyCode: 42 as never, agent, fromMcp: true, tool: 'delegate_task' }).agentTool?.code).toBe('403');
    expect(apiAnswerReports({ ...base, status: 500, agent, fromMcp: true, tool: 'delegate_task', errorText: 'x' }).agentTool)
      .toEqual({ code: '500', tool: 'delegate_task', cli: 'codex' });
    expect(apiAnswerReports({ ...base, status: 404, agent, fromMcp: true, tool: 'acme_merger' }).agentTool)
      .toEqual({ code: '404', tool: 'unknown', cli: 'codex' });
    expect(apiAnswerReports({ ...base, status: 404, agent, fromMcp: true }).agentTool?.tool).toBe('unknown');
    // Not an agent, not the MCP server, not an error.
    expect(apiAnswerReports({ ...base, status: 409, fromMcp: true, tool: 'send_message' }).agentTool).toBeUndefined();
    expect(apiAnswerReports({ ...base, status: 409, agent, fromMcp: false, tool: 'send_message' }).agentTool).toBeUndefined();
    expect(apiAnswerReports({ ...base, status: 302, agent, fromMcp: true, tool: 'send_message' }).agentTool).toBeUndefined();
    expect(apiAnswerReports({ ...base, status: 200, agent, fromMcp: true, tool: 'send_message' }).agentTool).toBeUndefined();
  });
});

describe("an agent's CLI that exits at its launch (F1)", () => {
  it('10. a failure code within 30 s is reported, named by its provider and code', () => {
    expect(LAUNCH_WINDOW_MS).toBe(30_000);
    const error = cliLaunchExit({ provider: 'codex', exitCode: 2, livedMs: 400 })!;
    expect(error.name).toBe('CliExitedAtLaunch');
    expect(error.message).toBe('codex exited with code 2, 0.4 s after its launch');
    expect(cliLaunchExit({ provider: 'claude', exitCode: 127, livedMs: 29_999 })?.message).toBe('claude exited with code 127, 30 s after its launch');
  });

  it('10. not a clean exit, a signal, an interrupt, or a CLI that ran longer', () => {
    expect(cliLaunchExit({ provider: 'codex', exitCode: 0, livedMs: 400 })).toBeNull();
    expect(cliLaunchExit({ provider: 'codex', exitCode: 1, signal: 15, livedMs: 400 })).toBeNull();
    expect(cliLaunchExit({ provider: 'codex', exitCode: 130, livedMs: 400 })).toBeNull();
    expect(cliLaunchExit({ provider: 'codex', exitCode: 1, livedMs: 30_001 })).toBeNull();
  });
});

describe('the sinks', () => {
  it('11. a report with no sink set, or with a sink that throws, never breaks its caller', () => {
    expect(() => reportHandledError(new Error('a'))).not.toThrow();
    expect(() => reportAgentToolError({ code: '409', tool: 'send_message', cli: 'claude' })).not.toThrow();
    setReportSinks({ handled: () => { throw new Error('down'); }, agentTool: () => { throw new Error('down'); } });
    expect(() => reportHandledError(new Error('b'))).not.toThrow();
    expect(() => reportAgentToolError({ code: '409', tool: 'send_message', cli: 'claude' })).not.toThrow();
  });

  it('11. a sink set is handed each report', () => {
    const handled = vi.fn();
    const agentTool = vi.fn();
    setReportSinks({ handled, agentTool });
    const error = new Error('c');
    reportHandledError(error);
    reportAgentToolError({ code: 'never-started', tool: 'delegate_task', cli: 'claude' });
    expect(handled).toHaveBeenCalledWith(error);
    expect(agentTool).toHaveBeenCalledWith({ code: 'never-started', tool: 'delegate_task', cli: 'claude' });
  });
});

describe("what a handled error is sent as (12, 13, the Audit's M1 on #474)", () => {
  const WORDS = /acme|buyout|lawyer|termsheet|patient|diagnosis|48213|atlassian|summarise|minutes|CFO|clients|worktree|branch|fatal|myself|unexpected|jdoe|toLowerCase/i;
  const at = '    at saveAgents (/Applications/Tars.app/Contents/Resources/app.asar/electron/dist/core/agent-manager.js:42:7)';
  /** An error as Node makes it: its message, its own properties, a stack whose first lines repeat the message. */
  const made = <T extends Error>(error: T, props: Record<string, unknown> = {}): T => {
    Object.assign(error, props);
    error.stack = `${error.name}: ${error.message}\n${at}`;
    return error;
  };

  it("12. the probe PA's five errors leave as their type and closed facts, with their frames, and no word of them", () => {
    const cases: Array<[Error, string]> = [
      [made(new Error("Command failed: git --no-optional-locks -C /Users/jdoe/clients/acme-merger worktree add -b feat/acme-buyout-terms /Users/jdoe/clients/acme-merger/.worktrees/lawyer HEAD\nfatal: a branch named 'feat/acme-buyout-terms' already exists"), { code: 128, killed: false, signal: null, cmd: 'git -C /Users/jdoe/clients/acme-merger worktree add' }), 'exit 128'],
      [made(new Error("ENOENT: no such file or directory, open '/Users/jdoe/clients/acme-merger/reports/termsheet-draft-v3.md'"), { code: 'ENOENT', errno: -2, syscall: 'open', path: '/Users/jdoe/clients/acme-merger/reports/termsheet-draft-v3.md' }), 'code ENOENT, syscall open'],
      [made(new SyntaxError('Unexpected token \'p\', "patient_id=48213;diagnosis=..." is not valid JSON')), '(message not sent)'],
      [made(new Error('request to https://acme-legal.atlassian.net/rest/api/3/myself failed, reason: getaddrinfo ENOTFOUND acme-legal.atlassian.net'), { code: 'ENOTFOUND', errno: 'ENOTFOUND', type: 'system' }), 'code ENOTFOUND'],
      [made(new Error('Command failed: claude -p Summarise the board minutes for the Acme acquisition and draft the email to the CFO'), { status: 1, signal: null }), 'exit 1'],
    ];
    for (const [error, said] of cases) {
      const copy = withoutWords(error);
      expect(copy.message, error.message).toBe(said);
      expect(copy.name).toBe(error.name);
      expect(`${copy.message}\n${copy.stack}`, error.message).not.toMatch(WORDS);
      expect(copy.stack).toContain(at);
      expect(copy).not.toBe(error);
    }
  });

  it("12. its causes are copied the same way, and Tars's own fixed sentences are kept", () => {
    const lookup = made(new Error('getaddrinfo ENOTFOUND acme-legal.atlassian.net'), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'acme-legal.atlassian.net' });
    const fetchFailed = made(new TypeError('fetch failed', { cause: lookup }));
    const copy = withoutWords(fetchFailed);
    expect(copy.message).toBe('(message not sent)');
    expect((copy.cause as Error).message).toBe('code ENOTFOUND, syscall getaddrinfo');
    expect(JSON.stringify([copy.message, (copy.cause as Error).message, (copy.cause as Error).stack])).not.toMatch(WORDS);

    const ipc = new Error('project:search-files', { cause: made(new TypeError('query.toLowerCase is not a function')) });
    ipc.name = 'IpcHandlerError';
    const ipcCopy = withoutWords(ipc);
    expect(ipcCopy.name).toBe('IpcHandlerError');
    expect(ipcCopy.message).toBe('project:search-files');
    expect((ipcCopy.cause as Error).name).toBe('TypeError');
    expect((ipcCopy.cause as Error).message).toBe('(message not sent)');

    for (const fixed of [cliLaunchExit({ provider: 'codex', exitCode: 2, livedMs: 400 })!, apiAnswerReports({ method: 'POST', route: '/api/agents', status: 500, threw: false, fromMcp: false, tools: new Set() }).handled!]) {
      expect(withoutWords(fixed).message).toBe(fixed.message);
    }
  });

  it('13. not an Error, a cause that loops, a name that is not a name: never a throw, never their words', () => {
    expect(withoutWords('Acme said: ship the termsheet').message).toBe('(message not sent)');
    expect(withoutWords(undefined).message).toBe('(message not sent)');
    const loop = made(new Error('acme loop'));
    (loop as { cause?: unknown }).cause = loop;
    // Walked to 10 at most: a copy that kept the loop would never end.
    const chain: unknown[] = [];
    for (let e: unknown = withoutWords(loop); e instanceof Error && chain.length < 10; e = e.cause) chain.push(e);
    expect(chain.length).toBeLessThanOrEqual(5);
    expect(chain).not.toContain(loop);
    const named = made(new Error('x'));
    named.name = 'Acme merger failed';
    expect(withoutWords(named).name).toBe('Error');
  });
});

describe("the frames a handled error is sent with (14, the Audit's L2 on #474)", () => {
  const tars = [
    '    at ChildProcess.exithandler (node:child_process:422:12)',
    '    at runCheck (/Applications/Tars.app/Contents/Resources/app.asar/electron/dist/services/cli-updater.js:88:5)',
  ];

  it("probe PB: a child process's own stack trace, in its stderr, never becomes frames", () => {
    const stderr = [
      '/Users/jdoe/clients/acme-merger/scripts/build.js:3',
      "    throw new Error('termsheet missing')",
      '    ^',
      'Error: termsheet missing',
      '    at Object.<anonymous> (/Users/jdoe/clients/acme-merger/scripts/build.js:3:9)',
      '    at loadTermsheetForAcmeBuyout (/Users/jdoe/clients/acme-merger/lib/terms.js:12:5)',
    ].join('\n');
    const error = Object.assign(new Error(`Command failed: node scripts/build.js\n${stderr}\n`), { code: 1, killed: false, signal: null });
    error.stack = `Error: ${error.message}\n${tars.join('\n')}`;
    const copy = withoutWords(error);
    expect(copy.message).toBe('exit 1');
    expect(copy.stack).toBe(['Error: exit 1', ...tars].join('\n'));
    expect(copy.stack).not.toMatch(/acme|clients|termsheet|loadTermsheetForAcmeBuyout|jdoe/i);
  });

  it("14. the frames after the message are kept, whatever name the error took after it was made; a stack that does not begin with its message gives none", () => {
    const renamed = new Error('codex exited with code 2, 0.4 s after its launch');
    renamed.stack = `Error: ${renamed.message}\n${tars.join('\n')}`;
    renamed.name = 'CliExitedAtLaunch';
    expect(withoutWords(renamed).stack).toBe(['CliExitedAtLaunch: codex exited with code 2, 0.4 s after its launch', ...tars].join('\n'));

    const empty = new Error('');
    empty.stack = `Error\n${tars.join('\n')}`;
    expect(withoutWords(empty).stack).toBe(['Error: (message not sent)', ...tars].join('\n'));

    // Node's own errors name their code in the stack's first line: their frames are kept too.
    const coded = Object.assign(new TypeError('The "path" argument must be of type string. Received undefined'), { code: 'ERR_INVALID_ARG_TYPE' });
    coded.stack = `TypeError [ERR_INVALID_ARG_TYPE]: ${coded.message}\n${tars.join('\n')}`;
    expect(withoutWords(coded).stack).toBe(['TypeError: code ERR_INVALID_ARG_TYPE', ...tars].join('\n'));

    const rewritten = new Error('acme merger failed');
    rewritten.stack = `    at loadTermsheetForAcmeBuyout (/Users/jdoe/clients/acme-merger/lib/terms.js:12:5)\n${tars.join('\n')}`;
    expect(withoutWords(rewritten).stack).toBe('Error: (message not sent)');
  });
});
