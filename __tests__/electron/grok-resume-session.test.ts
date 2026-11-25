import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveResumeSessionId } from '../../electron/utils/resume-session';

/**
 * A grok agent's session, found to be resumed after a restart.
 *
 * Measured on grok 1.0.92 (23/11): grok keeps a session in a folder of its own,
 * ~/.grok/sessions/<the folder it ran in, URL-encoded>/<session uuid>/ (chat_history.jsonl, events.jsonl, summary.json
 * and the rest), the uuid its hooks report as session_id; `grok --resume <uuid>` continues it.
 *
 * How it fails, written before the code:
 * 1. Its session looked for as a Claude transcript (~/.claude/projects/...), which grok never writes: the id is refused,
 *    so a grok agent begins anew after every restart of Tars.
 * 2. An id resumed whose folder is gone: grok starts on a session that is not there.
 * 3. Its session looked for under the folder as Tars saved it only, when grok filed it under its real path (a symlinked
 *    home), or under the project when the agent ran in its worktree.
 * 4. A claude agent resumed on a grok session folder, or a grok agent on a Claude transcript.
 * 5. Anything that is not a uuid resumed, whatever is on disk.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-grok-resume-'));
const real = fs.realpathSync(home);
const SESSION = '01a209b5-4b52-7662-8587-8afff0fb0bd0';

afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });

function grokSession(folder: string, id: string) {
  // The folder the agent ran in exists, as an agent's folder does: its real path is read from it.
  fs.mkdirSync(folder, { recursive: true });
  const dir = path.join(home, '.grok', 'sessions', encodeURIComponent(folder), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), '{}\n');
}

describe("a grok agent's session", () => {
  it('1. resumes when grok has its session folder, under the folder it ran in', () => {
    const project = path.join(real, 'p1');
    grokSession(project, SESSION);
    expect(resolveResumeSessionId({ provider: 'grok', resumableSessionId: SESSION, projectPath: project }, home)).toBe(SESSION);
  });

  it('2. refuses when the session folder is gone', () => {
    const project = path.join(real, 'p2');
    expect(resolveResumeSessionId({ provider: 'grok', resumableSessionId: SESSION, projectPath: project }, home)).toBeNull();
  });

  it('3. finds it under the worktree the agent ran in, and under the real path of a folder saved another way', () => {
    const worktree = path.join(real, 'p3-worktree');
    grokSession(worktree, SESSION);
    expect(resolveResumeSessionId({ provider: 'grok', resumableSessionId: SESSION, projectPath: path.join(real, 'p3'), worktreePath: worktree }, home)).toBe(SESSION);
    const link = path.join(os.tmpdir(), `tars-grok-link-${process.pid}`);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(real, link);
    try {
      const project = path.join(real, 'p4');
      grokSession(project, SESSION);
      expect(resolveResumeSessionId({ provider: 'grok', resumableSessionId: SESSION, projectPath: path.join(link, 'p4') }, home)).toBe(SESSION);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it('4. a claude agent never resumes on a grok session folder', () => {
    const project = path.join(real, 'p5');
    grokSession(project, SESSION);
    expect(resolveResumeSessionId({ provider: 'claude', resumableSessionId: SESSION, projectPath: project }, home)).toBeNull();
  });

  it('5. refuses anything that is not a uuid, whatever is on disk', () => {
    const project = path.join(real, 'p6');
    grokSession(project, 'my-session-title');
    expect(resolveResumeSessionId({ provider: 'grok', resumableSessionId: 'my-session-title', projectPath: project }, home)).toBeNull();
  });
});
