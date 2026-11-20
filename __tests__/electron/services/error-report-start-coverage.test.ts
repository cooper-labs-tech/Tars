import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * What the reports' start wires in 2.0.4 (the maintainer's go of 2026-10-18, F1 to F4, from the QA's diagnosis
 * sentry-pipeline-1810), with the SDK replaced as in error-report-start.test.ts.
 *
 * How it fails, written before the code (2026-10-19):
 * 1. (F2) Nothing says the reports are on: no line at start naming the version.
 * 2. (F4) The SDK is started without the onFatalError main hands it, and shows Electron's box after its flush.
 * 3. (F1) What main logs at error level is not reported once the reports are on; or it is while they are off, or
 *    before the SDK has started (a hook on console.error in the process of a user who never asked for reports).
 * 4. (F1) A handled error met at a site Tars captures (an API route's 500, a CLI that exited at its launch) does not
 *    reach the SDK, or reaches it as unhandled, or reaches it while the reports are off.
 * 5. (F3) An agent tool error does not reach the SDK as its own kind, or does while the reports are off; or the facts
 *    the reports are rebuilt with carry no vocabulary, and every agent tool error is dropped.
 * 6. (F2) A report's answer is not logged with Sentry's status, or not kept; the window cannot read the last one, or
 *    reading it while the reports are off makes the reports' file (an install id the user never asked for).
 * And from the Audit's gate of #474 (M1, written red on 106e1f41, 2026-10-19):
 * 7. (F1) The SDK is handed the logged or captured error itself, its message and its causes' with it: it must be
 *    handed a copy with its type, its closed facts and its frames only (handled.ts withoutWords).
 */

const loaded = vi.hoisted(() => ({ count: 0 }));
const init = vi.hoisted(() => vi.fn());
const captured = vi.hoisted(() => ({ exceptions: [] as Array<{ error: unknown; hint: unknown }>, events: [] as unknown[] }));
const dataDir = vi.hoisted(() => ({ path: '' }));
vi.mock('@sentry/electron/main', () => {
  loaded.count++;
  const integration = (name: string) => () => ({ name });
  return {
    init,
    IPCMode: { Classic: 1, Protocol: 2, Both: 3 },
    onUncaughtExceptionIntegration: integration('OnUncaughtException'),
    onUnhandledRejectionIntegration: integration('OnUnhandledRejection'),
    linkedErrorsIntegration: integration('LinkedErrors'),
    makeElectronTransport: vi.fn(() => ({ send: vi.fn(async () => ({ statusCode: 202 })), flush: vi.fn(async () => true) })),
    captureException: vi.fn((error: unknown, hint: unknown) => { captured.exceptions.push({ error, hint }); return 'id'; }),
    captureEvent: vi.fn((event: unknown) => { captured.events.push(event); return 'id'; }),
    flush: vi.fn(async () => true),
  };
});
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: { getVersion: () => '1.9.1', isReady: () => false, getPath: () => '/tmp', isPackaged: false },
    ipcMain: new EventEmitter(),
  };
});
vi.mock('../../../electron/constants', async (original) => ({
  ...(await original<typeof import('../../../electron/constants')>()),
  get DATA_DIR() { return dataDir.path; },
}));

const VOCABULARY = { tools: new Set(['delegate_task', 'send_message']), clis: new Set(['claude', 'codex']) };
const onFatalError = vi.fn();

let realError: typeof console.error;
beforeEach(() => {
  loaded.count = 0;
  init.mockReset();
  captured.exceptions = [];
  captured.events = [];
  dataDir.path = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-report-start-coverage-'));
  realError = console.error;
  vi.resetModules();
});
afterEach(async () => {
  // The hook is taken off with the reports, whatever a test left.
  console.error = realError;
  (await import('../../../electron/services/error-reports/handled')).setReportSinks(null);
  vi.restoreAllMocks();
});

async function start(isEnabled: () => boolean) {
  const { startErrorReports } = await import('../../../electron/services/error-reports');
  const reports = startErrorReports(isEnabled, 'darwin', { onFatalError, vocabulary: VOCABULARY, channels: new Set(['agent:start']) });
  await reports.sync();
  return reports;
}
const handled = () => import('../../../electron/services/error-reports/handled');

describe('the reports at start (F2, F4)', () => {
  it('1. say they are on, with the version', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await start(() => true);
    expect(log).toHaveBeenCalledWith('[error-reports] error reports on, tars@1.9.1');
  });

  it("2. hand the SDK main's onFatalError", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await start(() => true);
    expect(init.mock.calls[0][0].onFatalError).toBe(onFatalError);
  });
});

