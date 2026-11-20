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
 *    that, three times out of three, and none before. Up on that bar, never on its logo or its first frames.
 * 5. Its data folder read elsewhere than opencode writes it: `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`.
 */

import { OpenCodeProvider } from '../../../electron/providers/opencode-provider';
import { opencodeDbPath, opencodeUuidOf, opencodeSessionOfCommand } from '../../../electron/providers/opencode-cli';
import { resolveResumeSessionId } from '../../../electron/utils/resume-session';

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
  db.prepare('INSERT INTO session (id, directory, time_created) VALUES (?, ?, 1)').run(id, directory);
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
    expect(oc.upOnScreen(BOOTING)).toBe(false);
    expect(oc.upOnScreen([])).toBe(false);
    expect(oc.upOnScreen(['  the agents and their commands are listed in the docs'])).toBe(false);
  });
});
