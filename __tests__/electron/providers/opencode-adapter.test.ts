import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

/**
 * The opencode adapter around its session reader (services/opencode-sessions.ts): its sessions resumed after a restart
 * of Tars, and a task typed only once its TUI takes keys. Measured on opencode 1.19.6 (20/11/2026).
 *
 * How it fails, written before the code:
 * 1. Tars knows a session by the UUID it posted (hook routes take nothing else), and opencode resumes by its own id:
 *    the UUID never mapped back, so an opencode agent began anew after every restart; or mapped to a session of
 *    another folder, or to one opencode no longer has.
 * 2. Its own id reaching the command line in another form, or anything but an id.
 * 3. A restart that applies new settings continuing the same session id (its posts then refused as the old one's
 *    tombstone): it forks, `--session <id> --fork`, measured to go on under a new id with the earlier turns.
 * 4. A delegated task typed before opencode takes keys, and lost. opencode draws its field and its bottom bar
 *    (`tab agents`, `ctrl+p commands`) 10 to 26 s after it starts on a loaded machine; it took keys within 50 ms of
 *    that, three times out of three, and none before. Up on that bar, never on its logo or its first frames. Resumed
 *    on a session (`--session`), its bar shows the session's tokens where `tab agents` was (`<folder>  132  ctrl+p
 *    commands`, the conformance run's resume): what is always there is `<key> commands` at the line's end, after a
 *    gap. It took keys within 60 ms of that bar on a resumed session too (twice).
 * 5. Its data folder read elsewhere than opencode writes it: `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`.
 * 6. Its turns still taken for unseen: delegate_task then answers `delivered` at once, with neither answer nor tokens,
 *    and task_status never reads it completed. Its provider says its turns are reported, as codex's, pi's and kimi's.
 * 7. (The Audit's M1 on #613) A restart's line, `--session '<S>' --fork`, read as a resume of S: the reader then bound S
 *    while opencode went on under a new id. Read as a fork of S, and the launch's own `--prompt` read back as the text
 *    it sent, quotes and all.
 * 8. (Its conformance run with a restart, 20/11) A task typed into a forking opencode at its first bar, its home view's
 *    (`tab agents  ctrl+p commands`, nothing before it): it started a new session without the history, measured twice,
 *    and landed in the fork when typed once the forked session's view was drawn (`<folder>  <tokens>  ctrl+p
 *    commands`, about 5 s later). A plain resume's first bar is already its session's (`<folder>  tab agents  ctrl+p
 *    commands`), where a task typed at once landed in the session (twice). On a launch on a session, up on a bar with
 *    something before it, never the bare home view's; on a fresh launch, on either.
 * 9. (QA's gate of the stack, 21/11, gatestack613) The bar wrapped over two rows, read as never up: a long folder (the
 *    sandbox under /private/var/folders/...) or a narrow pane puts `132 ctrl+p` at the end of one row and `commands`
 *    alone at the end of the next. After a resume and after a restart every task was refused as still starting, and the
 *    resumed session sent nothing. Its bar on two rows is its bar; on a launch on a session, still never the bare home
 *    view's, and never rows of the conversation's frame.
 */

import { OpenCodeProvider } from '../../../electron/providers/opencode-provider';
import { opencodeDbPath, opencodeUuidOf, opencodeSessionOfCommand, opencodeLaunchOf } from '../../../electron/providers/opencode-cli';
import { resolveResumeSessionId } from '../../../electron/utils/resume-session';
import { hasEndOfTurn } from '../../../electron/core/end-of-turn';

const SES = 'ses_e0a2b2f04ffeyXxkOfD77KQMP5';
let root: string;
let project: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-opencode-adapter-')));
  project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function sessionIn(directory: string, id = SES): void {
  const file = opencodeDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec("CREATE TABLE IF NOT EXISTS session (id text PRIMARY KEY, directory text NOT NULL, time_created integer NOT NULL)");
  db.prepare('INSERT OR REPLACE INTO session (id, directory, time_created) VALUES (?, ?, 1)').run(id, directory);
  db.close();
}

describe("where opencode keeps its data (5)", () => {
  it('$XDG_DATA_HOME/opencode/opencode.db, else ~/.local/share/opencode/opencode.db', () => {
    expect(opencodeDbPath()).toBe(path.join(root, 'data', 'opencode', 'opencode.db'));
    expect(opencodeDbPath({}, '/h')).toBe(path.join('/h', '.local', 'share', 'opencode', 'opencode.db'));
  });
});

