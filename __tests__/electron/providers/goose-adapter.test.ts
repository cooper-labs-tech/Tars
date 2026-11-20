import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Goose as an agent of its own: the provider `goose`, the binary `goose` (block/goose, Apache-2.0). Measured on 1.60.1
 * (20/11/2026) in throwaway homes:
 * - `goose session` is its TUI. It takes no first prompt on its line: the task is typed in once it is up. It said
 *   `goose is ready` 0.2 to 0.6 s after its start and took a key typed then 54 to 61 ms later, three fresh starts out of
 *   three; it turns bracketed paste on 5 to 68 ms after that line, in the same write as its field line `> Enter to
 *   send` (three fresh starts, 0.4 to 0.8 s after the spawn). Its screen names its session (`20261120_1 · <folder>`).
 * - On an endpoint: `--provider openai --model <m>`, with OPENAI_HOST, OPENAI_BASE_PATH and OPENAI_API_KEY; nothing is
 *   written into its config.
 * - MCP servers per run: `--with-extension '<name>:<command> <args>'` names one, and a resumed session brings back the
 *   ones it was started with: given the same name again, Goose refused to start ("extension name ... is already in
 *   use"). Each is started with Goose's whole environment.
 * - `--resume --session-id <id>` continues a session with its history; `--fork` with it goes on under a new id with
 *   the earlier messages copied. Session ids are `YYYYMMDD_N`.
 * - A message typed during its turn is lost: its Enter is dropped and the text waits in the field after the turn.
 * - It reports its state in OSC 7501 (`state=idle:app=goose`, `state=error`).
 * - Its permission mode is read from GOOSE_MODE only (no flag): `auto` ran the shell tool unasked; `approve` drew
 *   "Goose would like to call the above tool, do you allow?" in its terminal; `chat` drew the same dialog, so nothing
 *   measured is a plan mode.
 * - An extension's command is split into shell words: a path with a space, single- or double-quoted, started; a
 *   backslash inside single quotes reached the process as it is; a backslash-escaped space did not start.
 *
 * How it fails, written before the code:
 * 1. Goose's binary read from another path setting, or Goose run as another provider: no Tars provider knows `goose`.
 * 2. A task put on its command line, which `goose session` does not take, or typed before its TUI is up: lost. Up
 *    on `goose is ready` alone, a paste sent then arrives raw, and its first line break sends a part of it.
 * 3. On an endpoint, the provider or the model left to the user's config: the task leaves for a service the user did
 *    not choose. Or the endpoint's key written into its config.
 * 4. Tars's servers left unnamed (named after their command, `node__...`) or written into the user's Goose config; a
 *    worker given X and Telegram against the owner's rule of 28/10; or a resumed session given its servers again,
 *    which Goose refuses to start with. Or a command or a path with a space (a Windows user folder) split in two, or
 *    one with a quote let through to break the value.
 * 5. Its session not resumed after a restart of Tars (the UUID Tars knows it by never mapped back), resumed in another
 *    folder, or a forked restart read as a resume. Or its database looked for under XDG_DATA_HOME while GOOSE_PATH_ROOT
 *    moves it (measured: `$GOOSE_PATH_ROOT/data/sessions/sessions.db`, XDG_DATA_HOME set or not): no turn read.
 * 6. A note typed during its turn, and lost: Goose says it loses one (noteDuringTurn 'lost'), so Tars holds it.
 * 7. Its turns taken for unseen: delegate_task then answers `delivered`. Its turns are read (turnsReported).
 * 8. Its permission mode lost: a normal agent run in the user's own mode, an auto one stopped on dialogs nobody
 *    answers, or plan run as something else. On macOS and Linux in the line, which no rc file runs after (as codex's
 *    CODEX_HOME); in the terminal's environment for Windows (goose-wiring.test.ts).
 */

vi.mock('../../../electron/services/traces-runtime', async () => {
  const { endpointLaunchFor: launchFor } = await vi.importActual<typeof import('../../../electron/services/endpoint-harness')>('../../../electron/services/endpoint-harness');
  return {
    endpointLaunchForAgent: (agentId: string | undefined, harness: string) =>
      agentId === 'on-ep' ? launchFor(harness, { proxyBase: 'http://127.0.0.1:31417/v1', model: 'org/Model-1' }) : null,
  };
});

import { GooseProvider } from '../../../electron/providers/goose-provider';
import { getProvider } from '../../../electron/providers';
import { endpointLaunchFor, ENDPOINT_TOKEN_VAR } from '../../../electron/services/endpoint-harness';
import { ENDPOINT_HARNESSES } from '../../../electron/services/inference-endpoints';
import { resolveResumeSessionId } from '../../../electron/utils/resume-session';
import { gooseDbPath, gooseUuidOf, gooseLaunchOf } from '../../../electron/providers/goose-cli';
import { hasEndOfTurn } from '../../../electron/core/end-of-turn';
import { sendModeOf } from '../../../electron/core/send-mode';
import { shellQuote } from '../../../electron/providers/cli-provider';
import { launchPlanRefusal, planModeRefusal } from '../../../electron/providers/plan-mode';

/** The line's start before the binary: the mode, on macOS and Linux. */
const modeWord = (mode: string) => (process.platform === 'win32' ? '' : `env GOOSE_MODE='${mode}' `);

const SES = '20261120_1';
let root: string;
let project: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-goose-adapter-')));
  project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'config'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Goose, an agent of its own (1, 2, 6, 7)', () => {
  it('is the provider goose, on its own binary and path setting, its turns read, its mid-turn notes held', () => {
    const goose = getProvider('goose');
    expect(goose).toBeInstanceOf(GooseProvider);
    expect(goose.binaryName).toBe('goose');
    expect(goose.resolveBinaryPath({ cliPaths: { goose: '/opt/goose', opencode: '/opt/opencode' } } as never)).toBe('/opt/goose');
    expect(hasEndOfTurn({ provider: 'goose' })).toBe(true);
    expect(goose.noteDuringTurn).toBe('lost');
    expect(sendModeOf('auto', { workerNote: false, noteDuringTurn: goose.noteDuringTurn })).toBe('queue');
  });

  it('2: starts its TUI with no task on the line, and types the task once it says it is ready', () => {
    const goose = new GooseProvider();
    const line = goose.buildInteractiveCommand({ binaryPath: '/opt/goose', prompt: 'do the task' });
    expect(line.startsWith(`${modeWord('approve')}'/opt/goose' session`)).toBe(true);
    expect(line).not.toContain('do the task');
    expect(goose.taskTypedAfterLaunch).toBe(true);
    expect(goose.typedTask!({ prompt: 'do the task' })).toBe('do the task');
    expect(goose.upOnScreen!(['    __( O)>  ● new session · openai m', '   \\\\____)    20261120_1 · /p', '     L L     goose is ready', '> Enter to send · Ctrl+J newline'])).toBe(true);
    expect(goose.upOnScreen!(['    __( O)>  ● new session · openai m'])).toBe(false);
    expect(goose.upOnScreen!(['    __( O)>  ● new session · openai m', '   \\\\____)    20261120_1 · /p', '     L L     goose is ready'])).toBe(false);
    expect(goose.upOnScreen!([])).toBe(false);
  });
});

