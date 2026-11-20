import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PiProvider } from '../../electron/providers/pi-provider';
import {
  encodeProjectDirName,
  resolveResumeSessionId,
  consumeResumeSessionId,
  resetResumeTracking,
} from '../../electron/utils/resume-session';

/**
 * Resuming an agent's conversation after a restart.
 *
 * Updating Tars restarts Electron, which kills every PTY, and every agent came
 * back with an empty conversation. The session id was recorded but never
 * survived the restart: `currentSessionId` is ownership and is cleared on load
 * on purpose, so a second field records where the work got to.
 *
 * The part that has to be right is the refusal. `claude --resume <id>` exits
 * rather than starting when the transcript is gone, so an id that cannot be
 * backed by a file on disk must never reach the command line: an agent that
 * starts fresh is a worse outcome than resuming, and an agent that does not
 * start at all is much worse than both.
 *
 * A codex agent (2.0.4): codex keeps a session in its own rollout file,
 * $CODEX_HOME/sessions/<y>/<m>/<d>/rollout-<time>-<id>.jsonl, under the day it
 * began, which `codex resume <id>` continues (measured on 0.163). How it fails:
 * its id refused because no Claude transcript has it, so a codex agent began
 * anew after every restart; an id resumed whose rollout is gone; the rollout
 * looked for under today's folder only, when a session resumed days later
 * lives under the day it began; a Claude agent resumed on a codex rollout.
 *
 * A Kimi Code agent (19/11): kimi lists its sessions in $KIMI_CODE_HOME/session_index.jsonl, ids of the form
 * `session_<uuid>`, which `kimi --session <id>` resumes (measured on 2.6.3). How it fails: its id refused for not
 * being a bare UUID, so it began anew after every restart; an id resumed that the index no longer lists, or whose
 * session folder is gone; an id of another form reaching the command line; a Claude agent resumed on a kimi session.
 * Tars keeps it as the UUID the hook routes took (kimi's own name is session_<uuid>), and gives that back.
 *
 * A pi agent (20/11, found by pi's harness conformance run): pi writes its sessions in a folder of the agent's own,
 * ~/.tars/pi/sessions/<agent id>/<time>_<id>.jsonl (PI_CODING_AGENT_SESSION_DIR, services/pi-sessions.ts), and
 * `pi --session <id>` continues one (measured on 1.5.2: the first request carried the earlier turns). How it fails,
 * written before the code: no resume at all, so a pi agent began anew after every restart of Tars (the conformance
 * run's step 5); an id resumed whose file is gone, or one from another agent's folder; an id of another form reaching
 * the command line; the session after the prompt, where pi reads it as text; a Claude agent resumed on a pi session;
 * a restart that applies new settings, which asks for a fork (a new session, the old one tombstoned), continuing the
 * same session id, whose posts the hook routes then drop as stale. `pi --fork <id>` goes on under a new session id with
 * the earlier turns (measured on 1.5.2).
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-resume-'));
const PROJECT = '/Users/you/tars';
const SESSION = '4ab31f00-ce51-4676-ab80-4023cf6e3f4e';

function writeTranscript(projectPath: string, sessionId: string) {
  const dir = path.join(home, '.claude', 'projects', encodeProjectDirName(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n');
  } catch {
    // Hostile ids are also unwritable filenames, which is beside the point:
    // the assertion is that they are refused whatever is on disk.
  }
}

beforeEach(() => {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  resetResumeTracking();
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('finding the transcript', () => {
  it('encodes a project path the way Claude Code does', () => {
    // Both slashes and dots become dashes.
    expect(encodeProjectDirName('/Users/you/docs.octav.fi')).toBe('-Users-you-docs-octav-fi');
  });

  it('on Windows, names the folder as Claude does there; elsewhere, as before', () => {
    // Claude turns every character that is not a letter or a digit into a
    // dash: the drive's colon and every backslash too. The old rule kept them,
    // and named a folder Claude never writes.
    expect(encodeProjectDirName('C:\\Users\\you\\my project.x', 'win32')).toBe('C--Users-you-my-project-x');
    // darwin/linux: Claude Code's own rule too (measured on 2.1.296, 2026-10-13):
    // the `/` and `.` Tars read before missed every other character.
    expect(encodeProjectDirName('/Users/you/my project.x', 'darwin')).toBe('-Users-you-my-project-x');
    expect(encodeProjectDirName('/home/you/my_project', 'linux')).toBe('-home-you-my-project');
  });

  it('resumes when the transcript is on disk', () => {
    writeTranscript(PROJECT, SESSION);
    expect(resolveResumeSessionId({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe(SESSION);
  });

  it('refuses when the transcript has been cleaned up', () => {
    expect(resolveResumeSessionId({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBeNull();
  });

  it('looks in the worktree, which is where an agent with one actually ran', () => {
    const worktree = '/Users/you/tars/.worktrees/feat-x';
    writeTranscript(worktree, SESSION);
    expect(
      resolveResumeSessionId({ resumableSessionId: SESSION, projectPath: PROJECT, worktreePath: worktree }, home),
    ).toBe(SESSION);
  });

  it('refuses when nothing was recorded', () => {
    expect(resolveResumeSessionId({ projectPath: PROJECT }, home)).toBeNull();
    expect(resolveResumeSessionId({ resumableSessionId: '', projectPath: PROJECT }, home)).toBeNull();
    expect(resolveResumeSessionId({ resumableSessionId: '   ', projectPath: PROJECT }, home)).toBeNull();
  });

  it('refuses anything that is not a session id, whatever is on disk', () => {
    // This value reaches a command line. A shape check is what keeps it from
    // being a flag, a path, or a shell fragment.
    for (const bad of ['../../etc/passwd', 'a b', "x'; rm -rf /", '--dangerously-skip-permissions', 'not-a-uuid']) {
      writeTranscript(PROJECT, bad);
      expect(resolveResumeSessionId({ resumableSessionId: bad, projectPath: PROJECT }, home)).toBeNull();
    }
  });
});

describe("a codex agent's session", () => {
  const CODEX = '01a14fb7-9e95-7c81-8980-2b82c8316805';
  const codexHome = path.join(home, '.codex');
  const rollout = (day: string) => {
    const dir = path.join(codexHome, 'sessions', ...day.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-2026-10-15T09-00-00-${CODEX}.jsonl`), '{"type":"session_meta","payload":{}}\n');
  };
  beforeEach(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
    vi.stubEnv('CODEX_HOME', codexHome);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('resumes when codex has its rollout, under the day it began', () => {
    rollout('2026/10/15');
    expect(resolveResumeSessionId({ provider: 'codex', resumableSessionId: CODEX, projectPath: PROJECT }, home)).toBe(CODEX);
    expect(consumeResumeSessionId({ id: 'cx', provider: 'codex', resumableSessionId: CODEX, projectPath: PROJECT }, home)).toBe(CODEX);
    expect(consumeResumeSessionId({ id: 'cx', provider: 'codex', resumableSessionId: CODEX, projectPath: PROJECT }, home)).toBeNull();
  });

  it('refuses when the rollout is gone, and a Claude agent never resumes on a rollout', () => {
    expect(resolveResumeSessionId({ provider: 'codex', resumableSessionId: CODEX, projectPath: PROJECT }, home)).toBeNull();
    rollout('2026/10/15');
    expect(resolveResumeSessionId({ provider: 'claude', resumableSessionId: CODEX, projectPath: PROJECT }, home)).toBeNull();
  });
});

describe("a Kimi Code agent's session", () => {
  // Tars knows it by its UUID (the hook routes take nothing else); kimi lists it as session_<uuid>.
  const KIMI = 'feabbac1-fc87-4756-8076-0c6adc57127b';
  const kimiHome = path.join(home, '.kimi-code-home');
  const listed = (uuid: string, withFolder = true) => {
    const id = `session_${uuid}`;
    const dir = path.join(kimiHome, 'sessions', 'wd_tars_0123456789ab', id);
    if (withFolder) fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    if (withFolder) fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), '{"type":"metadata"}\n');
    fs.mkdirSync(kimiHome, { recursive: true });
    fs.appendFileSync(path.join(kimiHome, 'session_index.jsonl'), `${JSON.stringify({ sessionId: id, sessionDir: dir, workDir: PROJECT })}\n`);
  };
  beforeEach(() => {
    fs.rmSync(kimiHome, { recursive: true, force: true });
    vi.stubEnv('KIMI_CODE_HOME', kimiHome);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('resumes a session kimi lists and still has', () => {
    listed(KIMI);
    expect(resolveResumeSessionId({ provider: 'kimi-code', resumableSessionId: KIMI, projectPath: PROJECT }, home)).toBe(KIMI);
  });

  it('refuses one gone from the index or from the disk, one of another form, and a Claude agent on a kimi session', () => {
    expect(resolveResumeSessionId({ provider: 'kimi-code', resumableSessionId: KIMI, projectPath: PROJECT }, home)).toBeNull();
    listed(KIMI, false);
    expect(resolveResumeSessionId({ provider: 'kimi-code', resumableSessionId: KIMI, projectPath: PROJECT }, home)).toBeNull();
    fs.rmSync(kimiHome, { recursive: true, force: true });
    listed(KIMI);
    for (const bad of [`${KIMI}'; rm -rf /`, `session_${KIMI}`, 'session_../x']) {
      expect(resolveResumeSessionId({ provider: 'kimi-code', resumableSessionId: bad, projectPath: PROJECT }, home)).toBeNull();
    }
    expect(resolveResumeSessionId({ provider: 'claude', resumableSessionId: KIMI, projectPath: PROJECT }, home)).toBeNull();
  });
});

describe('resuming happens once per run', () => {
  it('resumes the first start and not the second', () => {
    writeTranscript(PROJECT, SESSION);
    const agent = { id: 'a1', resumableSessionId: SESSION, projectPath: PROJECT };

    // The restart: pick the conversation back up.
    expect(consumeResumeSessionId(agent, home)).toBe(SESSION);
    // Pressing Start again is a request for a fresh conversation, which is
    // what it has always meant.
    expect(consumeResumeSessionId(agent, home)).toBeNull();
  });

  it('tracks agents independently', () => {
    writeTranscript(PROJECT, SESSION);
    const a = { id: 'a1', resumableSessionId: SESSION, projectPath: PROJECT };
    const b = { id: 'b1', resumableSessionId: SESSION, projectPath: PROJECT };

    expect(consumeResumeSessionId(a, home)).toBe(SESSION);
    expect(consumeResumeSessionId(b, home)).toBe(SESSION);
  });
});

describe('a fork that has not written its transcript yet', () => {
  const FORK = '3b0f2a6f-15ee-487d-9e1a-728c0c122f53';

  it('resumes the session it continues', () => {
    // Claude Code writes a forked session's transcript at its first turn.
    writeTranscript(PROJECT, SESSION);
    expect(resolveResumeSessionId({ resumableSessionId: FORK, forkedFromSessionId: SESSION, projectPath: PROJECT }, home))
      .toBe(SESSION);
  });

  it('resumes the fork itself once it has one', () => {
    writeTranscript(PROJECT, SESSION);
    writeTranscript(PROJECT, FORK);
    expect(resolveResumeSessionId({ resumableSessionId: FORK, forkedFromSessionId: SESSION, projectPath: PROJECT }, home))
      .toBe(FORK);
  });

  it('holds the fallback to the same shape check', () => {
    expect(resolveResumeSessionId({ forkedFromSessionId: "x'; touch /tmp/owned; '", projectPath: PROJECT }, home)).toBeNull();
  });
});

describe('the wiring holds', () => {
  const read = (p: string) => fs.readFileSync(p, 'utf-8');

  it('records the session where a restart can still find it', () => {
    const hooks = read('electron/services/api-routes/hooks-routes.ts');
    // Both, together: currentSessionId is ownership, resumableSessionId is the
    // memory of where the work got to.
    expect(hooks).toContain('agent.resumableSessionId = session_id;');
  });

  it('keeps it across a load, unlike the ownership field', () => {
    const manager = read('electron/core/agent-manager.ts');
    expect(manager).toContain('agent.currentSessionId = undefined;');
    // If a future change starts clearing it here, resuming silently stops
    // working and nothing else fails.
    expect(manager).not.toContain('agent.resumableSessionId = undefined;');
  });

  it('every caller that builds a CLI command passes the resume id', () => {
    // Four call sites build the interactive command, and the failure mode for
    // this feature is a fifth one being added without it: everything keeps
    // working, and that agent quietly stops resuming.
    // bot-core.ts holds the two builders the chat bots share since D1 (Slack
    // asks them not to resume; the D1 contract pins that per bot).
    const callers = [
      'electron/handlers/ipc-handlers.ts',
      'electron/services/bot-core.ts',
      'electron/services/api-routes/agent-routes.ts',
    ];
    // Counted as calls rather than as one spelling of the argument: agent:start
    // resolves the id a line above its builder, because a restart names the
    // session to continue instead (start-launch-settings.test.ts checks that
    // the id then reaches the command line, for both).
    for (const file of callers) {
      const src = read(file);
      const builds = src.split('buildInteractiveCommand({').length - 1;
      const passes = src.split('consumeResumeSessionId(').length - 1;
      expect(passes, `${file} builds ${builds} commands but resolves the resume id ${passes} times`).toBe(builds);
    }
  });

  it('claude turns it into the flag its binary documents', async () => {
    // Read off the command it builds, not off its source: the flag now comes
    // from resumeFlags, shared by every provider on the claude binary
    // (providers/resume-flags.test.ts holds all fourteen to it).
    const { ClaudeProvider } = await import('../../electron/providers/claude-provider');
    const command = new ClaudeProvider().buildInteractiveCommand({
      binaryPath: '/usr/local/bin/claude', prompt: '', resumeSessionId: SESSION,
    });
    expect(command).toContain(` --resume '${SESSION}'`);
  });
});

/**
 * A project reached through a symlink.
 *
 * Claude Code files a transcript under the real path of the directory it runs
 * in; Tars looked under the path as it stored it. On a project reached through
 * a symlink (anything under /tmp, which is /private/tmp on macOS, or a linked
 * checkout) the two encode to different directories, so the first start after
 * launch, the settings restart and agent.restart all silently started a new
 * conversation (QA's gate of #138, seen in the app, and its unit test, here).
 *
 * How this can fail, written before the fix:
 * 1. the transcript claude filed under the real path is not found through the symlinked path;
 * 2. the saved spelling stops being looked under, and a transcript filed there is lost;
 * 3. a saved path that no longer exists throws while it is resolved, and fails the start instead of starting fresh;
 * 4. a worktree reached through a symlink, which is where such an agent ran, is not resolved either.
 */