describe('a session resumed after a restart (1 and 2)', () => {
  it("the UUID Tars knows it by maps back to opencode's id, in the agent's folder, while opencode still has it", () => {
    const uuid = opencodeUuidOf(SES)!;
    const agent = { id: 'a1', provider: 'opencode', resumableSessionId: uuid, projectPath: project };
    expect(resolveResumeSessionId(agent, root)).toBeNull();
    sessionIn(path.join(root, 'elsewhere'));
    expect(resolveResumeSessionId(agent, root)).toBeNull();
    sessionIn(project, 'ses_another00000000000000000');
    expect(resolveResumeSessionId(agent, root)).toBeNull();
    sessionIn(project);
    expect(resolveResumeSessionId(agent, root)).toBe(SES);
    for (const bad of [`${uuid}'; rm -rf /`, SES, 'x']) {
      expect(resolveResumeSessionId({ ...agent, resumableSessionId: bad }, root)).toBeNull();
    }
    expect(resolveResumeSessionId({ ...agent, provider: 'claude' }, root)).toBeNull();
  });

  it('reaches opencode as --session <id> (and --fork for a fork), its id and nothing else', () => {
    const oc = new OpenCodeProvider();
    expect(oc.buildInteractiveCommand({ binaryPath: '/bin/opencode', prompt: 'go on', resumeSessionId: SES })).toContain(`--session '${SES}'`);
    const fork = oc.buildInteractiveCommand({ binaryPath: '/bin/opencode', prompt: '', resumeSessionId: SES, forkSession: true });
    expect(fork).toContain(`--session '${SES}'`);
    expect(fork).toContain('--fork');
    for (const bad of [`${SES}'; rm -rf ~`, opencodeUuidOf(SES)!, 'ses_']) {
      expect(oc.buildInteractiveCommand({ binaryPath: '/bin/opencode', prompt: 'go', resumeSessionId: bad })).not.toContain('--session');
    }
    expect(oc.buildInteractiveCommand({ binaryPath: '/bin/opencode', prompt: 'go' })).not.toContain('--session');
    expect(opencodeSessionOfCommand(oc.buildInteractiveCommand({ binaryPath: '/bin/opencode', prompt: 'go', resumeSessionId: SES }))).toBe(SES);
    expect(opencodeSessionOfCommand("'/bin/opencode' --prompt 'go'")).toBeUndefined();
  });
});

describe('a task typed once opencode takes keys (4)', () => {
  const BOOTING = ['                ▄', '  █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█', '  █  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀'];
  const READY = [
    '  ┃  Ask anything… "Fix broken tests"',
    '  ┃  Build · stand-in-coder Tars endpoint',
    '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
    '                                              tab agents  ctrl+p commands',
    '  ~/project                                   1.19.6  ⊙ 1 MCP  /status',
  ];
  it('up on its bottom bar, never on its logo or an empty screen', () => {
    const oc = new OpenCodeProvider();
    expect(oc.upOnScreen(READY)).toBe(true);
    // Resumed on a session with tokens used: the count where `tab agents` was.
    expect(oc.upOnScreen(['  ┃  Build auto · stand-in-coder Tars endpoint', '  ╹▀▀▀▀▀▀▀▀▀▀', '  /x/projects/project-a                              132  ctrl+p commands'])).toBe(true);
    expect(oc.upOnScreen(BOOTING)).toBe(false);
    expect(oc.upOnScreen([])).toBe(false);
    expect(oc.upOnScreen(['  the agents and their commands are listed in the docs'])).toBe(false);
  });
});

describe('its turns are heard (6)', () => {
  it('an opencode agent reads as one whose turn end Tars sees, so delegate_task waits for its answer', () => {
    expect(hasEndOfTurn({ provider: 'opencode' })).toBe(true);
  });
});