describe('on an inference endpoint (3)', () => {
  it("names Tars's provider and model on its line, and the proxy in its environment, nothing in its config", () => {
    expect(ENDPOINT_HARNESSES).toContain('goose');
    const launch = endpointLaunchFor('goose', { proxyBase: 'http://127.0.0.1:31417/v1', model: 'org/Model-1' })!;
    expect(launch.args).toEqual(['--provider', 'openai', '--model', 'org/Model-1']);
    expect(launch.env).toEqual({ OPENAI_HOST: 'http://127.0.0.1:31417', OPENAI_BASE_PATH: 'v1/chat/completions' });
    expect(launch.tokenVars).toEqual(['OPENAI_API_KEY']);
    const goose = new GooseProvider();
    expect(goose.buildInteractiveCommand({ agentId: 'on-ep', binaryPath: 'goose', prompt: '' })).toContain("'--provider' 'openai' '--model' 'org/Model-1'");
    expect(goose.getPtyEnvVars('on-ep', project, [])).toMatchObject({ OPENAI_HOST: 'http://127.0.0.1:31417', OPENAI_BASE_PATH: 'v1/chat/completions' });
    expect(goose.getPtyEnvVars('not-on-ep', project, []).OPENAI_HOST).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'config', 'goose'))).toBe(false);
    void ENDPOINT_TOKEN_VAR;
  });
});

