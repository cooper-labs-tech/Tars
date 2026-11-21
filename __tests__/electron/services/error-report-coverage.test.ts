import '../../setup/home-guard';
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodeClient, Scope, createTransport, defaultStackParser } from '@sentry/node';
import { errorReportOptions } from '../../../electron/services/error-reports/options';
import { AGENT_TOOL_PER_DAY, REPORTS_PER_DAY, ReportBudget } from '../../../electron/services/error-reports/budget';
import {
  agentToolEvent, reportFingerprint, reportKind, toReport, type ErrorReport, type ReportFacts,
} from '../../../electron/services/error-reports/report';

/**
 * What 2.0.4 adds to the reports (the maintainer's go of 2026-10-18, from the QA's diagnosis sentry-pipeline-1810):
 * the agents' tool errors as a report kind of their own (F3), the errors Tars handles leaving through the same gates
 * (F1), and the last report's answer kept for the window (F2). Through report.ts, budget.ts and options.ts, the last
 * with the real Sentry client (@sentry/node's NodeClient) and a transport that records the bytes and answers a status.
 *
 * How it fails, written before the code (2026-10-19):
 * 1. An agent tool error carries more than its code, its tool and its CLI: the agent's text, a name, a path, put in
 *    its message or beside its fields, reaches the report. Or a field outside its closed list leaves (a tool Tars has
 *    not, a CLI it does not run, a code that is not a status or one of Tars's own), where it should not leave at all.
 * 2. One leaves with no list to check it against (the facts carry no vocabulary): unchecked, it must not leave.
 * 3. A tag alone makes any error an agent tool error, with the fields it brings.
 * 4. Two different tool errors count as one for the budget (same fingerprint), or the same one as two.
 * 5. The agents' tool errors take the whole day's budget: a day of refused tools leaves no room for a crash. They may
 *    take 10 of the 20.
 * 6. That share is forgotten at a restart, or a budget file 2.0.3 wrote is no longer read.
 * 7. The last report's answer is not kept, not read back after a restart, or a damaged one is taken for an answer.
 * 8. A handled error (handled: true, from Tars's own capture) does not leave, leaves with what the SDK added around
 *    it, is counted as unhandled, or is not held to the budget.
 * 9. The window is told a report's answer without its kind, or the kind is wrong (an unhandled error, a handled one,
 *    an agent tool error, a health report).
 * 10. Over-correction: an ordinary error, or a health report, no longer leaves as it did.
 * And from the Audit's gate of #474 (M1, written red on 106e1f41, 2026-10-19):
 * 11. A handled error's message leaves, or a cause's: what Tars logs is the world's words (a git command line with a
 *     client's folder and branch, a file's path in a client's project, the start of a file a parse choked on, the
 *     user's Jira site, a prompt). The Audit's probe PA, its five messages, under both handled mechanisms.
 * 12. Under-correction of 11: what a handled error may say is lost, its closed facts (an errno code, a syscall, an
 *     exit status, a signal, one of Tars's own codes) or Tars's own fixed sentences (the channel of an IPC fault, the
 *     route of a 500, a CLI's launch exit, a task never started); or a value that only looks like one of them leaves.
 * 13. Over-correction of 11: an error nobody caught loses its message, as it never did.
 */

const HOME = os.homedir();
const PROMPT = 'please refactor the billing module for Acme Corp';
const NAME = 'Zephyrine';
const DSN = 'https://publickey@o1.ingest.example.invalid/42';
const TOOLS = new Set(['send_message', 'delegate_task', 'task_status', 'task_cancel']);
const CLIS = new Set(['claude', 'codex', 'gemini']);

const facts: ReportFacts = {
  installId: '3b1f6c2e-5d7a-4e8b-9c0d-1a2b3c4d5e6f',
  release: 'tars@2.0.4',
  home: HOME,
  host: 'MacBook-Pro-de-Somebody.local',
  os: { name: 'macOS', version: '26.0' },
  electron: '44.4.4',
  agentTools: { tools: TOOLS, clis: CLIS },
};
const bare: ReportFacts = { ...facts, agentTools: undefined };

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-report-coverage-')); });