describe("a launch line, read back (7)", () => {
  it("a fork is a fork of S, never a resume of it; a resume is one; the launch's prompt comes back as sent", () => {
    const oc = new OpenCodeProvider();
    const fork = oc.buildInteractiveCommand({ binaryPath: '/bin/opencode', prompt: "it's the task", resumeSessionId: SES, forkSession: true });
    expect(opencodeLaunchOf(fork)).toEqual({ forkOf: SES, prompt: "it's the task" });
    expect(opencodeSessionOfCommand(fork)).toBeUndefined();
    const resume = oc.buildInteractiveCommand({ binaryPath: '/bin/opencode', prompt: '', resumeSessionId: SES });
    expect(opencodeLaunchOf(resume)).toEqual({ resume: SES });
    expect(opencodeLaunchOf("'/bin/opencode' --auto")).toEqual({});
    expect(opencodeLaunchOf(undefined)).toEqual({});
    // An exec launch: a shell's -c holding the line (macOS, Linux), or the CLI's own words (Windows).
    expect(opencodeLaunchOf(['-l', '-c', `cd '/p' && exec ${fork}`])).toEqual({ forkOf: SES, prompt: "it's the task" });
    expect(opencodeLaunchOf(['--auto', '--session', SES, '--fork', '--prompt', "it's the task"])).toEqual({ forkOf: SES, prompt: "it's the task" });
    expect(opencodeLaunchOf(['--session', SES])).toEqual({ resume: SES });
  });
});

describe('up on its bar wrapped over two rows (9)', () => {
  /** The bottom rows of QA's screen (screen-second.txt of the opencode run, gatestack613), a pane of 120 columns. */
  const WRAPPED = [
    '  ┃',
    '  ┃  Build auto · stand-in-coder Tars endpoint',
    '  ╹' + '▀'.repeat(115),
    '   /private/var/folders/yp/j2nr6k4915z_bnf3tjv22t940000gn/T/dorothy-e2e-conformance-opencode-GRATOx/ 132 ctrl+p         ',
    '   projects/project-a                                                                                    commands       ',
    '',
  ];
  /** The home view in a narrow pane: nothing before its keys, wrapped the same way. */
  const HOME_NARROW = ['  ╹▀▀▀▀▀▀▀▀▀▀', '  tab agents ctrl+p', '            commands'];
  it("is up on a session's view whose bar wraps, after a resume, a restart's fork and a fresh launch", () => {
    const oc = new OpenCodeProvider();
    const fork = oc.buildInteractiveCommand({ binaryPath: '/bin/opencode', prompt: '', resumeSessionId: SES, forkSession: true });
    const resume = oc.buildInteractiveCommand({ binaryPath: '/bin/opencode', prompt: '', resumeSessionId: SES });
    expect(oc.upOnScreen(WRAPPED, resume)).toBe(true);
    expect(oc.upOnScreen(WRAPPED, fork)).toBe(true);
    expect(oc.upOnScreen(WRAPPED)).toBe(true);
  });

  it("is never up on the home view wrapped, on a launch on a session, nor on the conversation's rows", () => {
    const oc = new OpenCodeProvider();
    const fork = oc.buildInteractiveCommand({ binaryPath: '/bin/opencode', prompt: '', resumeSessionId: SES, forkSession: true });
    expect(oc.upOnScreen(HOME_NARROW, fork)).toBe(false);
    expect(oc.upOnScreen(HOME_NARROW)).toBe(true);
    expect(oc.upOnScreen(['  ┃  Run each of these', '  ┃                                   commands'])).toBe(false);
    expect(oc.upOnScreen(['', '                                   commands'])).toBe(false);
  });
});

describe('up on a launch on a session (8)', () => {
  const HOME = ['  ╹▀▀▀▀▀▀▀▀▀▀', '                                    tab agents  ctrl+p commands', '  ~/project                                   1.19.6'];
  const RESUMED = ['  ╹▀▀▀▀▀▀▀▀▀▀', '   /home/someone/project                     tab agents  ctrl+p commands'];
  const FORKED = ['  ╹▀▀▀▀▀▀▀▀▀▀', '   /home/someone/project                            132  ctrl+p commands'];
  it("a fork or a resume waits for its session's view; a fresh launch takes the home view", () => {
    const oc = new OpenCodeProvider();
    const fork = oc.buildInteractiveCommand({ binaryPath: '/bin/opencode', prompt: '', resumeSessionId: SES, forkSession: true });
    const resume = oc.buildInteractiveCommand({ binaryPath: '/bin/opencode', prompt: '', resumeSessionId: SES });
    const fresh = oc.buildInteractiveCommand({ binaryPath: '/bin/opencode', prompt: '' });
    expect(oc.upOnScreen(HOME, fork)).toBe(false);
    expect(oc.upOnScreen(FORKED, fork)).toBe(true);
    expect(oc.upOnScreen(HOME, resume)).toBe(false);
    expect(oc.upOnScreen(RESUMED, resume)).toBe(true);
    expect(oc.upOnScreen(HOME, fresh)).toBe(true);
    expect(oc.upOnScreen(HOME)).toBe(true);
  });
});