describe("Tars's servers (4)", () => {
  it('each named on the line of a fresh launch, a worker without X and Telegram, none on a resume, nothing in its config', async () => {
    const goose = new GooseProvider();
    await goose.registerMcpServer('claude-mgr-orchestrator', '/opt/node', ['/res/mcp-orchestrator/dist/bundle.js']);
    await goose.registerMcpServer('dorothy-x', '/opt/node', ['/res/mcp-x/dist/bundle.js']);
    await goose.registerMcpServer('claude-mgr-telegram', '/opt/node', ['/res/mcp-telegram/dist/bundle.js']);
    expect(goose.isMcpServerRegistered('dorothy-x', '/res/mcp-x/dist/bundle.js')).toBe(true);
    const lead = goose.buildInteractiveCommand({ binaryPath: 'goose', prompt: '', orchestratorMode: true });
    expect(lead).toContain("--with-extension 'claude-mgr-orchestrator:/opt/node /res/mcp-orchestrator/dist/bundle.js'");
    expect(lead).toContain("--with-extension 'dorothy-x:/opt/node /res/mcp-x/dist/bundle.js'");
    const worker = goose.buildInteractiveCommand({ binaryPath: 'goose', prompt: '', orchestratorMode: false });
    expect(worker).toContain("--with-extension 'claude-mgr-orchestrator:");
    expect(worker).not.toContain('dorothy-x');
    expect(worker).not.toContain('claude-mgr-telegram');
    const resumed = goose.buildInteractiveCommand({ binaryPath: 'goose', prompt: '', resumeSessionId: SES, orchestratorMode: true });
    expect(resumed).not.toContain('--with-extension');
    expect(fs.existsSync(path.join(root, 'config', 'goose'))).toBe(false);
    await goose.removeMcpServer('dorothy-x');
    expect(goose.isMcpServerRegistered('dorothy-x', '/res/mcp-x/dist/bundle.js')).toBe(false);
  });

  it('a command or a path with a space or a backslash is quoted inside the value; one with a quote is not passed', async () => {
    const goose = new GooseProvider();
    await goose.registerMcpServer('claude-mgr-vault', 'C:\\Users\\First Last\\Tars\\node.exe', ['C:\\Users\\First Last\\res\\mcp-vault\\dist\\bundle.js']);
    await goose.registerMcpServer('tars-memory', "/home/o'brien/node", ['/res/mcp-memory/dist/bundle.js']);
    const line = goose.buildInteractiveCommand({ binaryPath: 'goose', prompt: '', orchestratorMode: true });
    expect(line).toContain(` --with-extension ${shellQuote("claude-mgr-vault:'C:\\Users\\First Last\\Tars\\node.exe' 'C:\\Users\\First Last\\res\\mcp-vault\\dist\\bundle.js'")}`);
    expect(line).not.toContain('tars-memory');
  });
});

