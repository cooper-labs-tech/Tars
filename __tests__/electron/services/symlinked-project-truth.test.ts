import '../../setup/home-guard';
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodeProjectDirName } from '../../../electron/utils/resume-session';
import {
  clearAgentTruthCache, lastInterruptAt, lastLocalCommandAt, pendingBackgroundWork, sessionModel,
} from '../../../electron/services/agent-truth';
import { readAgentTranscript } from '../../../electron/services/agent-transcript';

/**
 * A project reached through a symlink (QA's re-check of #138).
 *
 * Claude Code files a transcript under the real path of the directory it runs
 * in, and Tars keeps the path as it was given: anything under /tmp (which is
 * /private/tmp on macOS), or a linked checkout. #138 made the resume look under
 * both spellings; four other readers looked under the saved one only.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. pendingBackgroundWork finds nothing, so a restart there does not wait for
 *    the work the session left running, and kills it.
 * 2. lastLocalCommandAt finds nothing, so a message held behind a command typed
 *    by hand never learns that the field emptied.
 * 3. sessionModel finds nothing, and the card cannot say the session runs
 *    another model.
 * 4. The Chat's transcript of the agent reads as unavailable.
 * 5. The saved spelling stops being read first when it does hold a transcript.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-symlink-truth-'));
// Real from the start: os.tmpdir() is itself behind a link on macOS.
const realBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-symlink-project-')));
const REAL = path.join(realBase, 'checkout');
const LINK = path.join(realBase, 'linked');
fs.mkdirSync(REAL, { recursive: true });
// A junction: Windows lets any account make one, where a symlink needs a privilege; the type is ignored off Windows.
fs.symlinkSync(REAL, LINK, 'junction');
const SESSION = '4ab31f00-ce51-4676-ab80-4023cf6e3f4e';
const SINCE = Date.parse('2026-09-24T03:00:00.000Z');
const at = (s: number) => new Date(SINCE + s * 1000).toISOString();

function writeTranscript(projectPath: string, lines: unknown[]) {
  const dir = path.join(home, '.claude', 'projects', encodeProjectDirName(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

/** A session's records, as claude 2.1.280 writes them, trimmed to what is read. */
const RECORDS = [
  { type: 'user', uuid: 'u1', timestamp: at(1), message: { role: 'user', content: 'start the build' } },
  { type: 'assistant', uuid: 'a1', timestamp: at(2), message: { model: 'claude-opus-5', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], usage: { input_tokens: 1 } } },
  { type: 'user', uuid: 'u2', timestamp: at(3), toolUseResult: { backgroundTaskId: 'bgsymlink1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'running' }] } },
  { type: 'user', uuid: 'u3', timestamp: at(4), message: { role: 'user', content: '<command-name>/model</command-name>' } },
];

beforeEach(() => {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  clearAgentTruthCache();
});

describe('a project reached through a symlink, its transcript under the real path', () => {
  const agent = { currentSessionId: SESSION, resumableSessionId: SESSION, projectPath: LINK };

  it('1. finds the background work its session left running', () => {
    writeTranscript(REAL, RECORDS);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual(['bgsymlink1']);
  });

  it('2. finds the command that emptied the field', () => {
    writeTranscript(REAL, RECORDS);
    expect(lastLocalCommandAt(agent, home)).toBe(Date.parse(at(4)));
  });

  it('3. finds the model the session answers on', () => {
    writeTranscript(REAL, RECORDS);
    expect(sessionModel(agent, home)).toBe('claude-opus-5');
  });

  it('4. reads the transcript for the Chat', async () => {
    writeTranscript(REAL, RECORDS);
    const r = await readAgentTranscript({ sessionId: SESSION, projectPath: LINK, homeDir: home });
    expect(r.available).toBe(true);
  });

  it('5. still reads the saved spelling first when it holds the transcript', () => {
    writeTranscript(LINK, RECORDS);
    writeTranscript(REAL, [RECORDS[0], { ...RECORDS[1], message: { ...RECORDS[1].message, model: 'claude-sonnet-5' } }]);
    expect(sessionModel(agent, home)).toBe('claude-opus-5');
  });
});

describe('QA #184: the interrupt of a turn, on a project reached through a symlink', () => {
  // Written by the QA at the gate of #184. lastInterruptAt read both spellings
  // before #184 (#179) and reads transcriptRoots since, but nothing held it on a
  // linked project: reading the saved spelling only left every test green.
  it('finds the interrupt claude recorded under the real path', () => {
    writeTranscript(REAL, [
      ...RECORDS,
      { type: 'user', uuid: 'u5', timestamp: at(5), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    ]);
    expect(lastInterruptAt({ currentSessionId: SESSION, projectPath: LINK }, home)).toBe(Date.parse(at(5)));
  });
});
