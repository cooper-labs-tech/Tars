import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IPty } from 'node-pty';

/**
 * What the transcript probe must not take for a finished command, and the
 * transcript it must find. Three cases the tests of #128 do not reach, found by
 * mutation at its gate (2026-09-23): a mutant that accepts any record type, one
 * that reads a session other than `currentSessionId`, and one that ignores the
 * worktree all survived.
 *
 * Measured on Claude Code 2.1.280 in a sandbox Tars: backing out of the "Switch
 * model?" confirmation (Fable) with Esc returns to the /model picker, which stays
 * open, and writes two `system` records of subtype `local_command` carrying
 * `<command-name>/model</command-name>` and `<local-command-stdout>Kept model as
 * ...`. Taking those for the end of the command types the message into the open
 * picker, whose Enter picks a model. The same records follow a /model cancelled
 * with Esc, so they cannot be told apart from the transcript alone.
 *
 * Harness as in held-after-a-command.test.ts: the real writer, draft model and
 * transcript reader; the terminal records what it is given.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import {
  FIELD_PROBE_MS, TYPING_PAUSE_MS, PROGRAMMATIC_SUBMIT_DELAY_MS,
  rememberTerminalOwner, resetTerminalInput, setFieldProbe, writeHumanInput, writeProgrammaticInput,
} from '../../../electron/core/pty-manager';
import { lastLocalCommandAt } from '../../../electron/services/agent-truth';
import { encodeProjectDirName } from '../../../electron/utils/resume-session';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-held-probe-blind-spots-'));
const project = path.join(home, 'tars-hermes');
const worktree = path.join(home, 'tars-hermes-worktrees', 'feat-x');
const CURRENT = '689838e5-82b4-429e-952e-e700fd915536';
const PREVIOUS = '11111111-2222-4333-8444-555555555555';
let agent: { currentSessionId?: string; resumableSessionId?: string; projectPath: string; worktreePath?: string };
const BRIEF = 'Gate PR #126.\nRead the report first.\nThen run the suite.\nThen answer.';

const transcriptOf = (root: string, sessionId: string) =>
  path.join(home, '.claude', 'projects', encodeProjectDirName(root), `${sessionId}.jsonl`);

function makeTerminal() {
  const written: string[] = [];
  const pty = { write: (data: string) => { written.push(data); } } as unknown as IPty;
  return { pty, written, get typed() { return written.join(''); } };
}
let terminal: ReturnType<typeof makeTerminal>;
const types = (text: string) => { for (const ch of [...text]) writeHumanInput(terminal.pty, ch); };
const key = (data: string) => writeHumanInput(terminal.pty, data);

function sessionStarted(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'say hi' }, timestamp: new Date(Date.now() - 60_000).toISOString() }) + '\n');
}

/** The two user records 2.1.280 writes when /model closes with a model set. */
function modelSet(file: string, ms = 50): void {
  const at = new Date(Date.now() + ms).toISOString();
  fs.appendFileSync(file, [
    { type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>' }, timestamp: at },
    { type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model to `Opus 5.5 (1M context)`</local-command-stdout>' }, timestamp: at },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
}

/** The two system records 2.1.280 writes when the Fable confirmation is backed out of, the picker still open. */
function keptWhilePickerOpen(file: string, ms = 70): void {
  const at = new Date(Date.now() + ms).toISOString();
  fs.appendFileSync(file, [
    { type: 'system', subtype: 'local_command', content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>', level: 'info', timestamp: at, isMeta: false },
    { type: 'system', subtype: 'local_command', content: '<local-command-stdout>Kept model as `Opus 5.5 (1M context)`</local-command-stdout>', level: 'info', timestamp: at, isMeta: false, commandRun: { command: 'model', args: '' } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
}

/** JeanBrasse at the /model picker: the command, Enter, down to Fable, Enter (the confirmation opens), Esc (back to the picker). */
function backsOutOfTheConfirmation(): void {
  types('/model');
  key('\r');
  key('\x1b[B');
  key('\r');
  key('\x1b');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-23T02:45:00.000Z'));
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  agent = { currentSessionId: CURRENT, resumableSessionId: PREVIOUS, projectPath: project };
  terminal = makeTerminal();
  rememberTerminalOwner(terminal.pty, 'worker');
  setFieldProbe(id => (id === 'worker' ? lastLocalCommandAt(agent, home) : undefined));
});

afterEach(() => {
  setFieldProbe(null);
  resetTerminalInput(terminal.pty);
  vi.useRealTimers();
});

describe('what the probe must not take for a finished command', () => {
  it('a system local_command record, written while the /model picker is still open', () => {
    const file = transcriptOf(project, CURRENT);
    sessionStarted(file);
    backsOutOfTheConfirmation();
    keptWhilePickerOpen(file);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    terminal.written.length = 0;

    const outcome = writeProgrammaticInput(terminal.pty, BRIEF, true, { agentId: 'worker', from: 'Tars-Orchestrator' });
    vi.advanceTimersByTime(FIELD_PROBE_MS * 20);

    expect(outcome).toBe('held');
    expect(terminal.written, 'typed into the open picker, whose Enter picks a model').toEqual([]);
  });

  it('a command record in a session that is not the current one', () => {
    // The previous session of the same agent, kept as resumable: its records say
    // nothing about the field of the session running now.
    sessionStarted(transcriptOf(project, CURRENT));
    const previous = transcriptOf(project, PREVIOUS);
    sessionStarted(previous);
    types('/model');
    key('\r');
    key('\x1b');
    modelSet(previous, 80);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    terminal.written.length = 0;

    writeProgrammaticInput(terminal.pty, BRIEF, true, { agentId: 'worker', from: 'Tars-Orchestrator' });
    vi.advanceTimersByTime(FIELD_PROBE_MS * 20);

    expect(terminal.written).toEqual([]);
  });
});

describe('the transcript the probe must find', () => {
  it('is the worktree one for an agent working in a worktree', () => {
    agent.worktreePath = worktree;
    const file = transcriptOf(worktree, CURRENT);
    sessionStarted(file);
    types('/model');
    key('\r');
    key('\x1b[B');
    key('\r');
    modelSet(file);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    terminal.written.length = 0;

    writeProgrammaticInput(terminal.pty, BRIEF, true, { agentId: 'worker', from: 'Tars-Orchestrator' });
    vi.advanceTimersByTime(FIELD_PROBE_MS + PROGRAMMATIC_SUBMIT_DELAY_MS + 100);

    expect(terminal.typed).toContain(BRIEF);
    expect(terminal.written.at(-1)).toBe('\r');
  });
});