describe('an agent tool error (F3)', () => {
  it('1. leaves as its code, its tool and its CLI, and nothing else', () => {
    const report = toReport(agentToolEvent({ code: '409', tool: 'delegate_task', cli: 'claude' }), facts)!;
    expect(report.tags).toEqual({ process: 'main', kind: 'agent-tool' });
    expect(report.contexts.tars).toEqual({ code: '409', tool: 'delegate_task', cli: 'claude' });
    expect(report.exception.values).toEqual([{
      type: 'TarsAgentToolError',
      value: 'delegate_task answered 409 (claude)',
      mechanism: { type: 'tars-agent-tool', handled: true },
    }]);
    expect(report.level).toBe('warning');
    expect(reportKind(report)).toBe('agent-tool');
  });

  it("1. what an event brings beside them never leaves: the agent's text, a name, a path", () => {
    const event = agentToolEvent({ code: '403', tool: 'send_message', cli: 'codex' }) as Record<string, any>;
    event.exception.values[0].value = `${NAME} said: ${PROMPT}`;
    event.exception.values[0].stacktrace = { frames: [{ filename: `${HOME}/clients/acme/x.js`, function: 'leak' }] };
    event.contexts.tars = { ...event.contexts.tars, message: PROMPT, agent: NAME, folder: `${HOME}/clients/acme` };
    event.extra = { prompt: PROMPT };
    const report = toReport(event, facts)!;
    const bytes = JSON.stringify(report);
    for (const absent of [PROMPT, NAME, HOME, 'clients', 'leak', 'stacktrace']) expect(bytes, absent).not.toContain(absent);
    expect(report.contexts.tars).toEqual({ code: '403', tool: 'send_message', cli: 'codex' });
    expect(report.exception.values[0].value).toBe('send_message answered 403 (codex)');
  });

  it('1. a field outside its closed list: not sent at all', () => {
    const tool = (e: { code: string; tool: string; cli: string }) => toReport(agentToolEvent(e), facts);
    expect(tool({ code: '409', tool: 'zephyrine_project', cli: 'claude' })).toBeNull();
    expect(tool({ code: '409', tool: 'delegate_task', cli: 'my-own-cli' })).toBeNull();
    expect(tool({ code: `refused for ${NAME}`, tool: 'delegate_task', cli: 'claude' })).toBeNull();
    expect(tool({ code: '600', tool: 'delegate_task', cli: 'claude' })).toBeNull();
    expect(tool({ code: '99', tool: 'delegate_task', cli: 'claude' })).toBeNull();
    expect(tool({ code: '403 Worker Zephyrine', tool: 'delegate_task', cli: 'claude' })).toBeNull();
    expect(tool({ code: '403 /Users/someone', tool: 'delegate_task', cli: 'claude' })).toBeNull();
    // Tars's own codes (a status and the code its answer carries, or one of its own words), and an unknown tool when
    // the MCP server named none: they leave.
    expect(tool({ code: '403 worker_may_not_order', tool: 'delegate_task', cli: 'claude' })?.exception.values[0].value).toBe('delegate_task answered 403 worker_may_not_order (claude)');
    expect(tool({ code: 'never-started', tool: 'delegate_task', cli: 'claude' })?.contexts.tars).toEqual({ code: 'never-started', tool: 'delegate_task', cli: 'claude' });
    expect(tool({ code: '404', tool: 'unknown', cli: 'gemini' })?.contexts.tars).toEqual({ code: '404', tool: 'unknown', cli: 'gemini' });
  });

  it('2. with no list to check it against, it does not leave', () => {
    expect(toReport(agentToolEvent({ code: '409', tool: 'delegate_task', cli: 'claude' }), bare)).toBeNull();
  });

  it('3. a tag alone does not make one: an ordinary error tagged so leaves as an ordinary error', () => {
    const report = toReport({
      exception: { values: [{ type: 'TypeError', value: 'x is undefined' }] },
      tags: { kind: 'agent-tool' },
      contexts: { tars: { code: '409', tool: 'delegate_task', cli: 'claude', message: PROMPT } },
    }, facts)!;
    expect(report.tags).toEqual({ process: 'main' });
    expect(report.contexts.tars).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain(PROMPT);
    expect(reportKind(report)).toBe('error');
  });

  it('4. one fingerprint per code, tool and CLI', () => {
    const fp = (code: string, tool: string, cli: string) => reportFingerprint(toReport(agentToolEvent({ code, tool, cli }), facts)!);
    expect(fp('409', 'delegate_task', 'claude')).toBe(fp('409', 'delegate_task', 'claude'));
    expect(new Set([
      fp('409', 'delegate_task', 'claude'), fp('403', 'delegate_task', 'claude'),
      fp('409', 'send_message', 'claude'), fp('409', 'delegate_task', 'codex'),
    ]).size).toBe(4);
  });
});