describe('what main logs, and what Tars captures (F1)', () => {
  it('3. an Error logged at error level reaches the SDK as handled, once the reports are on', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await start(() => true);
    const error = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/jdoe/clients/acme/agents.json'"), { code: 'ENOENT', syscall: 'open' });
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    console.error('[agents] save failed:', error);
    spy.mockRestore();
    expect(captured.exceptions).toHaveLength(1);
    const [{ error: sent, hint }] = captured.exceptions;
    expect(hint).toEqual({ data: { mechanism: { type: 'tars.logged', handled: true } } });
    // 7. A copy: its type, its closed facts and its frames, never its words.
    expect(sent).not.toBe(error);
    expect((sent as Error).message).toBe('code ENOENT, syscall open');
    expect((sent as Error).stack).not.toMatch(/acme|jdoe/);
    expect((sent as Error).stack).toContain(error.stack!.split('\n')[1]);
  });

  it("3. an IPC handler's fault is reported under its channel's name", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await start(() => true);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fault = new TypeError("Cannot read properties of undefined (reading 'id')");
    console.error("Error occurred in handler for 'agent:start':", fault);
    spy.mockRestore();
    const [only] = captured.exceptions;
    expect((only.error as Error).name).toBe('IpcHandlerError');
    expect((only.error as Error).message).toBe('agent:start');
    // 7. Its cause is copied too: the fault's type and frames, not its words.
    expect(((only.error as Error).cause as Error).name).toBe('TypeError');
    expect(((only.error as Error).cause as Error).message).toBe('(message not sent)');
    expect((only.error as Error).cause).not.toBe(fault);
  });

  it('3. nothing is hooked while the reports are off', async () => {
    const before = console.error;
    await start(() => false);
    expect(console.error).toBe(before);
    expect(loaded.count).toBe(0);
  });

  it('4. a site Tars captures reaches the SDK as handled; nothing while the reports are off', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let on = true;
    await start(() => on);
    const { reportHandledError } = await handled();
    const error = Object.assign(new Error('codex exited with code 2, 0.4 s after its launch'), { name: 'CliExitedAtLaunch' });
    reportHandledError(error);
    expect(captured.exceptions).toHaveLength(1);
    expect(captured.exceptions[0].hint).toEqual({ data: { mechanism: { type: 'tars.handled', handled: true } } });
    // Tars's own fixed sentence, built from closed facts, is kept.
    expect((captured.exceptions[0].error as Error).name).toBe('CliExitedAtLaunch');
    expect((captured.exceptions[0].error as Error).message).toBe('codex exited with code 2, 0.4 s after its launch');
    on = false;
    reportHandledError(new Error('while off'));
    expect(captured.exceptions).toHaveLength(1);
  });
});

describe("the agents' tool errors (F3)", () => {
  it('5. reach the SDK as their own kind, and not while the reports are off', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let on = true;
    await start(() => on);
    const { reportAgentToolError } = await handled();
    reportAgentToolError({ code: '409', tool: 'delegate_task', cli: 'claude' });
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({ tags: { kind: 'agent-tool' }, contexts: { tars: { code: '409', tool: 'delegate_task', cli: 'claude' } } });
    on = false;
    reportAgentToolError({ code: '404', tool: 'send_message', cli: 'claude' });
    expect(captured.events).toHaveLength(1);
  });

  it('5. the facts the reports are rebuilt with carry the vocabulary', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await start(() => true);
    const { beforeSend } = init.mock.calls[0][0];
    const { agentToolEvent } = await import('../../../electron/services/error-reports/report');
    expect(beforeSend(agentToolEvent({ code: '409', tool: 'delegate_task', cli: 'codex' }))?.contexts.tars).toEqual({ code: '409', tool: 'delegate_task', cli: 'codex' });
  });
});

describe("a report's answer (F2)", () => {
  it("6. is logged with Sentry's status and kept, and the window reads the last one", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const reports = await start(() => true);
    expect(reports.lastReport()).toBeNull();
    const { transport } = init.mock.calls[0][0];
    const event = { event_id: 'a'.repeat(32), exception: { values: [{ type: 'Error', value: 'x', mechanism: { type: 'tars.logged', handled: true } }] } };
    await transport({}).send([{ event_id: event.event_id }, [[{ type: 'event' }, event]]]);
    expect(log).toHaveBeenCalledWith('[error-reports] sent a handled report: HTTP 202');
    const last = reports.lastReport();
    expect(last).toMatchObject({ kind: 'handled', status: 202 });
    expect(Number.isNaN(Date.parse(last!.at))).toBe(false);
  });

  it('6. reading it while the reports are off makes no file', async () => {
    const reports = await start(() => false);
    expect(reports.lastReport()).toBeNull();
    expect(fs.existsSync(path.join(dataDir.path, 'error-reports.json'))).toBe(false);
  });
});