describe('a project reached through a symlink', () => {
  let real = '';
  let link = '';

  beforeEach(() => {
    real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-resume-real-')));
    link = path.join(home, `project-link-${path.basename(real)}`);
    // A junction: a link to a directory that Windows lets any account make
    // (Developer Mode off, decision D4); the type is ignored off Windows.
    fs.symlinkSync(real, link, 'junction');
  });

  it('finds the transcript claude filed under the real path', () => {
    writeTranscript(real, SESSION);
    expect(resolveResumeSessionId({ resumableSessionId: SESSION, projectPath: real }, home), 'the real path').toBe(SESSION);
    expect(resolveResumeSessionId({ resumableSessionId: SESSION, projectPath: link }, home), 'through the symlink').toBe(SESSION);
  });

  it('still finds a transcript filed under the saved spelling', () => {
    writeTranscript(link, SESSION);
    expect(resolveResumeSessionId({ resumableSessionId: SESSION, projectPath: link }, home)).toBe(SESSION);
  });

  it('starts fresh, without throwing, when the saved path no longer exists', () => {
    writeTranscript(real, SESSION);
    const gone = path.join(home, 'nothing-here');
    expect(resolveResumeSessionId({ resumableSessionId: SESSION, projectPath: gone }, home)).toBeNull();
  });

  it('resolves a worktree reached through a symlink too', () => {
    const worktreeReal = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-resume-worktree-')));
    const worktreeLink = path.join(home, `worktree-link-${path.basename(worktreeReal)}`);
    fs.symlinkSync(worktreeReal, worktreeLink, 'junction');
    writeTranscript(worktreeReal, SESSION);
    expect(resolveResumeSessionId({ resumableSessionId: SESSION, projectPath: link, worktreePath: worktreeLink }, home)).toBe(SESSION);
  });
});