describe('its permission mode (8)', () => {
  it('normal asks, auto and bypass never do, plan is refused; on the line and in the environment', () => {
    const goose = new GooseProvider();
    const line = (permissionMode?: 'normal' | 'auto' | 'bypass' | 'plan') => goose.buildInteractiveCommand({ binaryPath: '/opt/goose', prompt: '', permissionMode });
    expect(line('normal').startsWith(`${modeWord('approve')}'/opt/goose' session`)).toBe(true);
    expect(line(undefined).startsWith(`${modeWord('approve')}'/opt/goose'`)).toBe(true);
    expect(line('auto').startsWith(`${modeWord('auto')}'/opt/goose'`)).toBe(true);
    expect(line('bypass').startsWith(`${modeWord('auto')}'/opt/goose'`)).toBe(true);
    expect(() => line('plan')).toThrow(/no plan mode/);
    // Refused at creation and update, and at a launch, before anything is stopped (plan-mode.ts), as Kimi Code's.
    expect(planModeRefusal('goose', 'plan')).toMatch(/no plan mode/);
    expect(launchPlanRefusal('goose', 'plan')).toMatch(/no plan mode/);
    expect(launchPlanRefusal('goose', 'normal')).toBeNull();
    expect(goose.getPtyEnvVars('g1', project, [], undefined, { permissionMode: 'normal' }).GOOSE_MODE).toBe('approve');
    expect(goose.getPtyEnvVars('g1', project, [], undefined, { permissionMode: 'bypass' }).GOOSE_MODE).toBe('auto');
    expect(goose.getPtyEnvVars('g1', project, [], undefined, { permissionMode: 'auto' }).GOOSE_MODE).toBe('auto');
    expect(goose.getPtyEnvVars('g1', project, []).GOOSE_MODE).toBe('approve');
  });
});

describe('its sessions (5)', () => {
  function sessionIn(dir: string, id = SES): void {
    const file = gooseDbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, working_dir TEXT NOT NULL, created_at TIMESTAMP)');
    db.prepare("INSERT OR REPLACE INTO sessions (id, working_dir, created_at) VALUES (?, ?, '2026-11-20 16:31:10')").run(id, dir);
    db.close();
  }

  it("lives in $XDG_DATA_HOME/goose/sessions/sessions.db; the UUID Tars knows it by maps back, in the agent's folder", () => {
    expect(gooseDbPath()).toBe(path.join(root, 'data', 'goose', 'sessions', 'sessions.db'));
    const uuid = gooseUuidOf(SES)!;
    const agent = { id: 'g1', provider: 'goose', resumableSessionId: uuid, projectPath: project };
    expect(resolveResumeSessionId(agent, root)).toBeNull();
    sessionIn(path.join(root, 'elsewhere'));
    expect(resolveResumeSessionId(agent, root)).toBeNull();
    sessionIn(project);
    expect(resolveResumeSessionId(agent, root)).toBe(SES);
    expect(gooseUuidOf('not-a-goose-id')).toBeNull();
  });

  it('under GOOSE_PATH_ROOT when it is set, whatever XDG_DATA_HOME says', () => {
    vi.stubEnv('GOOSE_PATH_ROOT', path.join(root, 'goose-root'));
    expect(gooseDbPath()).toBe(path.join(root, 'goose-root', 'data', 'sessions', 'sessions.db'));
    expect(new GooseProvider().configDir).toBe(path.join(root, 'goose-root', 'config'));
    vi.stubEnv('GOOSE_PATH_ROOT', '  ');
    expect(gooseDbPath()).toBe(path.join(root, 'data', 'goose', 'sessions', 'sessions.db'));
  });

  it('resumes with --resume --session-id, forks with --fork, its own id only, and the line is read back as such', () => {
    const goose = new GooseProvider();
    const resume = goose.buildInteractiveCommand({ binaryPath: '/opt/goose', prompt: '', resumeSessionId: SES });
    expect(resume).toContain(`--resume --session-id '${SES}'`);
    expect(resume).not.toContain('--fork');
    const fork = goose.buildInteractiveCommand({ binaryPath: '/opt/goose', prompt: '', resumeSessionId: SES, forkSession: true });
    expect(fork).toContain(`--resume --session-id '${SES}' --fork`);
    for (const bad of [`${SES}'; rm -rf ~`, gooseUuidOf(SES)!, '2026']) {
      expect(goose.buildInteractiveCommand({ binaryPath: '/opt/goose', prompt: '', resumeSessionId: bad })).not.toContain('--resume');
    }
    expect(gooseLaunchOf(resume)).toEqual({ resume: SES });
    expect(gooseLaunchOf(fork)).toEqual({ forkOf: SES });
    expect(gooseLaunchOf(['session', '--resume', '--session-id', SES, '--fork'])).toEqual({ forkOf: SES });
    expect(gooseLaunchOf("'/opt/goose' session")).toEqual({});
  });
});
