import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodeClient, Scope, createTransport, defaultStackParser } from '@sentry/node';
import { errorReportOptions } from '../../../electron/services/error-reports/options';
import { ReportBudget } from '../../../electron/services/error-reports/budget';
import type { ReportFacts } from '../../../electron/services/error-reports/report';

/**
 * What reaches the network, byte for byte, from the real Sentry client with
 * Tars's options (@sentry/node's NodeClient, the class @sentry/electron's main
 * process runs). Only the network is replaced, by a transport that keeps the
 * bytes it is handed.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. A path under the home folder, a token or a conversation string, put where
 *    the SDK carries them (the error, breadcrumbs, the user, extra, tags,
 *    contexts, attachments), reaches the transport.
 * 2. With the setting off, anything reaches it: at start, and at once when it
 *    is turned off while running, an event already on its way included.
 * 3. Something other than an error event reaches it: a message, a session, an
 *    attachment, a feedback, an envelope sent straight to the client the way
 *    @sentry/electron forwards a renderer's replays, spans and profiles.
 * 4. The daily budget is not applied on this path: the same error twice.
 * 5. Tracing, sessions or client reports are on in the options.
 * 6. Over-correction: an error with the setting on does not leave at all.
 * 7. Errors thrown while the setting is off use up the day's budget, so the
 *    same error, once it is turned on, is never sent.
 */

const HOME = os.homedir();
const PROMPT = 'please refactor the billing module for Acme Corp';
const KEY = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const DSN = 'https://publickey@o1.ingest.example.invalid/42';

let sent: string[];
let enabled: boolean;
let dir: string;

const facts: ReportFacts = {
  installId: '3b1f6c2e-5d7a-4e8b-9c0d-1a2b3c4d5e6f',
  release: 'tars@1.9.1',
  home: HOME,
  host: 'MacBook-Pro-de-Somebody.local',
  os: { name: 'macOS', version: '26.0' },
  electron: '44.4.4',
};

function recordingTransport(options: Parameters<typeof createTransport>[0]) {
  return createTransport(options, async request => {
    sent.push(typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf-8'));
    return { statusCode: 200 };
  });
}

function client() {
  const options = errorReportOptions({
    dsn: DSN,
    isEnabled: () => enabled,
    facts: () => facts,
    budget: new ReportBudget(path.join(dir, 'error-reports.json')),
    makeTransport: recordingTransport,
  });
  const c = new NodeClient({ ...options, integrations: [], stackParser: defaultStackParser });
  const scope = new Scope();
  scope.setClient(c);
  c.init();
  scope.addBreadcrumb({ category: 'console', message: PROMPT });
  scope.setUser({ email: 'demo@example.com', ip_address: '10.0.0.2' });
  scope.setExtra('prompt', PROMPT);
  scope.setTag('project', `${HOME}/clients/acme`);
  scope.setContext('conversation', { text: PROMPT });
  scope.addAttachment({ filename: 'transcript.txt', data: PROMPT });
  return { c, scope };
}

function failure(): Error {
  const error = new Error(`could not read ${HOME}/clients/acme/notes.md with ${KEY}`);
  error.stack = `Error: could not read ${HOME}/clients/acme/notes.md\n    at startAgent (${HOME}/Applications/Tars.app/Contents/Resources/app.asar/electron/dist/main.js:42:7)`;
  return error;
}

beforeEach(() => {
  sent = [];
  enabled = true;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-report-transport-'));
});

describe('what reaches the transport', () => {
  it('6, 1. an error, and no path, token or conversation in its bytes', async () => {
    const { c, scope } = client();
    scope.captureException(failure());
    await c.flush(2_000);

    expect(sent).toHaveLength(1);
    const bytes = sent[0];
    expect(bytes).toContain('"type":"Error"');
    expect(bytes).toContain('could not read ~/clients/acme/notes.md');
    expect(bytes).toContain('startAgent');
    for (const absent of [HOME, KEY, PROMPT, 'demo@example.com', '10.0.0.2', 'transcript.txt', '"breadcrumbs"', '"extra"']) {
      expect(bytes, absent).not.toContain(absent);
    }
    // Every item in the envelope is the one error event.
    const lines = bytes.trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toEqual({ type: 'event' });
  });

  it('2. nothing at all while the setting is off', async () => {
    enabled = false;
    const { c, scope } = client();
    scope.captureException(failure());
    scope.captureException(new Error('another'));
    await c.flush(2_000);
    expect(sent).toEqual([]);
  });

  it('2. nothing once it is turned off, an event already captured included', async () => {
    const { c, scope } = client();
    scope.captureException(failure());
    enabled = false;
    scope.captureException(new Error('after'));
    await c.flush(2_000);
    expect(sent).toEqual([]);
  });

  it('7. an error thrown while off does not use the budget: once on, it is sent', async () => {
    enabled = false;
    const { c, scope } = client();
    scope.captureException(failure());
    await c.flush(2_000);
    enabled = true;
    scope.captureException(failure());
    await c.flush(2_000);
    expect(sent).toHaveLength(1);
  });

  it('3. no message, and no envelope that holds no error event', async () => {
    const { c, scope } = client();
    scope.captureMessage(PROMPT);
    await c.sendEnvelope([{ sent_at: new Date().toISOString() }, [
      [{ type: 'session' }, { sid: 'x', status: 'ok' }],
      [{ type: 'replay_event' }, { replay_id: 'x' }],
      [{ type: 'feedback' }, { contexts: { feedback: { message: PROMPT } } }],
      [{ type: 'span' }, { description: PROMPT }],
    ]] as never);
    await c.flush(2_000);
    expect(sent).toEqual([]);
  });

  it('4. the same error once, however often it is thrown', async () => {
    const { c, scope } = client();
    for (let i = 0; i < 5; i++) scope.captureException(failure());
    await c.flush(2_000);
    expect(sent).toHaveLength(1);
  });

  it('5. asks for no tracing, no sessions and no client reports', () => {
    const options = errorReportOptions({
      dsn: DSN, isEnabled: () => true, facts: () => facts,
      budget: new ReportBudget(path.join(dir, 'b.json')), makeTransport: recordingTransport,
    });
    expect(options.tracesSampleRate).toBeUndefined();
    expect(options.tracesSampler).toBeUndefined();
    expect(options.sendClientReports).toBe(false);
    expect(options.sendDefaultPii).toBe(false);
    expect(options.enableLogs).toBe(false);
    expect(options.maxBreadcrumbs).toBe(0);
  });
});
