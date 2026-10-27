import { describe, it, expect } from 'vitest';
import { statusFix, turnOnRecord, type StatusFacts, type TurnRecord } from '../../../electron/services/status-truth';

/**
 * An agent's status reconciled with its CLI's own record when an event never reached Tars (the DB brief of 28/10,
 * item B of the resources plan). Measured on 28/10 (reports/db-status-and-sleep-2810.md): a message Tars typed at
 * a Stop that the CLI never took left Kotsna-QA `running` at its prompt for 42 minutes; a claude that died mid-turn
 * left Parallel-Frontend `running` with no CLI for two days. Hooks keep the status; this only puts it right when
 * the record and the process say otherwise, and never on silence alone: a quiet transcript says nothing.
 *
 * How it fails, written before the code.
 *
 * The record, read from the tail of a Claude Code transcript (turnOnRecord):
 * R1 a turn in progress (a prompt, then the model's entries, no end yet) read as ended, or the reverse;
 * R2 an end Claude Code writes not taken as one: `system` `turn_duration`, and the interrupt marker ("[Request
 *    interrupted by user]", with or without "for tool use"), which ends a turn with no Stop at all; or a
 *    `stop_hook_summary` alone taken as one: a Stop hook that blocks writes it and the turn goes on;
 * R3 a prompt just submitted, with nothing after it yet, read as no turn;
 * R4 what is no turn read as one: a meta entry, a compact summary, a local command (`/compact`, `/model`: no
 *    model call, no Stop), a subagent's sidechain entry, a queue operation, an attachment, a title, a mode;
 * R5 the tail's first line, cut by the read, or a line that is not JSON, breaks the read;
 * R6 a tail with nothing of a turn in it is read as an ended turn (it says nothing: undefined).
 *
 * The rule (statusFix), every time measured from the pass's period E (30 s; four passes is the grace):
 * S1 `running` or a dialog's `waiting` with no CLI in the terminal is kept (Parallel-Frontend): it is `completed`,
 *    as SessionEnd would have posted;
 * S2 ... but a launch on its way, or a turn handed or started within the grace, is not touched;
 * S3 `running` whose record says the turn ended, with a message handed after the last turn began and not taken
 *    within the grace (Kotsna-QA), is kept: it is `idle`, said `not-taken`;
 * S4 `running` whose record says the turn ended and whose last turn began past the grace, nothing handed since
 *    (a Stop post lost), is kept: `idle`, said `turn-ended`;
 * S5 `running` whose record says a turn is in progress, or whose record cannot be read, or that was handed a
 *    message within the grace, is touched;
 * S6 `idle` (or the idle prompt's `waiting`) whose record shows a turn in progress, written within the grace and
 *    after the agent came to rest, is kept (a start post lost): it is `running`, said `turn-on-record`;
 * S7 ... but a record whose last entry is older than the grace (a turn a killed CLI left open), or that was written
 *    before the rest began (the end is being written as the Stop lands), turns a resting agent `running`;
 * S8 a status the record rules do not own is changed: a permission dialog with its CLI, an error, stopped,
 *    asleep, completed;
 * S9 an agent at rest whose CLI is gone is called `completed` or `running` (the sleep pass reads `no-cli` for it).
 */

const E = 30_000;
const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const at = (ms: number) => NOW - ms;

const entry = (o: Record<string, unknown>) => JSON.stringify({ sessionId: 's', timestamp: '2026-10-28T11:59:00.000Z', ...o });
const prompt = (text: string, ts?: string) => entry({ type: 'user', message: { role: 'user', content: text }, ...(ts ? { timestamp: ts } : {}) });
const said = (ts?: string) => entry({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, ...(ts ? { timestamp: ts } : {}) });
const toolResult = () => entry({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } });
const ended = (ts?: string, subtype = 'turn_duration') => entry({ type: 'system', subtype, ...(ts ? { timestamp: ts } : {}) });
const tail = (...lines: string[]) => lines.join('\n') + '\n';

