import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveResumeSessionId } from '../../electron/utils/resume-session';

/**
 * A gemini agent's session, found to be resumed after a restart.
 *
 * Measured on gemini 0.70.0 (23/11): gemini names each folder it runs in in ~/.gemini/projects.json
 * (`{ "projects": { "<folder>": "<short name>" } }`) and keeps a session in
 * ~/.gemini/tmp/<short name>/chats/session-<time>-<the uuid's first 8>.jsonl, whose first line names the whole uuid
 * (`{"sessionId": "<uuid>", "kind": "main", ...}`), the uuid its hooks report as session_id; `gemini --resume <uuid>`
 * continues it.
 *
 * How it fails, written before the code:
 * 1. Its session looked for as a Claude transcript (~/.claude/projects/...), which gemini never writes: the id is
 *    refused, so a gemini agent begins anew after every restart of Tars.
 * 2. An id resumed whose session file is gone.
 * 3. Another session taken for it: a file whose name ends with the same first 8 characters, a different uuid inside.
 * 4. Its folder looked for in projects.json under the spelling Tars saved only, when gemini named its real path (a
 *    symlinked home), or under the project when the agent ran in its worktree.
 * 5. A projects.json missing, unreadable or not JSON, or a short name that climbs out of ~/.gemini/tmp, throws or
 *    reads outside gemini's folder.
 * 6. A claude agent resumed on a gemini session, or anything that is not a uuid resumed.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-gemini-resume-'));
const real = fs.realpathSync(home);
const SESSION = '707f5907-38d6-47f7-b7ac-e6f16d78c1b2';
const projects: Record<string, string> = {};

afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });

function writeProjects() {
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'projects.json'), JSON.stringify({ projects }, null, 2));
}

function geminiSession(folder: string, name: string, id: string, inside = id) {
  fs.mkdirSync(folder, { recursive: true });
  projects[folder] = name;
  writeProjects();
  const chats = path.join(home, '.gemini', 'tmp', name, 'chats');
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(chats, `session-2026-11-23T18-41-${id.slice(0, 8)}.jsonl`),
    `${JSON.stringify({ sessionId: inside, projectHash: 'x', startTime: '2026-11-23T18:41:13.964Z', kind: 'main' })}\n{"id":"m1"}\n`);
}

const gemini = (projectPath: string, extra: Record<string, string> = {}) =>
  resolveResumeSessionId({ provider: 'gemini', resumableSessionId: SESSION, projectPath, ...extra }, home);

describe("a gemini agent's session", () => {
  it('1. resumes when gemini has its session, under the short name it gave the folder', () => {
    const project = path.join(real, 'p1');
    geminiSession(project, 'p1', SESSION);
    expect(gemini(project)).toBe(SESSION);
  });

  it('2. refuses when the session file is gone', () => {
    const project = path.join(real, 'p2');
    fs.mkdirSync(project, { recursive: true });
    projects[project] = 'p2';
    writeProjects();
    expect(gemini(project)).toBeNull();
  });

  it('3. never takes another session whose file name ends the same', () => {
    const project = path.join(real, 'p3');
    geminiSession(project, 'p3', SESSION, '707f5907-0000-4000-8000-000000000000');
    expect(gemini(project)).toBeNull();
  });

  it('4. finds it under the worktree the agent ran in, and under the real path of a folder saved another way', () => {
    const worktree = path.join(real, 'p4-worktree');
    geminiSession(worktree, 'p4-worktree', SESSION);
    expect(gemini(path.join(real, 'p4'), { worktreePath: worktree })).toBe(SESSION);
    const link = path.join(os.tmpdir(), `tars-gemini-link-${process.pid}`);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(real, link);
    try {
      const project = path.join(real, 'p5');
      geminiSession(project, 'p5', SESSION);
      expect(gemini(path.join(link, 'p5'))).toBe(SESSION);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it('5. refuses without throwing when projects.json is not JSON, and never reads outside gemini\'s tmp folder', () => {
    const project = path.join(real, 'p6');
    geminiSession(project, 'p6', SESSION);
    const file = path.join(home, '.gemini', 'projects.json');
    const kept = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{ not json');
    expect(() => gemini(project)).not.toThrow();
    expect(gemini(project)).toBeNull();
    fs.writeFileSync(file, kept);
    const outside = path.join(real, 'p7');
    fs.mkdirSync(path.join(home, '.gemini', 'escape', 'chats'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'escape', 'chats', `session-x-${SESSION.slice(0, 8)}.jsonl`), `${JSON.stringify({ sessionId: SESSION })}\n`);
    fs.mkdirSync(outside, { recursive: true });
    projects[outside] = '../escape';
    writeProjects();
    expect(gemini(outside)).toBeNull();
  });

  it('6. a claude agent never resumes on a gemini session, and nothing but a uuid is resumed', () => {
    const project = path.join(real, 'p8');
    geminiSession(project, 'p8', SESSION);
    expect(resolveResumeSessionId({ provider: 'claude', resumableSessionId: SESSION, projectPath: project }, home)).toBeNull();
    expect(resolveResumeSessionId({ provider: 'gemini', resumableSessionId: 'latest', projectPath: project }, home)).toBeNull();
  });
});