describe("the budget's share and the last answer (F2, F3)", () => {
  const file = () => path.join(dir, 'error-reports.json');

  it(`5. agent tool errors take ${AGENT_TOOL_PER_DAY} of the day's ${REPORTS_PER_DAY}, and errors keep the rest`, () => {
    expect(AGENT_TOOL_PER_DAY).toBe(10);
    let now = 1_000_000;
    const budget = new ReportBudget(file(), () => now);
    for (let i = 0; i < AGENT_TOOL_PER_DAY; i++) expect(budget.admit(`tool-${i}`, 'agent-tool'), `tool ${i}`).toBe(true);
    expect(budget.admit('tool-extra', 'agent-tool')).toBe(false);
    for (let i = 0; i < REPORTS_PER_DAY - AGENT_TOOL_PER_DAY; i++) expect(budget.admit(`error-${i}`, 'error'), `error ${i}`).toBe(true);
    expect(budget.admit('error-extra', 'error')).toBe(false);
    // A day later, room again.
    now += 24 * 3_600_000 + 1;
    expect(budget.admit('tool-next-day', 'agent-tool')).toBe(true);
  });

  it('5. errors and health reports are not held to the share', () => {
    const budget = new ReportBudget(file());
    for (let i = 0; i < 15; i++) expect(budget.admit(`error-${i}`), `error ${i}`).toBe(true);
    expect(budget.admit('abrupt', 'abrupt-end')).toBe(true);
    expect(budget.admit('handled', 'handled')).toBe(true);
  });

  it('6. the share holds across a restart, and a file 2.0.3 wrote is read as before', () => {
    let budget = new ReportBudget(file());
    for (let i = 0; i < AGENT_TOOL_PER_DAY; i++) budget.admit(`tool-${i}`, 'agent-tool');
    budget = new ReportBudget(file());
    expect(budget.admit('tool-again', 'agent-tool')).toBe(false);
    expect(budget.admit('an-error')).toBe(true);

    const old = path.join(dir, 'old.json');
    const id = '0f7c2e1a-4b3d-4c5e-8f6a-7b8c9d0e1f2a';
    fs.writeFileSync(old, JSON.stringify({ installId: id, sent: [Date.now() - 1_000], seen: { abc: Date.now() - 1_000 } }));
    const kept = new ReportBudget(old);
    expect(kept.installId).toBe(id);
    expect(kept.admit('abc')).toBe(false);
    expect(kept.last).toBeNull();
  });

  it('7. the last answer is kept, read back after a restart, and a damaged one is none', () => {
    let now = 1_760_000_000_000;
    const budget = new ReportBudget(file(), () => now);
    expect(budget.last).toBeNull();
    budget.noteAnswer('handled', 200);
    now += 5_000;
    budget.noteAnswer('agent-tool', 503);
    expect(budget.last).toEqual({ at: now, kind: 'agent-tool', status: 503 });
    expect(new ReportBudget(file()).last).toEqual({ at: now, kind: 'agent-tool', status: 503 });

    for (const last of [{ at: 'yesterday', kind: 'error', status: 200 }, { at: 1, kind: PROMPT, status: 200 }, { at: 1, kind: 'error', status: 'ok' }]) {
      const damaged = JSON.parse(fs.readFileSync(file(), 'utf8'));
      fs.writeFileSync(file(), JSON.stringify({ ...damaged, last }));
      expect(new ReportBudget(file()).last, JSON.stringify(last)).toBeNull();
    }
  });
});