describe('turnOnRecord: what the transcript says of the last turn', () => {
  it('R1: a prompt and the model\'s entries with no end are a turn in progress; an end after them is not', () => {
    expect(turnOnRecord(tail(prompt('go'), said(), toolResult(), said()))?.inTurn).toBe(true);
    expect(turnOnRecord(tail(prompt('go'), said(), ended()))?.inTurn).toBe(false);
    expect(turnOnRecord(tail(ended(), prompt('again'), said()))?.inTurn).toBe(true);
  });

  it('R2: turn_duration and the interrupt marker each end a turn; a stop_hook_summary alone does not', () => {
    expect(turnOnRecord(tail(prompt('go'), said(), ended(undefined, 'stop_hook_summary'), ended()))?.inTurn).toBe(false);
    // A Stop hook that blocked: its summary is written, and the turn goes on.
    expect(turnOnRecord(tail(prompt('go'), said(), ended(undefined, 'stop_hook_summary')))?.inTurn).toBe(true);
    for (const marker of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
      expect(turnOnRecord(tail(prompt('go'), said(), prompt(marker)))?.inTurn, marker).toBe(false);
      expect(turnOnRecord(tail(prompt('go'), said(), entry({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: marker }] } })))?.inTurn, marker).toBe(false);
    }
  });

  it('R3: a prompt just submitted, nothing after it yet, is a turn', () => {
    expect(turnOnRecord(tail(prompt('go'), said(), ended(), prompt('next')))?.inTurn).toBe(true);
  });

  it('R4: meta, compact summaries, local commands, sidechains and the bookkeeping entries are no turn', () => {
    const rest = [
      entry({ type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' } }),
      entry({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued' } }),
      prompt('<command-name>/compact</command-name>\n<command-message>compact</command-message>'),
      prompt('<local-command-stdout>Compacted</local-command-stdout>'),
      entry({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] } }),
      entry({ type: 'queue-operation', operation: 'enqueue', content: 'hi' }),
      entry({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'hi' } }),
      entry({ type: 'system', subtype: 'compact_boundary' }),
      JSON.stringify({ type: 'ai-title', title: 'x' }),
      JSON.stringify({ type: 'last-prompt' }),
    ];
    expect(turnOnRecord(tail(prompt('go'), said(), ended(), ...rest))?.inTurn).toBe(false);
  });

  it('R5: the cut first line and lines that are not JSON are skipped', () => {
    const text = `ype":"assistant","message":{}}\n${prompt('go')}\nnot json\n${said()}\n${ended()}\n`;
    expect(turnOnRecord(text)?.inTurn).toBe(false);
    expect(turnOnRecord(`{"type":"user","mess\n${prompt('go')}\n${said()}\n`)?.inTurn).toBe(true);
  });

  it('R6: a tail with nothing of a turn says nothing', () => {
    expect(turnOnRecord('')).toBeUndefined();
    expect(turnOnRecord(tail(JSON.stringify({ type: 'ai-title' }), entry({ type: 'queue-operation', operation: 'enqueue' })))).toBeUndefined();
  });

  it('says when the record was last written by a turn and when it last ended', () => {
    const r = turnOnRecord(tail(prompt('go', '2026-10-28T11:00:00.000Z'), said('2026-10-28T11:01:00.000Z'), ended('2026-10-28T11:01:01.000Z'), prompt('next', '2026-10-28T11:30:00.000Z')));
    expect(r).toEqual({ inTurn: true, lastAt: Date.parse('2026-10-28T11:30:00.000Z'), endedAt: Date.parse('2026-10-28T11:01:01.000Z') });
  });
});

const record = (inTurn: boolean, lastAgo = 10 * 60_000): TurnRecord => ({ inTurn, lastAt: at(lastAgo), ...(inTurn ? {} : { endedAt: at(lastAgo) }) });
const facts = (o: Partial<StatusFacts>): StatusFacts => ({
  status: 'running', now: NOW, cliRunning: true, starting: false,
  statusSince: ago(10 * 60_000), lastTurnStartedAt: ago(20 * 60_000), workHandedAt: ago(20 * 60_000),
  record: record(false), ...o,
});