describe("a pi agent's session", () => {
  const PI = '01a1f662-3700-76c7-b873-c0c609074f4d';
  const AGENT = 'eeee5555-0000-4000-8000-0000000000c2';
  const folder = (agentId: string) => path.join(home, '.tars', 'pi', 'sessions', agentId);
  const written = (agentId: string, id: string) => {
    fs.mkdirSync(folder(agentId), { recursive: true });
    fs.writeFileSync(path.join(folder(agentId), `2026-11-20T00-36-37-926Z_${id}.jsonl`), `${JSON.stringify({ type: 'session', id })}\n`);
  };
  beforeEach(() => { fs.rmSync(path.join(home, '.tars'), { recursive: true, force: true }); });

  it("resumes a session whose file is in the agent's own folder", () => {
    written(AGENT, PI);
    expect(resolveResumeSessionId({ id: AGENT, provider: 'pi', resumableSessionId: PI, projectPath: PROJECT }, home)).toBe(PI);
  });

  it("refuses one gone, one in another agent's folder, one of another form, and a Claude agent on a pi session", () => {
    expect(resolveResumeSessionId({ id: AGENT, provider: 'pi', resumableSessionId: PI, projectPath: PROJECT }, home)).toBeNull();
    written('ffff6666-0000-4000-8000-0000000000c3', PI);
    expect(resolveResumeSessionId({ id: AGENT, provider: 'pi', resumableSessionId: PI, projectPath: PROJECT }, home)).toBeNull();
    written(AGENT, PI);
    for (const bad of [`${PI}'; rm -rf /`, `../${PI}`, 'x']) {
      expect(resolveResumeSessionId({ id: AGENT, provider: 'pi', resumableSessionId: bad, projectPath: PROJECT }, home)).toBeNull();
    }
    expect(resolveResumeSessionId({ id: '../x', provider: 'pi', resumableSessionId: PI, projectPath: PROJECT }, home)).toBeNull();
    expect(resolveResumeSessionId({ id: AGENT, provider: 'claude', resumableSessionId: PI, projectPath: PROJECT }, home)).toBeNull();
  });

  it('reaches pi as --session <id>, before the prompt; an id of another form never reaches its line', () => {
    const pi = new PiProvider();
    const line = pi.buildInteractiveCommand({ binaryPath: '/bin/pi', prompt: 'go on', resumeSessionId: PI });
    expect(line).toContain(`--session '${PI}'`);
    expect(line.indexOf('--session')).toBeLessThan(line.indexOf("'go on'"));
    expect(pi.buildInteractiveCommand({ binaryPath: '/bin/pi', prompt: '', resumeSessionId: PI })).toContain(`--session '${PI}'`);
    expect(pi.buildInteractiveCommand({ binaryPath: '/bin/pi', prompt: 'go on', resumeSessionId: `${PI}'; rm -rf ~` })).not.toContain('--session');
    expect(pi.buildInteractiveCommand({ binaryPath: '/bin/pi', prompt: 'go on' })).not.toContain('--session');
  });

  it('a fork reaches pi as --fork <id>, never as --session', () => {
    const line = new PiProvider().buildInteractiveCommand({ binaryPath: '/bin/pi', prompt: 'go on', resumeSessionId: PI, forkSession: true });
    expect(line).toContain(`--fork '${PI}'`);
    expect(line).not.toContain('--session');
  });
});