describe('through the real client (F1, F2, F3)', () => {
  let sent: string[];
  let status: number;
  let answers: Array<{ id: string; status: number; kind: string }>;

  function client(withFacts: ReportFacts = facts) {
    sent = [];
    answers = [];
    const options = errorReportOptions({
      dsn: DSN,
      isEnabled: () => true,
      facts: () => withFacts,
      budget: new ReportBudget(path.join(dir, 'error-reports.json')),
      makeTransport: (o: Parameters<typeof createTransport>[0]) => createTransport(o, async request => {
        sent.push(typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf-8'));
        return { statusCode: status };
      }),
      onSent: (id, code, kind) => { answers.push({ id, status: code, kind }); },
    } as Parameters<typeof errorReportOptions>[0]);
    const c = new NodeClient({ ...options, integrations: [], stackParser: defaultStackParser });
    const scope = new Scope();
    scope.setClient(c);
    c.init();
    scope.setExtra('prompt', PROMPT);
    scope.setTag('agent', NAME);
    return { c, scope };
  }
  const events = () => sent.map(bytes => JSON.parse(bytes.trim().split('\n')[2]) as ErrorReport);

  beforeEach(() => { status = 200; });

  it('8. a handled error leaves once, as handled, with nothing the SDK added around it', async () => {
    const { c, scope } = client();
    const failure = () => {
      const error = new Error(`could not write ${HOME}/clients/acme/agents.json`);
      error.stack = `Error: could not write\n    at saveAgents (${HOME}/Applications/Tars.app/Contents/Resources/app.asar/electron/dist/core/agent-manager.js:42:7)`;
      return error;
    };
    scope.captureException(failure(), { data: { mechanism: { type: 'tars.logged', handled: true } } } as never);
    scope.captureException(failure(), { data: { mechanism: { type: 'tars.logged', handled: true } } } as never);
    await c.flush(2_000);
    expect(sent).toHaveLength(1);
    const [report] = events();
    expect(report.exception.values.at(-1)!.mechanism).toEqual({ type: 'tars.logged', handled: true });
    // Its words never leave (11): it says nothing it does not know for sure, and its frames say where.
    expect(report.exception.values.at(-1)!.value).toBe('(message not sent)');
    expect(report.exception.values.at(-1)!.stacktrace?.frames.at(-1)?.function).toBe('saveAgents');
    for (const absent of [PROMPT, NAME, HOME, '"extra"', 'acme', 'agents.json']) expect(sent[0], absent).not.toContain(absent);
    expect(answers).toEqual([{ id: report.event_id, status: 200, kind: 'handled' }]);
  });

  it('3, 8. an agent tool error leaves through the same gates, its three fields only', async () => {
    const { c, scope } = client();
    scope.captureEvent(agentToolEvent({ code: '409', tool: 'delegate_task', cli: 'claude' }) as never);
    scope.captureEvent(agentToolEvent({ code: '409', tool: 'delegate_task', cli: 'claude' }) as never);
    await c.flush(2_000);
    expect(sent).toHaveLength(1);
    const [report] = events();
    expect(report.contexts.tars).toEqual({ code: '409', tool: 'delegate_task', cli: 'claude' });
    for (const absent of [PROMPT, NAME, '"extra"']) expect(sent[0], absent).not.toContain(absent);
    expect(answers).toEqual([{ id: report.event_id, status: 200, kind: 'agent-tool' }]);
  });

  it("2. without the vocabulary in the facts, an agent tool error does not leave", async () => {
    const { c, scope } = client(bare);
    scope.captureEvent(agentToolEvent({ code: '409', tool: 'delegate_task', cli: 'claude' }) as never);
    await c.flush(2_000);
    expect(sent).toEqual([]);
  });

  it("9, 10. each report's answer is told with its kind; an unhandled error leaves as before", async () => {
    const { c, scope } = client();
    status = 503;
    scope.captureException(new Error('boom'), { data: { mechanism: { type: 'generic', handled: false } } } as never);
    await c.flush(2_000);
    expect(sent).toHaveLength(1);
    expect(events()[0].exception.values.at(-1)!.mechanism).toEqual({ type: 'generic', handled: false });
    expect(answers).toEqual([{ id: events()[0].event_id, status: 503, kind: 'error' }]);
  });
});

describe("a handled error's words never leave (11 to 13, the Audit's M1 on #474)", () => {
  const jdoe: ReportFacts = { ...facts, home: '/Users/jdoe', host: 'MacBook-Pro-de-jdoe.local' };
  /** The Audit's probe PA: five errors Tars logs, as their messages read. */
  const PA = [
    "Command failed: git --no-optional-locks -C /Users/jdoe/clients/acme-merger worktree add -b feat/acme-buyout-terms /Users/jdoe/clients/acme-merger/.worktrees/lawyer HEAD\nfatal: a branch named 'feat/acme-buyout-terms' already exists",
    "ENOENT: no such file or directory, open '/Users/jdoe/clients/acme-merger/reports/termsheet-draft-v3.md'",
    'Unexpected token \'p\', "patient_id=48213;diagnosis=..." is not valid JSON',
    'request to https://acme-legal.atlassian.net/rest/api/3/myself failed, reason: getaddrinfo ENOTFOUND acme-legal.atlassian.net',
    'Command failed: claude -p Summarise the board minutes for the Acme acquisition and draft the email to the CFO',
  ];
  const WORDS = /acme|buyout|lawyer|termsheet|patient|diagnosis|48213|atlassian|summarise|minutes|CFO|clients|worktree|branch|fatal|myself|unexpected/i;
  const frame = { filename: '/Applications/Tars.app/Contents/Resources/app.asar/electron/dist/core/agent-manager.js', function: 'saveAgents', lineno: 42, colno: 7, in_app: true };

  for (const mechanism of ['tars.logged', 'tars.handled']) {
    it(`11. probe PA under ${mechanism}: no word of the message leaves, nor of its cause's`, () => {
      for (const message of PA) {
        const report = toReport({ exception: { values: [
          { type: 'Error', value: message, mechanism: { type: 'chained', handled: true } },
          { type: 'Error', value: message, mechanism: { type: mechanism, handled: true }, stacktrace: { frames: [frame] } },
        ] } }, jdoe)!;
        expect(JSON.stringify(report), message).not.toMatch(WORDS);
        expect(report.exception.values.map(v => v.value), message).toEqual(['(message not sent)', '(message not sent)']);
        // Where it happened still leaves: Tars's own frames.
        expect(report.exception.values[1].stacktrace?.frames).toEqual([{ ...frame, filename: frame.filename }]);
      }
    });
  }

  it("12. what a handled error may say: its closed facts, and Tars's own fixed sentences", () => {
    const said = (type: string, value: string) =>
      toReport({ exception: { values: [{ type, value, mechanism: { type: 'tars.handled', handled: true } }] } }, facts)!.exception.values[0].value;
    for (const [type, value] of [
      ['Error', 'code ENOENT, syscall open'],
      ['Error', 'code ERR_INVALID_ARG_TYPE'],
      ['Error', 'exit 128'],
      ['Error', 'signal SIGTERM'],
      ['Error', 'code worker_may_not_order'],
      ['CliExitedAtLaunch', 'codex exited with code 2, 0.4 s after its launch'],
      ['TaskNeverStarted', 'claude: the task never started, 600 s after it was sent'],
      ['IpcHandlerError', 'project:search-files'],
      ['ApiRouteError', 'POST /api/vault/documents answered 500'],
      ['ApiRouteError', 'POST /api/agents/:id/run-task answered 503 agent_busy'],
    ]) expect(said(type, value), `${type}: ${value}`).toBe(value);
    // What only looks like one of them: withheld.
    for (const [type, value] of [
      ['Error', 'code ENOENT, open /Users/x/acme.md'],
      ['Error', 'code CFO'],
      ['Error', 'exit 128 because the board said so'],
      ['IpcHandlerError', 'project:search-files acme merger'],
      ['ApiRouteError', 'POST /api/vault/documents answered 500: Error: acme'],
      ['CliExitedAtLaunch', 'acme exited because the board said so'],
      ['TaskNeverStarted', 'Acme: the task never started'],
      ['Error', 'IpcHandlerError'],
    ]) expect(said(type, value), `${type}: ${value}`).toBe('(message not sent)');
  });

  it('13. an error nobody caught keeps its message, as before', () => {
    const report = toReport({ exception: { values: [{ type: 'Error', value: `could not read ${HOME}/clients/acme/notes.md`, mechanism: { type: 'generic', handled: false } }] } }, facts)!;
    expect(report.exception.values[0].value).toBe('could not read ~/clients/acme/notes.md');
  });
});