describe('statusFix: the status put right from the record and the process', () => {
  it('S1: running or in a dialog with no CLI is completed', () => {
    expect(statusFix(facts({ cliRunning: false }), E)).toEqual({ status: 'completed', why: 'no-cli' });
    expect(statusFix(facts({ cliRunning: false, record: undefined }), E)).toEqual({ status: 'completed', why: 'no-cli' });
    expect(statusFix(facts({ status: 'waiting', waitingReason: 'permission', cliRunning: false }), E)).toEqual({ status: 'completed', why: 'no-cli' });
  });

  it('S2: not while a launch is on its way, nor within the grace of a hand-over or a turn start', () => {
    expect(statusFix(facts({ cliRunning: false, starting: true }), E)).toBeNull();
    expect(statusFix(facts({ cliRunning: false, workHandedAt: ago(E) }), E)).toBeNull();
    expect(statusFix(facts({ cliRunning: false, lastTurnStartedAt: ago(E) }), E)).toBeNull();
  });

  it('S3: a message handed after the last turn began, not taken within the grace, is idle: not-taken', () => {
    expect(statusFix(facts({ lastTurnStartedAt: ago(20 * 60_000), workHandedAt: ago(5 * E), record: record(false, 5 * E) }), E))
      .toEqual({ status: 'idle', why: 'not-taken' });
  });

  it('S4: a turn the record ended, begun past the grace, nothing handed since, is idle: turn-ended', () => {
    expect(statusFix(facts({ lastTurnStartedAt: ago(10 * E), workHandedAt: ago(20 * E), record: record(false, 5 * E) }), E))
      .toEqual({ status: 'idle', why: 'turn-ended' });
    // No hand-over ever recorded.
    expect(statusFix(facts({ lastTurnStartedAt: ago(10 * E), workHandedAt: undefined }), E)).toEqual({ status: 'idle', why: 'turn-ended' });
  });

  it('S5: a turn in progress on record, a record not read, or a hand-over within the grace keeps running', () => {
    expect(statusFix(facts({ record: record(true, 1_000) }), E)).toBeNull();
    // In progress for a long while (a long Bash writes nothing): still in progress.
    expect(statusFix(facts({ record: record(true, 60 * 60_000) }), E)).toBeNull();
    expect(statusFix(facts({ record: undefined }), E)).toBeNull();
    expect(statusFix(facts({ workHandedAt: ago(E), record: record(false, 5 * E) }), E)).toBeNull();
    expect(statusFix(facts({ lastTurnStartedAt: ago(E), record: record(false, 5 * E) }), E)).toBeNull();
  });

  it('S6: at rest, with a turn in progress on record written lately and after the rest began, is running', () => {
    const fresh = { inTurn: true, lastAt: at(2_000) } satisfies TurnRecord;
    expect(statusFix(facts({ status: 'idle', statusSince: ago(60_000), record: fresh }), E)).toEqual({ status: 'running', why: 'turn-on-record' });
    expect(statusFix(facts({ status: 'waiting', waitingReason: 'idle', statusSince: ago(60_000), record: fresh }), E)).toEqual({ status: 'running', why: 'turn-on-record' });
  });

  it('S7: not from a record left open long ago, nor from one written before the rest began', () => {
    expect(statusFix(facts({ status: 'idle', statusSince: ago(60 * 60_000), record: { inTurn: true, lastAt: at(5 * E) } }), E)).toBeNull();
    expect(statusFix(facts({ status: 'idle', statusSince: ago(2_000), record: { inTurn: true, lastAt: at(3_000) } }), E)).toBeNull();
    expect(statusFix(facts({ status: 'idle', statusSince: undefined, record: { inTurn: true, lastAt: at(2_000) } }), E)).toBeNull();
  });

  it('S8: a status the record rules do not own is left alone', () => {
    for (const status of ['error', 'stopped', 'asleep', 'completed'] as const) {
      expect(statusFix(facts({ status, record: { inTurn: true, lastAt: at(2_000) } }), E), status).toBeNull();
      expect(statusFix(facts({ status, cliRunning: false }), E), status).toBeNull();
    }
    expect(statusFix(facts({ status: 'waiting', waitingReason: 'permission', record: record(false, 5 * E) }), E)).toBeNull();
  });

  it('S9: at rest with no CLI stays as it is', () => {
    expect(statusFix(facts({ status: 'idle', cliRunning: false }), E)).toBeNull();
    expect(statusFix(facts({ status: 'idle', cliRunning: false, record: { inTurn: true, lastAt: at(2_000) } }), E)).toBeNull();
  });
});
